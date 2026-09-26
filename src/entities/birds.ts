import {
  add, basis, cross, dot, easeInOut, length, lerp3, mul, normalize, rotationX, rotationY, rotationZ, scale, scaling, segment, sub,
  translation, type Mat4, type Vec3,
} from '../engine/math';
import { Pattern, type DrawItem } from '../engine/renderer';

/*
 * Angry Birds, the cast: the birds (Red, the Blues, Chuck, Bomb and the enormous Terence), all
 * primitives with eyes and furious eyebrows; a giant wooden slingshot; a pig's snout, ears and
 * eyes to put on anyone's head; and a five-pointed star for score boards.
 */

export type BirdKind = 'red' | 'blue' | 'chuck' | 'bomb' | 'terence';

/** Collision radius of each bird (m); the models are built around it. */
export const BIRD_RADIUS: Record<BirdKind, number> = { red: 0.5, blue: 0.3, chuck: 0.5, bomb: 0.62, terence: 1.4 };
export const BIRD_MASS: Record<BirdKind, number> = { red: 14, blue: 4, chuck: 12, bomb: 18, terence: 420 };

const WHITE = [0.97, 0.97, 0.95];
const BLACK = [0.03, 0.03, 0.035];
const BEAK = [1.0, 0.7, 0.08];
const BEAK_LOW = [0.9, 0.5, 0.05];

interface Look {
  body: number[];
  belly: number[];
  brow: number[];
  /** Brow thickness and tilt (rad) relative to the radius. */
  browH: number;
  browTilt: number;
  eyeR: number;
  eyeY: number;
  beak: number;
  crest: number[] | null;
  tail: number[] | null;
}

const LOOKS: Record<BirdKind, Look> = {
  red: { body: [0.86, 0.08, 0.06], belly: [0.97, 0.87, 0.72], brow: BLACK, browH: 0.14, browTilt: 0.45, eyeR: 0.27, eyeY: 0.12, beak: 1, crest: [0.86, 0.08, 0.06], tail: BLACK },
  blue: { body: [0.33, 0.62, 0.96], belly: [0.82, 0.92, 1.0], brow: [0.1, 0.2, 0.45], browH: 0.1, browTilt: 0.3, eyeR: 0.29, eyeY: 0.14, beak: 0.9, crest: [0.2, 0.42, 0.85], tail: [0.18, 0.4, 0.8] },
  chuck: { body: [1.0, 0.84, 0.1], belly: [0.99, 0.95, 0.8], brow: BLACK, browH: 0.15, browTilt: 0.5, eyeR: 0.2, eyeY: -0.02, beak: 1.25, crest: null, tail: BLACK },
  bomb: { body: [0.13, 0.13, 0.15], belly: [0.42, 0.42, 0.45], brow: [0.02, 0.02, 0.02], browH: 0.16, browTilt: 0.45, eyeR: 0.25, eyeY: 0.1, beak: 0.85, crest: null, tail: null },
  terence: { body: [0.5, 0.05, 0.04], belly: [0.88, 0.76, 0.6], brow: [0.05, 0.02, 0.02], browH: 0.22, browTilt: 0.32, eyeR: 0.2, eyeY: 0.14, beak: 0.8, crest: [0.5, 0.05, 0.04], tail: [0.12, 0.03, 0.03] },
};

export interface BirdDrawOptions {
  /** Eyes shut (a blink). */
  blink?: boolean;
  /** Bomb's fuse, 0-1 once lit (the body flashes and swells faster and faster); -1 = not lit. */
  fuse?: number;
  /** Squash along local y (landing hops): 1 = none. */
  squash?: number;
}

/**
 * Draws a bird in frame `m` (origin at its centre, facing -z, up +y). Everything scales with the
 * bird's collision radius.
 */
export function drawBird(out: DrawItem[], kind: BirdKind, m: Mat4, opts: BirdDrawOptions = {}) {
  const r = BIRD_RADIUS[kind];
  const look = LOOKS[kind];
  const fuse = opts.fuse ?? -1;
  const sq = opts.squash ?? 1;
  let frame = sq !== 1 ? mul(m, scaling([1 / Math.sqrt(sq), sq, 1 / Math.sqrt(sq)])) : m;
  let body = look.body;
  if (fuse >= 0) {
    // Lit: swells, and flashes hot red faster and faster.
    const rate = 3 + fuse * 14;
    const on = Math.sin(fuse * rate * 6) > 0;
    const swell = 1 + 0.18 * fuse;
    frame = mul(frame, scaling([swell, swell, swell]));
    if (on) body = [0.9 + fuse, 0.15, 0.08];
  }
  const part = (mesh: DrawItem['mesh'], pos: Vec3, size: Vec3, color: number[], rot?: Mat4, extra: Partial<DrawItem> = {}) => {
    const t = translation([pos[0] * r, pos[1] * r, pos[2] * r]);
    const s = scaling([size[0] * r, size[1] * r, size[2] * r]);
    out.push({ mesh, model: rot ? mul(frame, t, rot, s) : mul(frame, t, s), color, ...extra });
  };
  const faceZ = kind === 'chuck' ? -0.5 : -0.8;
  // Body.
  if (kind === 'chuck') {
    // A triangle, more or less: a squat cone.
    part('cone', [0, -0.08, 0], [1.1, 1.95, 1.0], body, undefined, { spec: 0.25 });
    part('sphere', [0, -0.62, -0.42], [0.62, 0.4, 0.38], look.belly);
  } else {
    part('sphere', [0, 0, 0], [1, 1, 1], body, undefined, { spec: 0.3 });
    part('sphere', [0, -0.42, -0.55], [0.78, 0.55, 0.55], look.belly);
  }
  // Eyes (white, with pupils), unless blinking.
  const eyeX = kind === 'chuck' ? 0.2 : 0.27;
  for (const side of [-1, 1]) {
    const ex = eyeX * side;
    if (opts.blink) {
      part('box', [ex, look.eyeY, faceZ - 0.12], [look.eyeR * 1.6, 0.05, 0.1], BLACK);
    } else {
      part('sphere', [ex, look.eyeY, faceZ], [look.eyeR, look.eyeR * 1.1, look.eyeR], WHITE, undefined, { spec: 0.5 });
      part('sphere', [ex * 0.92, look.eyeY - 0.02, faceZ - look.eyeR * 0.85], [look.eyeR * 0.42, look.eyeR * 0.46, look.eyeR * 0.3], BLACK);
    }
    // Furious eyebrows: the inner ends pulled down.
    part('box', [ex * 1.02, look.eyeY + look.eyeR + 0.08, faceZ - 0.06], [0.52, look.browH, 0.2], look.brow, rotationZ(look.browTilt * side));
  }
  // Beak: an upper and a lower cone pointing forward.
  const bz = faceZ - 0.12, by = kind === 'chuck' ? -0.32 : -0.08;
  part('cone', [0, by, bz - 0.12 * look.beak], [0.28 * look.beak, 0.5 * look.beak, 0.18 * look.beak], BEAK, rotationX(-Math.PI / 2), { spec: 0.4 });
  part('cone', [0, by - 0.13 * look.beak, bz - 0.06 * look.beak], [0.22 * look.beak, 0.34 * look.beak, 0.12 * look.beak], BEAK_LOW, rotationX(-Math.PI / 2));
  // Crest feathers, tail feathers.
  if (look.crest) {
    part('cone', [0, 1.02, -0.1], [0.14, 0.42, 0.12], look.crest, rotationX(-0.5));
    part('cone', [0, 0.98, 0.12], [0.12, 0.34, 0.1], look.crest, rotationX(-0.1));
  }
  if (look.tail) {
    for (const a of [-0.35, 0, 0.35]) part('box', [a * 0.25, 0.1 + Math.abs(a) * 0.1, 0.98], [0.07, 0.07, 0.42], look.tail, mul(rotationY(a), rotationX(0.35)));
  }
  if (kind === 'chuck') {
    // A black tuft on top.
    for (const a of [-0.35, 0.1, 0.45]) part('box', [0, 0.95, a * 0.2], [0.05, 0.4, 0.05], BLACK, rotationX(a));
  }
  if (kind === 'bomb') {
    // The fuse, sparking once lit.
    part('cylinder', [0, 1.1, 0.05], [0.07, 0.4, 0.07], [0.3, 0.28, 0.25], rotationX(0.2));
    const spark = fuse >= 0 ? 0.13 + 0.06 * Math.random() : 0.07;
    part('sphere', [0, 1.33, 0.1], [spark, spark, spark], fuse >= 0 ? [4, 2.2, 0.4] : [0.5, 0.3, 0.2], undefined, fuse >= 0 ? { pattern: Pattern.emissive, shadow: false } : {});
  }
}

// --- The slingshot ------------------------------------------------------------------------------

const BARK = [0.5, 0.31, 0.15];
const BARK_DARK = [0.34, 0.2, 0.09];
const RUBBER = [0.3, 0.12, 0.07];
const LEATHER = [0.36, 0.2, 0.1];
/** Fork point and prong tips relative to the base (the slingshot faces +x). */
const FORK_Y = 13.5;
const TIP: Vec3 = [0.3, 21.4, 2.8];
const REST_POUCH: Vec3 = [0.9, 20.5, 0];
/** How far below its final height it waits before rising. */
const HIDDEN_DEPTH = 26;

/**
 * A giant Y-shaped wooden slingshot standing outside the chamber, facing +x. The level pulls the
 * pouch back along the launch direction (`pullTo`) and lets go (`release`); the pouch springs
 * back and wobbles. `rise` (0-1) brings it up out of the ground, `sag` (0-1) wilts it.
 */
export class Slingshot {
  rise = 0;
  sag = 0;
  pouch: Vec3;
  private pouchVel: Vec3 = [0, 0, 0];
  private target: Vec3 | null = null;
  /** The launch direction the pouch is pulled against (for its orientation). */
  private dir: Vec3 = [1, 0, 0];

  constructor(readonly base: Vec3) {
    this.pouch = add(base, REST_POUCH);
  }

  private offset(): Vec3 {
    return [this.base[0], this.base[1] - HIDDEN_DEPTH * (1 - easeInOut(Math.min(1, this.rise))), this.base[2]];
  }

  /** Where the pouch sits when nobody's pulling it. */
  restPouch(): Vec3 {
    return add(add(this.offset(), REST_POUCH), [this.sag * 1.2, -this.sag * 5.5, 0]);
  }

  tip(side: 1 | -1): Vec3 {
    const o = this.offset();
    return add(o, [TIP[0] + this.sag * 1.8, TIP[1] - this.sag * 5.2, (TIP[2] + this.sag * 1.6) * side]);
  }

  /** Pull the pouch back to `pos`, the bird to be launched along `dir`. */
  pullTo(pos: Vec3, dir: Vec3) {
    this.target = pos;
    this.dir = dir;
  }

  release() {
    this.target = null;
  }

  update(dt: number) {
    if (this.target) {
      // Pulled: follow the hand, heavily damped.
      this.pouch = lerp3(this.pouch, this.target, 1 - Math.exp(-dt * 6));
      this.pouchVel = [0, 0, 0];
      return;
    }
    // Let go: spring back past the rest spot and wobble to a stop.
    const rest = this.restPouch();
    const k = 160, c = 5;
    for (let i = 0; i < 3; i++) {
      const acc = sub(scale(sub(rest, this.pouch), k), scale(this.pouchVel, c));
      this.pouchVel = add(this.pouchVel, scale(acc, dt));
    }
    this.pouch = add(this.pouch, scale(this.pouchVel, dt));
    if (length(this.pouchVel) < 0.05 && length(sub(rest, this.pouch)) < 0.02) this.dir = lerp3(this.dir, [1, 0, 0], dt * 2);
  }

  draw(out: DrawItem[]) {
    if (this.rise <= 0) return;
    const o = this.offset();
    const fork = add(o, [0, FORK_Y, 0]);
    // Trunk, with a couple of knots.
    out.push({ mesh: 'cylinder', model: segment(add(o, [0, -2, 0]), fork, 0.95), color: BARK, spec: 0.05 });
    out.push({ mesh: 'sphere', model: mul(translation(fork), scaling([1.05, 1.2, 1.05])), color: BARK });
    out.push({ mesh: 'sphere', model: mul(translation(add(o, [0.7, 6.5, 0.3])), scaling([0.35, 0.5, 0.35])), color: BARK_DARK });
    for (const side of [-1, 1] as const) {
      const tip = this.tip(side);
      out.push({ mesh: 'cylinder', model: segment(fork, tip, 0.72), color: BARK, spec: 0.05 });
      out.push({ mesh: 'sphere', model: mul(translation(tip), scaling([0.76, 0.76, 0.76])), color: BARK });
      // Leather wrap just under the tip, where the band's tied on.
      const wrapA = lerp3(fork, tip, 0.8), wrapB = lerp3(fork, tip, 0.9);
      out.push({ mesh: 'cylinder', model: segment(wrapA, wrapB, 0.78), color: BARK_DARK, spec: 0.1 });
      // The band, thinner the more it's stretched.
      const anchor = lerp3(fork, tip, 0.86);
      const side3 = this.pouchSide(side);
      const len = length(sub(side3, anchor));
      const thick = 0.24 * Math.sqrt(Math.min(1, 3.2 / Math.max(len, 0.5)));
      out.push({ mesh: 'cylinder', model: segment(anchor, side3, thick), color: RUBBER, spec: 0.2 });
    }
    // The pouch: a curved leather strap cupped toward the launch direction.
    const d = normalize(this.dir);
    const up0: Vec3 = Math.abs(d[1]) > 0.95 ? [1, 0, 0] : [0, 1, 0];
    const across = normalize(cross(d, up0));
    const up = cross(across, d);
    out.push({ mesh: 'roundbox', model: basis(scale(d, 0.35), scale(up, 1.2), scale(across, 1.9), this.pouch), color: LEATHER, spec: 0.15 });
  }

  private pouchSide(side: 1 | -1): Vec3 {
    const d = normalize(this.dir);
    const up0: Vec3 = Math.abs(d[1]) > 0.95 ? [1, 0, 0] : [0, 1, 0];
    const across = normalize(cross(d, up0));
    // `across` points to +z for a launch toward +x, so the +z prong's band goes to the +z side.
    return add(this.pouch, scale(across, 0.9 * side));
  }
}

// --- The pig --------------------------------------------------------------------------------------

const PIG_SNOUT = [0.52, 0.86, 0.3];
const PIG_EAR = [0.4, 0.74, 0.2];
const NOSTRIL = [0.12, 0.3, 0.06];
/** The green a pig's skin is. */
export const PIG_GREEN = [0.44, 0.78, 0.22];

/**
 * A pig's snout, ears and eyes on a head frame (the player's `partFrames().head`: origin at the
 * head's centre, facing -z). `pop` (0-1+) scales them in, overshooting is fine.
 */
export function drawPigFace(out: DrawItem[], head: Mat4, pop: number) {
  if (pop <= 0.01) return;
  const p = pop;
  const push = (mesh: DrawItem['mesh'], pos: Vec3, size: Vec3, color: number[], rot?: Mat4) => {
    const t = translation(pos), s = scaling([size[0] * p, size[1] * p, size[2] * p]);
    out.push({ mesh, model: rot ? mul(head, t, rot, s) : mul(head, t, s), color, spec: 0.2 });
  };
  // Snout: a fat disc on the front of the face, with nostrils.
  push('cylinder', [0, -0.035, -0.205], [0.085, 0.07, 0.07], PIG_SNOUT, rotationX(Math.PI / 2));
  for (const side of [-1, 1]) {
    push('sphere', [0.03 * side, -0.035, -0.242], [0.017, 0.024, 0.01], NOSTRIL);
    // Ears, flopping outward.
    push('cone', [0.13 * side, 0.17, -0.01], [0.065, 0.12, 0.04], PIG_EAR, rotationZ(-0.55 * side));
    // Eyes.
    push('sphere', [0.085 * side, 0.06, -0.165], [0.05, 0.055, 0.04], WHITE);
    push('sphere', [0.08 * side, 0.058, -0.2], [0.022, 0.026, 0.012], BLACK);
  }
}

// --- Stars ------------------------------------------------------------------------------------------

/**
 * A flat five-pointed star facing along right × up (e.g. on a wall), from five wedge points and a
 * centre disc. Returns nothing; pushes 6 items.
 */
export function drawStar(out: DrawItem[], centre: Vec3, right: Vec3, up: Vec3, radius: number, color: number[], extra: Partial<DrawItem> = {}) {
  const normal = cross(right, up);
  const inner = radius * 0.4;
  const thick = 0.06;
  const dirAt = (a: number): Vec3 => add(scale(right, Math.cos(a)), scale(up, Math.sin(a)));
  const c45 = Math.SQRT1_2;
  for (let k = 0; k < 5; k++) {
    const a = Math.PI / 2 + (k * 2 * Math.PI) / 5;
    const tip = add(centre, scale(dirAt(a), radius));
    const left = add(centre, scale(dirAt(a + Math.PI / 5), inner));
    const rightV = add(centre, scale(dirAt(a - Math.PI / 5), inner));
    let u = scale(sub(left, tip), 1.12), v = scale(sub(rightV, tip), 1.12);
    // The wedge mesh spans angles 0..45° in its xz plane with its point at the origin: map its
    // 0° edge to u and its 45° edge to v (keeping the handedness so it isn't drawn inside out).
    let zCol = scale(sub(v, scale(u, c45)), 1 / c45);
    const yCol = scale(normal, thick);
    if (dot(cross(u, yCol), zCol) < 0) {
      [u, v] = [v, u];
      zCol = scale(sub(v, scale(u, c45)), 1 / c45);
    }
    out.push({ mesh: 'wedge', model: basis(u, yCol, zCol, tip), color, ...extra });
  }
  out.push({ mesh: 'cylinder', model: basis(scale(up, inner * 0.98), scale(normal, thick), scale(right, inner * 0.98), centre), color, ...extra });
}
