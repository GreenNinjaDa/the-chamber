import { approachAngle, mul, scaling, translation, type Vec3 } from '../engine/math';
import type { DrawItem } from '../engine/renderer';
import { drawBody, poseFrames, standingRoot, type BodyColors, type Pose } from '../game/body';

/*
 * A security guard: the player's body in a grey uniform and a helmet, scripted (no physics).
 * The level steers them by setting `vel` (they turn to face where they're going) and `look`
 * (an extra head/body turn for glancing about); they animate a walk or a run from their speed.
 */

const UNIFORM: BodyColors = {
  suit: [0.3, 0.34, 0.4],
  pants: [0.22, 0.25, 0.3],
  skin: [0.78, 0.58, 0.46],
  hair: [0.1, 0.08, 0.06],
  pack: [0.15, 0.16, 0.18],
  boot: [0.06, 0.06, 0.07],
};

export class Guard {
  pos: Vec3;
  facing: number;
  vel: Vec3 = [0, 0, 0];
  private phase = Math.random() * 6;
  private amount = 0;

  constructor(pos: Vec3, facing: number) {
    this.pos = [...pos];
    this.facing = facing;
  }

  /** Where they're looking (unit, horizontal). */
  forward(): Vec3 {
    return [-Math.sin(this.facing), 0, -Math.cos(this.facing)];
  }

  eye(): Vec3 {
    return [this.pos[0], this.pos[1] + 1.6, this.pos[2]];
  }

  update(dt: number, turnTo?: number) {
    const hs = Math.hypot(this.vel[0], this.vel[2]);
    this.pos[0] += this.vel[0] * dt;
    this.pos[2] += this.vel[2] * dt;
    const want = turnTo ?? (hs > 0.05 ? Math.atan2(-this.vel[0], -this.vel[2]) : this.facing);
    this.facing = approachAngle(this.facing, want, dt * 6);
    this.amount += (Math.min(1.35, hs / 4.2) - this.amount) * (1 - Math.exp(-dt * 10));
    this.phase += dt * (hs > 0.05 ? 3 + hs * 1.3 : 0);
  }

  draw(out: DrawItem[]) {
    const a = this.amount, s = Math.sin(this.phase), c = Math.cos(this.phase);
    const pose: Pose = {
      lean: -0.12 * a, headPitch: 0.05, shoulderL: s * 0.55 * a, shoulderR: -s * 0.55 * a, armOut: 0.1,
      elbowL: 0.3 + 0.45 * a, elbowR: 0.3 + 0.45 * a, hipL: -s * 0.6 * a, hipR: s * 0.6 * a,
      kneeL: -0.05 - (0.1 + 1.0 * Math.max(0, -c)) * a, kneeR: -0.05 - (0.1 + 1.0 * Math.max(0, c)) * a,
    };
    const f = poseFrames(standingRoot(this.pos, this.facing), pose);
    drawBody(out, f, 1, UNIFORM);
    // Helmet and visor.
    out.push({ mesh: 'sphere', model: mul(f.head, translation([0, 0.08, 0.01]), scaling([0.23, 0.2, 0.24])), color: [0.22, 0.25, 0.3], spec: 0.5 });
    out.push({ mesh: 'box', model: mul(f.head, translation([0, 0.02, -0.19]), scaling([0.28, 0.07, 0.06])), color: [0.05, 0.06, 0.08], spec: 1 });
  }
}
