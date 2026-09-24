import {
  basis, cross, mul, normalize, rotationX, rotationY, scale, scaling, translation,
  type Mat4, type Vec3,
} from '../../engine/math';
import type { DrawItem } from '../../engine/renderer';

/** Distance from the tip to the grip point where the giant holds a dart. */
export const DART_GRIP = 0.9;

const METAL = [0.55, 0.57, 0.6];
const DARK = [0.08, 0.08, 0.09];

/** Dart frame: origin at the tip, local +y runs back toward the flights, tip points along `dir`. */
export function dartMatrix(tip: Vec3, dir: Vec3): Mat4 {
  const y = normalize(scale(dir, -1));
  const helper: Vec3 = Math.abs(y[1]) < 0.95 ? [0, 1, 0] : [1, 0, 0];
  const x = normalize(cross(helper, y));
  const z = cross(x, y);
  return basis(x, y, z, tip);
}

/** A player-sized (≈1.9 m) steel-tip dart. */
export function drawDart(out: DrawItem[], m: Mat4, flightColor: number[]) {
  out.push({ mesh: 'cone', model: mul(m, translation([0, 0.225, 0]), rotationX(Math.PI), scaling([0.09, 0.45, 0.09])), color: METAL, spec: 0.8 });
  out.push({ mesh: 'cylinder', model: mul(m, translation([0, 0.75, 0]), scaling([0.13, 0.6, 0.13])), color: METAL, spec: 0.8 });
  for (const y of [0.6, 0.75, 0.9]) {
    out.push({ mesh: 'cylinder', model: mul(m, translation([0, y, 0]), scaling([0.137, 0.04, 0.137])), color: DARK });
  }
  out.push({ mesh: 'cylinder', model: mul(m, translation([0, 1.3, 0]), scaling([0.05, 0.5, 0.05])), color: DARK });
  for (const a of [0, Math.PI / 2]) {
    out.push({ mesh: 'box', model: mul(m, translation([0, 1.62, 0]), rotationY(a), scaling([0.5, 0.55, 0.02])), color: flightColor });
  }
}
