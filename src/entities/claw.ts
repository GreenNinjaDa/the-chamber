import { add, basis, clamp, cross, dot, length, mul, normalize, scale, scaling, segment, sub, transformDir, transformPoint, translation, type Mat4, type Vec3 } from '../engine/math';
import { RAPIER, type Physics } from '../engine/physics';
import type { DrawItem } from '../engine/renderer';
import { CHAMBER_HALF, WALL_HEIGHT } from '../game/chamber';

/*
 * A claw-machine claw on a gantry over the whole chamber: two rails on top of the east and west
 * walls, a bridge that runs along them (z), a trolley that runs along the bridge (x), and a cable
 * down to a chrome three-pronged claw. The claw swings a little on its cable when the trolley
 * starts and stops. Its hub is a kinematic collider (it shoves prizes aside on the way down); the
 * prongs are drawn only. The level drives it: `driveTo`, `y` (hub height) and `angle` (prongs).
 */

/** Height of the gantry rails and bridge (world y). */
export const GANTRY_Y = 12.6;
/** The hub's resting height at the top of the cable. */
export const CLAW_TOP = 11.2;
/** Prong angle (radians out from straight down): fully open, and shut on nothing. */
export const PRONGS_OPEN = 0.95;
export const PRONGS_SHUT = 0.1;
/** How far below the hub centre a held thing sits. */
export const GRIP_DEPTH = 1.3;
/** How far below the hub centre the open prongs' tips reach. */
export const TIP_DEPTH = 1.5;
/** The hub's collider: a cylinder from HUB_BOTTOM below the hub centre up over the motor. */
export const HUB_BOTTOM = 0.1;

const HUB_R = 0.46;
const UPPER = 0.95;
const LOWER = 0.85;
/** How far the lower half of each prong bends inward from the upper half. */
const BEND = 0.85;
/** Top-speed per axis (m/s) and acceleration (m/s²): claws move like a joystick, one axis at a time or both. */
const MOVE_SPEED = 3.2;
const MOVE_ACCEL = 7;
/** Cable swing: damping (1/s), and how much of the cable's length it may swing out. */
const SWING_DAMPING = 2.2;
const SWING_MAX = 0.3;

const CHROME = [0.6, 0.62, 0.68];
const DARK_METAL = [0.18, 0.19, 0.22];
const PAINT = [0.85, 0.12, 0.2];
const RAIL = [0.3, 0.31, 0.35];
const CABLE = [0.12, 0.12, 0.13];
const shiny = { spec: 0.9 };

const COLLIDER_HALF = 0.4;

export class Claw {
  /** Trolley position: where the cable hangs from. */
  x: number;
  z: number;
  vx = 0;
  vz = 0;
  /** Hub centre height. */
  y = CLAW_TOP;
  /** Prong angle (see PRONGS_OPEN / PRONGS_SHUT). */
  angle = PRONGS_OPEN;
  /** Extra offset for the rigged "jiggle" (m). */
  shake: Vec3 = [0, 0, 0];
  /** The hub's frame: origin at the hub centre, y up along the cable. Updated by `update`. */
  frame: Mat4;
  private sx = 0;
  private sz = 0;
  private svx = 0;
  private svz = 0;
  private lastVx = 0;
  private lastVz = 0;
  private rb: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;

  constructor(physics: Physics, x: number, z: number) {
    this.x = x;
    this.z = z;
    this.rb = physics.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(x, CLAW_TOP, z));
    // Hits loose things (and blocks the player's walking), but never the player's body parts:
    // the level decides what a claw on the head does.
    this.collider = physics.world.createCollider(
      RAPIER.ColliderDesc.cylinder(COLLIDER_HALF, HUB_R)
        .setTranslation(0, COLLIDER_HALF - HUB_BOTTOM, 0)
        .setCollisionGroups((0x0001 << 16) | (0xffff & ~0x0002)),
      this.rb,
    );
    this.frame = translation([x, CLAW_TOP, z]);
  }

  /** The hub's centre. */
  hub(): Vec3 {
    return [this.frame[12], this.frame[13], this.frame[14]];
  }

  /** Where a held thing's centre sits. */
  gripPoint(depth = GRIP_DEPTH): Vec3 {
    return transformPoint(this.frame, [0, -depth, 0]);
  }

  /** The trolley's velocity, as a vector (the claw carries its load at this speed). */
  velocity(): Vec3 {
    return [this.vx, 0, this.vz];
  }

  /**
   * Moves the trolley toward (tx, tz) like a joystick: each axis at up to `speed`, easing in to
   * stop on the spot. True once it's there and stopped.
   */
  driveTo(tx: number, tz: number, dt: number, speed = MOVE_SPEED): boolean {
    const axis = (p: number, v: number, t: number) => {
      const want = clamp((t - p) * 2.6, -speed, speed);
      return v + clamp(want - v, -MOVE_ACCEL * dt, MOVE_ACCEL * dt);
    };
    this.vx = axis(this.x, this.vx, tx);
    this.vz = axis(this.z, this.vz, tz);
    this.x += this.vx * dt;
    this.z += this.vz * dt;
    return Math.abs(tx - this.x) < 0.04 && Math.abs(tz - this.z) < 0.04 && Math.abs(this.vx) + Math.abs(this.vz) < 0.15;
  }

  /** Stops the trolley where it is. */
  halt() {
    this.vx = this.vz = 0;
  }

  /** Swings on the cable, then places the hub (and its collider) for this frame. */
  update(dt: number) {
    const cable = Math.max(0.8, GANTRY_Y - 0.25 - this.y);
    if (dt > 0) {
      // A pendulum pushed by the trolley's acceleration.
      const ax = (this.vx - this.lastVx) / dt, az = (this.vz - this.lastVz) / dt;
      const w2 = 20 / cable;
      this.svx += (-w2 * this.sx - SWING_DAMPING * this.svx - ax) * dt;
      this.svz += (-w2 * this.sz - SWING_DAMPING * this.svz - az) * dt;
      this.sx += this.svx * dt;
      this.sz += this.svz * dt;
      const max = cable * SWING_MAX;
      this.sx = clamp(this.sx, -max, max);
      this.sz = clamp(this.sz, -max, max);
    }
    this.lastVx = this.vx;
    this.lastVz = this.vz;
    const hub: Vec3 = [this.x + this.sx + this.shake[0], this.y + this.shake[1], this.z + this.sz + this.shake[2]];
    // Hang along the cable: y points from the hub up to where the cable leaves the trolley.
    const y = normalize([this.x - hub[0], GANTRY_Y - 0.25 - hub[1], this.z - hub[2]]);
    const x = normalize(cross(y, [0, 0, 1]));
    const z = cross(x, y);
    this.frame = basis(x, y, z, hub);
    this.rb.setNextKinematicTranslation({ x: hub[0], y: hub[1], z: hub[2] });
  }

  /** The prong angle that brings the tips in to `radius` from the axis (to hold something that wide). */
  angleFor(radius: number): number {
    let lo = PRONGS_SHUT, hi = PRONGS_OPEN;
    for (let i = 0; i < 16; i++) {
      const mid = (lo + hi) / 2;
      if (tipRadius(mid) < radius) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  }

  /** Prong `i` (0-2) in world space: hinge, knuckle and tip, for the current angle. */
  prong(i: number): [Vec3, Vec3, Vec3] {
    const [p, k, t] = prongLocal(i, this.angle);
    return [transformPoint(this.frame, p), transformPoint(this.frame, k), transformPoint(this.frame, t)];
  }

  /** Horizontal-ish direction prong `i` opens toward (away from the axis), in world space. */
  prongOut(i: number): Vec3 {
    const phi = prongPhi(i);
    return transformDir(this.frame, [Math.cos(phi), 0, Math.sin(phi)]);
  }

  /** The prong whose knuckle is nearest `p`. */
  nearestProng(p: Vec3): number {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < 3; i++) {
      const d = length(sub(this.prong(i)[1], p));
      if (d < bestD) { best = i; bestD = d; }
    }
    return best;
  }

  /** Shortest distance from `p` to the claw (hub or any prong). */
  distanceTo(p: Vec3): number {
    const hub = this.hub();
    const bottom = transformPoint(this.frame, [0, -HUB_BOTTOM, 0]);
    let best = Math.max(0, distToSegment(p, bottom, add(hub, [0, 0.6, 0])) - HUB_R);
    for (let i = 0; i < 3; i++) {
      const [a, b, c] = this.prong(i);
      best = Math.min(best, distToSegment(p, a, b), distToSegment(p, b, c));
    }
    return best;
  }

  draw(out: DrawItem[]) {
    const m = this.frame;
    // Gantry: rails on top of the side walls, the bridge along them, and the trolley.
    const railY = GANTRY_Y + 0.1;
    const reach = CHAMBER_HALF + 0.5;
    for (const side of [-1, 1]) {
      out.push({ mesh: 'box', model: mul(translation([side * reach, railY, 0]), scaling([0.35, 0.3, reach * 2 + 0.4])), color: RAIL, spec: 0.5 });
      for (const zz of [-1, 1]) {
        const h = railY - WALL_HEIGHT;
        out.push({ mesh: 'box', model: mul(translation([side * reach, WALL_HEIGHT + h / 2, zz * reach]), scaling([0.3, h, 0.3])), color: RAIL, spec: 0.5 });
      }
    }
    out.push({ mesh: 'box', model: mul(translation([0, railY + 0.02, this.z]), scaling([reach * 2 + 0.3, 0.32, 0.5])), color: [0.85, 0.72, 0.1], spec: 0.4 });
    out.push({ mesh: 'roundbox', model: mul(translation([this.x, railY - 0.36, this.z]), scaling([0.9, 0.42, 0.8])), color: DARK_METAL, spec: 0.6 });
    // The cable, from the trolley to the top of the motor.
    const top = transformPoint(m, [0, 0.72, 0]);
    out.push({ mesh: 'cylinder', model: segment([this.x, railY - 0.55, this.z], top, 0.025), color: CABLE });

    // Motor housing, cap and hub.
    push(out, m, 'cylinder', [0, 0.36, 0], [0.4, 0.52, 0.4], PAINT, { spec: 0.7 });
    push(out, m, 'cylinder', [0, 0.66, 0], [0.26, 0.1, 0.26], CHROME, shiny);
    push(out, m, 'cylinder', [0, 0.03, 0], [HUB_R, 0.2, HUB_R], CHROME, shiny);
    push(out, m, 'cylinder', [0, -0.08, 0], [0.2, 0.08, 0.2], DARK_METAL, shiny);
    // Three prongs: hinge block, upper arm, knuckle, lower arm, and a curled tip.
    for (let i = 0; i < 3; i++) {
      const [p, k, t] = this.prong(i);
      out.push({ mesh: 'sphere', model: mul(translation(p), scaling([0.09, 0.09, 0.09])), color: DARK_METAL, spec: 0.8 });
      out.push({ mesh: 'cylinder', model: segment(p, k, 0.055), color: CHROME, ...shiny });
      out.push({ mesh: 'sphere', model: mul(translation(k), scaling([0.08, 0.08, 0.08])), color: CHROME, ...shiny });
      out.push({ mesh: 'cylinder', model: segment(k, t, 0.05), color: CHROME, ...shiny });
      // The tip curls in toward the axis.
      const phi = prongPhi(i);
      const inward = transformDir(m, [-Math.cos(phi), 0.15, -Math.sin(phi)]);
      out.push({ mesh: 'cone', model: segment(t, add(t, scale(inward, 0.17)), 0.065), color: CHROME, ...shiny });
    }
  }
}

function push(out: DrawItem[], m: Mat4, mesh: DrawItem['mesh'], pos: Vec3, size: Vec3, color: number[], extra: Partial<DrawItem> = {}) {
  out.push({ mesh, model: mul(m, translation(pos), scaling(size)), color, ...extra });
}

/** Which way prong `i` faces around the hub (radians, in the hub's xz plane). */
const prongPhi = (i: number) => (i / 3) * Math.PI * 2 + Math.PI / 6;

/** Prong `i` in the hub's frame for prong angle `a`: hinge, knuckle, tip. */
function prongLocal(i: number, a: number): [Vec3, Vec3, Vec3] {
  const phi = prongPhi(i);
  const dx = Math.cos(phi), dz = Math.sin(phi);
  const p: Vec3 = [HUB_R * dx, -0.08, HUB_R * dz];
  const out1 = Math.sin(a) * UPPER, down1 = Math.cos(a) * UPPER;
  const k: Vec3 = [p[0] + out1 * dx, p[1] - down1, p[2] + out1 * dz];
  const out2 = Math.sin(a - BEND) * LOWER, down2 = Math.cos(a - BEND) * LOWER;
  const t: Vec3 = [k[0] + out2 * dx, k[1] - down2, k[2] + out2 * dz];
  return [p, k, t];
}

function tipRadius(a: number): number {
  return HUB_R + Math.sin(a) * UPPER + Math.sin(a - BEND) * LOWER;
}

function distToSegment(p: Vec3, a: Vec3, b: Vec3): number {
  const ab = sub(b, a);
  const t = clamp(dot(sub(p, a), ab) / Math.max(dot(ab, ab), 1e-6), 0, 1);
  return length(sub(p, add(a, scale(ab, t))));
}
