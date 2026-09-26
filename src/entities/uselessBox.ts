import { add, clamp, easeInOut, lerp3, mul, rotationX, rotationY, scaling, segment, translation, type Mat4, type Vec3 } from '../engine/math';
import type { Physics, Usable } from '../engine/physics';
import { Pattern, type DrawItem } from '../engine/renderer';

/*
 * A "useless box": a plain black box with a toggle switch on top. Flip the switch on and, after a
 * pause, the lid opens, an arm reaches out, flips it back off and hides again. You can't flip it
 * off yourself. Each time you switch it on, the box waits one second longer than the time before.
 */

const BODY = [0.018, 0.018, 0.022];
const TRIM = [0.16, 0.16, 0.17];
const BRASS = [0.72, 0.56, 0.24];
const ARM = [0.82, 0.82, 0.78];

const W = 0.8;
const H = 0.62;
const D = 0.7;
const LID_ANGLE = 1.25;
/** Switch handle tilt (radians from upright): on leans back toward the lid, off leans forward. */
const ON_TILT = -0.45;
const OFF_TILT = 0.45;
const HANDLE = 0.16;

const LID_TIME = 0.25;
const REACH_TIME = 0.35;
const PUSH_TIME = 0.15;

type Stage = 'idle' | 'waiting' | 'lid' | 'reach' | 'push' | 'retract' | 'close';

export class UselessBox implements Usable {
  highlight = 0;
  on = false;
  /** How many times it has been switched on. */
  flips = 0;
  private stage: Stage = 'idle';
  private t = 0;
  private delay = 0;
  private tilt = OFF_TILT;
  private lid = 0;
  private reach = 0;
  private readonly base: Mat4;
  // In box space: the switch pivot (front half of the top), and the arm's hinge under the lid.
  private readonly switchAt: Vec3 = [0, H, D / 4];
  private readonly armHinge: Vec3 = [0, H * 0.5, -D * 0.36];

  /**
   * `onChange(on)` fires when the switch flips either way. The player can't switch it off (only
   * the box gets to do that): E does nothing then. `yaw` 0 faces the front toward +z.
   */
  constructor(
    physics: Physics,
    pos: Vec3,
    yaw: number,
    private onChange?: (on: boolean) => void,
  ) {
    this.base = mul(translation(pos), rotationY(yaw));
    const collider = physics.addStaticBox(add(pos, [0, H / 2, 0]), [W, H, D]);
    physics.registerUsable(collider, this);
    physics.addDrawable(this);
  }

  use() {
    // Already on: only the box gets to switch it off. Mid-routine: the arm is still putting itself away.
    if (this.on || this.stage !== 'idle') return;
    this.on = true;
    this.flips++;
    this.delay = this.flips; // 1 s, then 2 s, 3 s...
    this.stage = 'waiting';
    this.t = 0;
    this.onChange?.(true);
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
        this.tilt += (OFF_TILT - this.tilt) * Math.min(1, dt * 20);
        break;
      case 'waiting':
        this.tilt += (ON_TILT - this.tilt) * Math.min(1, dt * 20);
        if (this.t >= this.delay) next('lid');
        break;
      case 'lid':
        this.lid = clamp(this.t / LID_TIME, 0, 1);
        if (this.t >= LID_TIME) next('reach');
        break;
      case 'reach':
        this.reach = clamp(this.t / REACH_TIME, 0, 1);
        if (this.t >= REACH_TIME) next('push');
        break;
      case 'push': {
        const k = clamp(this.t / PUSH_TIME, 0, 1);
        this.tilt = ON_TILT + (OFF_TILT - ON_TILT) * k;
        if (this.t >= PUSH_TIME) {
          this.on = false;
          this.onChange?.(false);
          next('retract');
        }
        break;
      }
      case 'retract':
        this.reach = 1 - clamp(this.t / REACH_TIME, 0, 1);
        if (this.t >= REACH_TIME) next('close');
        break;
      case 'close':
        this.lid = 1 - clamp(this.t / LID_TIME, 0, 1);
        if (this.t >= LID_TIME) next('idle');
        break;
    }
  }

  /** Tip of the switch handle at a given tilt, in box space. */
  private handleTip(tilt: number): Vec3 {
    return add(this.switchAt, [0, Math.cos(tilt) * HANDLE, Math.sin(tilt) * HANDLE]);
  }

  draw(out: DrawItem[], time: number) {
    const b = this.base;
    const hl = this.highlight;
    // The box: black, with a slightly raised rim around the top.
    out.push({ mesh: 'bevelbox', model: mul(b, translation([0, H / 2, 0]), scaling([W, H, D])), color: BODY, spec: 0.25, highlight: hl });
    out.push({ mesh: 'box', model: mul(b, translation([0, H - 0.01, D / 4]), scaling([W - 0.02, 0.03, D / 2 - 0.02])), color: TRIM, highlight: hl });
    // The lid over the back half, hinged at the back edge.
    const lidModel = mul(b, translation([0, H, -D / 2]), rotationX(-easeInOut(this.lid) * LID_ANGLE), translation([0, 0.015, D / 4]), scaling([W - 0.04, 0.03, D / 2 - 0.02]));
    out.push({ mesh: 'box', model: lidModel, color: BODY, spec: 0.3, highlight: hl });
    if (this.lid > 0.05) {
      // A dark hole under the lid.
      out.push({ mesh: 'box', model: mul(b, translation([0, H - 0.005, -D / 4]), scaling([W - 0.08, 0.012, D / 2 - 0.06])), color: [0.01, 0.01, 0.01] });
    }

    // The switch: a brass plate and a bat-handle toggle.
    out.push({ mesh: 'cylinder', model: mul(b, translation(add(this.switchAt, [0, 0.01, 0])), scaling([0.07, 0.02, 0.07])), color: BRASS, spec: 0.8, highlight: hl });
    const tip = this.handleTip(this.tilt);
    out.push({ mesh: 'cylinder', model: mul(b, segment(this.switchAt, tip, 0.017)), color: [0.75, 0.76, 0.78], spec: 0.9, highlight: hl });
    out.push({ mesh: 'sphere', model: mul(b, translation(tip), scaling([0.028, 0.028, 0.028])), color: [0.75, 0.76, 0.78], spec: 0.9, highlight: hl });
    // A little red light that's on while the switch is.
    out.push({
      mesh: 'sphere',
      model: mul(b, translation([W * 0.32, H + 0.005, D * 0.36]), scaling([0.022, 0.012, 0.022])),
      color: this.on ? [7, 0.3, 0.2] : [0.25, 0.02, 0.02],
      pattern: this.on ? Pattern.emissive : Pattern.plain,
      shadow: false,
    });

    // The arm: from its hinge inside the box, out of the lid and onto the back of the handle.
    if (this.reach > 0.01) {
      const stowed: Vec3 = add(this.armHinge, [0, 0.12, 0.04]);
      const onHandle = add(this.handleTip(this.tilt), [0, 0.01, -0.045]);
      const fingerTip = lerp3(stowed, onHandle, easeInOut(this.reach));
      out.push({ mesh: 'cylinder', model: mul(b, segment(this.armHinge, fingerTip, 0.035)), color: ARM, spec: 0.3 });
      out.push({ mesh: 'sphere', model: mul(b, translation(fingerTip), scaling([0.045, 0.045, 0.045])), color: ARM, spec: 0.3 });
    }
    void time;
  }
}
