import { add, mul, rotationX, rotationY, rotationZ, scaling, translation, type Mat4, type Vec3 } from '../engine/math';
import { RAPIER, type Physics } from '../engine/physics';
import { Pattern, type DrawItem } from '../engine/renderer';

/*
 * A giant rubber duck (4 m long, 2.2 m tall) you can stand on: a kinematic body the level moves
 * by hand (drop it, float it, sail it), so it never tips over. Its body is a flat-bottomed
 * ellipsoid (a convex hull) whose back is 1.1 m up, low enough to jump onto from the floor; the
 * head is a ball on top at the front. Its local frame has the origin at the middle of its flat
 * bottom and the beak pointing along -z.
 */

/** The body: an ellipsoid with these radii, centred this high over the bottom (cut flat at 0). */
const BODY_R: Vec3 = [1.3, 0.65, 1.6];
const BODY_Y = 0.45;
/** Height of the top of its back over its bottom. */
export const DUCK_BACK = BODY_Y + BODY_R[1];
const HEAD_R = 0.72;
const HEAD: Vec3 = [0, 1.45, -1.2];
/** Footprint half-sizes (x, z), for landing on things. */
export const DUCK_HALF: [number, number] = [BODY_R[0], BODY_R[2]];

const YELLOW = [1, 0.8, 0.07];
const WING = [0.97, 0.68, 0.04];
const BEAK = [1, 0.42, 0.04];

export class GiantDuck {
  readonly rb: RAPIER.RigidBody;
  readonly colliders: RAPIER.Collider[] = [];
  /** Where its bottom centre is, and which way it faces (yaw 0: beak toward -z). */
  pos: Vec3;
  yaw: number;
  /** How fast it moved last frame (m/s), and turned (rad/s): for carrying riders along. */
  vel: Vec3 = [0, 0, 0];
  yawRate = 0;
  /** Visual only: squash on landing (0 = none, >0 flattened), and a little rocking roll (rad). */
  squash = 0;
  roll = 0;
  /** Drawn at all? (Hidden until it's dropped in.) */
  visible = true;
  /** Glowing lava look (0-1), for the rare day the duck is lava too. */
  lava = 0;

  constructor(private physics: Physics, pos: Vec3, yaw = 0) {
    this.pos = [...pos];
    this.yaw = yaw;
    this.rb = physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(pos[0], pos[1], pos[2])
        .setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }),
    );
    // A flat-bottomed ellipsoid hull for the body...
    const pts: number[] = [];
    const rings = 7, segs = 18;
    for (let i = 0; i <= rings; i++) {
      const phi = -Math.PI / 2 + (Math.PI * i) / rings;
      for (let j = 0; j < segs; j++) {
        const th = (Math.PI * 2 * j) / segs;
        const x = BODY_R[0] * Math.cos(phi) * Math.cos(th);
        const z = BODY_R[2] * Math.cos(phi) * Math.sin(th);
        const y = Math.max(0, BODY_Y + BODY_R[1] * Math.sin(phi));
        pts.push(x, y, z);
      }
    }
    const hull = RAPIER.ColliderDesc.convexHull(new Float32Array(pts));
    if (hull) this.colliders.push(physics.world.createCollider(hull.setFriction(0.9), this.rb));
    // ...and a ball for the head.
    this.colliders.push(physics.world.createCollider(
      RAPIER.ColliderDesc.ball(HEAD_R).setTranslation(HEAD[0], HEAD[1], HEAD[2]).setFriction(0.9),
      this.rb,
    ));
  }

  owns(collider: RAPIER.Collider) {
    return this.colliders.includes(collider);
  }

  setSolid(solid: boolean) {
    for (const c of this.colliders) c.setEnabled(solid);
  }

  /** Moves it (kinematically) to `pos` facing `yaw`, and works out how fast it went, for riders. */
  moveTo(pos: Vec3, yaw: number, dt: number) {
    if (dt > 0) {
      this.vel = [(pos[0] - this.pos[0]) / dt, (pos[1] - this.pos[1]) / dt, (pos[2] - this.pos[2]) / dt];
      this.yawRate = Math.atan2(Math.sin(yaw - this.yaw), Math.cos(yaw - this.yaw)) / dt;
    }
    this.pos = [...pos];
    this.yaw = yaw;
    this.rb.setNextKinematicTranslation({ x: pos[0], y: pos[1], z: pos[2] });
    this.rb.setNextKinematicRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) });
  }

  /** The velocity of the duck's surface at world point `p` (its motion plus its turning). */
  pointVelocity(p: Vec3): Vec3 {
    const rx = p[0] - this.pos[0], rz = p[2] - this.pos[2];
    // Spinning about +y at yawRate: v = w x r.
    return [this.vel[0] + this.yawRate * rz, this.vel[1], this.vel[2] - this.yawRate * rx];
  }

  /** Is the point (x, z) over its footprint (with `margin` to spare)? */
  over(x: number, z: number, margin = 0) {
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    const dx = x - this.pos[0], dz = z - this.pos[2];
    const lx = c * dx - s * dz, lz = s * dx + c * dz;
    return (lx / (BODY_R[0] + margin)) ** 2 + (lz / (BODY_R[2] + margin)) ** 2 < 1;
  }

  draw(out: DrawItem[]) {
    if (!this.visible) return;
    const sq = this.squash;
    const m = mul(
      translation(this.pos),
      rotationY(this.yaw),
      rotationZ(this.roll),
      scaling([1 + sq * 0.5, 1 - sq, 1 + sq * 0.5]),
    );
    const first = out.length;
    duckModel(out, m);
    if (this.lava > 0.5) for (let i = first; i < out.length; i++) {
      out[i].pattern = Pattern.lava;
      out[i].param = 2;
    }
  }

  /** A soft round shadow on the floor under it, for while it's falling out of the sky. */
  drawShadow(out: DrawItem[], floorY: number, strength: number) {
    out.push({
      mesh: 'cylinder',
      model: mul(translation([this.pos[0], floorY + 0.02, this.pos[2]]), rotationY(this.yaw), scaling([BODY_R[0] * 1.2, 0.01, BODY_R[2] * 1.3])),
      color: [0, 0, 0],
      pattern: Pattern.blob,
      param: strength,
      shadow: false,
    });
  }
}

function duckModel(out: DrawItem[], m: Mat4) {
  const put = (mesh: DrawItem['mesh'], pos: Vec3, size: Vec3, color: number[], spec = 0.75, rot?: Mat4) =>
    out.push({ mesh, model: rot ? mul(m, translation(pos), rot, scaling(size)) : mul(m, translation(pos), scaling(size)), color, spec });
  // Body, with a plump rear rising into the tail.
  put('sphere', [0, BODY_Y, 0], BODY_R, YELLOW);
  put('sphere', [0, 0.72, 1.05], [0.95, 0.5, 0.75], YELLOW);
  put('cone', [0, 1.12, 1.62], [0.42, 0.75, 0.3], YELLOW, 0.75, rotationX(0.95));
  // Wings.
  for (const s of [-1, 1]) put('sphere', [s * 1.18, 0.66, 0.2], [0.2, 0.36, 0.78], WING, 0.75, mul(rotationZ(s * 0.25), rotationX(-0.15)));
  // Head, beak and eyes.
  put('sphere', HEAD, [HEAD_R, HEAD_R * 0.96, HEAD_R], YELLOW);
  put('sphere', [0, 1.33, -1.86], [0.44, 0.13, 0.42], BEAK, 0.6);
  put('sphere', [0, 1.2, -1.76], [0.34, 0.08, 0.3], BEAK, 0.6);
  for (const s of [-1, 1]) {
    put('sphere', [s * 0.33, 1.7, -1.7], [0.17, 0.2, 0.12], [0.97, 0.97, 0.97], 0.9);
    put('sphere', [s * 0.35, 1.71, -1.8], [0.1, 0.12, 0.06], [0.02, 0.02, 0.03], 1);
    put('sphere', [s * 0.32, 1.76, -1.85], [0.03, 0.03, 0.02], [1, 1, 1], 1);
  }
}
