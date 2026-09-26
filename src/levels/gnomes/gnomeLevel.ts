import { add, clamp, cross, dot, length, mul, normalize, rotateByQuat, rotationX, scale, scaling, sub, translation, type Vec3 } from '../../engine/math';
import type { Body } from '../../engine/physics';
import { Pattern, type DrawItem, type Environment } from '../../engine/renderer';
import { drawGnomeHat, GNOME_HEIGHT, GNOME_POSES, newGnomeLook, spawnGnome, type GnomeLook } from '../../entities/gnome';
import { ExitPortal, PortalArrival } from '../../entities/portal';
import { CHAMBER_HALF } from '../../game/chamber';
import { DEFAULT_ENV, type CameraShot, type Level, type LevelContext, type LevelStatus, type TrackedTarget, type WorldLabel } from '../level';

/*
 * Gnome Alone (Weeping Angels, but garden gnomes). A huge progress bar on the north wall only
 * loads while you watch it; the gnomes only move while nobody watches them. Every so often the
 * lights flicker out, and in the dark nobody is watching anything. Get caught and you wake up
 * dead, in a pointy hat, in the middle of a gnome circle. Gnomes are light: carry one and it's
 * harmless, throw it far away and it has further to come back.
 */

// --- Tuning -----------------------------------------------------------------------------------
const SPAWN: Vec3 = [0, 0, 6];
/** The bar: centre height on the north wall, size (m), and how many blocks it's made of. */
const BAR_Y = 6;
const BAR_W = 20;
const BAR_H = 1.6;
const BAR_BLOCKS = 40;
const WALL_Z = -CHAMBER_HALF;
const BAR_CENTRE: Vec3 = [0, BAR_Y, WALL_Z + 0.3];
/** The bar fills while its centre is within this angle of the view direction (and not blocked). */
const WATCH_ANGLE = (20 * Math.PI) / 180;
/** The first two gnomes, by the south wall (behind you as you arrive). */
const FIRST_GNOMES: Vec3[] = [[-8.5, 0, 10.8], [8.5, 0, 10.8]];
const MAX_GNOMES = 10;
/** More gnomes turn up (out of sight) after this many seconds of watching the bar. */
const SPAWN_AT = [4, 8, 12, 17, 25, 25, 30, 34];
/** New gnomes appear at least this far from the player (m). */
const SPAWN_MIN_DISTANCE = 7;
/** Gliding speed (m/s) at the start and once the bar is full; in the dark they're this much faster. */
const SPEED_START = 1.1;
const SPEED_END = 1.9;
const DARK_SPEED_SCALE = 3;
/** A gnome this close (m, from the player's feet) that nobody is watching gets you. */
const CATCH_DISTANCE = 0.75;
/** Thrown (or dropped) gnomes are left to tumble this long (s) before they carry on. */
const THROWN_TUMBLE = 1.5;
/** Seen checks: the view frustum is widened by this share, and a gnome counts as a ball this big (m). */
const FRUSTUM_MARGIN = 0.08;
const GNOME_BOUND = 0.6;
/** Blackouts: the first comes this long after you arrive, then one every BLINK_MIN–BLINK_MAX s. */
const FIRST_BLINK = 18;
const BLINK_MIN = 10;
const BLINK_MAX = 15;
/** The telegraph before a blackout: brief dips in the light, [start, end, light level], s before it. */
const WARN_DIPS: [number, number, number][] = [[-2, -1.92, 0.3], [-1.84, -1.8, 0.6], [-1.3, -1.2, 0.25], [-0.75, -0.66, 0.35], [-0.58, -0.54, 0.6]];
/** The light level below which it counts as dark: nobody sees anything. */
const DARK = 0.2;
/** Getting caught: lights out this long, then you see what happened; the death screen follows. */
const CAUGHT_DARK = 1.2;
const DEATH_SCREEN_DELAY = 1.9;
/** The gnomes that got you stand in a ring this far (m) from the body, at least this many of them. */
const RING_RADIUS = 1.45;
const RING_MIN = 7;

/**
 * The bar's script, in seconds of watching: each stage runs until `end`, moving the bar from the
 * previous stage's `p` to its own. `{p}` is the percentage, `{n}` the number of gnomes.
 */
const SCRIPT: { end: number; p: number; text: string; update?: boolean }[] = [
  { end: 3, p: 0.13, text: 'LOADING TEST CHAMBER... {p}%' },
  { end: 6, p: 0.31, text: 'Reticulating splines... {p}%' },
  { end: 9, p: 0.44, text: 'Counting gnomes... {n}... {n1}... {n4}?' },
  { end: 11.5, p: 0.57, text: 'Time remaining: 2 minutes' },
  { end: 14, p: 0.61, text: 'Time remaining: 9 hours' },
  { end: 16.5, p: 0.99, text: 'Time remaining: 12 seconds' },
  { end: 18, p: 0.99, text: 'Almost there...' },
  { end: 19.5, p: 0.99, text: 'Still 99%.' },
  { end: 21, p: 0.99, text: 'Any second now.' },
  { end: 23, p: 0.99, text: 'Have you tried turning it off and on again?' },
  { end: 25, p: 0, text: 'INSTALLING UPDATE 1 OF 2...', update: true },
  { end: 29, p: 0.38, text: 'Downloading more gnomes... {p}%' },
  { end: 33, p: 0.8, text: 'INSTALLING UPDATE 2 OF 2... {p}%' },
  { end: 37, p: 1, text: 'Almost there. For real this time. {p}%' },
];
const WATCH_TOTAL = SCRIPT[SCRIPT.length - 1].end;
const UPDATE_STAGE = SCRIPT.findIndex((s) => s.update);

const DEATHS = {
  plain: ["They only move when nobody's looking. Nobody was looking.", 'You turned your back on a garden gnome. Rookie mistake.'],
  blink: ["Don't blink. Blink and you're dead. The lights blinked. Close enough.", 'The lights went out. So did you.'],
  watching: ['Riveting progress bar, to be fair. The gnomes thought so too.', 'You were watching the bar. The gnomes were watching you.'],
};

const BAR_GREEN = [0.1, 1.05, 0.22];
const BAR_BLUE = [0.12, 0.4, 1.4];
const SLOT = [0.025, 0.06, 0.035];

type GnomeState = 'still' | 'moving' | 'carried' | 'loose';
type PoseSet = keyof typeof GNOME_POSES;

interface Gnome {
  body: Body;
  look: GnomeLook;
  /** still: seen (or idle), left alone; moving: nobody's looking, gliding at you; carried; loose: thrown, tumbling. */
  state: GnomeState;
  tumble: number;
  /** Which set of poses it's in, so it only changes pose (while unseen) when that changes. */
  poseSet: PoseSet | null;
}

interface Caught {
  t: number;
  kind: keyof typeof DEATHS;
  ringed: boolean;
  /** Horizontal direction from the body to the camera for the reveal shot. */
  side: Vec3;
}

const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
const yawQuat = (yaw: number) => ({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) });
/** The yaw that points a gnome's face (-z) along (dx, dz). */
const faceYaw = (dx: number, dz: number) => Math.atan2(-dx, -dz);

function blinkPattern(): [number, number][] {
  // Two or three stretches of darkness over ~0.8 s, about 0.36 s of dark in all.
  const j = () => (Math.random() - 0.5) * 0.04;
  return Math.random() < 0.5
    ? [[0, 0.17 + j()], [0.6 + j(), 0.8]]
    : [[0, 0.11 + j()], [0.33 + j(), 0.46 + j()], [0.68 + j(), 0.8]];
}

export class GnomeLevel implements Level {
  readonly number: number;
  readonly title = 'Gnome Alone';
  status: LevelStatus = 'playing';
  private arrival: PortalArrival;
  private exit = new ExitPortal(0);
  private gnomes: Gnome[] = [];
  private t = 0;
  private started = false;
  /** Seconds spent watching the bar, and whether the player is watching it right now. */
  private watched = 0;
  private watching = false;
  private complete = false;
  private nextSpawn = 0;
  private spawnsDue = 0;
  /** When the next blackout starts (level time), and its dark stretches (s after that). */
  private blinkAt = Infinity;
  private blink: [number, number][] = blinkPattern();
  /** 0 (pitch black) to 1 (normal). */
  private light = 1;
  private caught: Caught | null = null;
  private env: Environment = {
    ...DEFAULT_ENV,
    sunColor: [...DEFAULT_ENV.sunColor],
    skyColor: [...DEFAULT_ENV.skyColor],
    groundColor: [...DEFAULT_ENV.groundColor],
    fogColor: [...DEFAULT_ENV.fogColor],
  };
  // The camera's view this frame, for the seen checks.
  private camPos: Vec3 = [0, 0, 0];
  private fwd: Vec3 = [0, 0, -1];
  private right: Vec3 = [1, 0, 0];
  private up: Vec3 = [0, 1, 0];
  private tanH = 1;
  private tanV = 1;
  // The bar, built once: its frame and the blocks that light up.
  private barParts: DrawItem[] = [];
  private blocks: DrawItem[] = [];
  private blockColors: number[][] = [];
  private headerLabel: WorldLabel = { pos: [0, BAR_Y + BAR_H / 2 + 0.85, WALL_Z + 0.3], text: 'PLEASE WAIT', size: 0.7, color: '#e8ffe8' };
  private pctLabel: WorldLabel = { pos: [0, BAR_Y, WALL_Z + 0.35], text: '0%', size: 0.9 };
  private statusLabel: WorldLabel = { pos: [0, BAR_Y - BAR_H / 2 - 0.75, WALL_Z + 0.3], text: '', size: 0.62, color: '#d9ffd9' };
  private subLabel: WorldLabel = { pos: [0, BAR_Y - BAR_H / 2 - 1.55, WALL_Z + 0.3], text: '', size: 0.44, color: '#bfc7bf' };
  private labelList: WorldLabel[] = [];
  private statusKey = '';

  constructor(private ctx: LevelContext) {
    this.number = ctx.number;
    const { hud, physics } = ctx;
    hud.setLevel(`The Chamber · Level ${this.number}`);
    hud.show(`LEVEL ${this.number}`, '', 2.5);
    hud.hint('');
    this.arrival = new PortalArrival(ctx, SPAWN);
    for (const p of FIRST_GNOMES) this.addGnome(p);
    physics.substepHooks.push((h) => this.drive(h));
    this.buildBar();
  }

  // --- Gnomes -----------------------------------------------------------------------------------

  private addGnome(feet: Vec3) {
    const look = newGnomeLook();
    look.arms = pick(GNOME_POSES.far);
    const toPlayer = sub(this.ctx.player.pos, feet);
    const body = spawnGnome(this.ctx.physics, feet, look, yawQuat(faceYaw(toPlayer[0], toPlayer[2])));
    this.gnomes.push({ body, look, state: 'still', tumble: 0, poseSet: 'far' });
  }

  /** Puts a new gnome somewhere along the south, east or west wall that the camera can't see. */
  private spawnHidden(): boolean {
    const { player } = this.ctx;
    const inset = CHAMBER_HALF - 0.8;
    for (let tries = 0; tries < 30; tries++) {
      const side = Math.floor(Math.random() * 3);
      const along = (Math.random() * 2 - 1) * (CHAMBER_HALF - 1.2);
      const feet: Vec3 = side === 0 ? [along, 0, inset] : side === 1 ? [inset, 0, along] : [-inset, 0, along];
      if (side === 1 && Math.abs(along) < 2.5) continue; // not in the exit's doorway
      if (Math.hypot(feet[0] - player.pos[0], feet[2] - player.pos[2]) < SPAWN_MIN_DISTANCE) continue;
      if (this.gnomes.some((g) => {
        const t = g.body.rb.translation();
        return Math.hypot(t.x - feet[0], t.z - feet[2]) < 1.2;
      })) continue;
      if (this.inFrustum([feet[0], GNOME_HEIGHT / 2, feet[2]], GNOME_BOUND + 0.4)) continue;
      this.addGnome(feet);
      return true;
    }
    return false;
  }

  /** Whether a ball of `radius` at `p` is (nearly) in the camera's view, ignoring anything in the way. */
  private inFrustum(p: Vec3, radius: number): boolean {
    const d = sub(p, this.camPos);
    const z = dot(d, this.fwd);
    if (z < -radius) return false;
    const x = Math.abs(dot(d, this.right)), y = Math.abs(dot(d, this.up));
    if ((x - z * this.tanH) / Math.sqrt(1 + this.tanH * this.tanH) > radius) return false;
    if ((y - z * this.tanV) / Math.sqrt(1 + this.tanV * this.tanV) > radius) return false;
    return true;
  }

  /** In view and not hidden behind anything (checked at its top, middle and bottom). */
  private isSeen(g: Gnome): boolean {
    const rb = g.body.rb;
    const t = rb.translation();
    const centre: Vec3 = [t.x, t.y, t.z];
    if (!this.inFrustum(centre, GNOME_BOUND)) return false;
    const axis = rotateByQuat(rb.rotation(), [0, 1, 0]);
    for (const k of [0.3, 0, -0.3]) {
      const p = add(centre, scale(axis, k));
      const delta = sub(p, this.camPos);
      const dist = length(delta);
      if (dist < 0.05) return true;
      const hit = this.ctx.physics.raycast(this.camPos, scale(delta, 1 / dist), dist + 0.05);
      if (!hit || hit.collider.handle === g.body.collider.handle) return true;
    }
    return false;
  }

  /** How fast the gnomes glide right now. */
  private speed() {
    const base = SPEED_START + (SPEED_END - SPEED_START) * clamp(this.watched / WATCH_TOTAL, 0, 1);
    return this.light < DARK ? base * DARK_SPEED_SCALE : base;
  }

  private updateGnomes(dt: number) {
    const { player } = this.ctx;
    const dark = this.light < DARK;
    const carried = player.carrying?.handle;
    for (const g of this.gnomes) {
      const rb = g.body.rb;
      if (carried === g.body.collider.handle) {
        g.state = 'carried';
        g.tumble = THROWN_TUMBLE;
        continue;
      }
      if (g.tumble > 0) {
        g.tumble -= dt;
        g.state = 'loose';
        continue;
      }
      const t = rb.translation();
      const v = rb.linvel();
      const seen = !dark && this.isSeen(g);
      if (seen) {
        if (g.state === 'moving') {
          // Caught in the act: freeze. Perfectly still.
          rb.setLinvel({ x: 0, y: Math.min(0, v.y), z: 0 }, true);
          rb.setAngvel({ x: 0, y: 0, z: 0 }, true);
        }
        g.state = 'still';
        continue;
      }
      if (g.state !== 'moving') {
        // Knocked about and still flying? Let it land first.
        if (Math.hypot(v.x, v.y, v.z) > 2.5) {
          g.tumble = 0.3;
          g.state = 'loose';
          continue;
        }
        // Nobody's looking: back on its feet, facing you.
        const q = rb.rotation();
        const upright = 1 - 2 * (q.x * q.x + q.z * q.z);
        if (upright < 0.97) {
          const dx = player.pos[0] - t.x, dz = player.pos[2] - t.z;
          rb.setRotation(yawQuat(faceYaw(dx, dz)), true);
          if (t.y < GNOME_HEIGHT / 2) rb.setTranslation({ x: t.x, y: GNOME_HEIGHT / 2 + 0.02, z: t.z }, true);
        }
        g.state = 'moving';
      }
      // While nobody's watching, strike a new pose to match how close it is (or, once the exit
      // is open, wave you goodbye; they're still coming, mind).
      const d = Math.hypot(player.pos[0] - t.x, player.pos[2] - t.z);
      const set: PoseSet = this.complete && d > 2.5 ? 'bye' : d < 3.2 ? 'near' : d < 8 ? 'mid' : 'far';
      if (set !== g.poseSet) {
        g.poseSet = set;
        g.look.arms = pick(GNOME_POSES[set]);
      }
      g.look.menace = clamp((9 - d) / 7, 0, 1);
      if (d < CATCH_DISTANCE && !player.inPortal) {
        this.gotCaught(g, dark);
        return;
      }
    }
  }

  /** Every physics substep: gnomes nobody is watching glide at the player, upright and facing them. */
  private drive(_h: number) {
    if (!this.started || this.caught || this.status !== 'playing') return;
    const p = this.ctx.player.pos;
    const speed = this.speed();
    for (const g of this.gnomes) {
      if (g.state !== 'moving') continue;
      const rb = g.body.rb;
      const t = rb.translation();
      const dx = p[0] - t.x, dz = p[2] - t.z;
      const d = Math.hypot(dx, dz);
      if (d < 1e-3) continue;
      let vx = (dx / d) * speed, vz = (dz / d) * speed;
      // Don't queue up behind each other: spread out a little.
      for (const o of this.gnomes) {
        if (o === g) continue;
        const u = o.body.rb.translation();
        const ox = t.x - u.x, oz = t.z - u.z;
        const od = Math.hypot(ox, oz);
        if (od < 0.9 && od > 1e-3) {
          vx += (ox / od) * (0.9 - od) * 3;
          vz += (oz / od) * (0.9 - od) * 3;
        }
      }
      rb.setLinvel({ x: vx, y: rb.linvel().y, z: vz }, true);
      rb.setRotation(yawQuat(faceYaw(dx, dz)), true);
      rb.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
  }

  // --- Getting caught ---------------------------------------------------------------------------

  private gotCaught(g: Gnome, dark: boolean) {
    const { player, hud, camera } = this.ctx;
    const t = g.body.rb.translation();
    const away = normalize([player.pos[0] - t.x, 0, player.pos[2] - t.z]);
    player.kill([away[0] * 2.5, 1, away[2] * 2.5], { violence: 0 });
    hud.hide();
    const toCam = normalize([camera.pos[0] - player.pos[0], 0, camera.pos[2] - player.pos[2]]);
    this.caught = { t: 0, kind: dark ? 'blink' : this.watching ? 'watching' : 'plain', ringed: false, side: toCam[0] || toCam[2] ? toCam : [0, 0, 1] };
    for (const o of this.gnomes) {
      o.state = 'still';
      o.tumble = 0;
    }
  }

  /** Where the body lies (between its hips and chest). */
  private bodyCentre(): Vec3 {
    const body = this.ctx.player.body;
    if (!body) return [...this.ctx.player.pos];
    const a = body.position('pelvis'), b = body.position('chest');
    return [(a[0] + b[0]) / 2, 0, (a[2] + b[2]) / 2];
  }

  /** In the dark, every gnome (and a few more) gathers in a ring around the body, facing it. */
  private formRing() {
    const c = this.bodyCentre();
    while (this.gnomes.length < RING_MIN) this.addGnome([c[0] + 30, 0, c[2]]);
    const n = this.gnomes.length;
    const a0 = Math.random() * Math.PI * 2;
    const lim = CHAMBER_HALF - 0.35;
    this.gnomes.forEach((g, i) => {
      const a = a0 + (i / n) * Math.PI * 2;
      const x = clamp(c[0] + Math.cos(a) * RING_RADIUS, -lim, lim);
      const z = clamp(c[2] + Math.sin(a) * RING_RADIUS, -lim, lim);
      const rb = g.body.rb;
      rb.setTranslation({ x, y: GNOME_HEIGHT / 2 + 0.01, z }, true);
      rb.setRotation(yawQuat(faceYaw(c[0] - x, c[2] - z)), true);
      rb.setLinvel({ x: 0, y: 0, z: 0 }, true);
      rb.setAngvel({ x: 0, y: 0, z: 0 }, true);
      g.state = 'still';
      g.look.arms = pick(GNOME_POSES.near);
      g.look.menace = 1;
    });
  }

  private updateCaught(dt: number) {
    const c = this.caught!;
    c.t += dt;
    if (!c.ringed && c.t > CAUGHT_DARK * 0.75) {
      c.ringed = true;
      this.formRing();
    }
    if (this.status === 'playing' && c.t > CAUGHT_DARK + DEATH_SCREEN_DELAY) {
      this.status = 'lost';
      const { hud } = this.ctx;
      hud.show('GNOMED', `${pick(DEATHS[c.kind])}\nPress R to try again.`);
      const tips: [string, string][] = [['Hint', 'The bar only fills while you watch it. The gnomes only move while you don\'t. Pick them up and throw them far away.']];
      if (c.kind === 'blink') tips.push(['Also', 'When the lights flicker, get the close ones far away (or into your arms). In the dark, they all come at once.']);
      tips.push(['Controls', 'Hold left click to carry a gnome, right-click to throw it · Mouse to look']);
      hud.tips(tips);
    }
  }

  // --- Lights -----------------------------------------------------------------------------------

  private updateLight() {
    if (this.caught) {
      this.light = this.caught.t < CAUGHT_DARK ? 0 : 1;
      return;
    }
    const b = this.t - this.blinkAt;
    const last = this.blink[this.blink.length - 1][1];
    if (b > last) {
      this.blinkAt = this.t + BLINK_MIN + Math.random() * (BLINK_MAX - BLINK_MIN);
      this.blink = blinkPattern();
      this.light = 1;
      return;
    }
    let k = 1;
    for (const [s, e, level] of WARN_DIPS) if (b >= s && b < e) k = level;
    for (const [s, e] of this.blink) if (b >= s && b < e) k = 0;
    this.light = k;
  }

  // --- The bar ----------------------------------------------------------------------------------

  private buildBar() {
    const z = WALL_Z;
    this.barParts.push(
      { mesh: 'bevelbox', model: mul(translation([0, BAR_Y, z + 0.12]), scaling([BAR_W + 0.8, BAR_H + 0.7, 0.24])), color: [0.09, 0.09, 0.1], spec: 0.4 },
      { mesh: 'box', model: mul(translation([0, BAR_Y, z + 0.245]), scaling([BAR_W + 0.2, BAR_H + 0.1, 0.02])), color: [0.01, 0.012, 0.01], spec: 0.2 },
    );
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
      this.barParts.push({
        mesh: 'cylinder',
        model: mul(translation([sx * (BAR_W / 2 + 0.2), BAR_Y + sy * (BAR_H / 2 + 0.17), z + 0.25]), rotationX(Math.PI / 2), scaling([0.07, 0.04, 0.07])),
        color: [0.55, 0.56, 0.58],
        spec: 0.9,
      });
    }
    const pitch = BAR_W / BAR_BLOCKS;
    for (let i = 0; i < BAR_BLOCKS; i++) {
      const color = [...SLOT];
      this.blockColors.push(color);
      this.blocks.push({
        mesh: 'box',
        model: mul(translation([-BAR_W / 2 + pitch * (i + 0.5), BAR_Y, z + 0.27]), scaling([pitch * 0.84, BAR_H * 0.82, 0.04])),
        color,
        shadow: false,
      });
    }
  }

  /** The bar's fill (0..1) and the script stage after `w` seconds of watching. */
  private progress(w: number): { p: number; stage: number } {
    let from = 0, start = 0;
    for (let i = 0; i < SCRIPT.length; i++) {
      const s = SCRIPT[i];
      if (w < s.end) return { p: from + (s.p - from) * ((w - start) / (s.end - start)), stage: i };
      from = s.p;
      start = s.end;
    }
    return { p: 1, stage: SCRIPT.length };
  }

  /** Watching = the bar's centre near the middle of the view, with a clear line of sight, lights on. */
  private isWatching(): boolean {
    const to = sub(BAR_CENTRE, this.camPos);
    const dist = length(to);
    if (dot(to, this.fwd) / dist < Math.cos(WATCH_ANGLE)) return false;
    for (const x of [0, -BAR_W / 3, BAR_W / 3]) {
      const p: Vec3 = [x, BAR_Y, WALL_Z + 0.3];
      const d = sub(p, this.camPos);
      const l = length(d);
      if (!this.ctx.physics.raycast(this.camPos, scale(d, 1 / l), l)) return true;
    }
    return false;
  }

  private updateBar(dt: number) {
    if (this.watching && !this.complete) {
      this.watched = Math.min(WATCH_TOTAL, this.watched + dt);
      while (this.nextSpawn < SPAWN_AT.length && this.watched >= SPAWN_AT[this.nextSpawn]) {
        this.nextSpawn++;
        this.spawnsDue++;
      }
      if (this.watched >= WATCH_TOTAL) {
        this.complete = true;
        this.exit.openNow();
      }
    }
    if (this.spawnsDue > 0 && this.gnomes.length < MAX_GNOMES && this.spawnHidden()) this.spawnsDue--;
  }

  private updateLabels() {
    const { p, stage } = this.progress(this.watched);
    const pct = Math.floor(p * 100 + 1e-6);
    const n = this.gnomes.length;
    const key = `${stage}|${pct}|${n}|${this.watching}`;
    if (key === this.statusKey) return;
    this.statusKey = key;
    this.pctLabel.text = `${pct}%`;
    if (this.complete) {
      this.headerLabel.text = 'THANK YOU FOR WAITING';
      this.statusLabel.text = 'LOADING COMPLETE.';
      this.subLabel.text = 'PLEASE PROCEED TO THE EXIT. DO NOT TURN AROUND.';
      this.subLabel.color = '#ffd166';
      return;
    }
    this.statusLabel.text = SCRIPT[stage].text
      .replace('{p}', String(pct))
      .replace('{n}', String(n))
      .replace('{n1}', String(n + 1))
      .replace('{n4}', String(n + 4));
    this.headerLabel.text = stage < UPDATE_STAGE ? 'PLEASE WAIT' : stage === UPDATE_STAGE ? 'DO NOT TURN OFF YOUR TEST CHAMBER' : 'PLEASE WAIT (AGAIN)';
    this.subLabel.text = this.watching ? '' : 'PAUSED · A WATCHED BAR ALWAYS FILLS';
  }

  private colorBlocks(time: number) {
    const { p, stage } = this.progress(this.watched);
    const updating = !this.complete && SCRIPT[stage]?.update === true;
    const lit = p * BAR_BLOCKS;
    const glow = this.light * (this.watching || this.complete ? 1 : 0.55);
    // A shine sweeps along the filled part; when it's done, the whole bar pulses.
    const shine = ((time * 0.6) % 1.4) * BAR_BLOCKS;
    const pulse = this.complete ? 0.8 + 0.4 * Math.sin(time * 6) : 1;
    const base = updating ? BAR_BLUE : BAR_GREEN;
    for (let i = 0; i < BAR_BLOCKS; i++) {
      const item = this.blocks[i], c = this.blockColors[i];
      const fill = clamp(lit - i, 0, 1);
      if (fill <= 0.02) {
        item.pattern = Pattern.plain;
        c[0] = SLOT[0]; c[1] = SLOT[1]; c[2] = SLOT[2];
        continue;
      }
      const bump = 1 + 0.7 * Math.exp(-((i - shine) ** 2) / 6);
      const k = glow * fill * bump * pulse;
      item.pattern = Pattern.emissive;
      c[0] = base[0] * k; c[1] = base[1] * k; c[2] = base[2] * k;
    }
  }

  // --- Level ------------------------------------------------------------------------------------

  private updateView() {
    const { camera } = this.ctx;
    this.camPos = camera.pos;
    this.fwd = normalize(sub(camera.target, camera.pos));
    this.right = normalize(cross(this.fwd, camera.up));
    this.up = cross(this.right, this.fwd);
    const tanHalf = Math.tan(camera.fov / 2) * (1 + FRUSTUM_MARGIN);
    this.tanV = tanHalf;
    this.tanH = tanHalf * (window.innerWidth / Math.max(1, window.innerHeight));
  }

  update(dt: number) {
    const { player } = this.ctx;
    this.t += dt;
    this.arrival.update(dt);
    this.exit.update(dt, player);
    if (this.exit.entered && this.status === 'playing') this.status = 'exited';
    if (!this.started && this.arrival.done) {
      this.started = true;
      this.blinkAt = this.t + FIRST_BLINK;
    }
    if (this.caught) this.updateCaught(dt);
    this.updateLight();
    this.updateView();
    const alive = this.started && !this.caught && player.mode === 'control' && this.status === 'playing';
    this.watching = alive && this.light >= DARK && this.isWatching();
    if (alive) {
      this.updateBar(dt);
      this.updateGnomes(dt);
    }
    const glow = clamp(1 - this.light / 0.3, 0, 1);
    for (const g of this.gnomes) g.look.glow = glow;
    this.updateLabels();
  }

  draw(out: DrawItem[], time: number) {
    this.arrival.draw(out);
    this.exit.draw(out);
    for (const part of this.barParts) out.push(part);
    this.colorBlocks(time);
    for (const block of this.blocks) out.push(block);
    // The victim gets a hat, once the lights come back on.
    const c = this.caught;
    if (c && c.t >= CAUGHT_DARK && this.ctx.player.body) drawGnomeHat(out, this.ctx.player.partFrames().head);
  }

  labels(): WorldLabel[] {
    const list = this.labelList;
    list.length = 0;
    if (this.light < 0.3) return list;
    list.push(this.headerLabel, this.pctLabel, this.statusLabel);
    if (this.subLabel.text) list.push(this.subLabel);
    return list;
  }

  trackedTargets(): TrackedTarget[] {
    const exit = this.exit.target();
    return exit ? [exit] : [];
  }

  environment() {
    const k = this.light;
    const amb = Math.max(k, 0.008);
    const env = this.env;
    for (let i = 0; i < 3; i++) {
      env.sunColor[i] = DEFAULT_ENV.sunColor[i] * k;
      env.skyColor[i] = DEFAULT_ENV.skyColor[i] * amb;
      env.groundColor[i] = DEFAULT_ENV.groundColor[i] * amb;
      env.fogColor[i] = DEFAULT_ENV.fogColor[i] * amb;
    }
    return env;
  }

  obstacles() {
    return [];
  }

  cameraShot(): CameraShot | null {
    const c = this.caught;
    if (c) {
      // Look down on the scene of the crime.
      const centre = this.bodyCentre();
      const lim = CHAMBER_HALF - 0.4;
      const pos: Vec3 = [clamp(centre[0] + c.side[0] * 3.4, -lim, lim), 3.6, clamp(centre[2] + c.side[2] * 3.4, -lim, lim)];
      return { pos, target: [centre[0], 0.4, centre[2]], sharpness: 4 };
    }
    return this.arrival.cameraShot();
  }
}
