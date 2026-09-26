import {
  add, clamp, easeInOut, lerp3, mul, rotationX, rotationY, scaling, segment, toQuat, transformPoint, translation,
  type Mat4, type Vec3,
} from '../engine/math';
import { RAPIER, type Body, type Physics } from '../engine/physics';
import { Pattern, type DrawItem } from '../engine/renderer';

/*
 * A "useless box": a plain black box with a big toggle lever on top. The lever is a real physical
 * handle on a hinge: grab it (hold left click) and push it back to switch the box on. After a
 * pause the lid opens, an arm reaches out, shoves the lever back off and hides again. Once it's on
 * the lever is locked, so you can't switch it off yourself. Each time you switch it on, the box
 * waits one second longer than the time before, except that half the time it can't resist and
 * flips it straight back after 0.2 s.
 */

const BODY = [0.018, 0.018, 0.022];
const TRIM = [0.16, 0.16, 0.17];
const BRASS = [0.72, 0.56, 0.24];
const ARM = [0.82, 0.82, 0.78];
const HANDLE_COLOR = [0.75, 0.76, 0.78];

// Box-space dimensions (before `size` scaling).
const W = 0.8;
const H = 0.62;
const D = 0.7;
const LID_ANGLE = 1.25;
/** Lever tilt (radians from upright): on leans back toward the lid, off leans forward. */
const ON_TILT = -0.5;
const OFF_TILT = 0.5;
/** Lever length, its pivot's height above the lid, and its (visual) thickness. */
const HANDLE = 0.34;
const PIVOT_LIFT = 0.07;
const HANDLE_R = 0.028;
/** Within this of the back stop counts as switched on. */
const ON_SNAP = 0.12;
const HANDLE_MASS = 3;
/** Idle: a light spring back to off (the player's pull easily beats it). */
const SPRING_STIFFNESS = 25;
const SPRING_DAMPING = 3;

const LID_TIME = 0.25;
const REACH_TIME = 0.35;
const PUSH_TIME = 0.15;
/** Chance per flip that the box snaps it straight back, and how quickly. */
const IMPATIENT_CHANCE = 0.5;
const IMPATIENT_DELAY = 0.2;

type Stage = 'idle' | 'waiting' | 'lid' | 'reach' | 'push' | 'retract' | 'close';

export class UselessBox {
  on = false;
  /** How many times it has been switched on. */
  flips = 0;
  /** The lever: grab it with left click. */
  readonly handle: Body;
  private stage: Stage = 'idle';
  private t = 0;
  private delay = 0;
  /** Lever tilt this tick, read back from its physics body. */
  private tilt = OFF_TILT;
  private lid = 0;
  private reach = 0;
  private readonly base: Mat4;
  private readonly rot: Mat4;
  private readonly unrot: Mat4;
  private readonly size: number;
  private readonly joint: RAPIER.RevoluteImpulseJoint;
  // In box space: the lever's pivot (front half of the top), and the arm's hinge under the lid.
  private readonly pivot: Vec3 = [0, H + PIVOT_LIFT, D / 4];
  private readonly armHinge: Vec3 = [0, H * 0.5, -D * 0.36];

  /**
   * `onChange(on)` fires when the lever flips either way. `yaw` 0 faces the front toward +z;
   * `size` scales the whole box.
   */
  constructor(
    physics: Physics,
    pos: Vec3,
    yaw: number,
    private onChange?: (on: boolean) => void,
    size = 1,
  ) {
    this.size = size;
    this.rot = rotationY(yaw);
    this.unrot = rotationY(-yaw);
    this.base = mul(translation(pos), this.rot, scaling([size, size, size]));
    physics.addStaticBox(add(pos, [0, (H * size) / 2, 0]), [W * size, H * size, D * size], toQuat(this.rot));

    // The lever: a dynamic handle hinged (about the box's x axis) to a fixed anchor at its pivot.
    const pivotWorld = transformPoint(this.base, this.pivot);
    const len = HANDLE * size;
    const q = toQuat(this.rot);
    const anchor = physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(pivotWorld[0], pivotWorld[1], pivotWorld[2]).setRotation(q),
    );
    this.handle = physics.addCylinder(add(pivotWorld, [0, len / 2, 0]), 0.09 * size, len, {
      mass: HANDLE_MASS,
      rotation: q,
      model: (out, m) => {
        const r = HANDLE_R * size;
        out.push({ mesh: 'cylinder', model: mul(m, scaling([r, len, r])), color: HANDLE_COLOR, spec: 0.9, highlight: this.handle.highlight });
        out.push({ mesh: 'sphere', model: mul(m, translation([0, len / 2, 0]), scaling([r * 1.8, r * 1.8, r * 1.8])), color: HANDLE_COLOR, spec: 0.9, highlight: this.handle.highlight });
      },
    });
    this.handle.throwScale = 0;
    const data = RAPIER.JointData.revolute({ x: 0, y: 0, z: 0 }, { x: 0, y: -len / 2, z: 0 }, { x: 1, y: 0, z: 0 });
    this.joint = physics.world.createImpulseJoint(data, anchor, this.handle.rb, true) as RAPIER.RevoluteImpulseJoint;
    this.joint.setLimits(ON_TILT, OFF_TILT);
    this.joint.configureMotorPosition(OFF_TILT, SPRING_STIFFNESS, SPRING_DAMPING);
    physics.addDrawable(this);
  }

  /** The lever's tilt in box space, from its body's orientation. */
  private readTilt(): number {
    const q = this.handle.rb.rotation();
    // The handle's up axis in world space...
    const x = 2 * (q.x * q.y - q.w * q.z), y = 1 - 2 * (q.x * q.x + q.z * q.z), z = 2 * (q.y * q.z + q.w * q.x);
    // ...turned back into box space (undo the yaw).
    const inv = transformPoint(this.unrot, [x, y, z]);
    return Math.atan2(inv[2], inv[1]);
  }

  /** Locks the lever (kinematic) at a tilt, or frees it again (dynamic, spring back to off). */
  private lock(tilt: number | null) {
    const rb = this.handle.rb;
    if (tilt === null) {
      if (rb.bodyType() !== RAPIER.RigidBodyType.Dynamic) {
        rb.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
        rb.setLinvel({ x: 0, y: 0, z: 0 }, true);
        rb.setAngvel({ x: 0, y: 0, z: 0 }, true);
      }
      return;
    }
    if (rb.bodyType() !== RAPIER.RigidBodyType.KinematicPositionBased) {
      rb.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    }
    const len = HANDLE * this.size;
    const frame = mul(this.base, translation(this.pivot), rotationX(tilt));
    const centre = transformPoint(frame, [0, len / 2 / this.size, 0]);
    const q = toQuat(mul(this.rot, rotationX(tilt)));
    rb.setNextKinematicTranslation({ x: centre[0], y: centre[1], z: centre[2] });
    rb.setNextKinematicRotation(q);
  }

  /** Call every tick. */
  update(dt: number) {
    this.t += dt;
    const next = (stage: Stage) => {
      this.stage = stage;
      this.t = 0;
    };
    switch (this.stage) {
      case 'idle':
        this.tilt = this.readTilt();
        if (this.tilt < ON_TILT + ON_SNAP) {
          // Pushed all the way back: switched on. It stays locked there until the box says so.
          this.on = true;
          this.flips++;
          // 1 s, then 2 s, 3 s... unless it's feeling impatient.
          this.delay = Math.random() < IMPATIENT_CHANCE ? IMPATIENT_DELAY : this.flips;
          this.tilt = ON_TILT;
          this.lock(ON_TILT);
          this.onChange?.(true);
          next('waiting');
        }
        break;
      case 'waiting':
        this.lock(ON_TILT);
        if (this.t >= this.delay) next('lid');
        break;
      case 'lid':
        this.lock(ON_TILT);
        this.lid = clamp(this.t / LID_TIME, 0, 1);
        if (this.t >= LID_TIME) next('reach');
        break;
      case 'reach':
        this.lock(ON_TILT);
        this.reach = clamp(this.t / REACH_TIME, 0, 1);
        if (this.t >= REACH_TIME) next('push');
        break;
      case 'push': {
        const k = clamp(this.t / PUSH_TIME, 0, 1);
        this.tilt = ON_TILT + (OFF_TILT - ON_TILT) * k;
        this.lock(this.tilt);
        if (this.t >= PUSH_TIME) {
          this.on = false;
          this.onChange?.(false);
          next('retract');
        }
        break;
      }
      case 'retract':
        this.lock(OFF_TILT);
        this.reach = 1 - clamp(this.t / REACH_TIME, 0, 1);
        if (this.t >= REACH_TIME) next('close');
        break;
      case 'close':
        this.lid = 1 - clamp(this.t / LID_TIME, 0, 1);
        if (this.t >= LID_TIME) {
          this.lock(null);
          next('idle');
        }
        break;
    }
  }

  /** Tip of the lever at a given tilt, in box space. */
  private handleTip(tilt: number): Vec3 {
    return add(this.pivot, [0, Math.cos(tilt) * HANDLE, Math.sin(tilt) * HANDLE]);
  }

  draw(out: DrawItem[]) {
    const b = this.base;
    // The box: black, with a slightly raised rim around the top.
    out.push({ mesh: 'bevelbox', model: mul(b, translation([0, H / 2, 0]), scaling([W, H, D])), color: BODY, spec: 0.25 });
    out.push({ mesh: 'box', model: mul(b, translation([0, H - 0.01, D / 4]), scaling([W - 0.02, 0.03, D / 2 - 0.02])), color: TRIM });
    // The lid over the back half, hinged at the back edge.
    const lidModel = mul(b, translation([0, H, -D / 2]), rotationX(-easeInOut(this.lid) * LID_ANGLE), translation([0, 0.015, D / 4]), scaling([W - 0.04, 0.03, D / 2 - 0.02]));
    out.push({ mesh: 'box', model: lidModel, color: BODY, spec: 0.3 });
    if (this.lid > 0.05) {
      // A dark hole under the lid.
      out.push({ mesh: 'box', model: mul(b, translation([0, H - 0.005, -D / 4]), scaling([W - 0.08, 0.012, D / 2 - 0.06])), color: [0.01, 0.01, 0.01] });
    }

    // The lever's brass base (the handle draws itself as a physics body).
    out.push({ mesh: 'cylinder', model: mul(b, translation([0, H + PIVOT_LIFT / 2, D / 4]), scaling([0.09, PIVOT_LIFT, 0.09])), color: BRASS, spec: 0.8 });
    // A little red light that's on while the lever is.
    out.push({
      mesh: 'sphere',
      model: mul(b, translation([W * 0.32, H + 0.005, D * 0.36]), scaling([0.022, 0.012, 0.022])),
      color: this.on ? [7, 0.3, 0.2] : [0.25, 0.02, 0.02],
      pattern: this.on ? Pattern.emissive : Pattern.plain,
      shadow: false,
    });

    // The arm: from its hinge inside the box, out of the lid and onto the back of the lever.
    if (this.reach > 0.01) {
      const stowed: Vec3 = add(this.armHinge, [0, 0.12, 0.04]);
      const onHandle = add(this.handleTip(this.tilt), [0, 0.01, -0.045]);
      const fingerTip = lerp3(stowed, onHandle, easeInOut(this.reach));
      out.push({ mesh: 'cylinder', model: mul(b, segment(this.armHinge, fingerTip, 0.035)), color: ARM, spec: 0.3 });
      out.push({ mesh: 'sphere', model: mul(b, translation(fingerTip), scaling([0.045, 0.045, 0.045])), color: ARM, spec: 0.3 });
    }
  }
}

