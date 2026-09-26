import { sfx } from '../engine/audio';
import { add, mul, rotationX, rotationY, scale, scaling, transformDir, translation, type Mat4, type Vec3 } from '../engine/math';
import type { Physics, Usable } from '../engine/physics';
import { Pattern, type DrawItem } from '../engine/renderer';
import { PixelText } from './pixelText';

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
    sfx.click();
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
    sfx.button();
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

/**
 * A square button mounted on a wall, with a raised label (pixel digits) on its face. E or a
 * click presses it in; it springs back out. `pos` is where it meets the wall, and `yaw` turns
 * it (0: on the north wall, facing south, +z).
 */
export class WallButton implements Usable {
  highlight = 0;
  /** Lit up (the current choice). */
  lit = false;
  /** A gold rim round the backing plate. */
  rim = false;
  private pressedAt = -10;
  private lastTime = 0;
  private label: PixelText;
  private base: Mat4;

  constructor(
    physics: Physics,
    pos: Vec3,
    yaw: number,
    text: string,
    private onPress?: () => void,
  ) {
    this.base = mul(translation(pos), rotationY(yaw));
    const out = transformDir(this.base, [0, 0, 1]);
    const collider = physics.addStaticBox(add(pos, scale(out, WALL_BUTTON_DEPTH / 2)), [WALL_BUTTON_W, WALL_BUTTON_H, WALL_BUTTON_DEPTH], {
      x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2),
    });
    physics.registerUsable(collider, this);
    physics.addDrawable(this);
    // Raised lettering: from the pressed-in face to a little proud of the resting one.
    const face = WALL_BUTTON_DEPTH - WALL_BUTTON_TRAVEL;
    this.label = new PixelText({
      centre: add(pos, scale(out, face)),
      right: transformDir(this.base, [1, 0, 0]),
      up: [0, 1, 0],
      pixel: 0.085,
      color: [1.4, 1.4, 1.5],
      depth: WALL_BUTTON_TRAVEL + 0.025,
      pattern: Pattern.emissive,
    }, text);
  }

  use() {
    sfx.button();
    this.pressedAt = this.lastTime;
    this.onPress?.();
  }

  draw(out: DrawItem[], time: number) {
    this.lastTime = time;
    const depress = time - this.pressedAt < 0.25 ? WALL_BUTTON_TRAVEL : 0;
    const b = this.base;
    if (this.rim) {
      out.push({ mesh: 'bevelbox', model: mul(b, translation([0, 0, 0.02]), scaling([WALL_BUTTON_W + 0.5, WALL_BUTTON_H + 0.5, 0.04])), color: [1.25, 0.9, 0.3], pattern: Pattern.emissive, shadow: false });
    }
    out.push({ mesh: 'bevelbox', model: mul(b, translation([0, 0, 0.04]), scaling([WALL_BUTTON_W + 0.3, WALL_BUTTON_H + 0.3, 0.08])), color: METAL, spec: 0.4 });
    const d = WALL_BUTTON_DEPTH - depress;
    out.push({
      mesh: 'bevelbox',
      model: mul(b, translation([0, 0, d / 2]), scaling([WALL_BUTTON_W, WALL_BUTTON_H, d])),
      color: this.lit ? [0.08, 0.5, 0.16] : [0.12, 0.12, 0.15],
      pattern: this.lit ? Pattern.emissive : undefined,
      spec: 0.6,
      highlight: this.highlight,
    });
    const from = out.length;
    this.label.draw(out);
    for (let i = from; i < out.length; i++) out[i].shadow = false;
  }
}

const WALL_BUTTON_W = 1.3;
const WALL_BUTTON_H = 0.95;
const WALL_BUTTON_DEPTH = 0.2;
const WALL_BUTTON_TRAVEL = 0.08;
