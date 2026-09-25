import { add, mul, rotationY, scaling, transformPoint, translation, type Mat4, type Vec3 } from '../engine/math';
import type { Physics, Usable } from '../engine/physics';
import { Pattern, type DrawItem } from '../engine/renderer';

/*
 * A black forest cake on a pedestal, one slice already cut and pulled out. E on the slice eats it.
 * The cake is built from eight 45° wedges (seven for the cake, one for the slice), each a stack of
 * sponge, cream and glaze.
 */

const SPONGE = [0.24, 0.12, 0.07];
const CREAM = [0.96, 0.92, 0.86];
const GLAZE = [0.13, 0.06, 0.04];
const CHERRY = [0.62, 0.02, 0.05];
const STAND = [0.9, 0.91, 0.92];
const STAND_TRIM = [0.3, 0.31, 0.33];

const CAKE_R = 0.42;
const PEDESTAL_R = 0.5;
const PEDESTAL_H = 1.0;
const TOP_R = 0.72;
const SLICE = Math.PI / 4;
/** How far the cut slice has been pulled out from the cake. */
const PULL = 0.2;
const EAT_TIME = 0.9;

// Layers from the bottom: [colour, thickness, radius scale].
const LAYERS: [number[], number, number][] = [
  [SPONGE, 0.1, 1],
  [CREAM, 0.03, 1],
  [SPONGE, 0.1, 1],
  [CREAM, 0.025, 1],
  [GLAZE, 0.025, 1.02],
];
const CAKE_H = LAYERS.reduce((h, l) => h + l[1], 0);

export class Cake implements Usable {
  highlight = 0;
  /** 0 = whole slice, 1 = eaten. */
  eaten = 0;
  private eating = false;
  private readonly base: Mat4;

  /**
   * `onEat` runs when the slice is finished (and `onSeconds` when someone tries to eat it again).
   * `yaw` turns the gap in the cake to face a direction.
   */
  constructor(
    physics: Physics,
    private pos: Vec3,
    yaw: number,
    private onEat?: () => void,
    private onSeconds?: () => void,
  ) {
    this.base = mul(translation(pos), rotationY(yaw));
    physics.addStaticCylinder(add(pos, [0, PEDESTAL_H / 2, 0]), PEDESTAL_R + 0.05, PEDESTAL_H);
    physics.addStaticCylinder(add(pos, [0, PEDESTAL_H + CAKE_H / 2, 0]), CAKE_R, CAKE_H);
    // The slice's own (invisible) collider is what the crosshair targets.
    const slice = this.slicePoint(0.55);
    const collider = physics.addStaticCylinder(add(slice, [0, PEDESTAL_H + 0.1, 0]), 0.2, 0.3);
    physics.registerUsable(collider, this);
    physics.addDrawable(this);
  }

  /** A point along the middle of the cut slice, `t` of the way out from its tip (world space). */
  private slicePoint(t: number): Vec3 {
    const out = PULL + CAKE_R * t;
    const local: Vec3 = [Math.cos(SLICE / 2) * out, 0, Math.sin(SLICE / 2) * out];
    const p = transformPoint(this.base, local);
    return [p[0], this.pos[1], p[2]];
  }

  use() {
    if (this.eaten >= 1) this.onSeconds?.();
    else this.eating = true;
  }

  /** Call every tick (eating takes a moment). */
  update(dt: number) {
    if (!this.eating || this.eaten >= 1) return;
    this.eaten = Math.min(1, this.eaten + dt / EAT_TIME);
    if (this.eaten >= 1) this.onEat?.();
  }

  draw(out: DrawItem[], time: number) {
    const b = this.base;
    // The pedestal: a white column with dark rims, and a wide top.
    out.push({ mesh: 'cylinder', model: mul(b, translation([0, PEDESTAL_H / 2, 0]), scaling([PEDESTAL_R, PEDESTAL_H, PEDESTAL_R])), color: STAND, spec: 0.3 });
    out.push({ mesh: 'cylinder', model: mul(b, translation([0, 0.04, 0]), scaling([PEDESTAL_R + 0.08, 0.08, PEDESTAL_R + 0.08])), color: STAND_TRIM });
    out.push({ mesh: 'cylinder', model: mul(b, translation([0, PEDESTAL_H - 0.03, 0]), scaling([TOP_R, 0.06, TOP_R])), color: STAND, spec: 0.4 });
    out.push({ mesh: 'cylinder', model: mul(b, translation([0, PEDESTAL_H - 0.075, 0]), scaling([TOP_R - 0.03, 0.04, TOP_R - 0.03])), color: STAND_TRIM });

    // Seven slices of cake, the eighth pulled out.
    for (let k = 1; k < 8; k++) this.drawSlice(out, mul(b, rotationY(-k * SLICE)), 1);
    const left = 1 - this.eaten;
    if (left > 0.02) {
      // Eaten from the pointy end: shrink toward the crust.
      const dir: Vec3 = [Math.cos(SLICE / 2), 0, Math.sin(SLICE / 2)];
      const shift = PULL + CAKE_R * (1 - left);
      this.drawSlice(out, mul(b, translation([dir[0] * shift, 0, dir[2] * shift])), left, this.highlight);
    }

    // Candle and flame in the middle.
    const top = PEDESTAL_H + CAKE_H;
    out.push({ mesh: 'cylinder', model: mul(b, translation([0, top + 0.09, 0]), scaling([0.018, 0.18, 0.018])), color: [0.95, 0.95, 0.9] });
    const flicker = 1 + Math.sin(time * 23) * 0.12 + Math.sin(time * 37) * 0.08;
    out.push({
      mesh: 'sphere',
      model: mul(b, translation([0, top + 0.21, 0]), scaling([0.018, 0.035 * flicker, 0.018])),
      color: [6, 3.4, 0.9],
      pattern: Pattern.emissive,
      shadow: false,
    });
  }

  /** One 45° slice, `size` of full radius (eaten slices shrink toward their crust), with its cherry. */
  private drawSlice(out: DrawItem[], m: Mat4, size: number, highlight = 0) {
    let y = PEDESTAL_H;
    const r = CAKE_R * size;
    for (const [color, h, rs] of LAYERS) {
      out.push({ mesh: 'wedge', model: mul(m, translation([0, y + h / 2, 0]), scaling([r * rs, h, r * rs])), color, spec: color === GLAZE ? 0.6 : 0.1, highlight });
      y += h;
    }
    // A cream dollop and a cherry near the crust, on every slice.
    if (size < 0.35) return;
    const a = SLICE / 2;
    const at = CAKE_R * 0.78 - CAKE_R * (1 - size);
    const p: Vec3 = [Math.cos(a) * at, y + 0.02, Math.sin(a) * at];
    out.push({ mesh: 'sphere', model: mul(m, translation(p), scaling([0.045, 0.03, 0.045])), color: CREAM, highlight });
    out.push({ mesh: 'sphere', model: mul(m, translation(add(p, [0, 0.045, 0])), scaling([0.032, 0.032, 0.032])), color: CHERRY, spec: 0.9, highlight });
  }
}
