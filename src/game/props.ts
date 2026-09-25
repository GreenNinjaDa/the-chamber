import { add, mul, rotationX, rotationY, scaling, translation, type Vec3 } from '../engine/math';
import type { Physics, Usable } from '../engine/physics';
import type { DrawItem } from '../engine/renderer';

const METAL = [0.28, 0.29, 0.31];
const DARK = [0.1, 0.1, 0.11];

/** A floor lever. E flips it; `onToggle` receives the new state. */
export class Lever implements Usable {
  on = false;
  highlight = 0;
  private angle = -0.6;
  private lastTime = 0;

  constructor(
    physics: Physics,
    private pos: Vec3,
    private yaw: number,
    private onToggle?: (on: boolean) => void,
  ) {
    const collider = physics.addStaticBox(add(pos, [0, 0.6, 0]), [0.6, 1.2, 0.6]);
    physics.registerUsable(collider, this);
    physics.addDrawable(this);
  }

  use() {
    this.on = !this.on;
    this.onToggle?.(this.on);
  }

  draw(out: DrawItem[], time: number) {
    const dt = Math.min(0.1, time - this.lastTime);
    this.lastTime = time;
    const target = this.on ? 0.6 : -0.6;
    this.angle += (target - this.angle) * (1 - Math.exp(-dt * 14));

    const base = mul(translation(this.pos), rotationY(this.yaw));
    out.push({ mesh: 'box', model: mul(base, translation([0, 0.15, 0]), scaling([0.55, 0.3, 0.4])), color: METAL, spec: 0.4 });
    const handle = mul(base, translation([0, 0.28, 0]), rotationX(this.angle));
    out.push({
      mesh: 'cylinder',
      model: mul(handle, translation([0, 0.45, 0]), scaling([0.05, 0.9, 0.05])),
      color: DARK,
      highlight: this.highlight,
    });
    out.push({
      mesh: 'sphere',
      model: mul(handle, translation([0, 0.92, 0]), scaling([0.1, 0.1, 0.1])),
      color: this.on ? [0.1, 0.8, 0.2] : [0.85, 0.1, 0.08],
      spec: 0.6,
      highlight: this.highlight,
    });
  }
}

/** A big button on a pedestal. E presses it; it springs back up. */
export class Button implements Usable {
  highlight = 0;
  private pressedAt = -10;
  private lastTime = 0;

  constructor(
    physics: Physics,
    private pos: Vec3,
    public color: number[],
    private onPress?: () => void,
  ) {
    const collider = physics.addStaticBox(add(pos, [0, 0.55, 0]), [0.7, 1.1, 0.7]);
    physics.registerUsable(collider, this);
    physics.addDrawable(this);
  }

  use() {
    this.pressedAt = this.lastTime;
    this.onPress?.();
  }

  draw(out: DrawItem[], time: number) {
    this.lastTime = time;
    const depress = time - this.pressedAt < 0.25 ? 0.07 : 0;
    const p = this.pos;
    out.push({ mesh: 'cylinder', model: mul(translation(add(p, [0, 0.5, 0])), scaling([0.3, 1, 0.3])), color: METAL, spec: 0.4 });
    out.push({ mesh: 'cylinder', model: mul(translation(add(p, [0, 1.02, 0])), scaling([0.34, 0.06, 0.34])), color: DARK });
    out.push({
      mesh: 'cylinder',
      model: mul(translation(add(p, [0, 1.1 - depress, 0])), scaling([0.24, 0.12, 0.24])),
      color: this.color,
      spec: 0.7,
      highlight: this.highlight,
    });
  }
}
