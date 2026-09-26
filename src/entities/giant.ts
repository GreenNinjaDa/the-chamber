import {
  add, basis, clamp, cross, dot, length, mul, normalize, rotationX, rotationY, rotationZ,
  scale, scaling, segment, sub, transformPoint, translation,
  type Mat4, type Vec3,
} from '../engine/math';
import { Pattern, type DrawItem } from '../engine/renderer';

const SKIN = [0.86, 0.64, 0.5];
const SHIRT = [0.08, 0.26, 0.28];
const PANTS = [0.18, 0.2, 0.28];
const HAIR = [0.25, 0.15, 0.08];
const BELT = [0.2, 0.12, 0.07];

const UPPER_ARM = 28;
const FOREARM = 28;
const HIP_HEIGHT = 15;
const SHOULDER_WIDTH = 14;
const SHOULDER_HEIGHT = 27; // above the hip, in torso space
const HEAD_HEIGHT = 40;
/** Where held objects sit, in hand space (below the palm, toward the fingers). */
const GRASP_LOCAL: Vec3 = [0, -2.6, -3.0];

/**
 * A huge man built from primitives. He faces -z, his right arm (+x) is the grabbing
 * arm and solved with two-bone IK; his left hand rests on the south chamber wall.
 */
export class Giant {
  /** Feet position. Lower y to sink him into the ground. */
  root: Vec3 = [0, -80, 26];
  lean = 0.08;
  leanTarget = 0.08;
  rightCurl = 0;
  lookTarget: Vec3 = [0, 0, 0];
  headShake = 0;
  /** A party blindfold over his eyes (and a party hat). */
  blindfold = false;
  /** Draws the right (reaching) arm and hand see-through below 1, so it doesn't hide what it's reaching for. */
  armOpacity = 1;
  time = 0;

  graspPoint: Vec3 = [0, 0, 0];
  private torso: Mat4 = translation([0, 0, 0]);
  private headYaw = 0;
  private headPitch = 0;
  private arms: { shoulder: Vec3; elbow: Vec3; wrist: Vec3; hand: Mat4; curl: number; thumbSide: number }[] = [];

  shoulder(side: 1 | -1): Vec3 {
    return transformPoint(this.torso, [SHOULDER_WIDTH * side, SHOULDER_HEIGHT, 0]);
  }

  headCenter(): Vec3 {
    return transformPoint(this.torso, [0, HEAD_HEIGHT, 0]);
  }

  /** Poses the body so the right hand's grasp point reaches toward `grasp`. */
  update(dt: number, grasp: Vec3) {
    this.lean += (this.leanTarget - this.lean) * (1 - Math.exp(-dt * 3));
    const sway = Math.sin(this.time * 0.8) * 0.02;
    this.torso = mul(
      translation(add(this.root, [0, HIP_HEIGHT, 0])),
      rotationX(-(this.lean + sway)),
      rotationZ(Math.sin(this.time * 0.5) * 0.015),
    );

    // Right arm: aim the wrist so the grasp point lands on the target.
    const sR = this.shoulder(1);
    const f = horizontalDir(sub(grasp, sR));
    const wristTarget = add(sub(grasp, scale(f, -GRASP_LOCAL[2])), [0, -GRASP_LOCAL[1], 0]);
    const right = solveIK(sR, wristTarget, UPPER_ARM, FOREARM, [1, 0.3, 0.7]);
    const handR = handFrame(right.hand, f);
    this.graspPoint = transformPoint(handR, GRASP_LOCAL);

    // Left arm: palm on top of the south wall, fingers curled over the inside edge.
    const sL = this.shoulder(-1);
    const leftWrist: Vec3 = [-9, 10.9 + Math.min(0, this.root[1]), 15];
    const left = solveIK(sL, leftWrist, UPPER_ARM, FOREARM, [-1, 0.3, 0.7]);

    this.arms = [
      { shoulder: sR, elbow: right.elbow, wrist: right.hand, hand: handR, curl: this.rightCurl, thumbSide: -1 },
      { shoulder: sL, elbow: left.elbow, wrist: left.hand, hand: handFrame(left.hand, [0, 0, -1]), curl: 1.2, thumbSide: 1 },
    ];

    // Head tracks its look target (in world space, roughly corrected for the lean).
    const head = transformPoint(this.torso, [0, HEAD_HEIGHT, 0]);
    const d = sub(this.lookTarget, head);
    const yaw = clamp(Math.atan2(-d[0], -d[2]), -0.9, 0.9) + Math.sin(this.time * 9) * 0.35 * this.headShake;
    const pitch = clamp(Math.atan2(d[1], Math.hypot(d[0], d[2])) + this.lean, -0.9, 0.5);
    const k = 1 - Math.exp(-dt * 4);
    this.headYaw += (yaw - this.headYaw) * k;
    this.headPitch += (pitch - this.headPitch) * k;
  }

  draw(out: DrawItem[]) {
    const push = (mesh: DrawItem['mesh'], model: Mat4, color: number[], pattern: number = Pattern.plain) =>
      out.push({ mesh, model, color, pattern });
    const t = this.torso;

    for (const side of [-1, 1]) {
      push('box', mul(translation(add(this.root, [6.5 * side, 7.5, 0])), scaling([9, 15.5, 9])), PANTS);
    }
    push('box', mul(t, translation([0, 15, 0]), scaling([26, 30, 12])), SHIRT);
    push('box', mul(t, translation([0, 1, 0]), scaling([26.4, 2, 12.4])), BELT);
    push('cylinder', mul(t, translation([0, 32, 0]), scaling([3.2, 5, 3.2])), SKIN, Pattern.skin);

    const head = mul(t, translation([0, HEAD_HEIGHT, 0]), rotationY(this.headYaw), rotationX(this.headPitch));
    push('sphere', mul(head, scaling([8, 9.5, 8])), SKIN, Pattern.skin);
    push('sphere', mul(head, translation([0, 2.5, 1.2]), scaling([8.5, 8, 8.4])), HAIR);
    for (const side of [-1, 1]) {
      // (Under a blindfold the eyes would poke through it.)
      if (!this.blindfold) {
        push('sphere', mul(head, translation([2.9 * side, 1.8, -6.9]), scaling([1.4, 1.4, 1.4])), [0.95, 0.95, 0.92]);
        push('sphere', mul(head, translation([2.9 * side, 1.8, -8.1]), scaling([0.75, 0.75, 0.75])), [0.03, 0.03, 0.04]);
      }
      push('box', mul(head, translation([2.9 * side, 3.7, -7.3]), rotationZ(0.18 * side), scaling([3.4, 0.7, 0.9])), HAIR);
      push('sphere', mul(head, translation([8 * side, 0.5, 0]), scaling([1.2, 2.2, 1.4])), SKIN, Pattern.skin);
    }
    push('sphere', mul(head, translation([0, -0.6, -8.2]), scaling([1.3, 1.8, 1.5])), SKIN, Pattern.skin);
    push('box', mul(head, translation([0, -4.2, -7.0]), scaling([4, 0.5, 0.6])), [0.35, 0.08, 0.08]);
    if (this.blindfold) {
      push('cylinder', mul(head, translation([0, 1.9, 0]), scaling([8.25, 2.6, 8.25])), [0.12, 0.1, 0.35]);
      push('cone', mul(head, translation([0, 12.5, 0.5]), rotationX(-0.12), scaling([4.2, 7, 4.2])), [0.95, 0.3, 0.55]);
      push('sphere', mul(head, translation([0, 16.2, 0.1]), scaling([1.2, 1.2, 1.2])), [1, 0.9, 0.3]);
    }

    for (const arm of this.arms) {
      const first = out.length;
      push('sphere', mul(translation(arm.shoulder), scaling([4.5, 4.5, 4.5])), SHIRT);
      push('cylinder', segment(arm.shoulder, arm.elbow, 3.4), SHIRT);
      push('sphere', mul(translation(arm.elbow), scaling([3.1, 3.1, 3.1])), SKIN, Pattern.skin);
      push('cylinder', segment(arm.elbow, arm.wrist, 2.9), SKIN, Pattern.skin);
      push('sphere', mul(translation(arm.wrist), scaling([2.6, 2.6, 2.6])), SKIN, Pattern.skin);
      drawHand(out, arm.hand, arm.curl, arm.thumbSide);
      if (arm === this.arms[0] && this.armOpacity < 1) for (let i = first; i < out.length; i++) out[i].opacity = this.armOpacity;
    }
  }
}

function drawHand(out: DrawItem[], frame: Mat4, curl: number, thumbSide: number) {
  const push = (model: Mat4) => out.push({ mesh: 'box', model, color: SKIN, pattern: Pattern.skin });
  push(mul(frame, translation([0, 0, -2.2]), scaling([5.2, 1.8, 4.8])));
  for (const x of [-1.85, -0.62, 0.62, 1.85]) {
    const base = mul(frame, translation([x, 0, -4.4]), rotationX(-curl * 0.9));
    push(mul(base, translation([0, 0, -1.1]), scaling([1.1, 1.2, 2.4])));
    const tip = mul(base, translation([0, 0, -2.2]), rotationX(-curl * 1.1));
    push(mul(tip, translation([0, 0, -0.9]), scaling([1.0, 1.1, 2.0])));
  }
  const thumb = mul(
    frame,
    translation([2.9 * thumbSide, -0.2, -1.2]),
    rotationY(0.5 * thumbSide * (1 - curl * 0.6)),
    rotationX(-curl * 0.7),
  );
  push(mul(thumb, translation([0, 0, -1.4]), scaling([1.2, 1.2, 3])));
}

/** Palm-down hand frame: local -z points along `forward`, +y is world up. */
function handFrame(wrist: Vec3, forward: Vec3): Mat4 {
  const x = normalize(cross(forward, [0, 1, 0]));
  return basis(x, [0, 1, 0], scale(forward, -1), wrist);
}

function horizontalDir(v: Vec3): Vec3 {
  const h: Vec3 = [v[0], 0, v[2]];
  return length(h) > 0.5 ? normalize(h) : [0, 0, -1];
}

/** Two-bone IK. Returns the elbow and the (possibly clamped) hand position. */
function solveIK(s: Vec3, target: Vec3, a: number, b: number, pole: Vec3) {
  const d = sub(target, s);
  const dir = normalize(d);
  const dist = clamp(length(d), Math.abs(a - b) + 0.01, a + b - 0.01);
  const hand = add(s, scale(dir, dist));
  const x = (a * a - b * b + dist * dist) / (2 * dist);
  const h = Math.sqrt(Math.max(0, a * a - x * x));
  const p = normalize(sub(pole, scale(dir, dot(pole, dir))));
  return { elbow: add(add(s, scale(dir, x)), scale(p, h)), hand };
}
