import { clamp, type Mat4, type Vec3 } from '../engine/math';
import type { Physics } from '../engine/physics';
import { Pattern, type DrawItem } from '../engine/renderer';
import { CHAMBER_HALF } from '../game/chamber';
import type { WorldLabel } from '../levels/level';

/*
 * Athletics stadium kit: bleachers along the north wall packed with a (cheaply drawn) crowd that
 * cheers, gasps and eventually goes home; a running track with lanes; and confetti. Everything
 * keeps its draw items and matrices, so drawing allocates nothing.
 */

/** Writes a box `size` at `c`, turned by `a` about z (then scaled), into `m`. */
function setBox(m: Mat4, c: Vec3, size: Vec3, a = 0) {
  const co = Math.cos(a), si = Math.sin(a);
  m[0] = co * size[0]; m[1] = si * size[0]; m[2] = 0; m[3] = 0;
  m[4] = -si * size[1]; m[5] = co * size[1]; m[6] = 0; m[7] = 0;
  m[8] = 0; m[9] = 0; m[10] = size[2]; m[11] = 0;
  m[12] = c[0]; m[13] = c[1]; m[14] = c[2]; m[15] = 1;
}

// --- Crowd --------------------------------------------------------------------------------------

const TIERS = 4;
const TIER_DEPTH = 0.9;
const TIER_RISE = 0.55;
/** Front edge (z) of the lowest tier; each tier above steps back toward the north wall. */
const FRONT_Z = -8.4;
const tierFront = (i: number) => FRONT_Z - TIER_DEPTH * i;
const tierTop = (i: number) => TIER_RISE * (i + 1);

const SHIRTS = [
  [0.85, 0.15, 0.15], [0.15, 0.35, 0.85], [0.95, 0.8, 0.15], [0.15, 0.6, 0.3], [0.95, 0.95, 0.95],
  [0.55, 0.2, 0.65], [0.95, 0.5, 0.1], [0.1, 0.1, 0.12], [0.3, 0.75, 0.85],
];
const SKINS = [[0.95, 0.78, 0.66], [0.8, 0.58, 0.45], [0.55, 0.38, 0.28], [0.36, 0.24, 0.17]];
const HAIRS = [[0.1, 0.07, 0.04], [0.35, 0.2, 0.08], [0.8, 0.65, 0.3], [0.5, 0.5, 0.5]];
const PANTS = [[0.15, 0.17, 0.25], [0.25, 0.22, 0.2], [0.2, 0.3, 0.5]];
const SEATS = [[0.12, 0.3, 0.75], [0.8, 0.14, 0.12], [0.12, 0.3, 0.75], [0.95, 0.75, 0.12]];
const CONCRETE = [0.62, 0.62, 0.64];

interface Fan {
  x: number;
  y: number;
  z: number;
  phase: number;
  /** How keen this one is (scales bouncing and waving). */
  zeal: number;
  /** When (in `leave` 0-1) this one gets up and goes. */
  leaveAt: number;
  items: DrawItem[];
}

export type CrowdMood = 'idle' | 'cheer' | 'gasp' | 'stare';

/**
 * Bleachers along the north wall with fans on them. `rise` (0-1) lifts it all out of the floor,
 * `mood` sets what the fans do, `leave` (0-1) empties the stands (they sink away row by row).
 * `shout(text)` puts a line over a random fan for a moment (see `labels`).
 */
export class Crowd {
  rise = 0;
  mood: CrowdMood = 'idle';
  /** 0-1: how into it they are (bouncing, arm waving) while idle or cheering. */
  excitement = 0.3;
  leave = 0;
  readonly labels: WorldLabel[] = [];
  private fans: Fan[] = [];
  private stands: { item: DrawItem; y: number; h: number }[] = [];
  private time = 0;
  private shouts: { label: WorldLabel; fan: Fan; t: number }[] = [];

  constructor() {
    const width = CHAMBER_HALF * 2;
    for (let i = 0; i < TIERS; i++) {
      const z0 = -CHAMBER_HALF, z1 = tierFront(i), top = tierTop(i);
      this.stands.push({
        item: { mesh: 'box', model: new Float32Array(16), color: CONCRETE, spec: 0.1 },
        y: top / 2, h: top,
      });
      setBox(this.stands[this.stands.length - 1].item.model, [0, top / 2, (z0 + z1) / 2], [width, top, z1 - z0]);
      // A strip of plastic seats along the front of each tier.
      const seat: DrawItem = { mesh: 'box', model: new Float32Array(16), color: SEATS[i], spec: 0.5 };
      setBox(seat.model, [0, top + 0.12, z1 - 0.35], [width, 0.24, 0.4]);
      this.stands.push({ item: seat, y: top + 0.12, h: 0.24 });
    }
    // A railing along the front.
    const rail: DrawItem = { mesh: 'box', model: new Float32Array(16), color: [0.85, 0.85, 0.88], spec: 0.6 };
    setBox(rail.model, [0, 1.05, FRONT_Z + 0.05], [width, 0.06, 0.06]);
    this.stands.push({ item: rail, y: 1.05, h: 0.06 });
    for (let k = 0; k < 9; k++) {
      const post: DrawItem = { mesh: 'box', model: new Float32Array(16), color: [0.85, 0.85, 0.88], spec: 0.6 };
      const x = -11.5 + k * (23 / 8);
      setBox(post.model, [x, 0.8, FRONT_Z + 0.05], [0.06, 0.5, 0.06]);
      this.stands.push({ item: post, y: 0.8, h: 0.5 });
    }

    // The fans: a row per tier, a few empty seats.
    let seed = 7;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let i = 0; i < TIERS; i++) {
      for (let x = -11.2 + (i % 2) * 0.45; x < 11.3; x += 0.95) {
        if (rnd() < 0.12) continue;
        const shirt = SHIRTS[Math.floor(rnd() * SHIRTS.length)];
        const skin = SKINS[Math.floor(rnd() * SKINS.length)];
        const hair = HAIRS[Math.floor(rnd() * HAIRS.length)];
        const pants = PANTS[Math.floor(rnd() * PANTS.length)];
        const items: DrawItem[] = [
          { mesh: 'roundbox', model: new Float32Array(16), color: pants },
          { mesh: 'roundbox', model: new Float32Array(16), color: shirt },
          { mesh: 'sphere', model: new Float32Array(16), color: skin },
          { mesh: 'sphere', model: new Float32Array(16), color: hair, shadow: false },
          { mesh: 'roundbox', model: new Float32Array(16), color: shirt, shadow: false },
          { mesh: 'roundbox', model: new Float32Array(16), color: shirt, shadow: false },
        ];
        this.fans.push({
          x: x + (rnd() - 0.5) * 0.2, y: tierTop(i), z: tierFront(i) - 0.62, phase: rnd() * 10, zeal: 0.5 + rnd() * 0.8,
          leaveAt: 0.05 + (TIERS - 1 - i) * 0.12 + rnd() * 0.45, items,
        });
      }
    }
  }

  /** Static colliders for the bleachers (so nobody walks through them). */
  addColliders(physics: Physics) {
    for (let i = 0; i < TIERS; i++) {
      const z0 = -CHAMBER_HALF, z1 = tierFront(i), top = tierTop(i);
      physics.addStaticBox([0, top / 2, (z0 + z1) / 2], [CHAMBER_HALF * 2, top, z1 - z0]);
    }
  }

  /** A fan shouts `text` (shown over their head for `seconds`). */
  shout(text: string, seconds = 1.6) {
    const present = this.fans.filter((f) => this.leave < f.leaveAt);
    if (!present.length) return;
    const fan = present[Math.floor(Math.random() * present.length)];
    const label: WorldLabel = { pos: [fan.x, fan.y + 2.3, fan.z], text, size: 0.62, color: '#ffffff' };
    this.shouts.push({ label, fan, t: seconds });
  }

  update(dt: number) {
    this.time += dt;
    for (const s of this.shouts) s.t -= dt;
    this.shouts = this.shouts.filter((s) => s.t > 0);
    this.labels.length = 0;
    const lift = (1 - this.rise) * 3.2;
    for (const s of this.shouts) {
      s.label.pos[1] = s.fan.y + 2.3 - lift;
      this.labels.push(s.label);
    }
  }

  draw(out: DrawItem[]) {
    if (this.rise <= 0) return;
    const lift = (1 - this.rise) * 3.2;
    for (const s of this.stands) {
      s.item.model[13] = s.y - lift;
      out.push(s.item);
    }
    const t = this.time;
    for (const f of this.fans) {
      const gone = clamp((this.leave - f.leaveAt) / 0.15, 0, 1);
      if (gone >= 1) continue;
      const ph = t * (this.mood === 'cheer' ? 9 : 5) + f.phase;
      const k = this.excitement * f.zeal;
      let bounce = 0, armL = 0.15, armR = -0.15;
      if (this.mood === 'cheer') {
        bounce = Math.abs(Math.sin(ph)) * 0.22 * f.zeal;
        armL = 2.5 + Math.sin(ph * 1.3) * 0.4;
        armR = -2.5 + Math.sin(ph * 1.1 + 1) * 0.4;
      } else if (this.mood === 'gasp') {
        // Hands on heads.
        armL = 2.75;
        armR = -2.75;
      } else if (this.mood === 'idle') {
        bounce = Math.max(0, Math.sin(ph)) * 0.1 * k;
        const wave = k > 0.45 && Math.sin(ph * 0.37) > 0.3;
        armL = wave ? 2.3 + Math.sin(ph * 2) * 0.35 : 0.15;
      }
      const y = f.y + bounce - lift - gone * 1.9;
      const [pants, torso, head, hair, al, ar] = f.items;
      setBox(pants.model, [f.x, y + 0.42, f.z], [0.36, 0.8, 0.26]);
      setBox(torso.model, [f.x, y + 1.08, f.z], [0.46, 0.58, 0.3]);
      const lookUp = this.mood === 'stare' ? 0 : Math.sin(ph * 0.3) * 0.02;
      setBox(head.model, [f.x, y + 1.55 + lookUp, f.z + 0.01], [0.15, 0.17, 0.15]);
      setBox(hair.model, [f.x, y + 1.6 + lookUp, f.z - 0.02], [0.155, 0.14, 0.15]);
      // Arms swing out sideways from the shoulders (about z).
      const arm = (m: Mat4, sx: number, a: number) => {
        const L = 0.56;
        setBox(m, [f.x + sx + Math.sin(a) * L / 2, y + 1.3 - Math.cos(a) * L / 2, f.z], [0.12, L, 0.13], a);
      };
      arm(al.model, -0.27, -armL);
      arm(ar.model, 0.27, -armR);
      const opacity = 1 - gone;
      for (const it of f.items) {
        it.opacity = opacity;
        out.push(it);
      }
    }
  }
}

// --- Track --------------------------------------------------------------------------------------

export interface TrackOptions {
  /** Lane centres run along x at these z; lanes are `laneWidth` wide. */
  lanes: number;
  laneWidth: number;
  /** z of the middle of the first lane (the others follow toward +z). */
  firstLaneZ: number;
  /** x range the track covers. */
  from: number;
  to: number;
  startX: number;
  finishX: number;
}

const TARTAN = [0.42, 0.075, 0.045];
const GRASS = [0.17, 0.36, 0.12];
const LINE = [0.95, 0.95, 0.95];

/**
 * A running track (lanes along x) on a grass field, drawn a hair above the floor. `unroll` (0-1)
 * rolls it out from west to east.
 */
export class RunningTrack {
  unroll = 1;
  private items: { item: DrawItem; x0: number; x1: number; y: number; z: number; sy: number; sz: number }[] = [];

  constructor(readonly opts: TrackOptions) {
    const { lanes, laneWidth: w, firstLaneZ, from, to, startX, finishX } = opts;
    const zMin = firstLaneZ - w / 2, zMax = firstLaneZ + w * (lanes - 0.5);
    const strip = (x0: number, x1: number, y: number, z: number, sy: number, sz: number, color: number[], extra: Partial<DrawItem> = {}) =>
      this.items.push({ item: { mesh: 'box', model: new Float32Array(16), color, spec: 0.05, shadow: false, ...extra }, x0, x1, y, z, sy, sz });
    // Grass everywhere else (it covers the chamber floor).
    strip(-CHAMBER_HALF, CHAMBER_HALF, 0.004, 0, 0.008, CHAMBER_HALF * 2, GRASS);
    strip(from, to, 0.01, (zMin + zMax) / 2, 0.012, zMax - zMin + 0.3, TARTAN);
    for (let l = 0; l <= lanes; l++) strip(from, to, 0.018, zMin + l * w, 0.006, 0.06, LINE);
    strip(startX - 0.04, startX + 0.04, 0.02, (zMin + zMax) / 2, 0.006, zMax - zMin, LINE);
    // The finish: a thick line with a chequered strip behind it.
    strip(finishX - 0.06, finishX + 0.06, 0.02, (zMin + zMax) / 2, 0.006, zMax - zMin, LINE);
    for (let i = 0; i < Math.round((zMax - zMin) / 0.3); i++) {
      for (let j = 0; j < 2; j++) {
        const dark = (i + j) % 2 === 0;
        strip(finishX + 0.06 + j * 0.3, finishX + 0.36 + j * 0.3, 0.02, zMin + (i + 0.5) * 0.3, 0.006, 0.3, dark ? [0.08, 0.08, 0.09] : LINE);
      }
    }
    // Distance ticks every 5 m along both edges.
    for (let x = startX + 5; x < finishX - 1; x += 5) {
      for (const z of [zMin - 0.3, zMax + 0.3]) strip(x - 0.05, x + 0.05, 0.02, z, 0.006, 0.5, LINE);
    }
  }

  draw(out: DrawItem[]) {
    if (this.unroll <= 0) return;
    const { from, to } = this.opts;
    const edge = from - 0.5 + (to - from + 1) * this.unroll;
    for (const s of this.items) {
      const x1 = Math.min(s.x1, edge);
      if (x1 <= s.x0) continue;
      setBox(s.item.model, [(s.x0 + x1) / 2, s.y, s.z], [x1 - s.x0, s.sy, s.sz]);
      out.push(s.item);
    }
  }
}

// --- Confetti -----------------------------------------------------------------------------------

const CONFETTI_COLORS = [[1, 0.25, 0.3], [0.2, 0.6, 1], [1, 0.85, 0.2], [0.3, 0.9, 0.4], [0.9, 0.4, 1], [1, 1, 1]];

/** A burst of confetti: `burst(centre)` throws a cloud of paper that flutters down. */
export class Confetti {
  private bits: { p: Vec3; v: Vec3; a: number; spin: number; age: number; item: DrawItem }[] = [];

  constructor(count = 160) {
    for (let i = 0; i < count; i++) {
      this.bits.push({
        p: [0, -10, 0], v: [0, 0, 0], a: 0, spin: 0, age: 99,
        item: { mesh: 'box', model: new Float32Array(16), color: CONFETTI_COLORS[i % CONFETTI_COLORS.length], shadow: false, pattern: Pattern.emissive },
      });
    }
  }

  burst(centre: Vec3, spread = 2) {
    for (const b of this.bits) {
      b.p = [centre[0] + (Math.random() - 0.5) * spread, centre[1] + Math.random() * 0.5, centre[2] + (Math.random() - 0.5) * spread];
      const a = Math.random() * Math.PI * 2, s = 2 + Math.random() * 5;
      b.v = [Math.cos(a) * s, 3 + Math.random() * 6, Math.sin(a) * s];
      b.a = Math.random() * 6;
      b.spin = (Math.random() - 0.5) * 20;
      b.age = Math.random() * 0.3;
    }
  }

  update(dt: number) {
    for (const b of this.bits) {
      if (b.age > 8) continue;
      b.age += dt;
      // Heavy air: paper soon drifts at a gentle fall speed, swaying.
      const drag = Math.min(1, dt * 3);
      b.v[0] += (Math.sin(b.age * 3 + b.spin) * 0.8 - b.v[0]) * drag;
      b.v[2] += (Math.cos(b.age * 2.3 + b.spin) * 0.8 - b.v[2]) * drag;
      b.v[1] += (-1.2 - b.v[1]) * drag;
      if (b.p[1] <= 0.03) b.v = [0, 0, 0];
      b.p[0] += b.v[0] * dt;
      b.p[1] = Math.max(0.03, b.p[1] + b.v[1] * dt);
      b.p[2] += b.v[2] * dt;
      b.a += b.spin * dt * (b.p[1] > 0.03 ? 1 : 0);
    }
  }

  draw(out: DrawItem[]) {
    for (const b of this.bits) {
      if (b.age > 8) continue;
      setBox(b.item.model, b.p, [0.1, 0.012, 0.07], b.a);
      out.push(b.item);
    }
  }
}
