import { mul, rotationX, scaling, translation, type Vec3 } from '../engine/math';
import type { Physics } from '../engine/physics';
import { HOLE_PLATE_RATIO, Pattern, TUBE_INNER_RATIO, type DrawItem } from '../engine/renderer';

/** The chamber interior spans [-CHAMBER_HALF, CHAMBER_HALF] on x and z. */
export const CHAMBER_HALF = 12;
export const WALL_HEIGHT = 10;
const WALL_THICKNESS = 1;
const NORTH_Z = -CHAMBER_HALF - WALL_THICKNESS / 2;

const WALL = [0.86, 0.87, 0.88];
const FLOOR = [0.6, 0.61, 0.63];
const OUTSIDE = [0.42, 0.44, 0.42];
const HOLE_RIM = [0.85, 0.06, 0.04];

/** Per-level tweaks to the standard chamber. */
export interface ChamberOptions {
  /** A round hole through the north wall, centred at (x, y) on the wall, with this radius (m). */
  hole?: { x: number; y: number; radius: number };
  /** The light comes from below (e.g. lava): the floor and ground mustn't shadow everything above them. */
  litFromBelow?: boolean;
  /** No test chamber at all: the level builds its own map. */
  none?: boolean;
}

interface WallBox {
  pos: Vec3;
  size: Vec3;
  color: number[];
  panel: number;
}

/** The chamber's boxes: ground, floor and walls (the north wall split around the hole, if any). */
function chamberBoxes(opts: ChamberOptions): WallBox[] {
  if (opts.none) return [];
  const size = CHAMBER_HALF * 2;
  const h = WALL_HEIGHT;
  const bottom = -0.2, top = h;
  const wy = (bottom + top) / 2;
  const boxes: WallBox[] = [
    { pos: [0, -0.6, 0], size: [900, 1, 900], color: OUTSIDE, panel: 8 },
    { pos: [0, -0.25, 0], size: [size, 0.5, size], color: FLOOR, panel: 2 },
    { pos: [0, wy, CHAMBER_HALF + 0.5], size: [size + 2, h + 0.2, WALL_THICKNESS], color: WALL, panel: 2 },
    { pos: [-CHAMBER_HALF - 0.5, wy, 0], size: [WALL_THICKNESS, h + 0.2, size], color: WALL, panel: 2 },
    { pos: [CHAMBER_HALF + 0.5, wy, 0], size: [WALL_THICKNESS, h + 0.2, size], color: WALL, panel: 2 },
  ];
  const hole = opts.hole;
  const left = -CHAMBER_HALF - 1, right = CHAMBER_HALF + 1;
  if (!hole) {
    boxes.push({ pos: [0, wy, NORTH_Z], size: [size + 2, h + 0.2, WALL_THICKNESS], color: WALL, panel: 2 });
    return boxes;
  }
  // North wall as four pieces around a square opening that the hole plate fills.
  const half = plateSide(hole.radius) / 2;
  const x0 = hole.x - half, x1 = hole.x + half, y0 = hole.y - half, y1 = hole.y + half;
  const piece = (xa: number, xb: number, ya: number, yb: number) =>
    boxes.push({ pos: [(xa + xb) / 2, (ya + yb) / 2, NORTH_Z], size: [xb - xa, yb - ya, WALL_THICKNESS], color: WALL, panel: 2 });
  piece(left, x0, bottom, top);
  piece(x1, right, bottom, top);
  piece(x0, x1, bottom, y0);
  piece(x0, x1, y1, top);
  return boxes;
}

const plateSide = (radius: number) => radius / HOLE_PLATE_RATIO;

export function drawChamber(out: DrawItem[], opts: ChamberOptions = {}) {
  for (const b of chamberBoxes(opts)) {
    out.push({
      mesh: 'box',
      model: mul(translation(b.pos), scaling(b.size)),
      color: b.color,
      pattern: Pattern.panels,
      param: b.panel,
      spec: 0.15,
      shadow: opts.litFromBelow && b.pos[1] < 0 ? false : undefined,
    });
  }
  const hole = opts.hole;
  if (hole) {
    const center: Vec3 = [hole.x, hole.y, NORTH_Z];
    const side = plateSide(hole.radius);
    out.push({ mesh: 'holeplate', model: mul(translation(center), scaling([side, side, WALL_THICKNESS])), color: WALL, spec: 0.15 });
    // Red rim ringing the hole on both faces of the wall.
    // Slightly wider than the hole so its inner surface sits behind the white lining (no flicker).
    const rim = (hole.radius * 1.03) / TUBE_INNER_RATIO;
    out.push({
      mesh: 'tube',
      model: mul(translation(center), rotationX(Math.PI / 2), scaling([rim, WALL_THICKNESS + 0.04, rim])),
      color: HOLE_RIM,
      spec: 0.3,
    });
  }
}

/** Static colliders matching drawChamber. The hole is a 16-sided ring of boxes. */
export function addChamberColliders(physics: Physics, opts: ChamberOptions = {}) {
  for (const b of chamberBoxes(opts)) physics.addStaticBox(b.pos, b.size);
  const hole = opts.hole;
  if (!hole) return;
  const sides = 16;
  const thick = 0.45; // radial thickness: covers the plate out to its corners
  const r = hole.radius + thick / 2;
  const len = ((2 * Math.PI * r) / sides) * 1.15;
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    const pos: Vec3 = [hole.x + Math.cos(a) * r, hole.y + Math.sin(a) * r, NORTH_Z];
    const q = { x: 0, y: 0, z: Math.sin(a / 2), w: Math.cos(a / 2) };
    physics.addStaticBox(pos, [thick, len, WALL_THICKNESS], q);
  }
}
