import { add, basis, clamp, cross, easeInOut, normalize, scale, sub, type Vec3 } from '../engine/math';
import { Pattern, type DrawItem } from '../engine/renderer';
import type { CameraShot, LevelContext } from '../levels/level';
import { CHAMBER_HALF } from '../game/chamber';
import type { Player } from '../game/player';

/*
 * Purple liquid portals: levels start by spitting the player out of one, and most end by walking
 * (or flying) into one, which goes straight to the next level.
 */

const RIM = [0.14, 0.12, 0.18];
/** Seconds the player takes to shrink into a portal, or to grow back out of one. */
export const PORTAL_SQUEEZE_TIME = 0.5;

/** A portal disc facing along `normal`, optionally with a dark metal rim around it. */
export function drawPortal(out: DrawItem[], centre: Vec3, normal: Vec3, radius: number, rim: boolean) {
  if (radius <= 0.01) return;
  const n = normalize(normal);
  const helper: Vec3 = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const x = normalize(cross(helper, n));
  const z = cross(x, n);
  out.push({
    mesh: 'cylinder',
    model: basis(scale(x, radius), scale(n, 0.03), scale(z, radius), centre),
    color: [1, 1, 1],
    pattern: Pattern.portal,
    shadow: false,
  });
  if (rim) {
    const r = radius + 0.16;
    out.push({
      mesh: 'cylinder',
      model: basis(scale(x, r), scale(n, 0.12), scale(z, r), sub(centre, scale(n, 0.05))),
      color: RIM,
      spec: 0.6,
    });
  }
}

// --- Entrance -----------------------------------------------------------------------------------

/** Seconds from the level starting to the portal opening, and to the player being spat out. */
const OPEN_AT = 0.35;
const SPIT_AT = 1.0;
/** The portal shrinks away this long after dropping the player off, over CLOSE_TIME. */
const CLOSE_AFTER = 0.5;
const CLOSE_TIME = 0.35;
const GROW_TIME = 0.35;
const RADIUS = 1.1;
/** How high the portal hangs, how hard it spits, how long you're stunned, and the launch angle range
 * (below horizontal: 90° is straight down). */
const HEIGHT = 3.4;
const SPIT_SPEED = 7;
const STUN = 1.5;
const MIN_ELEVATION = (30 * Math.PI) / 180;
const MAX_ELEVATION = (90 * Math.PI) / 180;

/**
 * The start of a level: a rimless purple portal opens above the floor near `spawn` and flings the
 * player out downward at a random angle 30–90° below horizontal, stunned, then shrinks into nothing.
 */
export class PortalArrival {
  private t = 0;
  private spat = false;
  private readonly centre: Vec3;
  private readonly dir: Vec3;
  private readonly facing: number;

  constructor(private ctx: LevelContext, spawn: Vec3) {
    ctx.player.hide();
    // Aim roughly toward the middle of the chamber (± 90°) so you don't get fired into a wall.
    const toCentre = Math.atan2(spawn[0], spawn[2]);
    const yaw = toCentre + (Math.random() - 0.5) * Math.PI;
    const elevation = MIN_ELEVATION + Math.random() * (MAX_ELEVATION - MIN_ELEVATION);
    this.facing = yaw;
    this.dir = [-Math.sin(yaw) * Math.cos(elevation), -Math.sin(elevation), -Math.cos(yaw) * Math.cos(elevation)];
    this.centre = [spawn[0], HEIGHT, spawn[2]];
  }

  /** True once the player has been spat out and has had time to get back up. */
  get done() {
    return this.spat && this.t > SPIT_AT + STUN + 0.4;
  }

  update(dt: number) {
    this.t += dt;
    if (!this.spat && this.t >= SPIT_AT) {
      this.spat = true;
      // The body comes out below the portal, so start it a body-length along the spit direction.
      this.ctx.player.emerge(add(this.centre, scale(this.dir, 1.0)), this.facing, scale(this.dir, SPIT_SPEED), STUN);
      // They start as a speck inside the portal and grow to full size on the way out.
      this.ctx.player.growFrom(this.centre, PORTAL_SQUEEZE_TIME);
      this.ctx.camera.addShake(0.3);
    }
  }

  private radius() {
    const t = this.t;
    if (t < OPEN_AT) return 0;
    if (t < OPEN_AT + GROW_TIME) return RADIUS * easeInOut((t - OPEN_AT) / GROW_TIME);
    const closeAt = SPIT_AT + CLOSE_AFTER;
    if (t < closeAt) return RADIUS;
    return RADIUS * (1 - clamp((t - closeAt) / CLOSE_TIME, 0, 1));
  }

  draw(out: DrawItem[]) {
    // Wobble a little while open, like a liquid surface.
    const wobble = 1 + Math.sin(this.t * 9) * 0.03;
    drawPortal(out, this.centre, this.dir, this.radius() * wobble, false);
  }

  /** Until the player pops out, the camera watches the portal. */
  cameraShot(): CameraShot | null {
    if (this.spat) return null;
    const flat = normalize([this.dir[0], 0, this.dir[2]]);
    const side = [flat[2], 0, -flat[0]] as Vec3;
    const pos = add(add(this.centre, scale(flat[0] || flat[2] ? flat : [0, 0, 1], 5.5)), add(scale(side, 2), [0, 0.6, 0]));
    return { pos, target: this.centre, sharpness: 6 };
  }
}

// --- Exit ---------------------------------------------------------------------------------------

const EXIT_RADIUS = 1.2;
const EXIT_HEIGHT = 1.5;
const PANEL: Vec3 = [0.12, 3.3, 3.0];
const PANEL_SLIDE_TIME = 0.6;
const WALL = [0.86, 0.87, 0.88];

/**
 * An exit portal in the east wall, hidden behind a wall panel until `openNow()` slides the panel
 * aside. Walking into it sets `entered`.
 */
export class ExitPortal {
  /** Set once the player has been sucked all the way in. */
  entered = false;
  private isOpen = false;
  private openT = 0;
  /** Seconds since the player touched it (-1: not yet). */
  private sucking = -1;
  readonly centre: Vec3;

  constructor(z = 0) {
    this.centre = [CHAMBER_HALF - 0.02, EXIT_HEIGHT, z];
  }

  get open() {
    return this.isOpen;
  }

  openNow() {
    this.isOpen = true;
  }

  /** Open from the start, with the panel already out of the way. */
  openAlready() {
    this.isOpen = true;
    this.openT = PANEL_SLIDE_TIME;
  }

  update(dt: number, player: Player) {
    if (!this.isOpen) return;
    this.openT += dt;
    if (this.sucking >= 0) {
      this.sucking += dt;
      if (this.sucking >= PORTAL_SQUEEZE_TIME) this.entered = true;
      return;
    }
    if (this.openT < PANEL_SLIDE_TIME * 0.6 || player.mode !== 'control') return;
    const nearWall = CHAMBER_HALF - player.pos[0] < 0.75;
    const inside = Math.hypot(player.pos[2] - this.centre[2], player.pos[1] + 1 - this.centre[1]) < EXIT_RADIUS + 0.1;
    if (nearWall && inside) {
      this.sucking = 0;
      player.shrinkInto(this.centre, PORTAL_SQUEEZE_TIME);
    }
  }

  draw(out: DrawItem[]) {
    // Until it opens there's nothing to see: the plain wall hides it.
    if (!this.isOpen) return;
    drawPortal(out, this.centre, [-1, 0, 0], EXIT_RADIUS, true);
    // A wall panel slides aside to reveal it.
    const slide = easeInOut(clamp(this.openT / PANEL_SLIDE_TIME, 0, 1));
    const panelCentre: Vec3 = [CHAMBER_HALF - PANEL[0] / 2 - 0.005, PANEL[1] / 2, this.centre[2] + slide * (PANEL[2] + 0.1)];
    out.push({
      mesh: 'box',
      model: basis([PANEL[0], 0, 0], [0, PANEL[1], 0], [0, 0, PANEL[2]], panelCentre),
      color: WALL,
      pattern: Pattern.panels,
      param: 2,
      spec: 0.15,
    });
  }

  /** For the HUD's pulsing marker once it's open. */
  target() {
    return this.isOpen ? { pos: this.centre, radius: EXIT_RADIUS, color: 'purple' as const } : null;
  }
}
