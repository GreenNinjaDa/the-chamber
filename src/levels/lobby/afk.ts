import { sfx } from '../../engine/audio';
import { add, clamp, fromQuat, length, mul, normalize, scale, scaling, sub, translation, type Vec3 } from '../../engine/math';
import type { Body } from '../../engine/physics';
import { Pattern, type DrawItem } from '../../engine/renderer';
import { drawPortal } from '../../entities/portal';
import { drawPineapple, GRENADE_OLIVE } from '../../entities/grenade';
import { junk, spawnJunk } from '../../entities/junk';
import type { LevelContext } from '../level';

/*
 * Idle in the lobby for 20 s and the chamber gets bored: it drops a fridge on your head, bounces
 * you between portals, or (rarely) hands you a live grenade. Any input stops the portal game
 * instantly. After each prank the 20 s start again.
 */

const AFK_AFTER = 20;
const GRENADE_CHANCE = 0.15;
const PORTAL_CHANCE = 0.45;

const G = 9.8;
const PORTAL_R = 1.0;
const PORTAL_GROW = 0.4;
/** Height of the portal in the air, and how long each hop from it to a floor portal takes. */
const AIR_HEIGHT = 7.5;
const HOP_TIME = 1.1;
const CATCH_TIME = 0.3;
const MIN_HOPS = 3;
const MAX_HOPS = 5;

const FRIDGE_HEIGHT = 7;
const FRIDGE_LIFETIME = 5;

const GRENADE_FUSE = 4;
const BLAST_RADIUS = 8;
const FLASH_TIME = 0.3;

type Prank = 'grenade' | 'portals' | 'fridge';
type PortalStage = 'open' | 'sink' | 'fly' | 'land' | 'close';

export class AfkPranks {
  private idle = 0;
  private prank: Prank | null = null;
  private t = 0;

  // Portal game: two floor portals and one in the air, facing down.
  private stage: PortalStage = 'open';
  private stageT = 0;
  private floorA: Vec3 = [0, 0, 0];
  private floorB: Vec3 = [0, 0, 0];
  private air: Vec3 = [0, 0, 0];
  private target: Vec3 = [0, 0, 0];
  private flyVel: Vec3 = [0, 0, 0];
  private hopsLeft = 0;
  private catching = false;
  private portalRadius = 0;

  private fridge: Body | null = null;
  private grenade: Body | null = null;
  private flashAt: Vec3 = [0, 0, 0];
  private flashT = -1;

  constructor(private ctx: LevelContext) {}

  /** For testing: seconds of idling so far. */
  get idleTime() {
    return this.idle;
  }

  /** `ready`: the player is in the lobby and able to be pranked. */
  update(dt: number, ready: boolean) {
    const active = this.ctx.input.active();
    if (this.flashT >= 0) this.flashT += dt;
    if (this.prank) {
      if (active && this.prank === 'portals') this.stopPortals();
      else this.updatePrank(dt);
      return;
    }
    const alive = ready && this.ctx.player.mode === 'control' && !this.ctx.player.inPortal;
    this.idle = active || !alive ? 0 : this.idle + dt;
    if (this.idle >= AFK_AFTER) this.start();
  }

  /** Forces a prank now (dev testing). */
  start(prank?: Prank) {
    const r = Math.random();
    this.prank = prank ?? (r < GRENADE_CHANCE ? 'grenade' : r < GRENADE_CHANCE + PORTAL_CHANCE ? 'portals' : 'fridge');
    this.t = 0;
    this.idle = 0;
    const p = this.ctx.player.pos;
    if (this.prank === 'fridge') {
      this.fridge = spawnJunk(this.ctx.physics, junk('fridge'), [p[0], FRIDGE_HEIGHT, p[2]]);
    } else if (this.prank === 'grenade') {
      const a = Math.random() * Math.PI * 2;
      const pos: Vec3 = [p[0] + Math.cos(a) * 1.5, 10, p[2] + Math.sin(a) * 1.5];
      this.grenade = this.ctx.physics.addBall(pos, 0.16, { mass: 0.3, restitution: 0.3, hidden: true });
    } else {
      this.startPortals();
    }
  }

  private finish() {
    this.prank = null;
    this.idle = 0;
  }

  private updatePrank(dt: number) {
    this.t += dt;
    const { physics } = this.ctx;
    if (this.prank === 'fridge') {
      if (this.t >= FRIDGE_LIFETIME) {
        if (this.fridge) physics.remove(this.fridge);
        this.fridge = null;
        this.finish();
      }
    } else if (this.prank === 'grenade') {
      if (this.grenade && this.t >= GRENADE_FUSE) this.explode();
      if (!this.grenade && this.t >= GRENADE_FUSE + 1) this.finish();
    } else {
      this.updatePortals(dt);
    }
  }

  // --- Grenade ------------------------------------------------------------------------------------

  private explode() {
    const { physics, player, camera } = this.ctx;
    const t = this.grenade!.rb.translation();
    const pos: Vec3 = [t.x, t.y, t.z];
    physics.remove(this.grenade!);
    this.grenade = null;
    this.flashAt = pos;
    this.flashT = 0;
    camera.addShake(1.2);
    sfx.explosion(0.6);
    for (const b of physics.bodies) {
      const q = b.rb.translation();
      const d = length(sub([q.x, q.y, q.z], pos));
      if (d > BLAST_RADIUS * 1.5) continue;
      const dir = normalize(add(sub([q.x, q.y, q.z], pos), [0, 0.6, 0]));
      const speed = Math.min(18, 900 / (d + 1) / b.rb.mass());
      const m = b.rb.mass();
      b.rb.applyImpulse({ x: dir[0] * speed * m, y: dir[1] * speed * m, z: dir[2] * speed * m }, true);
    }
    const chest = add(player.pos, [0, 1.3, 0]);
    const d = length(sub(chest, pos));
    if (d < BLAST_RADIUS) {
      const away = normalize(add(sub(chest, pos), [0, 0.5, 0]));
      player.kill(scale(away, 26 - 2 * d), { violence: 44 - 4 * d, origin: pos });
    }
  }

  // --- Portal game ----------------------------------------------------------------------------

  private startPortals() {
    const p = this.ctx.player.pos;
    this.floorA = [p[0], 0.03, p[2]];
    // The catching portal: somewhere else on the floor, a few metres away.
    for (let tries = 0; tries < 40; tries++) {
      this.floorB = [(Math.random() * 2 - 1) * 8, 0.03, (Math.random() * 2 - 1) * 8];
      const d = Math.hypot(this.floorB[0] - p[0], this.floorB[2] - p[2]);
      if (d > 4 && d < 10) break;
    }
    const mid = scale(add(this.floorA, this.floorB), 0.5);
    this.air = [clamp(mid[0], -8, 8), AIR_HEIGHT, clamp(mid[2], -8, 8)];
    this.hopsLeft = MIN_HOPS + Math.floor(Math.random() * (MAX_HOPS - MIN_HOPS + 1));
    this.target = this.floorB;
    this.setStage('open');
  }

  private setStage(stage: PortalStage) {
    this.stage = stage;
    this.stageT = 0;
  }

  private updatePortals(dt: number) {
    const { player } = this.ctx;
    this.stageT += dt;
    switch (this.stage) {
      case 'open':
        this.portalRadius = PORTAL_R * clamp(this.stageT / PORTAL_GROW, 0, 1);
        if (this.stageT >= PORTAL_GROW) {
          player.shrinkInto(this.floorA, 0.5);
          this.setStage('sink');
        }
        break;
      case 'sink':
        if (this.stageT >= 0.5) this.hop();
        break;
      case 'fly':
        this.flyVel[1] -= G * dt;
        player.pos = add(player.pos, scale(this.flyVel, dt));
        player.flightDir = normalize(this.flyVel);
        if (!this.catching && this.stageT >= HOP_TIME - CATCH_TIME) {
          this.catching = true;
          player.shrinkInto(this.target, CATCH_TIME);
        }
        if (this.stageT >= HOP_TIME) {
          this.hopsLeft--;
          this.target = this.target === this.floorB ? this.floorA : this.floorB;
          if (this.hopsLeft > 0) this.hop();
          else this.dropOut();
        }
        break;
      case 'land':
        if (this.stageT >= 0.6) this.setStage('close');
        break;
      case 'close':
        this.portalRadius = PORTAL_R * (1 - clamp(this.stageT / PORTAL_GROW, 0, 1));
        if (this.stageT >= PORTAL_GROW) this.finish();
        break;
    }
  }

  /** Out of the air portal, on a ballistic arc into the current target portal. */
  private hop() {
    const { player } = this.ctx;
    const start = add(this.air, [0, -0.4, 0]);
    const end = add(this.target, [0, 0.2, 0]);
    this.flyVel = add(scale(sub(end, start), 1 / HOP_TIME), [0, 0.5 * G * HOP_TIME, 0]);
    player.mode = 'flying';
    player.pos = start;
    player.flightDir = normalize(this.flyVel);
    player.growFrom(this.air, 0.3);
    this.catching = false;
    this.setStage('fly');
  }

  /** Done bouncing: the air portal drops them for real, in a heap. */
  private dropOut() {
    const { player } = this.ctx;
    player.growFrom(this.air, 0.5);
    player.emerge(add(this.air, [0, -1, 0]), player.facing, [0, -6, 0], 1.5);
    this.setStage('land');
  }

  /** Any input: every prank portal vanishes on the spot and the player drops wherever they are. */
  private stopPortals() {
    const { player } = this.ctx;
    player.cancelPortal();
    if (player.mode === 'flying') player.emerge(player.pos, player.facing, this.flyVel, 1.2);
    this.portalRadius = 0;
    this.finish();
  }

  draw(out: DrawItem[]) {
    if (this.prank === 'portals' && this.portalRadius > 0.01) {
      const wobble = 1 + Math.sin(this.t * 9) * 0.03;
      drawPortal(out, this.floorA, [0, 1, 0], this.portalRadius * wobble, false);
      drawPortal(out, this.floorB, [0, 1, 0], this.portalRadius * wobble, false);
      drawPortal(out, this.air, [0, -1, 0], this.portalRadius * wobble, false);
    }
    if (this.grenade) {
      const t = this.grenade.rb.translation();
      const blink = Math.sin(this.t * (6 + this.t * 4)) > 0;
      drawPineapple(out, fromQuat(this.grenade.rb.rotation(), [t.x, t.y, t.z]), 1, GRENADE_OLIVE, blink);
    }
    if (this.flashT >= 0 && this.flashT < FLASH_TIME) {
      const r = 0.5 + this.flashT * 20;
      out.push({
        mesh: 'sphere',
        model: mul(translation(this.flashAt), scaling([r, r, r])),
        color: [6, 3.2, 0.8].map((c) => c * (1 - this.flashT / FLASH_TIME)),
        pattern: Pattern.emissive,
        shadow: false,
      });
    }
  }
}
