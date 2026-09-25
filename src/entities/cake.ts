import { add, mul, rotationY, scale, scaling, transformPoint, translation, type Mat4, type Vec3 } from '../engine/math';
import type { Physics, RAPIER, Usable } from '../engine/physics';
import { Pattern, type DrawItem } from '../engine/renderer';

/*
 * A black forest cake on a pedestal, made of eight 45° slices, each a stack of sponge, cream and
 * glaze with a cherry on top. One slice starts cut and pulled out; that one has to be eaten first,
 * then E on any other slice eats that one too.
 */

const SPONGE = [0.24, 0.12, 0.07];
const CREAM = [0.96, 0.92, 0.86];
const GLAZE = [0.13, 0.06, 0.04];
const CHERRY = [0.62, 0.02, 0.05];
const STAND = [0.9, 0.91, 0.92];
const STAND_TRIM = [0.3, 0.31, 0.33];

export const CAKE_SLICES = 8;
const CAKE_R = 0.42;
const PEDESTAL_R = 0.5;
const PEDESTAL_H = 1.0;
const TOP_R = 0.72;
const SLICE = (Math.PI * 2) / CAKE_SLICES;
/** How far the first (already cut) slice has been pulled out from the cake. */
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
/** Direction of a slice's middle in its own frame. */
const MID: Vec3 = [Math.cos(SLICE / 2), 0, Math.sin(SLICE / 2)];

class Slice implements Usable {
  highlight = 0;
  /** 0 = whole, 1 = gone. */
  eaten = 0;
  eating = false;
  collider: RAPIER.Collider | null = null;

  constructor(
    private cake: Cake,
    readonly index: number,
    /** The slice's frame: rotated into place around the cake, and pulled out if it's the cut one. */
    readonly frame: Mat4,
  ) {}

  use() {
    this.cake.tryEat(this);
  }
}

export class Cake {
  /** Slices eaten so far. */
  eatenCount = 0;
  private slices: Slice[] = [];
  private readonly base: Mat4;

  /**
   * `onEat(n)` runs as the nth slice is finished; `onRefuse` when someone goes for an uncut slice
   * before the cut one. `yaw` turns the cut slice to face a direction.
   */
  constructor(
    private physics: Physics,
    pos: Vec3,
    yaw: number,
    private onEat?: (count: number) => void,
    private onRefuse?: () => void,
  ) {
    this.base = mul(translation(pos), rotationY(yaw));
    physics.addStaticCylinder(add(pos, [0, PEDESTAL_H / 2, 0]), PEDESTAL_R + 0.05, PEDESTAL_H);
    for (let k = 0; k < CAKE_SLICES; k++) {
      const pull = k === 0 ? PULL : 0;
      const frame = mul(this.base, rotationY(-k * SLICE), translation([MID[0] * pull, 0, MID[2] * pull]));
      const slice = new Slice(this, k, frame);
      // Each slice has its own (invisible) collider: it's what the crosshair targets, and together
      // they make the cake solid.
      const c = transformPoint(frame, scale(MID, CAKE_R * 0.55));
      slice.collider = physics.addStaticCylinder([c[0], pos[1] + PEDESTAL_H + CAKE_H / 2, c[2]], 0.19, CAKE_H + 0.05);
      physics.registerUsable(slice.collider, slice);
      this.slices.push(slice);
    }
    physics.addDrawable(this);
  }

  tryEat(slice: Slice) {
    if (slice.eaten > 0 || this.slices.some((s) => s.eating)) return;
    if (this.eatenCount === 0 && slice.index !== 0) {
      this.onRefuse?.();
      return;
    }
    slice.eating = true;
  }

  /** Call every tick (eating takes a moment). */
  update(dt: number) {
    for (const s of this.slices) {
      if (!s.eating) continue;
      s.eaten = Math.min(1, s.eaten + dt / EAT_TIME);
      if (s.eaten < 1) continue;
      s.eating = false;
      if (s.collider) this.physics.world.removeCollider(s.collider, false);
      s.collider = null;
      this.eatenCount++;
      this.onEat?.(this.eatenCount);
    }
  }

  draw(out: DrawItem[], time: number) {
    const b = this.base;
    // The pedestal: a white column with dark rims, and a wide top.
    out.push({ mesh: 'cylinder', model: mul(b, translation([0, PEDESTAL_H / 2, 0]), scaling([PEDESTAL_R, PEDESTAL_H, PEDESTAL_R])), color: STAND, spec: 0.3 });
    out.push({ mesh: 'cylinder', model: mul(b, translation([0, 0.04, 0]), scaling([PEDESTAL_R + 0.08, 0.08, PEDESTAL_R + 0.08])), color: STAND_TRIM });
    out.push({ mesh: 'cylinder', model: mul(b, translation([0, PEDESTAL_H - 0.03, 0]), scaling([TOP_R, 0.06, TOP_R])), color: STAND, spec: 0.4 });
    out.push({ mesh: 'cylinder', model: mul(b, translation([0, PEDESTAL_H - 0.075, 0]), scaling([TOP_R - 0.03, 0.04, TOP_R - 0.03])), color: STAND_TRIM });

    for (const s of this.slices) {
      const left = 1 - s.eaten;
      if (left <= 0.02) continue;
      // Eaten from the pointy end: shrink toward the crust.
      const shift = CAKE_R * (1 - left);
      this.drawSlice(out, mul(s.frame, translation([MID[0] * shift, 0, MID[2] * shift])), left, s.highlight);
    }

    // Candle and flame in the middle (until there's nothing left to stand on).
    if (this.eatenCount >= CAKE_SLICES) return;
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

  /** One slice, `size` of full radius (eaten slices shrink toward their crust), with its cherry. */
  private drawSlice(out: DrawItem[], m: Mat4, size: number, highlight: number) {
    let y = PEDESTAL_H;
    const r = CAKE_R * size;
    for (const [color, h, rs] of LAYERS) {
      out.push({ mesh: 'wedge', model: mul(m, translation([0, y + h / 2, 0]), scaling([r * rs, h, r * rs])), color, spec: color === GLAZE ? 0.6 : 0.1, highlight });
      y += h;
    }
    // A cream dollop and a cherry near the crust.
    if (size < 0.35) return;
    const at = CAKE_R * 0.78 - CAKE_R * (1 - size);
    const p: Vec3 = [MID[0] * at, y + 0.02, MID[2] * at];
    out.push({ mesh: 'sphere', model: mul(m, translation(p), scaling([0.045, 0.03, 0.045])), color: CREAM, highlight });
    out.push({ mesh: 'sphere', model: mul(m, translation(add(p, [0, 0.045, 0])), scaling([0.032, 0.032, 0.032])), color: CHERRY, spec: 0.9, highlight });
  }
}
