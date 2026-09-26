import { add, mul, rotationX, rotationY, rotationZ, scaling, translation, type Mat4, type Vec3 } from '../engine/math';
import { RAPIER, type Physics } from '../engine/physics';
import { Pattern, type DrawItem } from '../engine/renderer';

/*
 * A giant rubber duck (4 m long, 2.2 m tall) you can stand on, moved by hand by the level (drop it,
 * float it, sail it), so it never tips over. It's a fixed body teleported every frame rather than a
 * kinematic one: Rapier's character controller can't jump up alongside kinematic colliders. Riders
 * are carried along with `pointVelocity` (player.platformVel). Its back is 1.1 m up, low enough to
 * jump onto from the floor; the head is a ball on top at the front. Its local frame has the origin at
 * the middle of its flat bottom and the beak pointing along -z.
 */

/** The body: an ellipsoid with these radii, centred this high over the bottom (cut flat at 0). */
const BODY_R: Vec3 = [1.3, 0.65, 1.6];
const BODY_Y = 0.45;
/** Height of the top of its back over its bottom. */
export const DUCK_BACK = BODY_Y + BODY_R[1];
/**
 * The body collider's side profile: (fraction of the body's radii, height), bottom to top. It never
 * overhangs: jumping up an overhang counts as bumping your head, and you drop straight back down.
 */
const HULL_PROFILE: [number, number][] = [[0.9, 0], [0.9, 0.72], [0.74, 0.96], [0.45, 1.07], [0.001, DUCK_BACK]];
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
      RAPIER.RigidBodyDesc.fixed()
        .setTranslation(pos[0], pos[1], pos[2])
        .setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }),
    );
    // A hull for the body: the ellipsoid's outline from above, but with near-vertical flanks and a
    // rounded top (an ellipsoid's bulging sides deflect a jumping player; a wall they can climb).
    const pts: number[] = [];
    const segs = 20;
    for (const [r, y] of HULL_PROFILE) {
      for (let j = 0; j < segs; j++) {
        const th = (Math.PI * 2 * j) / segs;
        pts.push(BODY_R[0] * r * Math.cos(th), y, BODY_R[2] * r * Math.sin(th));
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

  /** Moves it to `pos` facing `yaw`, and works out how fast it went, for riders (dt 0: a teleport). */
  moveTo(pos: Vec3, yaw: number, dt: number) {
    if (dt <= 0) {
      // Teleported: not moving.
      this.vel = [0, 0, 0];
      this.yawRate = 0;
    } else {
      this.vel = [(pos[0] - this.pos[0]) / dt, (pos[1] - this.pos[1]) / dt, (pos[2] - this.pos[2]) / dt];
      this.yawRate = Math.atan2(Math.sin(yaw - this.yaw), Math.cos(yaw - this.yaw)) / dt;
    }
    this.pos = [...pos];
    this.yaw = yaw;
    this.rb.setTranslation({ x: pos[0], y: pos[1], z: pos[2] }, false);
    this.rb.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, false);
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
