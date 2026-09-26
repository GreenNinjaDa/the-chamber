import { basis, mul, scaling, segment, translation, type Vec3 } from '../engine/math';
import type { RAPIER, Physics } from '../engine/physics';
import { Pattern, type DrawItem } from '../engine/renderer';
import type { Frames, PartName } from '../game/body';

/*
 * Lasers: thin glowing red beams that slice through anything, a test for whether a beam touches
 * the player's body, and the pylon that emits them.
 */

// --- Beams --------------------------------------------------------------------------------------

/** How thick a beam is for hit tests (m). It's drawn as a thinner white-hot core in a red glow. */
export const BEAM_RADIUS = 0.03;
const CORE_RADIUS = 0.02;
const GLOW_RADIUS = 0.085;
const GLOW_OPACITY = 0.35;
const CORE = [4, 0.12, 0.1];
const GLOW = [1.4, 0.03, 0.03];
const DOT = [5, 0.3, 0.25];
const DOT_GLOW = [1.6, 0.04, 0.03];

const scaled = (c: number[], k: number) => (k >= 1 ? c : [c[0] * k, c[1] * k, c[2] * k]);

/** A beam from `a` to `b`; `intensity` below 1 dims it (e.g. flickering on). */
export function drawBeam(out: DrawItem[], a: Vec3, b: Vec3, intensity = 1) {
  out.push({ mesh: 'cylinder', model: segment(a, b, CORE_RADIUS), color: scaled(CORE, intensity), pattern: Pattern.emissive, shadow: false });
  out.push({
    mesh: 'cylinder',
    model: segment(a, b, GLOW_RADIUS),
    color: scaled(GLOW, intensity),
    pattern: Pattern.emissive,
    shadow: false,
    opacity: GLOW_OPACITY * Math.min(1, intensity),
  });
}

/** The bright spot where a beam meets a wall (or the floor). */
export function drawBeamDot(out: DrawItem[], p: Vec3, intensity = 1, size = 1) {
  const r = 0.05 * size, g = 0.2 * size;
  out.push({ mesh: 'sphere', model: mul(translation(p), scaling([r, r, r])), color: scaled(DOT, intensity), pattern: Pattern.emissive, shadow: false });
  out.push({
    mesh: 'sphere',
    model: mul(translation(p), scaling([g, g, g])),
    color: scaled(DOT_GLOW, intensity),
    pattern: Pattern.emissive,
    shadow: false,
    opacity: 0.35 * Math.min(1, intensity),
  });
}

/**
 * The glow a beam casts on the floor under it, from `a` to `b` (on the floor): a brighter line
 * in a fainter band `width` wide. `brightness` scales it.
 */
export function drawFloorGlow(out: DrawItem[], a: Vec3, b: Vec3, width: number, brightness: number) {
  const dx = b[0] - a[0], dz = b[2] - a[2];
  const len = Math.hypot(dx, dz);
  if (len < 1e-3) return;
  const ux = dx / len, uz = dz / len;
  const cx = (a[0] + b[0]) / 2, cz = (a[2] + b[2]) / 2;
  const strip = (w: number, y: number, k: number, opacity: number) => out.push({
    mesh: 'box',
    model: basis([dx, 0, dz], [0, 0.002, 0], [-uz * w, 0, ux * w], [cx, y, cz]),
    color: [0.7 * k * brightness, 0.015 * k * brightness, 0.012 * k * brightness],
    pattern: Pattern.emissive,
    shadow: false,
    opacity,
  });
  strip(width * 0.3, 0.007, 1, 1);
  strip(width, 0.005, 0.45, 0.5);
}

// --- Hitting the player ------------------------------------------------------------------------

/*
 * The body parts as simple shapes in each part's own frame, a little smaller than they're drawn
 * (a beam has to really cut into you, not just brush your hair).
 */
const CAPSULES: [PartName, Vec3, Vec3, number][] = [
  ['head', [0, 0.01, 0.01], [0, 0.01, 0.01], 0.18],
  ['upperArmL', [0, 0.14, 0], [0, -0.14, 0], 0.06],
  ['upperArmR', [0, 0.14, 0], [0, -0.14, 0], 0.06],
  ['foreArmL', [0, 0.13, 0], [0, -0.2, 0], 0.055],
  ['foreArmR', [0, 0.13, 0], [0, -0.2, 0], 0.055],
  ['thighL', [0, 0.14, 0], [0, -0.14, 0], 0.085],
  ['thighR', [0, 0.14, 0], [0, -0.14, 0], 0.085],
  ['shinL', [0, 0.13, 0], [0, -0.19, -0.03], 0.07],
  ['shinR', [0, 0.13, 0], [0, -0.19, -0.03], 0.07],
];
/** Boxes: half extents, centred on the part. */
const BOXES: [PartName, Vec3][] = [
  ['pelvis', [0.16, 0.1, 0.11]],
  ['chest', [0.22, 0.22, 0.12]],
];
/** Every part lies within this distance (m) of the pelvis. */
const BODY_REACH = 1.45;

// Closest-point parameter on the first segment from the last segSegDist2 call.
let closestS = 0;

/** Squared distance between segments p1-q1 and p2-q2 (Ericson); sets `closestS` along the first. */
function segSegDist2(
  p1x: number, p1y: number, p1z: number, q1x: number, q1y: number, q1z: number,
  p2x: number, p2y: number, p2z: number, q2x: number, q2y: number, q2z: number,
): number {
  const d1x = q1x - p1x, d1y = q1y - p1y, d1z = q1z - p1z;
  const d2x = q2x - p2x, d2y = q2y - p2y, d2z = q2z - p2z;
  const rx = p1x - p2x, ry = p1y - p2y, rz = p1z - p2z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z;
  const e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;
  let s = 0, t = 0;
  const EPS = 1e-9;
  if (a <= EPS && e <= EPS) {
    s = t = 0;
  } else if (a <= EPS) {
    t = clamp01(f / e);
  } else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= EPS) {
      s = clamp01(-c / a);
    } else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z;
      const denom = a * e - b * b;
      s = denom > EPS ? clamp01((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp01(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clamp01((b - c) / a);
      }
    }
  }
  closestS = s;
  const dx = p1x + d1x * s - (p2x + d2x * t);
  const dy = p1y + d1y * s - (p2y + d2y * t);
  const dz = p1z + d1z * s - (p2z + d2z * t);
  return dx * dx + dy * dy + dz * dz;
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Tests beams (line segments) against the player's actual body parts. Call `load` with the part
 * frames once per tick, then `test` each beam; `hit` and `hitPart` say where the last hit was.
 */
export class BodySlicer {
  /** Where the last hit beam cut the body (world space), and which part it cut. */
  readonly hit: Vec3 = [0, 0, 0];
  hitPart: PartName = 'chest';
  // Capsules in world space: ax ay az bx by bz r.
  private caps = new Float64Array(CAPSULES.length * 7);
  private frames: Frames | null = null;
  private cx = 0;
  private cy = 0;
  private cz = 0;

  load(frames: Frames) {
    this.frames = frames;
    const p = frames.pelvis;
    this.cx = p[12];
    this.cy = p[13];
    this.cz = p[14];
    CAPSULES.forEach(([name, a, b, r], i) => {
      const m = frames[name];
      const o = i * 7;
      for (let k = 0; k < 3; k++) {
        this.caps[o + k] = m[12 + k] + m[k] * a[0] + m[4 + k] * a[1] + m[8 + k] * a[2];
        this.caps[o + 3 + k] = m[12 + k] + m[k] * b[0] + m[4 + k] * b[1] + m[8 + k] * b[2];
      }
      this.caps[o + 6] = r;
    });
  }

  /** Squared distance from the body's rough centre to a segment, to skip beams nowhere near. */
  private nearBody(ax: number, ay: number, az: number, bx: number, by: number, bz: number, radius: number) {
    const d2 = segSegDist2(ax, ay, az, bx, by, bz, this.cx, this.cy, this.cz, this.cx, this.cy, this.cz);
    const reach = BODY_REACH + radius;
    return d2 < reach * reach;
  }

  /** True if the beam from a to b (with `radius`) touches any body part; sets `hit` / `hitPart`. */
  test(ax: number, ay: number, az: number, bx: number, by: number, bz: number, radius = BEAM_RADIUS): boolean {
    const frames = this.frames;
    if (!frames || !this.nearBody(ax, ay, az, bx, by, bz, radius)) return false;
    const caps = this.caps;
    for (let i = 0; i < CAPSULES.length; i++) {
      const o = i * 7;
      const r = caps[o + 6] + radius;
      const d2 = segSegDist2(ax, ay, az, bx, by, bz, caps[o], caps[o + 1], caps[o + 2], caps[o + 3], caps[o + 4], caps[o + 5]);
      if (d2 < r * r) {
        this.setHit(ax, ay, az, bx, by, bz, closestS, CAPSULES[i][0]);
        return true;
      }
    }
    for (const [name, half] of BOXES) {
      const m = frames[name];
      // The beam in the box's frame (the frames are rigid: the transpose undoes the rotation).
      const px = ax - m[12], py = ay - m[13], pz = az - m[14];
      const qx = bx - m[12], qy = by - m[13], qz = bz - m[14];
      const l0x = px * m[0] + py * m[1] + pz * m[2], l0y = px * m[4] + py * m[5] + pz * m[6], l0z = px * m[8] + py * m[9] + pz * m[10];
      const l1x = qx * m[0] + qy * m[1] + qz * m[2], l1y = qx * m[4] + qy * m[5] + qz * m[6], l1z = qx * m[8] + qy * m[9] + qz * m[10];
      const s = slab(l0x, l0y, l0z, l1x, l1y, l1z, half[0] + radius, half[1] + radius, half[2] + radius);
      if (s >= 0) {
        this.setHit(ax, ay, az, bx, by, bz, s, name);
        return true;
      }
    }
    return false;
  }

  private setHit(ax: number, ay: number, az: number, bx: number, by: number, bz: number, s: number, part: PartName) {
    this.hit[0] = ax + (bx - ax) * s;
    this.hit[1] = ay + (by - ay) * s;
    this.hit[2] = az + (bz - az) * s;
    this.hitPart = part;
  }
}

/** Where (0-1 along it) a segment enters the box [-h, h], or -1 if it misses. */
function slab(ax: number, ay: number, az: number, bx: number, by: number, bz: number, hx: number, hy: number, hz: number): number {
  let t0 = 0, t1 = 1;
  const axis = (a: number, d: number, h: number) => {
    if (Math.abs(d) < 1e-9) return a >= -h && a <= h;
    let u = (-h - a) / d, v = (h - a) / d;
    if (u > v) { const w = u; u = v; v = w; }
    if (u > t0) t0 = u;
    if (v < t1) t1 = v;
    return t0 <= t1;
  };
  if (!axis(ax, bx - ax, hx) || !axis(ay, by - ay, hy) || !axis(az, bz - az, hz)) return -1;
  return t0;
}

// --- The pylon -----------------------------------------------------------------------------------

export const PYLON_RADIUS = 0.7;
export const PYLON_HEIGHT = 1.2;
/** The mast that rises out of the pylon's top to carry a second, higher emitter. */
export const MAST_RADIUS = 0.2;
const MAST_LENGTH = 0.9;
const METAL = [0.1, 0.1, 0.115];
const METAL_LIGHT = [0.2, 0.2, 0.22];
const RING_DIM = [0.25, 0.01, 0.01];

/**
 * A squat dark-metal emitter that rises out of a hatch in the floor, with a glowing red ring
 * around it at `ringHeight` (where its beam comes out). A mast can slide up out of its top with
 * a second ring at `mastRingHeight`. `rise` and `mast` (0-1) are set by the level.
 */
export class LaserPylon {
  /** 0 = sunk in the floor, 1 = fully up. */
  rise = 0;
  /** 0 = mast retracted, 1 = raised. */
  mast = 0;
  /** How brightly each ring glows (0-1). */
  ringGlow = 0;
  mastGlow = 0;
  private body: RAPIER.Collider;
  private mastBody: RAPIER.Collider;

  constructor(physics: Physics, readonly pos: Vec3, readonly ringHeight: number, readonly mastRingHeight: number) {
    this.body = physics.addStaticCylinder([pos[0], pos[1] - PYLON_HEIGHT, pos[2]], PYLON_RADIUS, PYLON_HEIGHT);
    this.mastBody = physics.addStaticCylinder([pos[0], pos[1] - PYLON_HEIGHT, pos[2]], MAST_RADIUS, MAST_LENGTH);
    this.sync();
  }

  /** Height of the pylon's top (the floor when sunk). */
  get top() {
    return this.pos[1] + PYLON_HEIGHT * this.rise;
  }

  /** Height of the mast's top (the pylon's top when retracted). */
  get mastTop() {
    return this.top + (this.mastRingHeight + 0.15 - PYLON_HEIGHT) * this.mast;
  }

  /** Where the pylon's own beam comes out, and the mast's. */
  get ringY() {
    return this.top - PYLON_HEIGHT + this.ringHeight;
  }

  get mastRingY() {
    return this.mastTop - 0.15;
  }

  /** Moves the colliders to match `rise` and `mast`. */
  sync() {
    const [x, y, z] = this.pos;
    this.body.setTranslation({ x, y: this.top - PYLON_HEIGHT / 2, z });
    this.mastBody.setTranslation({ x, y: this.mastTop - MAST_LENGTH / 2, z });
  }

  draw(out: DrawItem[], time: number) {
    const [x, y, z] = this.pos;
    // The hatch it comes out of: a dark disc in the floor.
    out.push({ mesh: 'cylinder', model: mul(translation([x, y + 0.002, z]), scaling([PYLON_RADIUS + 0.06, 0.004, PYLON_RADIUS + 0.06])), color: [0.05, 0.05, 0.055], shadow: false });
    if (this.rise <= 0.001) return;
    const base = this.top - PYLON_HEIGHT;
    const cyl = (y0: number, y1: number, r: number, color: number[], extra: Partial<DrawItem> = {}) =>
      out.push({ mesh: 'cylinder', model: mul(translation([x, (y0 + y1) / 2, z]), scaling([r, y1 - y0, r])), color, ...extra });
    // Body, with a couple of grooves and a chamfered cap.
    cyl(base, this.top - 0.05, PYLON_RADIUS, METAL, { spec: 0.35 });
    cyl(this.top - 0.05, this.top, PYLON_RADIUS - 0.05, METAL_LIGHT, { spec: 0.35 });
    for (const gy of [0.75, 0.95]) cyl(base + gy, base + gy + 0.025, PYLON_RADIUS + 0.008, [0.03, 0.03, 0.035]);
    // Base flange.
    cyl(base, base + 0.08, PYLON_RADIUS + 0.06, METAL_LIGHT, { spec: 0.5 });
    // The emitter ring.
    const pulse = 0.85 + 0.15 * Math.sin(time * 7);
    const ring = this.ringGlow > 0.01 ? [3 * this.ringGlow * pulse + RING_DIM[0], 0.08 * this.ringGlow, 0.06 * this.ringGlow] : RING_DIM;
    const ry = this.ringY;
    cyl(ry - 0.04, ry + 0.04, PYLON_RADIUS + 0.015, ring, { pattern: Pattern.emissive, shadow: false });
    // The mast (hidden inside the body while retracted).
    if (this.mast > 0.001) {
      const mt = this.mastTop;
      cyl(mt - MAST_LENGTH, mt - 0.04, MAST_RADIUS, METAL, { spec: 0.7 });
      cyl(mt - 0.04, mt, MAST_RADIUS - 0.03, METAL_LIGHT, { spec: 0.7 });
      const mring = this.mastGlow > 0.01 ? [3 * this.mastGlow * pulse + RING_DIM[0], 0.08 * this.mastGlow, 0.06 * this.mastGlow] : RING_DIM;
      const my = this.mastRingY;
      cyl(my - 0.035, my + 0.035, MAST_RADIUS + 0.015, mring, { pattern: Pattern.emissive, shadow: false });
    }
    // A lens on top.
    const lens = this.ringGlow > 0.01 ? [2 * this.ringGlow, 0.06 * this.ringGlow, 0.05 * this.ringGlow] : RING_DIM;
    out.push({ mesh: 'sphere', model: mul(translation([x, this.mastTop, z]), scaling([0.12, 0.05, 0.12])), color: lens, pattern: Pattern.emissive, shadow: false });
  }
}
