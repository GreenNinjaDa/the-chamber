import {
  add, basis, fromQuat, mul, quatConj, quatMul, rotationX, rotationZ, scale, scaling, sub, toQuat,
  translation, type Mat4, type Quat, type Vec3,
} from '../engine/math';
import { GROUPS_PLAYER_BODY, GROUPS_PLAYER_BODY_LIMP, RAPIER, type Physics } from '../engine/physics';
import type { DrawItem } from '../engine/renderer';

/*
 * The player's body: 11 rounded parts on a simple skeleton. The same skeleton is used to
 * draw scripted poses (walking, flailing in the giant's hand, flying) and to build the
 * physical body, which follows those poses with joint motors (active ragdoll) and goes
 * limp on death or when hit hard.
 */

export type PartName =
  | 'pelvis' | 'chest' | 'head'
  | 'upperArmL' | 'upperArmR' | 'foreArmL' | 'foreArmR'
  | 'thighL' | 'thighR' | 'shinL' | 'shinR';

export const PART_NAMES: PartName[] = [
  'pelvis', 'chest', 'head', 'upperArmL', 'upperArmR', 'foreArmL', 'foreArmR', 'thighL', 'thighR', 'shinL', 'shinR',
];

export type Frames = Record<PartName, Mat4>;

/** Joint angles in radians. Positive shoulder/hip swings the limb forward; knees bend back (negative). */
export interface Pose {
  lean: number;
  headPitch: number;
  shoulderL: number;
  shoulderR: number;
  /** Raises the arms out sideways. */
  armOut: number;
  elbowL: number;
  elbowR: number;
  hipL: number;
  hipR: number;
  kneeL: number;
  kneeR: number;
}

export const REST_POSE: Pose = {
  lean: 0, headPitch: 0, shoulderL: 0, shoulderR: 0, armOut: 0.08,
  elbowL: 0.15, elbowR: 0.15, hipL: 0, hipR: 0, kneeL: -0.05, kneeR: -0.05,
};

// Skeleton, in the standing player's local space (feet at the origin, facing -z).
const PELVIS_Y = 0.98;
const WAIST: Vec3 = [0, 0.1, 0]; //    on the pelvis
const CHEST_UP = 0.22; //              waist -> chest centre
const NECK: Vec3 = [0, 0.23, 0]; //    on the chest
const HEAD_UP = 0.21; //               neck -> head centre
const SHOULDER: Vec3 = [0.33, 0.17, 0]; // on the chest (x mirrored)
const UPPER_ARM = 0.32;
const FOREARM = 0.3;
const HIP: Vec3 = [0.11, -0.08, 0]; // on the pelvis (x mirrored)
const THIGH = 0.42;
const SHIN = 0.4;

/** World frames at each part's centre for a pose, given the root (feet, facing) transform. */
export function poseFrames(root: Mat4, p: Pose): Frames {
  const pelvis = mul(root, translation([0, PELVIS_Y, 0]));
  const chest = mul(pelvis, translation(WAIST), rotationX(p.lean), translation([0, CHEST_UP, 0]));
  const head = mul(chest, translation(NECK), rotationX(p.headPitch), translation([0, HEAD_UP, 0]));
  const arm = (side: 1 | -1, shoulder: number, elbow: number) => {
    const upper = mul(
      chest,
      translation([SHOULDER[0] * side, SHOULDER[1], SHOULDER[2]]),
      rotationZ(p.armOut * side),
      rotationX(shoulder),
      translation([0, -UPPER_ARM / 2, 0]),
    );
    const fore = mul(upper, translation([0, -UPPER_ARM / 2, 0]), rotationX(elbow), translation([0, -FOREARM / 2, 0]));
    return [upper, fore];
  };
  const leg = (side: 1 | -1, hip: number, knee: number) => {
    const thigh = mul(pelvis, translation([HIP[0] * side, HIP[1], HIP[2]]), rotationX(hip), translation([0, -THIGH / 2, 0]));
    const shin = mul(thigh, translation([0, -THIGH / 2, 0]), rotationX(knee), translation([0, -SHIN / 2, 0]));
    return [thigh, shin];
  };
  const [upperArmL, foreArmL] = arm(-1, p.shoulderL, p.elbowL);
  const [upperArmR, foreArmR] = arm(1, p.shoulderR, p.elbowR);
  const [thighL, shinL] = leg(-1, p.hipL, p.kneeL);
  const [thighR, shinR] = leg(1, p.hipR, p.kneeR);
  return { pelvis, chest, head, upperArmL, upperArmR, foreArmL, foreArmR, thighL, thighR, shinL, shinR };
}

const SUIT = [0.95, 0.4, 0.07];
const PANTS = [0.18, 0.19, 0.22];
const SKIN = [0.8, 0.58, 0.45];
const HAIR = [0.12, 0.08, 0.05];
const PACK = [0.35, 0.37, 0.4];
const BOOT = [0.1, 0.09, 0.08];

export function drawBody(out: DrawItem[], f: Frames) {
  const rb = (m: Mat4, pos: Vec3, size: Vec3, color: number[]) =>
    out.push({ mesh: 'roundbox', model: mul(m, translation(pos), scaling(size)), color });
  const ball = (m: Mat4, pos: Vec3, size: Vec3, color: number[]) =>
    out.push({ mesh: 'sphere', model: mul(m, translation(pos), scaling(size)), color });

  rb(f.pelvis, [0, 0, 0], [0.36, 0.24, 0.25], PANTS);
  rb(f.chest, [0, 0, 0], [0.5, 0.5, 0.29], SUIT);
  rb(f.chest, [0, 0.02, 0.19], [0.38, 0.4, 0.14], PACK);
  ball(f.head, [0, 0, 0], [0.2, 0.23, 0.21], SKIN);
  ball(f.head, [0, 0.06, 0.03], [0.21, 0.2, 0.22], HAIR);
  for (const s of ['L', 'R'] as const) {
    rb(f[`upperArm${s}`], [0, 0, 0], [0.15, 0.36, 0.16], SUIT);
    rb(f[`foreArm${s}`], [0, 0, 0], [0.13, 0.33, 0.14], SUIT);
    ball(f[`foreArm${s}`], [0, -0.2, 0], [0.075, 0.08, 0.075], SKIN);
    rb(f[`thigh${s}`], [0, 0, 0], [0.19, 0.46, 0.21], PANTS);
    rb(f[`shin${s}`], [0, 0, 0], [0.16, 0.43, 0.18], PANTS);
    rb(f[`shin${s}`], [0, -0.2, -0.05], [0.16, 0.11, 0.28], BOOT);
  }
}

// ---------------------------------------------------------------------------------------
// Physical body
// ---------------------------------------------------------------------------------------

interface PartDef {
  collider: () => RAPIER.ColliderDesc;
  mass: number;
}

const PARTS: Record<PartName, PartDef> = {
  pelvis: { collider: () => RAPIER.ColliderDesc.roundCuboid(0.15, 0.09, 0.1, 0.03), mass: 12 },
  chest: { collider: () => RAPIER.ColliderDesc.roundCuboid(0.22, 0.21, 0.11, 0.035), mass: 22 },
  head: { collider: () => RAPIER.ColliderDesc.ball(0.21), mass: 5 },
  upperArmL: { collider: () => RAPIER.ColliderDesc.capsule(0.1, 0.07), mass: 2.5 },
  upperArmR: { collider: () => RAPIER.ColliderDesc.capsule(0.1, 0.07), mass: 2.5 },
  foreArmL: { collider: () => RAPIER.ColliderDesc.capsule(0.1, 0.065), mass: 1.8 },
  foreArmR: { collider: () => RAPIER.ColliderDesc.capsule(0.1, 0.065), mass: 1.8 },
  thighL: { collider: () => RAPIER.ColliderDesc.capsule(0.12, 0.09), mass: 8 },
  thighR: { collider: () => RAPIER.ColliderDesc.capsule(0.12, 0.09), mass: 8 },
  shinL: { collider: () => RAPIER.ColliderDesc.capsule(0.12, 0.08), mass: 4 },
  shinR: { collider: () => RAPIER.ColliderDesc.capsule(0.12, 0.08), mass: 4 },
};

type BallJointName = 'waist' | 'neck' | 'shoulderL' | 'shoulderR' | 'hipL' | 'hipR';
type HingeName = 'elbowL' | 'elbowR' | 'kneeL' | 'kneeR';

// [parent, child, anchor on parent, anchor on child], anchors relative to each part's centre.
const BALL_JOINTS: Record<BallJointName, [PartName, PartName, Vec3, Vec3]> = {
  waist: ['pelvis', 'chest', WAIST, [0, -CHEST_UP, 0]],
  neck: ['chest', 'head', NECK, [0, -HEAD_UP, 0]],
  shoulderL: ['chest', 'upperArmL', [-SHOULDER[0], SHOULDER[1], 0], [0, UPPER_ARM / 2, 0]],
  shoulderR: ['chest', 'upperArmR', SHOULDER, [0, UPPER_ARM / 2, 0]],
  hipL: ['pelvis', 'thighL', [-HIP[0], HIP[1], 0], [0, THIGH / 2, 0]],
  hipR: ['pelvis', 'thighR', HIP, [0, THIGH / 2, 0]],
};

// Hinges about local x, with limits so elbows and knees only bend the natural way.
const HINGES: Record<HingeName, [PartName, PartName, Vec3, Vec3, number, number]> = {
  elbowL: ['upperArmL', 'foreArmL', [0, -UPPER_ARM / 2, 0], [0, FOREARM / 2, 0], 0, 2.5],
  elbowR: ['upperArmR', 'foreArmR', [0, -UPPER_ARM / 2, 0], [0, FOREARM / 2, 0], 0, 2.5],
  kneeL: ['thighL', 'shinL', [0, -THIGH / 2, 0], [0, SHIN / 2, 0], -2.4, 0],
  kneeR: ['thighR', 'shinR', [0, -THIGH / 2, 0], [0, SHIN / 2, 0], -2.4, 0],
};

const v3 = (v: Vec3) => ({ x: v[0], y: v[1], z: v[2] });

/**
 * Rapier hands spherical joints back as a generic joint type without the motor methods, but
 * the underlying motor call works for any joint axis, so go through it directly.
 */
interface RawJointSet {
  jointConfigureMotorPosition(handle: number, axis: number, target: number, stiffness: number, damping: number): void;
  jointConfigureMotorVelocity(handle: number, axis: number, targetVel: number, factor: number): void;
}
const rawSet = (j: RAPIER.ImpulseJoint) => (j as unknown as { rawSet: RawJointSet }).rawSet;
const fromV = (v: { x: number; y: number; z: number }): Vec3 => [v.x, v.y, v.z];

/** Motor strength at full muscle (acceleration-based, so independent of part mass). */
const STIFFNESS = { ball: 7000, hinge: 5000 };
const DAMPING = { ball: 140, hinge: 110 };
/**
 * How hard each part is pulled toward its animated position/rotation at full muscle. The core
 * holds the body up; looser limbs let hits and momentum show.
 */
const MATCH: Record<PartName, number> = {
  pelvis: 1, chest: 1, head: 0.9,
  upperArmL: 0.45, upperArmR: 0.45, foreArmL: 0.35, foreArmR: 0.35,
  thighL: 0.7, thighR: 0.7, shinL: 0.6, shinR: 0.6,
};
/** Fraction of the remaining position/rotation error closed per substep. */
const MATCH_GAIN = 0.3;
/** Joint friction when limp, so ragdolls tumble rather than spin like wet noodles. */
const LIMP_FRICTION = 0.08;

/**
 * The player's physical body. With `muscle` 1 the pelvis tracks its target transform and the
 * joints track the pose (an active ragdoll that looks animated); lower muscle makes it floppy,
 * and 0 is a fully limp ragdoll.
 */
export class PhysBody {
  readonly parts = {} as Record<PartName, RAPIER.RigidBody>;
  readonly colliders: RAPIER.Collider[] = [];
  muscle = 1;
  /** Overall muscle strength (scales pose matching and joint motors); set by the player. */
  strength = 1;
  /** Fastest the parts may move / spin to catch up with their pose (m/s, rad/s). */
  catchUpSpeed = Infinity;
  catchUpSpin = Infinity;
  private balls = {} as Record<BallJointName, RAPIER.ImpulseJoint>;
  private hinges = {} as Record<HingeName, RAPIER.RevoluteImpulseJoint>;
  private enabled = true;
  private selfCollision = false;

  constructor(private physics: Physics, frames: Frames) {
    const world = physics.world;
    for (const name of PART_NAMES) {
      const m = frames[name];
      const rb = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(m[12], m[13], m[14])
          .setRotation(toQuat(m))
          .setAngularDamping(0.5)
          .setCcdEnabled(true),
      );
      const collider = world.createCollider(
        PARTS[name].collider()
          .setMass(PARTS[name].mass)
          .setFriction(0.8)
          .setRestitution(0.1)
          .setCollisionGroups(GROUPS_PLAYER_BODY),
        rb,
      );
      this.parts[name] = rb;
      this.colliders.push(collider);
    }
    for (const [name, [a, b, anchorA, anchorB]] of Object.entries(BALL_JOINTS) as [BallJointName, [PartName, PartName, Vec3, Vec3]][]) {
      const j = world.createImpulseJoint(
        RAPIER.JointData.spherical(v3(anchorA), v3(anchorB)), this.parts[a], this.parts[b], true,
      );
      j.setContactsEnabled(false);
      this.balls[name] = j;
    }
    for (const [name, [a, b, anchorA, anchorB, lo, hi]] of Object.entries(HINGES) as [HingeName, [PartName, PartName, Vec3, Vec3, number, number]][]) {
      const j = world.createImpulseJoint(
        RAPIER.JointData.revolute(v3(anchorA), v3(anchorB), { x: 1, y: 0, z: 0 }), this.parts[a], this.parts[b], true,
      ) as RAPIER.RevoluteImpulseJoint;
      j.setContactsEnabled(false);
      j.setLimits(lo, hi);
      this.hinges[name] = j;
    }
  }

  /** Moves every part to the given frames and stops it (used when switching back from scripted poses). */
  teleport(frames: Frames, velocity: Vec3 = [0, 0, 0]) {
    for (const name of PART_NAMES) {
      const rb = this.parts[name];
      const m = frames[name];
      rb.setTranslation({ x: m[12], y: m[13], z: m[14] }, true);
      rb.setRotation(toQuat(m), true);
      rb.setLinvel(v3(velocity), true);
      rb.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
  }

  setEnabled(enabled: boolean) {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    for (const name of PART_NAMES) this.parts[name].setEnabled(enabled);
  }

  /**
   * Limp bodies need self-collision so limbs can't pass through the torso. Animated bodies
   * leave it off: the animation keeps limbs apart, and self-contacts would let a tangled limb
   * get stuck fighting its target pose.
   */
  setSelfCollision(on: boolean) {
    if (on === this.selfCollision) return;
    this.selfCollision = on;
    for (const c of this.colliders) c.setCollisionGroups(on ? GROUPS_PLAYER_BODY_LIMP : GROUPS_PLAYER_BODY);
  }

  get isEnabled() {
    return this.enabled;
  }

  owns(collider: RAPIER.Collider) {
    return this.colliders.some((c) => c.handle === collider.handle);
  }

  frames(): Frames {
    const out = {} as Frames;
    for (const name of PART_NAMES) {
      const rb = this.parts[name];
      const t = rb.translation();
      out[name] = fromQuat(rb.rotation(), [t.x, t.y, t.z]);
    }
    return out;
  }

  position(name: PartName): Vec3 {
    return fromV(this.parts[name].translation());
  }

  velocity(name: PartName): Vec3 {
    return fromV(this.parts[name].linvel());
  }

  /** Adds the same velocity change to every part. */
  addVelocity(dv: Vec3) {
    for (const name of PART_NAMES) {
      const rb = this.parts[name];
      rb.setLinvel(v3(add(fromV(rb.linvel()), dv)), true);
    }
  }

  applyImpulse(name: PartName, impulse: Vec3) {
    this.parts[name].applyImpulse(v3(impulse), true);
  }

  /**
   * Called every physics substep. Pulls every part toward its animated frame in `targets`
   * (with the character's velocity as feed-forward) and the joint motors toward `pose`,
   * all scaled by `muscle`.
   */
  drive(h: number, targets: Frames, targetVel: Vec3, pose: Pose) {
    const m = this.muscle;
    const k = { ball: STIFFNESS.ball * this.strength, hinge: STIFFNESS.hinge * this.strength };
    const d = { ball: DAMPING.ball * this.strength, hinge: DAMPING.hinge * this.strength };
    const ball = (j: RAPIER.ImpulseJoint, x: number, z = 0) => {
      const raw = rawSet(j);
      if (m <= 0) {
        for (const axis of [RAPIER.JointAxis.AngX, RAPIER.JointAxis.AngY, RAPIER.JointAxis.AngZ]) {
          raw.jointConfigureMotorVelocity(j.handle, axis, 0, LIMP_FRICTION);
        }
        return;
      }
      raw.jointConfigureMotorPosition(j.handle, RAPIER.JointAxis.AngX, x, k.ball * m, d.ball * m);
      raw.jointConfigureMotorPosition(j.handle, RAPIER.JointAxis.AngY, 0, k.ball * m, d.ball * m);
      raw.jointConfigureMotorPosition(j.handle, RAPIER.JointAxis.AngZ, z, k.ball * m, d.ball * m);
    };
    const hinge = (j: RAPIER.RevoluteImpulseJoint, angle: number) => {
      if (m <= 0) j.configureMotorVelocity(0, LIMP_FRICTION);
      else j.configureMotorPosition(angle, k.hinge * m, d.hinge * m);
    };
    ball(this.balls.waist, pose.lean);
    ball(this.balls.neck, pose.headPitch);
    ball(this.balls.shoulderL, pose.shoulderL, -pose.armOut);
    ball(this.balls.shoulderR, pose.shoulderR, pose.armOut);
    ball(this.balls.hipL, pose.hipL);
    ball(this.balls.hipR, pose.hipR);
    hinge(this.hinges.elbowL, pose.elbowL);
    hinge(this.hinges.elbowR, pose.elbowR);
    hinge(this.hinges.kneeL, pose.kneeL);
    hinge(this.hinges.kneeR, pose.kneeR);
    if (m <= 0) return;

    for (const name of PART_NAMES) {
      const rb = this.parts[name];
      const w = Math.min(1, m * m * MATCH[name] * this.strength); // squared: recovering starts gently
      const target = targets[name];

      const goal: Vec3 = [target[12], target[13], target[14]];
      const wantV = add(clampLength(scale(sub(goal, fromV(rb.translation())), MATCH_GAIN / h), this.catchUpSpeed), targetVel);
      const v = fromV(rb.linvel());
      rb.setLinvel(v3(add(v, scale(sub(wantV, v), w))), true);

      let err = quatMul(toQuat(target), quatConj(rb.rotation() as Quat));
      if (err.w < 0) err = { x: -err.x, y: -err.y, z: -err.z, w: -err.w };
      const sinHalf = Math.sqrt(Math.max(0, 1 - err.w * err.w));
      const angle = 2 * Math.acos(Math.min(1, err.w));
      const axis: Vec3 = sinHalf > 1e-4 ? [err.x / sinHalf, err.y / sinHalf, err.z / sinHalf] : [0, 0, 0];
      const wantW = scale(axis, Math.min((angle * MATCH_GAIN) / h, this.catchUpSpin));
      const av = fromV(rb.angvel());
      rb.setAngvel(v3(add(av, scale(sub(wantW, av), w))), true);
    }
  }
}

function clampLength(v: Vec3, max: number): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > max ? scale(v, max / l) : v;
}

/** Root transform for a standing player: feet position and facing (yaw). */
export function standingRoot(feet: Vec3, facing: number): Mat4 {
  const c = Math.cos(facing), s = Math.sin(facing);
  return basis([c, 0, -s], [0, 1, 0], [s, 0, c], feet);
}



