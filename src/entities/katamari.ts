import {
  approachAngle, clamp, fromQuat, mul, quatConj, quatMul, rotateByQuat, rotationX, rotationY, rotationZ, scaling, translation,
  type Mat4, type Quat, type Vec3,
} from '../engine/math';
import type { Body, BodyModel, Physics } from '../engine/physics';
import type { DrawItem } from '../engine/renderer';
import { standingRoot } from '../game/body';

/*
 * A katamari: a sticky ball that rolls things up. Anything it absorbs is taken out of the physics
 * world and stuck onto its surface where it touched (drawn turning with the ball, poking out a
 * little); it grows as it goes, and older things get buried under the new. Pushed along by a very
 * small green prince with a very wide head (drawn here too; he isn't a physics object).
 */

/** Radius of a fresh katamari (m). */
export const KATAMARI_START_RADIUS = 0.31;
/** The pink core is drawn at this fraction of the collision radius; the knobs and the junk make up the rest. */
const CORE = 0.9;
/** A stuck thing may poke out past the collision radius by at most this share of the radius (plus 3 cm). */
const PROTRUDE = 0.3;
/**
 * As the ball grows, stuck things ride outward with its surface but sink into it by this share of
 * the growth, so the oldest (and smallest) slowly disappear under the newer ones.
 */
const SINK = 0.25;
/** Seconds for a thing to squish into place once stuck. */
const STICK_TIME = 0.16;
/** How far behind the ball's surface the prince stands (m), and his height to the top of his head. */
const PRINCE_GAP = 0.14;
export const PRINCE_HEIGHT = 0.62;
const PRINCE_HANDS = 0.34;
/** Ball mass: this at the start, growing with its cross-section, up to MAX_MASS (kg). */
const START_MASS = 30;
const MAX_MASS = 600;

const CORE_PINK = [0.93, 0.42, 0.66];
const KNOB_PINK = [0.98, 0.7, 0.84];
const knobDirs: Vec3[] = [];
{
  // Knobs spread evenly over the core (a Fibonacci sphere).
  const n = 18, golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - ((i + 0.5) / n) * 2, r = Math.sqrt(1 - y * y), a = i * golden;
    knobDirs.push([Math.cos(a) * r, y, Math.sin(a) * r]);
  }
}

/** A body's full extents along its own axes (box, ball, cylinder, cone or capsule). */
export function dimsOf(b: Body): Vec3 {
  const s = b.size;
  if (b.mesh === 'sphere') return [s[0] * 2, s[0] * 2, s[0] * 2];
  if (b.mesh === 'cylinder' || b.mesh === 'cone') return [s[0] * 2, s[1], s[2] * 2];
  return [s[0], s[1], s[2]];
}

/** The biggest and second-biggest of three extents. */
export function bigTwo(d: Vec3): [number, number] {
  const a = Math.max(d[0], d[1], d[2]);
  const c = Math.min(d[0], d[1], d[2]);
  return [a, d[0] + d[1] + d[2] - a - c];
}

/** Draws a plain body (one primitive, no custom model). */
function primitiveModel(b: Body): BodyModel {
  const { mesh, size, color, pattern, param } = b;
  return (out, m) => out.push({ mesh, model: mul(m, scaling(size)), color, pattern, param });
}

interface Stuck {
  model: BodyModel;
  /** Orientation and direction from the centre, in the ball's frame. */
  rot: Quat;
  dir: Vec3;
  /** Distance from the centre when it touched; how far below the surface it settled; the radius then. */
  from: number;
  depth: number;
  radius: number;
  /** 0-1 through settling in. */
  t: number;
  /** Half its biggest extent: roughly how far it reaches from its centre. */
  extent: number;
  local: Mat4;
  /** The distance `local` was last built for. */
  dist: number;
}

export class Katamari {
  readonly body: Body;
  radius: number;
  private stuck: Stuck[] = [];
  /** How many things it has rolled up. */
  count = 0;
  /** The prince: where he stands (on the floor), which way he faces, and his running cycle. */
  princeX: number;
  princeZ: number;
  princeFacing = 0;
  private princeAngle = 0;
  private walk = 0;
  /** 0-1: arms up and hopping (a job well done). */
  cheer = 0;
  /** Hide the prince (e.g. before he arrives), or the ball (e.g. once it's up in the sky). */
  princeVisible = true;
  ballVisible = true;
  /** The prince stays behind the ball; false leaves him where he is (the ball has gone somewhere he can't follow). */
  followBall = true;
  /** Extra height for the prince (dropping in from the sky). */
  princeLift = 0;
  /** Which way the ball is being pushed (unit, xz); the prince stays behind it. */
  heading: [number, number] = [0, -1];
  private time = 0;

  constructor(physics: Physics, pos: Vec3, radius = KATAMARI_START_RADIUS) {
    this.radius = radius;
    this.body = physics.addBall(pos, radius, {
      mass: START_MASS,
      friction: 1.2,
      restitution: 0.05,
      grabbable: false,
      hidden: true,
    });
    this.body.rb.setAngularDamping(0);
    this.body.angularDamping = 0;
    this.princeX = pos[0];
    this.princeZ = pos[2] + radius + PRINCE_GAP;
    this.princeAngle = Math.PI / 2;
  }

  get diameter() {
    return this.radius * 2;
  }

  centre(): Vec3 {
    const t = this.body.rb.translation();
    return [t.x, t.y, t.z];
  }

  /** The ball's world transform (origin at its centre, turning with it). */
  frame(): Mat4 {
    const t = this.body.rb.translation();
    return fromQuat(this.body.rb.rotation(), [t.x, t.y, t.z]);
  }

  /** Grows (or shrinks) to radius `r`, lifting itself so it doesn't sink into the floor. */
  setRadius(r: number) {
    const rb = this.body.rb, old = this.radius;
    this.radius = r;
    this.body.collider.setRadius(r);
    this.body.size = [r, r, r];
    const d = r * 2;
    this.body.collider.setMass(Math.min(MAX_MASS, START_MASS * (d / (KATAMARI_START_RADIUS * 2)) ** 2));
    const t = rb.translation();
    if (r > old) rb.setTranslation({ x: t.x, y: t.y + (r - old), z: t.z }, true);
  }

  /**
   * Sticks `b` onto the ball where it is now (it leaves the physics world) and returns its
   * extents. The caller decides how much the ball grows.
   */
  absorb(physics: Physics, b: Body): Vec3 {
    const dims = dimsOf(b);
    const rb = this.body.rb;
    const qb = rb.rotation(), cb = rb.translation();
    const qo = b.rb.rotation(), po = b.rb.translation();
    const inv = quatConj(qb);
    const rot = quatMul(inv, qo);
    let local = rotateByQuat(inv, [po.x - cb.x, po.y - cb.y, po.z - cb.z]);
    let dist = Math.hypot(local[0], local[1], local[2]);
    if (dist < 1e-3) {
      local = [0, 1, 0];
      dist = 1;
    }
    const dir: Vec3 = [local[0] / dist, local[1] / dist, local[2] / dist];
    // How far it reaches out along that direction (its box's support), so it pokes out only so far.
    const n = rotateByQuat(quatConj(rot), dir);
    const reach = 0.5 * (Math.abs(n[0]) * dims[0] + Math.abs(n[1]) * dims[1] + Math.abs(n[2]) * dims[2]);
    const R = this.radius;
    const to = Math.max(R * 0.35, R + Math.min(reach, PROTRUDE * R + 0.03) - reach);
    const from = clamp(dist, to, R + reach + 0.3);
    const s: Stuck = {
      model: b.model ?? primitiveModel(b),
      rot,
      dir,
      from,
      depth: R - to,
      radius: R,
      t: 0,
      extent: Math.max(dims[0], dims[1], dims[2]) / 2,
      local: fromQuat(rot, [dir[0] * from, dir[1] * from, dir[2] * from]),
      dist: from,
    };
    this.stuck.push(s);
    this.count++;
    physics.remove(b);
    return dims;
  }

  /** A point on the surface in the ball's own frame (unit direction), in world space right now. */
  toWorld(localDir: Vec3, dist: number): Vec3 {
    const t = this.body.rb.translation();
    const d = rotateByQuat(this.body.rb.rotation(), localDir);
    return [t.x + d[0] * dist, t.y + d[1] * dist, t.z + d[2] * dist];
  }

  /** A world direction in the ball's frame. */
  toLocalDir(worldDir: Vec3): Vec3 {
    return rotateByQuat(quatConj(this.body.rb.rotation()), worldDir);
  }

  update(dt: number) {
    this.time += dt;
    const R = this.radius;
    for (const s of this.stuck) {
      s.t = Math.min(1, s.t + dt / STICK_TIME);
      const rest = this.restDistance(s);
      const k = 1 - (1 - s.t) * (1 - s.t);
      const d = s.from + (rest - s.from) * k;
      if (Math.abs(d - s.dist) < 1e-4) continue;
      s.dist = d;
      s.local = fromQuat(s.rot, [s.dir[0] * d, s.dir[1] * d, s.dir[2] * d]);
    }
    if (!this.followBall) return;
    // The prince trots round the ball to stay behind it (never through it).
    const c = this.body.rb.translation();
    const v = this.body.rb.linvel();
    const reach =Math.sqrt(Math.max(0, R * R - (R - PRINCE_HANDS) * (R - PRINCE_HANDS)));
    const dist = Math.max(reach, 0.12) + PRINCE_GAP;
    const behind = Math.atan2(-this.heading[1], -this.heading[0]);
    this.princeAngle = approachAngle(this.princeAngle, behind, dt * 7);
    const x = c.x + Math.cos(this.princeAngle) * dist, z = c.z + Math.sin(this.princeAngle) * dist;
    const moved = Math.hypot(x - this.princeX, z - this.princeZ);
    this.princeX = x;
    this.princeZ = z;
    this.princeFacing = Math.atan2(-(c.x - x), -(c.z - z));
    const speed = Math.max(Math.hypot(v.x, v.z), dt > 0 ? moved / dt : 0);
    this.walk += dt * Math.min(speed, 9) * 7;
  }

  draw(out: DrawItem[], time: number) {
    if (this.princeVisible) this.drawPrince(out, time);
    if (!this.ballVisible) return;
    const f = this.frame();
    const R = this.radius, core = R * CORE;
    out.push({ mesh: 'sphere', model: mul(f, scaling([core, core, core])), color: CORE_PINK, spec: 0.35 });
    // The sticky knobs of a new katamari disappear under the junk as it fills up.
    const k = R * 0.16 * clamp(1 - this.count / 45, 0.35, 1);
    for (const d of knobDirs) {
      out.push({ mesh: 'sphere', model: mul(f, translation([d[0] * R * 0.86, d[1] * R * 0.86, d[2] * R * 0.86]), scaling([k, k, k])), color: KNOB_PINK, spec: 0.3 });
    }
    for (const s of this.stuck) {
      // Buried under everything since: out of sight.
      if (s.t >= 1 && s.dist + s.extent * 0.55 < core) continue;
      s.model(out, mul(f, s.local));
    }
  }

  /** Where a stuck thing sits now: riding out with the surface as the ball grows, sinking in a little. */
  private restDistance(s: Stuck) {
    const R = this.radius;
    return Math.max(R * 0.3, R - s.depth - SINK * (R - s.radius));
  }

  private drawPrince(out: DrawItem[], time: number) {
    const cheer = this.cheer;
    const hop = cheer > 0 ? Math.abs(Math.sin(time * 9)) * 0.18 * cheer : 0;
    const root = mul(standingRoot([this.princeX, this.princeLift + hop, this.princeZ], this.princeFacing), rotationX(-0.25 * (1 - cheer)));
    drawPrince(out, root, this.walk, cheer, time);
  }
}

const PRINCE_SUIT = [0.2, 0.62, 0.28];
const PRINCE_DARK = [0.1, 0.36, 0.14];
const PRINCE_SKIN = [0.62, 0.88, 0.4];
const PRINCE_SHOE = [0.35, 0.18, 0.08];

/**
 * The prince: about 0.6 m of royalty, most of it a head shaped like a very wide tin can (lying on
 * its side), with an antenna. `root` is his feet (facing -z); `walk` runs the legs; `cheer` (0-1)
 * throws his arms up; otherwise his arms reach forward, pushing.
 */
export function drawPrince(out: DrawItem[], root: Mat4, walk: number, cheer: number, time: number) {
  const p = (mesh: DrawItem['mesh'], m: Mat4, color: number[], spec = 0.2) => out.push({ mesh, model: m, color, spec });
  const swing = Math.sin(walk) * 0.7 * (1 - cheer);
  for (const side of [-1, 1]) {
    const hip = mul(root, translation([side * 0.05, 0.16, 0]), rotationX(side * swing));
    p('cylinder', mul(hip, translation([0, -0.07, 0]), scaling([0.034, 0.14, 0.034])), PRINCE_SUIT);
    p('roundbox', mul(hip, translation([0, -0.145, -0.02]), scaling([0.06, 0.035, 0.1])), PRINCE_SHOE);
  }
  p('roundbox', mul(root, translation([0, 0.25, 0]), scaling([0.17, 0.2, 0.13])), PRINCE_SUIT);
  p('box', mul(root, translation([0, 0.19, 0]), scaling([0.175, 0.03, 0.135])), PRINCE_DARK); // belt
  for (const side of [-1, 1]) {
    // Arms: forward to push, or up to celebrate.
    const up = cheer * (2.6 + Math.sin(time * 12 + side) * 0.3);
    const push = 1.35 * (1 - cheer);
    const sh = mul(root, translation([side * 0.1, 0.31, 0]), rotationZ(side * 0.25 * cheer), rotationX(push + up));
    p('cylinder', mul(sh, translation([0, -0.08, 0]), scaling([0.028, 0.16, 0.028])), PRINCE_SUIT);
    p('sphere', mul(sh, translation([0, -0.17, 0]), scaling([0.035, 0.035, 0.035])), PRINCE_SKIN);
  }
  const head = mul(root, translation([0, 0.47, 0]));
  p('cylinder', mul(head, rotationZ(Math.PI / 2), scaling([0.13, 0.46, 0.13])), PRINCE_SKIN, 0.3);
  // Rosy cheeks either side of a very small face.
  for (const side of [-1, 1]) p('sphere', mul(head, translation([side * 0.075, -0.03, -0.118]), scaling([0.025, 0.018, 0.012])), [0.95, 0.55, 0.5], 0.2);
  for (const side of [-1, 1]) p('sphere', mul(head, translation([side * 0.035, 0.02, -0.125]), scaling([0.016, 0.022, 0.01])), [0.03, 0.03, 0.03], 0.6);
  p('box', mul(head, translation([0, -0.045, -0.128]), scaling([0.04, 0.008, 0.006])), [0.5, 0.12, 0.15]);
  // The antenna, with a little bob on the end.
  const ant = mul(head, translation([0, 0.13, 0]), rotationZ(Math.sin(time * 5) * 0.12), rotationY(0));
  p('cylinder', mul(ant, translation([0, 0.06, 0]), scaling([0.008, 0.12, 0.008])), PRINCE_DARK);
  p('sphere', mul(ant, translation([0, 0.13, 0]), scaling([0.025, 0.025, 0.025])), [0.95, 0.25, 0.3], 0.6);
}
