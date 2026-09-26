import { approachAngle, clamp, mul, rotationX, rotationY, scaling, translation, type Mat4, type Vec3 } from '../engine/math';
import type { DrawItem } from '../engine/renderer';
import { drawBody, poseFrames, SIT_POSE, type BodyColors, type Pose } from '../game/body';

/*
 * A fellow test subject in a green tracksuit: the player's body model, scripted (no physics).
 * The level steers them by setting `vel`; they animate a walk / run from it, can freeze
 * mid-stride, do a few party pieces (wobbling, sneezing, cheering) and die dramatically.
 */

const TRACK_TOP = [0.13, 0.45, 0.38];
const TRACK_BOTTOM = [0.12, 0.4, 0.34];
const SNEAKER = [0.92, 0.92, 0.9];
const WHITE = [0.93, 0.93, 0.9];
const PATCH: Vec3 = [0.13, 0.08, 0.01];
const BACK_PATCH: Vec3 = [0.24, 0.16, 0.01];
const STRIPE: Vec3 = [0.01, 0.34, 0.035];
const GRAVITY = 20;
/** Pelvis height when lying flat on the floor (its centre, m). */
const LYING_PELVIS = 0.15;
const PELVIS_Y = 0.98;

export interface ContestantLook {
  /** Printed over their head. */
  number: string;
  hair: number[];
  skin?: number[];
  girth?: number;
  /** Hunched, with a shuffle instead of a walk. */
  old?: boolean;
}

export type ContestantAction = 'none' | 'wobble' | 'sneeze' | 'cheer' | 'sit';

export class Contestant {
  pos: Vec3;
  facing: number;
  /** Horizontal velocity the level wants (m/s); they turn to face where they're going. */
  vel: Vec3 = [0, 0, 0];
  /** Holds the pose they're in (mid-stride and all) instead of animating it. */
  frozen = false;
  action: ContestantAction = 'none';
  actionT = 0;
  state: 'alive' | 'dying' | 'dead' = 'alive';
  readonly colors: BodyColors;
  private phase = Math.random() * 6;
  private amount = 0;
  private t = Math.random() * 10;
  // Dying: flung through the air (pelvis height `fallY`), toppling by `tilt`, then lying still.
  private fallT = 0;
  private fallVel: Vec3 = [0, 0, 0];
  private fallY = PELVIS_Y;
  private fallVy = 0;
  private tilt = 0;
  private tiltTarget = 0;
  private flightTime = 0.5;
  private spin = 0;
  private landed = false;
  private landT = 0;
  private sprawl = Math.random();

  constructor(readonly look: ContestantLook, pos: Vec3, facing: number) {
    this.pos = [...pos];
    this.facing = facing;
    this.colors = {
      suit: TRACK_TOP, pants: TRACK_BOTTOM, skin: look.skin ?? [0.82, 0.62, 0.48], hair: look.hair, pack: null, boot: SNEAKER,
    };
  }

  get alive() {
    return this.state === 'alive';
  }

  /** Roughly where their chest is (for lasers). */
  chest(): Vec3 {
    if (this.state === 'alive') return [this.pos[0], this.pos[1] + 1.3, this.pos[2]];
    return [this.pos[0], this.fallY + 0.1, this.pos[2]];
  }

  /**
   * Eliminated: flung along `dir` (horizontal, unit) at `speed` m/s and `up` m/s, turning `flips`
   * extra somersaults on the way down and spinning `spin` rad/s about the vertical.
   */
  kill(dir: Vec3, speed: number, up: number, flips = 0, spin = 0) {
    if (this.state !== 'alive') return;
    this.state = 'dying';
    this.fallT = 0;
    this.fallVel = [dir[0] * speed, 0, dir[2] * speed];
    this.fallVy = up;
    this.fallY = PELVIS_Y;
    this.spin = spin;
    // Facing the blast: over backwards. Facing away: flat on their face.
    const fx = -Math.sin(this.facing), fz = -Math.cos(this.facing);
    const sign = fx * dir[0] + fz * dir[2] < 0 ? 1 : -1;
    this.tilt = 0;
    this.tiltTarget = sign * (Math.PI / 2 + flips * Math.PI * 2);
    // When the pelvis comes back down to lying height.
    const drop = PELVIS_Y - LYING_PELVIS;
    this.flightTime = (up + Math.sqrt(up * up + 2 * GRAVITY * drop)) / GRAVITY;
    this.frozen = false;
    this.action = 'none';
  }

  update(dt: number) {
    this.t += dt;
    if (this.state !== 'alive') return this.updateFall(dt);
    this.actionT += dt;
    const hs = Math.hypot(this.vel[0], this.vel[2]);
    this.pos[0] += this.vel[0] * dt;
    this.pos[2] += this.vel[2] * dt;
    if (hs > 0.05) this.facing = approachAngle(this.facing, Math.atan2(-this.vel[0], -this.vel[2]), dt * 8);
    if (this.frozen) return;
    const want = Math.min(1.35, hs / (this.look.old ? 1.6 : 4.2));
    this.amount += (want - this.amount) * (1 - Math.exp(-dt * 10));
    this.phase += dt * (hs > 0.05 ? 3 + hs * 1.3 : 0);
  }

  private updateFall(dt: number) {
    this.fallT += dt;
    const k = Math.exp(-dt * (this.landed ? 7 : 0.3));
    this.fallVel[0] *= k;
    this.fallVel[2] *= k;
    this.pos[0] += this.fallVel[0] * dt;
    this.pos[2] += this.fallVel[2] * dt;
    if (!this.landed) {
      this.fallVy -= GRAVITY * dt;
      this.fallY += this.fallVy * dt;
      this.facing += this.spin * dt;
      const p = clamp(this.fallT / this.flightTime, 0, 1);
      this.tilt = this.tiltTarget * (p * p * (3 - 2 * p));
      if (this.fallY <= LYING_PELVIS && this.fallT > 0.05) {
        this.landed = true;
        this.fallY = LYING_PELVIS;
        this.tilt = this.tiltTarget;
      }
      return;
    }
    // A little bounce on landing, then still.
    this.landT += dt;
    this.fallY = LYING_PELVIS + Math.abs(Math.sin(this.landT * 11)) * 0.14 * Math.exp(-this.landT * 6);
    if (this.landT > 1) this.state = 'dead';
  }

  private pose(): Pose {
    const t = this.t;
    if (this.state !== 'alive') {
      // Flailing in the air, then sprawled out.
      const flail = { lean: 0.2, headPitch: 0.4, shoulderL: 2.4 + Math.sin(t * 17) * 0.5, shoulderR: 2.2 + Math.cos(t * 15) * 0.5, armOut: 0.9, elbowL: 0.5, elbowR: 0.6, hipL: 0.7, hipR: 0.3, kneeL: -1.0, kneeR: -0.5 };
      const s = this.sprawl;
      const lying = { lean: 0, headPitch: 0.35, shoulderL: 0.3 + s * 0.6, shoulderR: -0.2 + s * 0.3, armOut: 1.1 + s * 0.4, elbowL: 0.4, elbowR: 0.2, hipL: 0.15, hipR: -0.1 - s * 0.2, kneeL: -0.3, kneeR: -0.1 };
      const k = this.landed ? clamp(this.landT / 0.25, 0, 1) : 0;
      return blend(flail, lying, k);
    }
    const a = this.amount, s = Math.sin(this.phase), c = Math.cos(this.phase);
    const old = this.look.old;
    const stride = old ? 0.35 : 1;
    // Frozen people can't help a tiny tremble.
    const tremble = this.frozen ? Math.sin(t * 31) * 0.025 : 0;
    const walk: Pose = {
      lean: (old ? -0.28 : -0.12 * a) + tremble,
      headPitch: (old ? 0.25 : 0.1 * a),
      shoulderL: s * 0.55 * a * stride + tremble,
      shoulderR: -s * 0.55 * a * stride - tremble,
      armOut: 0.08,
      elbowL: 0.2 + 0.45 * a + (old ? 0.4 : 0),
      elbowR: 0.2 + 0.45 * a + (old ? 0.4 : 0),
      hipL: -s * 0.6 * a * stride,
      hipR: s * 0.6 * a * stride,
      kneeL: -0.05 - (0.1 + 1.0 * Math.max(0, -c)) * a * stride - (old ? 0.15 : 0),
      kneeR: -0.05 - (0.1 + 1.0 * Math.max(0, c)) * a * stride - (old ? 0.15 : 0),
    };
    const at = this.actionT;
    switch (this.action) {
      case 'wobble': {
        // Lost their balance mid-stride: windmilling arms, one leg up, rocking.
        const k = clamp(at / 0.2, 0, 1);
        return blend(walk, {
          lean: Math.sin(at * 7) * 0.3, headPitch: 0.2, shoulderL: 1.6 + Math.sin(at * 13) * 1.2, shoulderR: 1.6 + Math.sin(at * 13 + Math.PI) * 1.2,
          armOut: 1.2, elbowL: 0.3, elbowR: 0.3, hipL: 0.8 + Math.sin(at * 5) * 0.2, hipR: -0.1, kneeL: -1.2, kneeR: -0.1,
        }, k);
      }
      case 'sneeze': {
        // Ah... ah... (head back, hands up) ...CHOO (doubled over).
        const wind = clamp(at / 0.5, 0, 1), choo = clamp((at - 0.75) / 0.08, 0, 1);
        const ah: Pose = { ...walk, lean: 0.25, headPitch: 0.5, shoulderL: 0.9, shoulderR: 0.9, elbowL: 1.9, elbowR: 1.9, armOut: 0.2 };
        const achoo: Pose = { ...walk, lean: -0.7, headPitch: -0.5, shoulderL: 1.2, shoulderR: 1.2, elbowL: 2.1, elbowR: 2.1, armOut: 0.15 };
        return blend(blend(walk, ah, wind), achoo, choo);
      }
      case 'cheer': {
        const k = clamp(at / 0.3, 0, 1);
        return blend(walk, {
          lean: 0.1, headPitch: 0.35, shoulderL: 2.8 + Math.sin(at * 11) * 0.25, shoulderR: 2.8 + Math.cos(at * 11) * 0.25, armOut: 0.45,
          elbowL: 0.3, elbowR: 0.3, hipL: 0, hipR: 0, kneeL: -0.1, kneeR: -0.1,
        }, k);
      }
      case 'sit':
        return blend(walk, SIT_POSE, clamp(at / 0.15, 0, 1));
      default:
        return walk;
    }
  }

  private root(): Mat4 {
    if (this.state !== 'alive') {
      // Pivot about the pelvis: flung, toppling, lying.
      return mul(translation([this.pos[0], this.fallY, this.pos[2]]), rotationY(this.facing), rotationX(this.tilt), translation([0, -PELVIS_Y, 0]));
    }
    const hop = this.action === 'cheer' ? Math.abs(Math.sin(this.actionT * 9)) * 0.12 : 0;
    return mul(translation([this.pos[0], this.pos[1] + hop, this.pos[2]]), rotationY(this.facing));
  }

  draw(out: DrawItem[]) {
    const f = poseFrames(this.root(), this.pose());
    drawBody(out, f, this.look.girth ?? 1, this.colors);
    // White number patches, front and back, and a white stripe down each sleeve.
    // (drawBody's chest front, belly included.)
    const deep = 1 + ((this.look.girth ?? 1) - 1) * 1.3;
    const front = 0.145 * (2 * deep - 1) + 0.004;
    out.push({ mesh: 'box', model: mul(f.chest, translation([0.12, 0.1, -front]), scaling(PATCH)), color: WHITE });
    out.push({ mesh: 'box', model: mul(f.chest, translation([0, 0.06, 0.149]), scaling(BACK_PATCH)), color: WHITE });
    out.push({ mesh: 'box', model: mul(f.upperArmL, translation([-0.076, 0, 0]), scaling(STRIPE)), color: WHITE });
    out.push({ mesh: 'box', model: mul(f.upperArmR, translation([0.076, 0, 0]), scaling(STRIPE)), color: WHITE });
  }
}

function blend(a: Pose, b: Pose, k: number): Pose {
  if (k <= 0) return a;
  if (k >= 1) return b;
  const l = (x: number, y: number) => x + (y - x) * k;
  return {
    lean: l(a.lean, b.lean), headPitch: l(a.headPitch, b.headPitch), shoulderL: l(a.shoulderL, b.shoulderL), shoulderR: l(a.shoulderR, b.shoulderR),
    armOut: l(a.armOut, b.armOut), elbowL: l(a.elbowL, b.elbowL), elbowR: l(a.elbowR, b.elbowR), hipL: l(a.hipL, b.hipL), hipR: l(a.hipR, b.hipR),
    kneeL: l(a.kneeL, b.kneeL), kneeR: l(a.kneeR, b.kneeR), crouch: l(a.crouch ?? 0, b.crouch ?? 0),
  };
}

