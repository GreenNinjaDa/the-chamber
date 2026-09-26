import { add, lerp3, mul, rotationX, rotationY, rotationZ, scaling, segment, transformPoint, translation, type Mat4, type Vec3 } from '../engine/math';
import { Pattern, type DrawItem } from '../engine/renderer';
import { drawStar } from './pinball';

/*
 * A whack-a-mole mole (about 1.55 m): a fuzzy brown bean with a tan belly and muzzle, a big pink
 * nose, whiskers, buck teeth, little pink paws and feet, and (optionally) sunglasses. Scripted, no
 * physics: the level sets `pos` (feet), `yaw` and the animation knobs and draws it. It can be
 * flattened by a mallet (`squash`), see stars (`dazed`: X eyes and stars circling its head), wave
 * its paws (`armsUp`), waddle (`walk` / `walking`) and wiggle (`wiggle`, taunting).
 * Local frame: feet at the origin, facing -z.
 */

export const MOLE_HEIGHT = 1.55;
export const MOLE_RADIUS = 0.45;

export interface MoleLook {
  fur: number[];
  belly: number[];
  /** Cool shades instead of beady eyes. */
  shades: boolean;
}

export const MOLE_LOOKS: MoleLook[] = [
  { fur: [0.34, 0.22, 0.14], belly: [0.78, 0.6, 0.44], shades: true },
  { fur: [0.28, 0.2, 0.15], belly: [0.72, 0.58, 0.46], shades: false },
  { fur: [0.42, 0.28, 0.17], belly: [0.82, 0.66, 0.48], shades: false },
  { fur: [0.24, 0.18, 0.16], belly: [0.66, 0.55, 0.46], shades: true },
  { fur: [0.38, 0.25, 0.13], belly: [0.8, 0.62, 0.42], shades: false },
  { fur: [0.3, 0.24, 0.2], belly: [0.76, 0.64, 0.52], shades: false },
];

const PINK = [1.0, 0.45, 0.58];
const PAW = [0.95, 0.62, 0.62];
const TOOTH = [0.97, 0.95, 0.88];
const BLACK = [0.02, 0.02, 0.025];
const WHISKER = [0.12, 0.1, 0.09];
export const STAR_COLOR = [2.2, 1.8, 0.35];

export class Mole {
  pos: Vec3 = [0, 0, 0];
  yaw = 0;
  /** 0-1: flattened by a mallet (squashed down about the feet and spread out sideways). */
  squash = 0;
  /** Seconds of seeing stars left (X eyes, stars circling its head, a woozy sway). */
  dazed = 0;
  /** 0-1: paws up in the air (waving, taunting). */
  armsUp = 0;
  /** Walk cycle phase (advance it while it walks) and how much it's walking (0-1). */
  walk = 0;
  walking = 0;
  /** Side-to-side wiggle (radians of body roll), e.g. a taunting dance. */
  wiggle = 0;
  /** Glow on the whole mole (0-1), e.g. a flash when it's hit. */
  flash = 0;
  time = 0;

  constructor(public look: MoleLook) {}

  /** The top of its head (for labels), allowing for the squash. */
  top(): Vec3 {
    return [this.pos[0], this.pos[1] + MOLE_HEIGHT * (1 - 0.75 * this.squash), this.pos[2]];
  }

  draw(out: DrawItem[]) {
    drawMole(out, this.frame(), this.look, this);
  }

  /** The mole's frame: feet at the origin, squashed and swaying as it should be. */
  frame(): Mat4 {
    const s = this.squash;
    const sway = this.dazed > 0 ? Math.sin(this.time * 7) * 0.12 * Math.min(1, this.dazed) : 0;
    return mul(
      translation(this.pos),
      rotationY(this.yaw),
      rotationZ(this.wiggle + sway),
      scaling([1 + 0.85 * s, 1 - 0.75 * s, 1 + 0.85 * s]),
    );
  }
}

/** Draws a mole in `m` (feet at the origin, facing -z). */
export function drawMole(out: DrawItem[], m: Mat4, look: MoleLook, st: Pick<Mole, 'dazed' | 'armsUp' | 'walk' | 'walking' | 'time' | 'flash'>) {
  const first = out.length;
  const push = (mesh: DrawItem['mesh'], local: Mat4, color: number[], spec = 0.08) =>
    out.push({ mesh, model: mul(m, local), color, spec });
  const ball = (p: Vec3, s: Vec3, color: number[], spec = 0.08) => push('sphere', mul(translation(p), scaling(s)), color, spec);
  const fur = look.fur, belly = look.belly;
  const bob = Math.abs(Math.sin(st.walk)) * 0.05 * st.walking;

  // Body (the head is its top), belly and muzzle.
  ball([0, 0.78 + bob, 0], [0.5, 0.78, 0.46], fur);
  ball([0, 0.66 + bob, -0.2], [0.37, 0.5, 0.3], belly);
  ball([0, 1.2 + bob, -0.36], [0.22, 0.16, 0.22], belly);
  ball([0, 1.26 + bob, -0.57], [0.11, 0.1, 0.1], PINK, 0.7);
  // Buck teeth.
  for (const x of [-0.04, 0.04]) push('box', mul(translation([x, 1.07 + bob, -0.53]), scaling([0.065, 0.1, 0.03])), TOOTH, 0.4);
  // Ears.
  for (const x of [-0.34, 0.34]) ball([x, 1.36 + bob, -0.02], [0.09, 0.07, 0.05], fur);
  // Whiskers.
  for (const side of [-1, 1]) {
    for (const dy of [0.03, -0.04]) {
      const a: Vec3 = [0.17 * side, 1.22 + bob + dy, -0.47];
      const b: Vec3 = [0.6 * side, 1.26 + bob + dy * 2.2, -0.38];
      out.push({ mesh: 'cylinder', model: mul(m, segment(a, b, 0.008)), color: WHISKER, shadow: false });
    }
  }
  // Eyes: beady, X'd out when dazed, or behind shades.
  const eyeY = 1.4 + bob;
  if (st.dazed > 0) {
    for (const x of [-0.15, 0.15]) {
      for (const r of [0.8, -0.8]) push('box', mul(translation([x, eyeY, -0.41]), rotationZ(r), scaling([0.13, 0.025, 0.02])), BLACK);
    }
  } else if (look.shades) {
    for (const x of [-0.14, 0.14]) push('box', mul(translation([x, eyeY, -0.43]), rotationX(-0.1), scaling([0.2, 0.11, 0.035])), BLACK, 1.5);
    push('box', mul(translation([0, eyeY + 0.02, -0.44]), scaling([0.1, 0.025, 0.02])), BLACK);
    for (const x of [-0.26, 0.26]) push('box', mul(translation([x, eyeY + 0.02, -0.26]), scaling([0.02, 0.025, 0.34])), BLACK);
  } else {
    for (const x of [-0.15, 0.15]) {
      ball([x, eyeY, -0.39], [0.05, 0.055, 0.04], BLACK, 1.2);
      ball([x + 0.015, eyeY + 0.02, -0.425], [0.014, 0.014, 0.01], [1, 1, 1]);
    }
  }
  // Arms and paws: down by the belly, or up and waving.
  const up = st.armsUp;
  for (const side of [-1, 1]) {
    const wave = up > 0 ? Math.sin(st.time * 12 + side) * 0.12 * up : 0;
    const shoulder: Vec3 = [0.42 * side, 0.98 + bob, -0.12];
    const down: Vec3 = [0.5 * side, 0.72 + bob + Math.sin(st.walk + (side > 0 ? Math.PI : 0)) * 0.06 * st.walking, -0.32];
    const high: Vec3 = [0.66 * side, 1.62 + bob + wave, -0.22];
    const paw = lerp3(down, high, up);
    out.push({ mesh: 'cylinder', model: mul(m, segment(shoulder, paw, 0.09)), color: fur });
    ball(paw, [0.13, 0.08, 0.14], PAW);
    // Three little claws.
    for (const k of [-1, 0, 1]) ball(add(paw, [0.05 * k, up > 0.5 ? 0.07 : -0.03, -0.12]), [0.03, 0.03, 0.05], TOOTH);
  }
  // Feet (waddling).
  for (const side of [-1, 1]) {
    const step = Math.sin(st.walk + (side > 0 ? 0 : Math.PI)) * 0.16 * st.walking;
    ball([0.21 * side, 0.05, -0.12 + step], [0.14, 0.06, 0.22], PAW);
  }
  // A stubby tail.
  ball([0, 0.3, 0.44], [0.06, 0.06, 0.08], PAW);
  if (st.flash > 0) for (let i = first; i < out.length; i++) out[i].highlight = st.flash;

  // Seeing stars: three little stars circling over its head.
  if (st.dazed > 0) {
    const head = transformPoint(m, [0, 1.62, 0]);
    drawDazedStars(out, add(head, [0, 0.12, 0]), 0.5, st.time);
  }
}

/** Three Looney Tunes stars circling a point (over a dazed head), `r` metres out. */
export function drawDazedStars(out: DrawItem[], centre: Vec3, r: number, time: number, size = 0.13) {
  for (let k = 0; k < 3; k++) {
    const a = time * 4 + (k * Math.PI * 2) / 3;
    const p: Vec3 = [centre[0] + Math.cos(a) * r, centre[1] + Math.sin(a * 2) * 0.06, centre[2] + Math.sin(a) * r];
    drawStar(out, mul(translation(p), rotationY(-a + time * 3), rotationX(Math.PI / 2)), size, STAR_COLOR, 0.03, { pattern: Pattern.emissive });
  }
}
