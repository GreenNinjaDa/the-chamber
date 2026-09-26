import { noise, note, tone } from '../engine/audio';
import { basis, clamp, cross, mul, quatMul, rotationX, rotationY, scaling, translation, type Mat4, type Quat, type Vec3 } from '../engine/math';
import { RAPIER, type Body, type Physics } from '../engine/physics';
import { Pattern, type DrawItem } from '../engine/renderer';
import { PixelText } from './pixelText';

/*
 * Pinball parts, sized for a person-sized ball: a tilted table frame to build on, flippers (kinematic,
 * swinging about the table's normal), pop bumpers, slingshots, drop targets with a letter on them,
 * steel balls, the plunger, playfield art (stars, chevrons, lamp inserts) and a dot-matrix display.
 * Everything sits on a `TableFrame`: a flat surface rising toward -z.
 */

// --- The table ----------------------------------------------------------------------------------------

/** A tilted table: a plane rising toward -z at `slope` radians, at height `baseY` where z = `baseZ`. */
export class TableFrame {
  readonly tan: number;
  readonly sin: number;
  readonly cos: number;
  /** The surface normal, and the unit direction up the slope (toward -z) along the surface. */
  readonly normal: Vec3;
  readonly upSlope: Vec3;

  constructor(readonly slope: number, readonly baseY: number, readonly baseZ: number) {
    this.tan = Math.tan(slope);
    this.sin = Math.sin(slope);
    this.cos = Math.cos(slope);
    this.normal = [0, this.cos, this.sin];
    this.upSlope = [0, this.sin, -this.cos];
  }

  /** Surface height at world z. */
  y(z: number) {
    return this.baseY + (this.baseZ - z) * this.tan;
  }

  /** The world point `lift` above the surface at (x, z), measured along the surface normal. */
  point(x: number, z: number, lift = 0): Vec3 {
    return [x, this.y(z) + lift * this.cos, z + lift * this.sin];
  }

  /** A frame on the surface at (x, z): y along the normal, z down the slope, turned `yaw` about the normal. */
  frame(x: number, z: number, yaw = 0, lift = 0): Mat4 {
    return mul(translation(this.point(x, z, lift)), rotationX(this.slope), rotationY(yaw));
  }

  /** The frame's rotation as a quaternion (for colliders). */
  quat(yaw = 0): Quat {
    const qx = { x: Math.sin(this.slope / 2), y: 0, z: 0, w: Math.cos(this.slope / 2) };
    const qy = { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
    return quatMul(qx, qy);
  }

  /** A direction along the surface, given as (across x, down the slope z), in world space. */
  dir(dx: number, dz: number): Vec3 {
    return [dx, -dz * this.sin, dz * this.cos];
  }

  /** A static box on the table: `size` in the table's frame, its bottom `lift` above the surface. */
  addBox(physics: Physics, x: number, z: number, size: Vec3, yaw = 0, lift = 0): RAPIER.Collider {
    return physics.addStaticBox(this.point(x, z, lift + size[1] / 2), size, this.quat(yaw));
  }
}

/**
 * Maps the renderer's 'wedge' mesh (a 45° slice of a unit cylinder) onto a triangle p0 p1 p2 in a
 * frame's xz plane, y from y0 to y1. The p1-p2 edge bulges out very slightly (it's the arc).
 */
export function triangleModel(frame: Mat4, p0: [number, number], p1: [number, number], p2: [number, number], y0: number, y1: number): Mat4 {
  let a = p1, b = p2;
  // Keep the winding the mesh was built with, or its faces get culled inside out.
  if ((a[0] - p0[0]) * (b[1] - p0[1]) - (a[1] - p0[1]) * (b[0] - p0[0]) < 0) [a, b] = [b, a];
  const u: [number, number] = [a[0] - p0[0], a[1] - p0[1]];
  const v: [number, number] = [b[0] - p0[0], b[1] - p0[1]];
  const w: [number, number] = [v[0] * Math.SQRT2 - u[0], v[1] * Math.SQRT2 - u[1]];
  return mul(frame, basis([u[0], 0, u[1]], [0, y1 - y0, 0], [w[0], 0, w[1]], [p0[0], (y0 + y1) / 2, p0[1]]));
}

// --- Colours ---------------------------------------------------------------------------------------------

export const CHROME = [0.62, 0.64, 0.68];
const FLIPPER_WHITE = [0.93, 0.91, 0.86];
const RUBBER_RED = [0.75, 0.08, 0.06];
const RUBBER_WHITE = [0.92, 0.92, 0.9];
const BLACK = [0.03, 0.03, 0.04];

// --- Flippers ----------------------------------------------------------------------------------------------

/** Seconds for a full swing up, and back down. */
const FLIP_UP_TIME = 0.13;
const FLIP_DOWN_TIME = 0.24;

/**
 * A flipper: a tapered bar pivoting about the table's normal at (x, z). It points along `restYaw` at
 * rest and swings to `upYaw` while `holding` (yaw about the normal; 0 points along +x, and positive
 * turns toward -z). A kinematic body, so it bats steel balls for real.
 */
export class Flipper {
  /** 0 at rest, 1 all the way up. */
  u = 0;
  /** Set to swing up (and stay up); clear to drop back. */
  holding = false;
  /** Signed change in u per second over the last substep (> 0 swinging up). */
  rate = 0;
  readonly rb: RAPIER.RigidBody;
  readonly pivot: Vec3;
  /** 1 if the flipper turns toward +yaw going up, else -1. */
  private readonly sense: number;

  constructor(
    physics: Physics,
    private table: TableFrame,
    readonly x: number,
    readonly z: number,
    private restYaw: number,
    private upYaw: number,
    readonly length = 3.8,
    readonly r0 = 0.55,
    readonly r1 = 0.28,
    readonly height = 0.8,
  ) {
    this.pivot = table.point(x, z);
    this.sense = Math.sign(upYaw - restYaw);
    this.rb = physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(this.pivot[0], this.pivot[1], this.pivot[2])
        .setRotation(table.quat(restYaw)),
    );
    // The collider: the convex hull of the pivot and tip discs, top and bottom.
    const pts: number[] = [];
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      for (const y of [-0.05, height]) {
        pts.push(Math.cos(a) * r0, y, Math.sin(a) * r0);
        pts.push(length + Math.cos(a) * r1, y, Math.sin(a) * r1);
      }
    }
    const desc = RAPIER.ColliderDesc.convexHull(new Float32Array(pts));
    if (desc) physics.world.createCollider(desc.setFriction(0.4).setRestitution(0.3), this.rb);
  }

  get yaw() {
    return this.restYaw + (this.upYaw - this.restYaw) * this.u;
  }

  /** Advances the swing by one physics substep and moves the body. */
  step(h: number) {
    const before = this.u;
    this.u = this.holding ? Math.min(1, this.u + h / FLIP_UP_TIME) : Math.max(0, this.u - h / FLIP_DOWN_TIME);
    this.rate = (this.u - before) / h;
    this.rb.setNextKinematicRotation(this.table.quat(this.yaw));
  }

  /** Unit direction from pivot to tip along the surface, as table (x, z). */
  along(): [number, number] {
    const y = this.yaw;
    return [Math.cos(y), -Math.sin(y)];
  }

  /** Unit direction (table x, z) the face moves in while swinging up. */
  sweep(): [number, number] {
    const y = this.yaw;
    return [-Math.sin(y) * this.sense, -Math.cos(y) * this.sense];
  }

  /** Radius of the bar `s` metres out from the pivot. */
  radiusAt(s: number) {
    return this.r0 + (this.r1 - this.r0) * clamp(s / this.length, 0, 1);
  }

  /**
   * Where a point (world x, z) is relative to the flipper: `s` along it from the pivot, and `e` its
   * distance out from the bar's surface on the side it swings toward (negative: behind it).
   */
  relative(x: number, z: number): { s: number; e: number } {
    const dx = x - this.x, dz = (z - this.z) / this.table.cos;
    const [ax, az] = this.along();
    const [sx, sz] = this.sweep();
    const s = dx * ax + dz * az;
    return { s, e: dx * sx + dz * sz - this.radiusAt(s) };
  }

  draw(out: DrawItem[], lit: number) {
    const f = this.table.frame(this.x, this.z, this.yaw);
    const { length: L, r0, r1, height: h } = this;
    const body = (y0: number, y1: number, grow: number, color: number[], spec: number) => {
      const a = r0 + grow, b = r1 + grow, hy = y1 - y0, cy = (y0 + y1) / 2;
      out.push({ mesh: 'cylinder', model: mul(f, translation([0, cy, 0]), scaling([a, hy, a])), color, spec });
      out.push({ mesh: 'cylinder', model: mul(f, translation([L, cy, 0]), scaling([b, hy, b])), color, spec });
      // The tapered middle: a strip as wide as the tip, and a parallelogram along each tapered side
      // (its edges run along the side from the pivot's disc to the tip's; z is flipped as needed to
      // keep the box right-handed, which a box doesn't otherwise mind).
      out.push({ mesh: 'box', model: mul(f, translation([L / 2, cy, 0]), scaling([L, hy, (a - b) * 2 + 0.001])), color, spec });
      for (const side of [1, -1]) {
        out.push({ mesh: 'box', model: mul(f, basis([L, 0, (b - a) * side], [0, hy, 0], [0, 0, b], [L / 2, cy, (a / 2) * side])), color, spec });
      }
    };
    body(0, h, 0, FLIPPER_WHITE, 0.5);
    body(h * 0.3, h * 0.62, 0.05, RUBBER_RED, 0.3);
    // A lit pivot cap.
    const glow = 0.3 + 1.7 * lit;
    out.push({ mesh: 'cylinder', model: mul(f, translation([0, h + 0.02, 0]), scaling([r0 * 0.55, 0.05, r0 * 0.55])), color: [glow, glow * 0.85, glow * 0.3], pattern: Pattern.emissive, shadow: false });
  }
}

// --- Pop bumpers ---------------------------------------------------------------------------------------------

/** A pop bumper: a mushroom on a post with a lit cap. Touch it and it kicks you away (the level does the kicking). */
export class PopBumper {
  /** Seconds left of the flash after a kick. */
  flash = 0;
  readonly centre: Vec3;
  readonly collider: RAPIER.Collider;
  private capColor = [0, 0, 0];
  private static readonly HEIGHT = 1.35;

  constructor(physics: Physics, private table: TableFrame, readonly x: number, readonly z: number, readonly radius: number, readonly color: number[]) {
    this.centre = table.point(x, z);
    this.collider = physics.world.createCollider(
      RAPIER.ColliderDesc.cylinder(PopBumper.HEIGHT / 2, radius)
        .setTranslation(...table.point(x, z, PopBumper.HEIGHT / 2))
        .setRotation(table.quat())
        .setRestitution(0.6),
    );
  }

  kick() {
    this.flash = 0.16;
  }

  update(dt: number) {
    this.flash = Math.max(0, this.flash - dt);
  }

  draw(out: DrawItem[], time: number, lit: number) {
    const f = this.table.frame(this.x, this.z);
    const R = this.radius;
    const cyl = (y: number, h: number, r: number, color: number[], extra: Partial<DrawItem> = {}) =>
      out.push({ mesh: 'cylinder', model: mul(f, translation([0, y + h / 2, 0]), scaling([r, h, r])), color, ...extra });
    cyl(0, 0.14, R * 1.06, BLACK, { spec: 0.3 });
    cyl(0.1, 1.0, R * 0.74, [0.9, 0.88, 0.82], { spec: 0.4 });
    // The ring that slams down when it fires.
    const ringY = this.flash > 0 ? 0.18 : 0.5;
    out.push({ mesh: 'tube', model: mul(f, translation([0, ringY, 0]), scaling([R, 0.1, R])), color: CHROME, spec: 1.6 });
    // The cap: lit plastic, flashing white when it fires.
    const pulse = 0.75 + 0.25 * Math.sin(time * 5 + this.x);
    const k = this.flash > 0 ? 3 : (0.12 + 0.9 * pulse) * lit + 0.05;
    for (let i = 0; i < 3; i++) this.capColor[i] = this.flash > 0 ? [2.6, 2.4, 1.8][i] : this.color[i] * k;
    cyl(1.08, 0.24, R * 1.12, this.capColor, { pattern: Pattern.emissive });
    out.push({ mesh: 'sphere', model: mul(f, translation([0, 1.32, 0]), scaling([R * 0.72, 0.16, R * 0.72])), color: [0.95, 0.95, 0.92], spec: 0.8 });
    drawStar(out, mul(f, translation([0, 1.47, 0])), R * 0.45, [0.95, 0.2, 0.25], 0.02);
  }
}

// --- Slingshots --------------------------------------------------------------------------------------------

/**
 * A slingshot kicker: a triangular post whose rubber face (from `top` to `inner`) kicks whatever
 * touches it away along the face's normal. Points are world (x, z) on the table.
 */
export class Slingshot {
  flash = 0;
  /** Unit normal of the kicking face (table x, z), pointing away from the triangle. */
  readonly normal: [number, number];
  private litColor = [0, 0, 0];
  private static readonly HEIGHT = 1.0;

  constructor(physics: Physics, private table: TableFrame, readonly top: [number, number], readonly outer: [number, number], readonly inner: [number, number], private color: number[]) {
    const pts: number[] = [];
    for (const p of [top, outer, inner]) {
      for (const lift of [-0.05, Slingshot.HEIGHT]) pts.push(...table.point(p[0], p[1], lift));
    }
    const desc = RAPIER.ColliderDesc.convexHull(new Float32Array(pts));
    if (desc) physics.world.createCollider(desc.setRestitution(0.5));
    const dx = inner[0] - top[0], dz = inner[1] - top[1];
    const len = Math.hypot(dx, dz);
    let n: [number, number] = [dz / len, -dx / len];
    // Away from the outer corner.
    if ((outer[0] - top[0]) * n[0] + (outer[1] - top[1]) * n[1] > 0) n = [-n[0], -n[1]];
    this.normal = n;
  }

  kick() {
    this.flash = 0.14;
  }

  update(dt: number) {
    this.flash = Math.max(0, this.flash - dt);
  }

  /** Distance from (x, z) to the rubber face, and whether it's in front of it. */
  faceDistance(x: number, z: number): number {
    const [ax, az] = this.top, [bx, bz] = this.inner;
    const dx = bx - ax, dz = bz - az;
    const t = clamp(((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz), 0, 1);
    const px = ax + dx * t, pz = az + dz * t;
    const side = (x - px) * this.normal[0] + (z - pz) * this.normal[1];
    return side < -0.3 ? Infinity : Math.hypot(x - px, z - pz);
  }

  draw(out: DrawItem[], lit: number) {
    const t = this.table;
    const f = t.frame(0, 0);
    // The frame's origin is on the surface at z = 0; the triangle is in world (x, z), so shift by
    // the slope: a point's table-local z is its world z / cos (close enough: use world z).
    const loc = (p: [number, number]): [number, number] => [p[0], p[1] / t.cos];
    const h = Slingshot.HEIGHT;
    out.push({ mesh: 'wedge', model: triangleModel(f, loc(this.outer), loc(this.top), loc(this.inner), -0.02, h * 0.8), color: [0.9, 0.88, 0.84], spec: 0.3 });
    // A coloured plastic cover on top, lit.
    const k = this.flash > 0 ? 2.6 : 0.1 + 0.8 * lit;
    for (let i = 0; i < 3; i++) this.litColor[i] = this.flash > 0 ? 2.4 : this.color[i] * k;
    out.push({ mesh: 'wedge', model: triangleModel(f, loc(this.outer), loc(this.top), loc(this.inner), h * 0.8, h), color: this.litColor, pattern: Pattern.emissive });
    // The rubber band along the kicking face, bowing in when it fires.
    const [ax, az] = this.top, [bx, bz] = this.inner;
    const bow = this.flash > 0 ? 0.28 : 0.1;
    const mx = (ax + bx) / 2 + this.normal[0] * bow, mz = (az + bz) / 2 + this.normal[1] * bow;
    const lift = h * 0.45;
    const rubber = (p: [number, number], q: [number, number]) =>
      out.push({ mesh: 'cylinder', model: segmentOn(t, p, q, lift, 0.13), color: RUBBER_WHITE, spec: 0.2 });
    rubber([ax, az], [mx, mz]);
    rubber([mx, mz], [bx, bz]);
    for (const p of [this.top, this.inner, this.outer]) {
      out.push({ mesh: 'cylinder', model: mul(t.frame(p[0], p[1]), translation([0, h / 2, 0]), scaling([0.2, h + 0.1, 0.2])), color: CHROME, spec: 1.4 });
    }
  }
}

/** A cylinder along the table surface from (x, z) `a` to `b`, `lift` above it. */
export function segmentOn(t: TableFrame, a: [number, number], b: [number, number], lift: number, radius: number): Mat4 {
  const p = t.point(a[0], a[1], lift), q = t.point(b[0], b[1], lift);
  const d: Vec3 = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
  const len = Math.hypot(d[0], d[1], d[2]);
  const y: Vec3 = [d[0] / len, d[1] / len, d[2] / len];
  const x = cross(y, t.normal);
  const xl = Math.hypot(x[0], x[1], x[2]);
  const xn: Vec3 = [x[0] / xl * radius, x[1] / xl * radius, x[2] / xl * radius];
  const z = cross(xn, y);
  return basis(xn, d, z, [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2]);
}

// --- Drop targets ------------------------------------------------------------------------------------------

const TARGET_W = 1.8;
const TARGET_H = 1.3;
const TARGET_D = 0.4;
const TARGET_SINK_TIME = 0.15;

/**
 * A drop target: a plastic slab standing on the table with a letter on its face (facing `yaw`, where
 * 0 faces +z, down the table). Once hit it drops flush into the table with a clack.
 */
export class DropTarget {
  down = false;
  /** 0 standing, 1 all the way down. */
  sink = 0;
  readonly collider: RAPIER.Collider;
  private letterText: PixelText;

  constructor(physics: Physics, private table: TableFrame, readonly x: number, readonly z: number, readonly yaw: number, readonly letter: string, private color: number[]) {
    this.collider = table.addBox(physics, x, z, [TARGET_W, TARGET_H, TARGET_D], yaw);
    const face = table.frame(x, z, yaw);
    const right: Vec3 = [face[0], face[1], face[2]];
    const up: Vec3 = [face[4], face[5], face[6]];
    const out: Vec3 = [face[8], face[9], face[10]];
    const c: Vec3 = [face[12] + up[0] * TARGET_H * 0.52 + out[0] * TARGET_D / 2, face[13] + up[1] * TARGET_H * 0.52 + out[1] * TARGET_D / 2, face[14] + up[2] * TARGET_H * 0.52 + out[2] * TARGET_D / 2];
    this.letterText = new PixelText({ centre: c, right, up, pixel: 0.13, color: [0.08, 0.02, 0.1], depth: 0.04 }, letter);
  }

  /** Whether a sphere at `p` (world) of radius `r` touches the target. */
  touches(p: Vec3, r: number): boolean {
    if (this.down) return false;
    const f = this.table.frame(this.x, this.z, this.yaw);
    const dx = p[0] - f[12], dy = p[1] - f[13], dz = p[2] - f[14];
    const lx = dx * f[0] + dy * f[1] + dz * f[2];
    const ly = dx * f[4] + dy * f[5] + dz * f[6];
    const lz = dx * f[8] + dy * f[9] + dz * f[10];
    const qx = Math.max(0, Math.abs(lx) - TARGET_W / 2), qz = Math.max(0, Math.abs(lz) - TARGET_D / 2);
    const qy = ly < 0 ? -ly : Math.max(0, ly - TARGET_H);
    return Math.hypot(qx, qy, qz) < r;
  }

  drop() {
    this.down = true;
  }

  update(dt: number) {
    if (!this.down || this.sink >= 1) return;
    this.sink = Math.min(1, this.sink + dt / TARGET_SINK_TIME);
    this.collider.setTranslation(vec3obj(this.table.point(this.x, this.z, TARGET_H / 2 - this.sink * (TARGET_H + 0.05))));
  }

  draw(out: DrawItem[]) {
    if (this.sink >= 1) return;
    const f = this.table.frame(this.x, this.z, this.yaw, -this.sink * (TARGET_H + 0.05));
    out.push({ mesh: 'box', model: mul(f, translation([0, TARGET_H / 2, 0]), scaling([TARGET_W, TARGET_H, TARGET_D])), color: this.color, spec: 0.7 });
    // A darker frame round the edge of the face.
    out.push({ mesh: 'box', model: mul(f, translation([0, TARGET_H - 0.05, 0]), scaling([TARGET_W + 0.04, 0.1, TARGET_D + 0.04])), color: [0.1, 0.1, 0.12], spec: 0.5 });
    if (this.sink === 0) this.letterText.draw(out);
  }
}

const vec3obj = (v: Vec3) => ({ x: v[0], y: v[1], z: v[2] });

// --- Steel balls --------------------------------------------------------------------------------------------

export const STEEL_BALL_RADIUS = 0.65;
export const STEEL_BALL_MASS = 110;

/** A big chrome ball: a physics sphere with a fixed glint on top so it reads as polished steel. */
export function spawnSteelBall(physics: Physics, pos: Vec3): Body {
  const r = STEEL_BALL_RADIUS;
  const body = physics.addBall(pos, r, {
    mass: STEEL_BALL_MASS,
    grabbable: false,
    friction: 0.3,
    restitution: 0.35,
    color: CHROME,
    model: (out, m) => drawSteelBall(out, [m[12], m[13], m[14]], r),
  });
  // Pinball tables are fast: much less rolling resistance than the default.
  body.angularDamping = 0.15;
  body.rb.setAngularDamping(0.15);
  return body;
}

export function drawSteelBall(out: DrawItem[], p: Vec3, r: number) {
  out.push({ mesh: 'sphere', model: mul(translation(p), scaling([r, r, r])), color: CHROME, spec: 2.4 });
  // Reflections of the lamps overhead: a bright glint on top, a smaller one off to the side.
  out.push({ mesh: 'sphere', model: mul(translation([p[0] - r * 0.2, p[1] + r * 0.9, p[2] + r * 0.28]), scaling([r * 0.28, r * 0.1, r * 0.2])), color: [1.8, 1.8, 1.9], pattern: Pattern.emissive, shadow: false });
  out.push({ mesh: 'sphere', model: mul(translation([p[0] + r * 0.55, p[1] + r * 0.62, p[2] + r * 0.5]), scaling([r * 0.1, r * 0.08, r * 0.1])), color: [1.4, 1.3, 1.1], pattern: Pattern.emissive, shadow: false });
}

// --- The plunger ------------------------------------------------------------------------------------------------

/**
 * The plunger at the bottom of a shooter lane, drawn in `frame` (origin on the lane floor at the
 * tip's resting spot, +z toward the housing). `pull` (0-1) draws it back.
 */
export function drawPlunger(out: DrawItem[], frame: Mat4, pull: number, housingZ: number) {
  const back = pull * 0.9;
  const tipZ = back;
  // Rubber tip, chrome rod, and the spring coiled between the tip and the housing.
  out.push({ mesh: 'cylinder', model: mul(frame, translation([0, 0.62, tipZ + 0.15]), rotationX(Math.PI / 2), scaling([0.45, 0.3, 0.45])), color: [0.1, 0.1, 0.1], spec: 0.3 });
  out.push({ mesh: 'cylinder', model: mul(frame, translation([0, 0.62, (tipZ + housingZ) / 2 + 0.3]), rotationX(Math.PI / 2), scaling([0.12, housingZ - tipZ, 0.12])), color: CHROME, spec: 1.8 });
  const coils = 9;
  const z0 = tipZ + 0.35, z1 = housingZ - 0.05;
  for (let i = 0; i < coils; i++) {
    const z = z0 + ((z1 - z0) * (i + 0.5)) / coils;
    out.push({ mesh: 'tube', model: mul(frame, translation([0, 0.62, z]), rotationX(Math.PI / 2), scaling([0.34, 0.06, 0.34])), color: [0.75, 0.72, 0.6], spec: 1.2 });
  }
  // The housing and its knob sticking out of the (south) wall.
  out.push({ mesh: 'box', model: mul(frame, translation([0, 0.62, housingZ + 0.3]), scaling([1.2, 1.24, 0.6])), color: [0.2, 0.2, 0.24], spec: 0.6 });
}

// --- Playfield art --------------------------------------------------------------------------------------------

/** A flat five-pointed star lying in `frame`'s xz plane (a thin slab `thick` high). */
export function drawStar(out: DrawItem[], frame: Mat4, r: number, color: number[], thick = 0.012, extra: Partial<DrawItem> = {}) {
  const inner = r * 0.42;
  for (let i = 0; i < 5; i++) {
    // Each point is a triangle from the tip back to the two inner corners either side of it.
    const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
    const tip: [number, number] = [Math.cos(a) * r, Math.sin(a) * r];
    const b1: [number, number] = [Math.cos(a - Math.PI / 5) * inner, Math.sin(a - Math.PI / 5) * inner];
    const b2: [number, number] = [Math.cos(a + Math.PI / 5) * inner, Math.sin(a + Math.PI / 5) * inner];
    out.push({ mesh: 'wedge', model: triangleModel(frame, tip, b1, b2, -thick / 2, thick / 2), color, shadow: false, ...extra });
  }
  out.push({ mesh: 'cylinder', model: mul(frame, scaling([inner * 0.98, thick, inner * 0.98])), color, shadow: false, ...extra });
}

/** A flat chevron (a ">" of two bars) in `frame`'s xz plane, pointing along +x. */
export function drawChevron(out: DrawItem[], frame: Mat4, size: number, color: number[], extra: Partial<DrawItem> = {}) {
  for (const s of [1, -1]) {
    out.push({
      mesh: 'box',
      model: mul(frame, translation([-size * 0.25, 0, s * size * 0.3]), rotationY(s * 0.9), scaling([size * 0.85, 0.02, size * 0.22])),
      color,
      shadow: false,
      ...extra,
    });
  }
}

// --- Dot-matrix display -------------------------------------------------------------------------------------

export interface DotMatrixLine {
  /** Height of the line's middle above the display's centre (m). */
  offset: number;
  pixel: number;
}

/**
 * A pinball dot-matrix display on a wall: a dark panel with lines of glowing orange block text.
 * Text only rebuilds when it changes, so drawing it allocates nothing.
 */
export class DotMatrix {
  readonly color = [2.4, 0.95, 0.16];
  private lines: PixelText[];
  /** Per line: whether it's drawn (for flashing). */
  readonly visible: boolean[];

  constructor(private centre: Vec3, private right: Vec3, private up: Vec3, private width: number, private height: number, lines: DotMatrixLine[]) {
    const n = cross(right, up);
    this.lines = lines.map((l) => new PixelText({
      centre: [centre[0] + up[0] * l.offset + n[0] * 0.08, centre[1] + up[1] * l.offset + n[1] * 0.08, centre[2] + up[2] * l.offset + n[2] * 0.08],
      right,
      up,
      pixel: l.pixel,
      color: this.color,
      depth: 0.03,
      pattern: Pattern.emissive,
    }));
    this.visible = lines.map(() => true);
  }

  setLine(i: number, text: string) {
    this.lines[i].setText(text);
  }

  line(i: number) {
    return this.lines[i].value;
  }

  draw(out: DrawItem[]) {
    const n = cross(this.right, this.up);
    out.push({
      mesh: 'box',
      model: basis(
        [this.right[0] * this.width, this.right[1] * this.width, this.right[2] * this.width],
        [this.up[0] * this.height, this.up[1] * this.height, this.up[2] * this.height],
        [n[0] * 0.1, n[1] * 0.1, n[2] * 0.1],
        this.centre,
      ),
      color: [0.03, 0.015, 0.01],
      spec: 1.2,
    });
    this.lines.forEach((l, i) => this.visible[i] && l.draw(out));
  }
}

// --- Sounds ----------------------------------------------------------------------------------------------------

/** Electro-mechanical noises: chimes, solenoids, bells. */
export const pinSfx = {
  /** A pop bumper: a solenoid thock and one of the chime bells. */
  bumper(bell = 0) {
    noise(0.07, { freq: 2600, to: 400, vol: 0.4 });
    tone(95, 0.12, { to: 50, wave: 'square', vol: 0.18 });
    const f = [note('C6'), note('E6'), note('G6'), note('C7')][bell % 4];
    tone(f, 0.6, { wave: 'sine', vol: 0.16 });
    tone(f * 2.76, 0.25, { wave: 'sine', vol: 0.04 });
  },
  sling() {
    noise(0.06, { freq: 3200, to: 700, vol: 0.35 });
    tone(240, 0.08, { to: 120, wave: 'square', vol: 0.12 });
  },
  flipper() {
    noise(0.05, { freq: 1800, to: 300, vol: 0.3 });
    tone(70, 0.09, { to: 45, wave: 'square', vol: 0.16 });
  },
  /** A drop target falling: a clack, then a bell. */
  target(bell = 0) {
    noise(0.05, { freq: 4000, to: 900, type: 'bandpass', q: 2, vol: 0.45 });
    tone(160, 0.07, { wave: 'square', vol: 0.12 });
    tone(note(['A5', 'C#6', 'E6', 'A6'][bell % 4]), 0.9, { wave: 'sine', vol: 0.2, at: 0.04 });
  },
  plungerPull() {
    noise(0.8, { freq: 500, to: 1600, type: 'bandpass', q: 6, vol: 0.12 });
    tone(110, 0.8, { to: 160, wave: 'sawtooth', vol: 0.03 });
  },
  plungerFire() {
    tone(140, 0.35, { to: 620, wave: 'triangle', vol: 0.3 });
    tone(620, 0.4, { to: 300, wave: 'triangle', vol: 0.1, at: 0.08 });
    noise(0.12, { freq: 1500, to: 300, vol: 0.4 });
  },
  /** Steel on steel. */
  clack(vol = 0.3) {
    tone(2200 + Math.random() * 600, 0.06, { wave: 'sine', vol: vol * 0.5 });
    noise(0.03, { freq: 5000, type: 'highpass', vol });
  },
  coin() {
    tone(2637, 0.12, { wave: 'square', vol: 0.06 });
    tone(3520, 0.3, { wave: 'square', vol: 0.06, at: 0.08 });
    noise(0.15, { freq: 6000, type: 'highpass', vol: 0.12, at: 0.5 });
    tone(1800, 0.05, { wave: 'sine', vol: 0.1, at: 0.55 });
  },
  /** The replay knocker: one loud wooden THOCK. */
  knocker() {
    tone(80, 0.18, { to: 40, wave: 'square', vol: 0.4 });
    noise(0.1, { freq: 900, to: 150, vol: 0.6 });
  },
  jackpot() {
    const run = ['C5', 'E5', 'G5', 'C6', 'E6', 'G6', 'C7'];
    run.forEach((n, i) => tone(note(n), 0.14, { wave: 'square', vol: 0.09, at: i * 0.07 }));
    ['C6', 'E6', 'G6'].forEach((n) => tone(note(n), 0.9, { wave: 'triangle', vol: 0.12, at: 0.52 }));
    for (let i = 0; i < 6; i++) tone(note('C7'), 0.1, { wave: 'sine', vol: 0.1, at: 0.6 + i * 0.12 });
  },
  multiball() {
    for (let i = 0; i < 6; i++) tone(i % 2 ? 660 : 880, 0.18, { wave: 'sawtooth', vol: 0.06, at: i * 0.2 });
  },
  tilt() {
    tone(55, 1.4, { wave: 'sawtooth', vol: 0.18 });
    tone(58, 1.4, { wave: 'square', vol: 0.06 });
  },
  danger() {
    tone(440, 0.12, { wave: 'square', vol: 0.08 });
    tone(440, 0.12, { wave: 'square', vol: 0.08, at: 0.2 });
  },
  /** The ball going down the drain. */
  drain() {
    tone(note('E4'), 0.3, { wave: 'square', vol: 0.08 });
    tone(note('C4'), 0.3, { wave: 'square', vol: 0.08, at: 0.3 });
    tone(note('A3'), 0.6, { to: note('E3'), wave: 'square', vol: 0.08, at: 0.6 });
  },
  /** Power-up: the lamps coming on in a sweep. */
  boot() {
    for (let i = 0; i < 8; i++) tone(200 + i * 120, 0.08, { wave: 'square', vol: 0.05, at: i * 0.06 });
    tone(note('G5'), 0.5, { wave: 'triangle', vol: 0.1, at: 0.55 });
    tone(note('C6'), 0.8, { wave: 'triangle', vol: 0.1, at: 0.75 });
  },
};
