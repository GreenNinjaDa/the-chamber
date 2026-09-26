import { add, clamp, mul, rotateByQuat, rotationX, rotationY, rotationZ, scaling, segment, translation, type Mat4, type Quat, type Vec3 } from '../engine/math';
import { GRAVITY, RAPIER, type Body, type Physics } from '../engine/physics';
import type { DrawItem } from '../engine/renderer';
import { junk } from './junk';

/*
 * Swimming pools: `Water` makes loose objects float (buoyancy and drag worked out at a few sample
 * points on each one, so things bob, tip and right themselves, and heavy things sink), plus pool
 * toys that float (inflatable ring, noodle, air mattress, pallet, a couch with a proper seat) and
 * a chrome pool ladder.
 */

export interface WaterRect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

export interface FloatOptions {
  /**
   * Kilograms of buoyancy when it's all under (its volume times how floaty it is). More than its
   * mass and it floats, with that share of it under; less and it sinks.
   */
  capacity: number;
  /** Sample points in the body's frame, each carrying an equal share; default: the 8 octant centres of `size`. */
  points?: Vec3[];
  /** Box size, for the default points. */
  size?: Vec3;
  /** Half the height each point stands for (m); default a quarter of the box's height. */
  half?: number;
  /** Water drag (1/s when all under). */
  drag?: number;
  /** More colliders on the same rigid body (e.g. a couch's back), so `bodyFor` knows them. */
  colliders?: RAPIER.Collider[];
  /**
   * How hard it rights itself in the water (rad/s² at 90°): toward upright, or with `anyFace`
   * toward whichever face is nearest up (a crate). Real floating crates are top-heavy with
   * someone on them and capsize; a game wants a wobble.
   */
  righting?: number;
  anyFace?: boolean;
}

/**
 * Bobbing is damped to this share of critical (worked out from how springy each thing is in the
 * water), so light, very floaty things don't bounce about like corks on a trampoline.
 */
const BOB_DAMPING = 0.7;

interface Floater {
  body: Body;
  points: Vec3[];
  half: number;
  capacity: number;
  drag: number;
  /** Vertical drag (1/s): about critical damping for its bobbing. */
  bob: number;
  righting: number;
  anyFace: boolean;
  /** Share of it under water (0-1), after the last step. */
  submerged: number;
  above: boolean;
}

const FACE_AXES: Vec3[] = [[1, 0, 0], [0, 0, 1]];

/** The 8 octant centres of a box of this size (sample points for Water). */
export function boxPoints(size: Vec3): Vec3[] {
  const pts: Vec3[] = [];
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) pts.push([(x * size[0]) / 4, (y * size[1]) / 4, (z * size[2]) / 4]);
  return pts;
}

/**
 * A rectangle of water (x0..x1, z0..z1, surface at `level`) that floats whatever is added to it.
 * Forces are applied every physics step. `setLoad` presses down on a floater (someone standing
 * on it). Things that hit the water hard are queued in `splashes` for the level to show.
 */
export class Water {
  level: number;
  /** No water (and no floating) until it's switched on. */
  enabled = true;
  /** Gentle swell (m): the surface each thing floats on rises and falls this much. */
  swell = 0.025;
  time = 0;
  readonly splashes: { pos: Vec3; strength: number }[] = [];
  private floaters: Floater[] = [];
  private byCollider = new Map<number, Floater>();
  private loads = new Map<Body, { point: Vec3; kg: number }>();

  constructor(physics: Physics, readonly rect: WaterRect, level: number) {
    this.level = level;
    physics.substepHooks.push((h) => this.step(h));
  }

  add(body: Body, opts: FloatOptions) {
    const size = opts.size ?? body.size;
    const half = opts.half ?? size[1] / 4;
    // Bobbing: the water is a spring of stiffness capacity·g / height on its mass.
    const omega = Math.sqrt((opts.capacity * GRAVITY) / (Math.max(0.1, body.rb.mass()) * 4 * half));
    const f: Floater = {
      body,
      points: opts.points ?? boxPoints(size),
      half,
      capacity: opts.capacity,
      drag: opts.drag ?? 1.4,
      bob: Math.min(90, Math.max(6, 2 * BOB_DAMPING * omega)),
      righting: opts.righting ?? 0,
      anyFace: opts.anyFace ?? false,
      submerged: 0,
      above: true,
    };
    this.floaters.push(f);
    this.byCollider.set(body.collider.handle, f);
    for (const c of opts.colliders ?? []) this.byCollider.set(c.handle, f);
  }

  remove(body: Body) {
    const i = this.floaters.findIndex((f) => f.body === body);
    if (i < 0) return;
    this.floaters.splice(i, 1);
    for (const [k, f] of this.byCollider) if (f.body === body) this.byCollider.delete(k);
    this.loads.delete(body);
  }

  /** The floating body a collider belongs to, if any. */
  bodyFor(collider: RAPIER.Collider): Body | undefined {
    return this.byCollider.get(collider.handle)?.body;
  }

  contains(x: number, z: number, margin = 0) {
    const r = this.rect;
    return x > r.x0 - margin && x < r.x1 + margin && z > r.z0 - margin && z < r.z1 + margin;
  }

  /** The surface height things float on at (x, z). */
  surfaceAt(x: number, z: number) {
    return this.level + this.swell * (Math.sin(this.time * 1.6 + x * 0.7) * 0.6 + Math.sin(this.time * 1.1 - z * 0.9) * 0.4);
  }

  /** How much of a floating body is under water (0-1). */
  submerged(body: Body) {
    return this.byCollider.get(body.collider.handle)?.submerged ?? 0;
  }

  /**
   * Presses down on `body` with `kg` of weight (someone standing on it at `point`) until changed or
   * cleared (0). It pushes at the body's middle, shifted only `lever` of the way toward `point`,
   * so standing near an edge tips it a little rather than flipping it.
   */
  setLoad(body: Body, point: Vec3, kg: number, lever = 0.05) {
    if (kg <= 0) {
      this.loads.delete(body);
      return;
    }
    const c = body.rb.translation();
    this.loads.set(body, { point: [c.x + (point[0] - c.x) * lever, c.y, c.z + (point[2] - c.z) * lever], kg });
  }

  clearLoads() {
    this.loads.clear();
  }

  private step(h: number) {
    this.time += h;
    if (!this.enabled) return;
    for (const f of this.floaters) {
      const rb = f.body.rb;
      const t = rb.translation(), q = rb.rotation(), v = rb.linvel(), w = rb.angvel();
      const mass = rb.mass();
      const n = f.points.length;
      let under = 0;
      for (const p of f.points) {
        const r = rotateByQuat(q as Quat, p);
        const x = t.x + r[0], y = t.y + r[1], z = t.z + r[2];
        if (!this.contains(x, z)) continue;
        const k = clamp((this.surfaceAt(x, z) - y) / (2 * f.half) + 0.5, 0, 1);
        if (k <= 0) continue;
        under += k / n;
        // The point's velocity (the body's, plus its spin), dragged back by the water.
        const px = v.x + w.y * r[2] - w.z * r[1];
        const py = v.y + w.z * r[0] - w.x * r[2];
        const pz = v.z + w.x * r[1] - w.y * r[0];
        // (Even a thing barely in the water is held by it: bobbing dies down quickly.)
        const wet = (mass / n) * Math.min(1, k * 3) * h;
        const lift = (f.capacity / n) * GRAVITY * k * h;
        rb.applyImpulseAtPoint({ x: -px * wet * f.drag, y: lift - py * wet * f.bob, z: -pz * wet * f.drag }, { x, y, z }, true);
      }
      f.submerged = under;
      const wetness = Math.min(1, under * 4);
      rb.setAngularDamping(under > 0 ? Math.max(f.body.angularDamping, (f.righting > 0 ? 5 : 1.6) * wetness) : f.body.angularDamping);
      if (f.righting > 0 && under > 0) {
        // Turn the axis nearest up (or its own up) back toward up.
        let ax: Vec3 = rotateByQuat(q as Quat, [0, 1, 0]);
        if (f.anyFace) {
          for (const a of FACE_AXES) {
            const d = rotateByQuat(q as Quat, a);
            if (Math.abs(d[1]) > Math.abs(ax[1])) ax = d;
          }
          if (ax[1] < 0) ax = [-ax[0], -ax[1], -ax[2]];
        }
        const s = f.righting * wetness * h;
        const av = rb.angvel();
        rb.setAngvel({ x: av.x - ax[2] * s, y: av.y, z: av.z + ax[0] * s }, true);
      }
      const load = this.loads.get(f.body);
      if (load) rb.applyImpulseAtPoint({ x: 0, y: -load.kg * GRAVITY * h, z: 0 }, { x: load.point[0], y: load.point[1], z: load.point[2] }, true);
      // Hitting the water: a splash.
      const above = t.y > this.level || !this.contains(t.x, t.z);
      if (f.above && !above && v.y < -2) this.splashes.push({ pos: [t.x, this.level, t.z], strength: -v.y * mass });
      f.above = above;
    }
  }
}

// --- Pool toys -----------------------------------------------------------------------------------

export type PoolFloatKind = 'ring' | 'noodle' | 'lilo' | 'pallet';

const RING_RED = [0.92, 0.12, 0.1];
const RING_WHITE = [0.95, 0.95, 0.93];
const PALLET_WOOD = [0.72, 0.56, 0.36];
const PALLET_DARK = [0.56, 0.42, 0.26];

const ringModel = (out: DrawItem[], m: Mat4) => {
  const n = 14;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push({ mesh: 'sphere', model: mul(m, rotationY(-a), translation([0.4, 0, 0]), scaling([0.15, 0.12, 0.13])), color: Math.floor(i / 2) % 2 ? RING_WHITE : RING_RED, spec: 0.6 });
  }
  // The rope round the outside.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    out.push({ mesh: 'cylinder', model: mul(m, rotationY(-a), translation([0.54, 0.02, 0]), rotationX(Math.PI / 2), scaling([0.018, 0.34, 0.018])), color: [0.85, 0.82, 0.7] });
  }
};

const noodleModel = (color: number[]) => (out: DrawItem[], m: Mat4) => {
  out.push({ mesh: 'cylinder', model: mul(m, scaling([0.09, 1.56, 0.09])), color, spec: 0.25 });
  for (const y of [-0.78, 0.78]) {
    out.push({ mesh: 'sphere', model: mul(m, translation([0, y, 0]), scaling([0.09, 0.025, 0.09])), color, spec: 0.25 });
    out.push({ mesh: 'cylinder', model: mul(m, translation([0, y * 1.03, 0]), scaling([0.03, 0.01, 0.03])), color: [0.1, 0.1, 0.1] });
  }
};

const liloModel = (out: DrawItem[], m: Mat4) => {
  const pink = [0.98, 0.42, 0.62], white = [0.97, 0.95, 0.96];
  for (let i = 0; i < 6; i++) {
    const x = -0.33 + i * 0.132;
    out.push({ mesh: 'cylinder', model: mul(m, translation([x, -0.01, 0.12]), rotationX(Math.PI / 2), scaling([0.085, 1.66, 0.085])), color: i % 2 ? white : pink, spec: 0.7 });
    out.push({ mesh: 'sphere', model: mul(m, translation([x, -0.01, 0.95]), scaling([0.085, 0.085, 0.06])), color: i % 2 ? white : pink, spec: 0.7 });
  }
  // The pillow end.
  out.push({ mesh: 'cylinder', model: mul(m, translation([0, 0.01, -0.78]), rotationZ(Math.PI / 2), scaling([0.11, 0.8, 0.16])), color: pink, spec: 0.7 });
  out.push({ mesh: 'box', model: mul(m, translation([0, -0.06, 0.08]), scaling([0.78, 0.06, 1.8])), color: pink, spec: 0.5 });
};

const palletModel = (out: DrawItem[], m: Mat4) => {
  for (let k = 0; k < 5; k++) out.push({ mesh: 'box', model: mul(m, translation([-0.48 + k * 0.24, 0.055, 0]), scaling([0.18, 0.05, 1.2])), color: k % 2 ? PALLET_DARK : PALLET_WOOD });
  for (const z of [-0.5, 0, 0.5]) out.push({ mesh: 'box', model: mul(m, translation([0, -0.03, z]), scaling([1.2, 0.1, 0.12])), color: PALLET_DARK });
  for (let k = 0; k < 3; k++) out.push({ mesh: 'box', model: mul(m, translation([-0.45 + k * 0.45, -0.07, 0]), scaling([0.14, 0.02, 1.2])), color: PALLET_WOOD });
};

/** A pool toy (or a pallet), floating in `water`. Returns its body. */
export function spawnPoolFloat(physics: Physics, water: Water, kind: PoolFloatKind, pos: Vec3, yaw = 0, color?: number[]): Body {
  const rotation = { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
  switch (kind) {
    case 'ring': {
      const body = physics.addCylinder(pos, 0.56, 0.24, { mass: 0.8, rotation, model: ringModel, restitution: 0.4, friction: 0.5 });
      const points: Vec3[] = [];
      for (let i = 0; i < 6; i++) points.push([Math.cos((i / 6) * Math.PI * 2) * 0.4, 0, Math.sin((i / 6) * Math.PI * 2) * 0.4]);
      water.add(body, { capacity: 28, points, half: 0.12, drag: 1.2 });
      return body;
    }
    case 'noodle': {
      // Lying down: the cylinder's axis (its y) along the world's x, turned by `yaw`.
      const lie = { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
      const tip = { x: 0, y: 0, z: Math.sin(Math.PI / 4), w: Math.cos(Math.PI / 4) };
      const q = { w: lie.w * tip.w - lie.y * tip.y, x: lie.w * tip.x + lie.y * tip.z, y: lie.y * tip.w + lie.w * tip.y, z: lie.w * tip.z - lie.y * tip.x };
      const body = physics.addCylinder(pos, 0.09, 1.6, { mass: 0.3, rotation: q, model: noodleModel(color ?? [0.45, 0.95, 0.2]), friction: 0.6 });
      water.add(body, { capacity: 13, points: [[0, -0.6, 0], [0, -0.2, 0], [0, 0.2, 0], [0, 0.6, 0]], half: 0.09, drag: 1.2 });
      return body;
    }
    case 'lilo': {
      const size: Vec3 = [0.8, 0.2, 2.0];
      const body = physics.addBox(pos, size, { mass: 2.5, rotation, model: liloModel, friction: 0.8 });
      water.add(body, { capacity: 88, size, drag: 1.6, righting: 30 });
      return body;
    }
    case 'pallet': {
      const size: Vec3 = [1.2, 0.16, 1.2];
      const body = physics.addBox(pos, size, { mass: 12, rotation, model: palletModel, friction: 0.9 });
      water.add(body, { capacity: 112, size, drag: 1.8, righting: 40 });
      return body;
    }
  }
}

/**
 * The junk couch, built to float the right way up with a seat you can stand on (lower than its
 * back and arms, which are colliders of their own), in `water`.
 */
export function spawnFloatingCouch(physics: Physics, water: Water, pos: Vec3, yaw = 0): Body {
  const couch = junk('couch');
  const rotation = { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
  // The body's centre is the middle of the seat box; the couch model is centred 0.14 m higher.
  const body = physics.addBox(pos, [2.2, 0.52, 0.9], { mass: 50, rotation, model: (out, m) => couch.model(out, mul(m, translation([0, 0.14, 0]))), friction: 0.9 });
  const extra = [
    RAPIER.ColliderDesc.cuboid(1.1, 0.14, 0.11).setTranslation(0, 0.4, 0.33).setMass(8),
    RAPIER.ColliderDesc.cuboid(0.11, 0.06, 0.45).setTranslation(-0.99, 0.32, 0).setMass(1),
    RAPIER.ColliderDesc.cuboid(0.11, 0.06, 0.45).setTranslation(0.99, 0.32, 0).setMass(1),
  ].map((d) => physics.world.createCollider(d.setFriction(0.9), body.rb));
  const points: Vec3[] = boxPoints([2.2, 0.8, 0.9]).map((p) => add(p, [0, 0.14, 0]));
  water.add(body, { capacity: 330, points, half: 0.2, drag: 1.5, colliders: extra, righting: 45 });
  return body;
}

// --- The ladder ------------------------------------------------------------------------------------

const CHROME = [0.82, 0.84, 0.88];

/**
 * A chrome pool ladder in its own frame: the origin on the pool's edge at deck height, the pool
 * toward -z (the rails arch over the edge and run down the wall into the water), the deck toward +z.
 */
export function drawPoolLadder(out: DrawItem[], m: Mat4) {
  const rail: Vec3[] = [[0, 0, 0.5], [0, 0.72, 0.46], [0, 0.9, 0.3], [0, 0.94, 0.1], [0, 0.86, -0.1], [0, 0.6, -0.2], [0, -0.3, -0.22], [0, -2.7, -0.2]];
  for (const x of [-0.32, 0.32]) {
    for (let i = 1; i < rail.length; i++) {
      const a = add(rail[i - 1], [x, 0, 0]), b = add(rail[i], [x, 0, 0]);
      out.push({ mesh: 'cylinder', model: mul(m, segment(a, b, 0.035)), color: CHROME, spec: 1.2 });
      out.push({ mesh: 'sphere', model: mul(m, translation(b), scaling([0.035, 0.035, 0.035])), color: CHROME, spec: 1.2 });
    }
    out.push({ mesh: 'cylinder', model: mul(m, translation([x, 0.01, 0.5]), scaling([0.08, 0.02, 0.08])), color: CHROME, spec: 1.2 });
  }
  for (const y of [-0.55, -1.1, -1.65, -2.2]) {
    out.push({ mesh: 'box', model: mul(m, translation([0, y, -0.21]), scaling([0.64, 0.05, 0.17])), color: [0.9, 0.92, 0.94], spec: 0.8 });
  }
}
