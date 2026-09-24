import { mul, scaling, translation } from '../engine/math';
import { Pattern, type DrawItem } from '../engine/renderer';

/** The chamber interior spans [-CHAMBER_HALF, CHAMBER_HALF] on x and z. */
export const CHAMBER_HALF = 12;
export const WALL_HEIGHT = 10;

const WALL = [0.86, 0.87, 0.88];
const FLOOR = [0.6, 0.61, 0.63];
const OUTSIDE = [0.42, 0.44, 0.42];

export function drawChamber(out: DrawItem[]) {
  const size = CHAMBER_HALF * 2;
  const h = WALL_HEIGHT;
  const box = (pos: [number, number, number], s: [number, number, number], color: number[], param: number) =>
    out.push({
      mesh: 'box',
      model: mul(translation(pos), scaling(s)),
      color,
      pattern: Pattern.panels,
      param,
      spec: 0.15,
    });

  // Outside ground, just below the chamber floor.
  box([0, -0.6, 0], [900, 1, 900], OUTSIDE, 8);
  box([0, -0.25, 0], [size, 0.5, size], FLOOR, 2);
  // Four walls, no roof.
  const wy = (h - 0.2) / 2;
  box([0, wy, -CHAMBER_HALF - 0.5], [size + 2, h + 0.2, 1], WALL, 2);
  box([0, wy, CHAMBER_HALF + 0.5], [size + 2, h + 0.2, 1], WALL, 2);
  box([-CHAMBER_HALF - 0.5, wy, 0], [1, h + 0.2, size], WALL, 2);
  box([CHAMBER_HALF + 0.5, wy, 0], [1, h + 0.2, size], WALL, 2);
}
