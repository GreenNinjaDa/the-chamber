import { mul, scaling, translation, type Vec3 } from '../../engine/math';
import type { Physics, RAPIER } from '../../engine/physics';
import { Pattern, type DrawItem } from '../../engine/renderer';
import { CHAMBER_HALF } from '../../game/chamber';

/*
 * The maze: a 13 x 13 grid of cells over the chamber floor. '#' is wall, '.' a pellet, 'o' a power
 * pellet, ' ' an empty corridor, 'P' where the player starts, 'H' the ghost house and '=' its door.
 * Symmetric, no dead ends, no open 2 x 2 squares, and every corridor connected.
 */
const LAYOUT = [
  'o.....#.....o',
  '.##.#.#.#.##.',
  '.##.#...#.##.',
  '.....###.....',
  '.###     ###.',
  '.### H=H ###.',
  '....     ....',
  '.### HHH ###.',
  '.###     ###.',
  '.....###.....',
  '.##.#.P.#.##.',
  '.##.#.#.#.##.',
  'o.....#.....o',
];

export const COLS = LAYOUT[0].length;
export const ROWS = LAYOUT.length;
/** Cell size (m): the grid spans the whole chamber. */
export const CELL = (CHAMBER_HALF * 2) / COLS;
/** Wall blocks stop this far (m) short of their cells' edges, so corridors are CELL + 2 x INSET wide. */
const INSET = 0.2;
/** Too tall to jump onto (a jump clears about 1.28 m), low enough for the camera to see over. */
export const MAZE_WALL_HEIGHT = 1.5;
/** The ghost house's cells, its door, and the corridor cell in front of the door. */
export const HOUSE = { i0: 5, i1: 7, j0: 5, j1: 7 };
export const DOOR_CELL = { i: 6, j: 5 };
export const EXIT_CELL = { i: 6, j: 4 };
const HOUSE_WALL = 0.3;
const DOOR_HALF_WIDTH = 0.75;

export const cellX = (i: number) => -CHAMBER_HALF + (i + 0.5) * CELL;
export const cellZ = (j: number) => -CHAMBER_HALF + (j + 0.5) * CELL;
/** Continuous cell coordinates of a world position (cell centres are whole numbers). */
export const toCellX = (x: number) => (x + CHAMBER_HALF) / CELL - 0.5;
export const toCellZ = (z: number) => (z + CHAMBER_HALF) / CELL - 0.5;

const tile = (i: number, j: number) => (i >= 0 && j >= 0 && i < COLS && j < ROWS ? LAYOUT[j][i] : '#');
/** Corridor cells, where the player and roaming ghosts go. */
export const walkable = (i: number, j: number) => '.o P'.includes(tile(i, j));

export interface Rect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

export interface PelletSpot {
  i: number;
  j: number;
  power: boolean;
}

export const PELLET_SPOTS: PelletSpot[] = [];
for (let j = 0; j < ROWS; j++) {
  for (let i = 0; i < COLS; i++) {
    const c = tile(i, j);
    if (c === '.' || c === 'o') PELLET_SPOTS.push({ i, j, power: c === 'o' });
  }
}

export const START_CELL = (() => {
  for (let j = 0; j < ROWS; j++) for (let i = 0; i < COLS; i++) if (tile(i, j) === 'P') return { i, j };
  return { i: 6, j: ROWS - 3 };
})();

/** The wall cells merged into rectangles, inset from the corridors (but flush with the chamber walls). */
function wallRects(): Rect[] {
  const used = new Set<number>();
  const isWall = (i: number, j: number) => tile(i, j) === '#' && i >= 0 && j >= 0 && i < COLS && j < ROWS && !used.has(j * COLS + i);
  const rects: Rect[] = [];
  for (let j = 0; j < ROWS; j++) {
    for (let i = 0; i < COLS; i++) {
      if (!isWall(i, j)) continue;
      let i1 = i;
      while (isWall(i1 + 1, j)) i1++;
      let j1 = j;
      const rowFree = (jj: number) => {
        for (let k = i; k <= i1; k++) if (!isWall(k, jj)) return false;
        return true;
      };
      while (rowFree(j1 + 1)) j1++;
      for (let jj = j; jj <= j1; jj++) for (let k = i; k <= i1; k++) used.add(jj * COLS + k);
      rects.push({
        x0: -CHAMBER_HALF + i * CELL + (i > 0 ? INSET : 0),
        x1: -CHAMBER_HALF + (i1 + 1) * CELL - (i1 < COLS - 1 ? INSET : 0),
        z0: -CHAMBER_HALF + j * CELL + (j > 0 ? INSET : 0),
        z1: -CHAMBER_HALF + (j1 + 1) * CELL - (j1 < ROWS - 1 ? INSET : 0),
      });
    }
  }
  return rects;
}

/** The ghost house: an outline of thin walls with a gap (the door) in the middle of its north side. */
function houseRects(): { walls: Rect[]; door: Rect; outer: Rect } {
  const x0 = -CHAMBER_HALF + HOUSE.i0 * CELL + INSET, x1 = -CHAMBER_HALF + (HOUSE.i1 + 1) * CELL - INSET;
  const z0 = -CHAMBER_HALF + HOUSE.j0 * CELL + INSET, z1 = -CHAMBER_HALF + (HOUSE.j1 + 1) * CELL - INSET;
  const w = HOUSE_WALL, dx = cellX(DOOR_CELL.i);
  return {
    outer: { x0, x1, z0, z1 },
    walls: [
      { x0, x1: x0 + w, z0, z1 },
      { x0: x1 - w, x1, z0, z1 },
      { x0: x0 + w, x1: x1 - w, z0: z1 - w, z1 },
      { x0: x0 + w, x1: dx - DOOR_HALF_WIDTH, z0, z1: z0 + w },
      { x0: dx + DOOR_HALF_WIDTH, x1: x1 - w, z0, z1: z0 + w },
    ],
    door: { x0: dx - DOOR_HALF_WIDTH, x1: dx + DOOR_HALF_WIDTH, z0: z0 + 0.08, z1: z0 + w - 0.08 },
  };
}

export const WALL_RECTS = wallRects();
const HOUSE_RECTS = houseRects();
/** Everything the rising maze must push the player out of. */
export const SOLID_RECTS: Rect[] = [...WALL_RECTS, HOUSE_RECTS.outer];
/** Inside the ghost house (walls excluded). */
export const HOUSE_INSIDE: Rect = {
  x0: HOUSE_RECTS.outer.x0 + HOUSE_WALL, x1: HOUSE_RECTS.outer.x1 - HOUSE_WALL,
  z0: HOUSE_RECTS.outer.z0 + HOUSE_WALL, z1: HOUSE_RECTS.outer.z1 - HOUSE_WALL,
};

const BODY = [0.012, 0.014, 0.05];
const RIM = [0.045, 0.06, 1.5];
const RIM_FLASH = [2.2, 2.2, 2.4];
const DOOR = [2.2, 0.4, 2.0];
const RIM_HEIGHT = 0.07;
const RIM_WIDTH = 0.13;

/** Static colliders for the walls and the house (door included: only ghosts go through it). */
export function addMazeColliders(physics: Physics): RAPIER.Collider[] {
  const h = MAZE_WALL_HEIGHT;
  const box = (r: Rect) => physics.addStaticBox([(r.x0 + r.x1) / 2, h / 2, (r.z0 + r.z1) / 2], [r.x1 - r.x0, h, r.z1 - r.z0]);
  return [...WALL_RECTS.map(box), ...HOUSE_RECTS.walls.map(box), box(HOUSE_RECTS.door)];
}

/**
 * Draws the maze: dark blocks outlined in glowing blue along their top edges (a double line down
 * the sides, like the arcade's), and the house's pink door. `rise` is how far out of the floor it
 * is (0-1); `flash` turns the outlines white.
 */
export function drawMaze(out: DrawItem[], rise: number, flash: boolean) {
  if (rise <= 0) return;
  if (rise < 1) {
    buildMaze(out, rise, flash);
    return;
  }
  // Fully up it never moves: build it once (per outline colour) and reuse the items.
  const key = flash ? 'flash' : 'normal';
  const items = (fullMaze[key] ??= buildMaze([], 1, flash));
  for (const item of items) out.push(item);
}

const fullMaze: { normal?: DrawItem[]; flash?: DrawItem[] } = {};

function buildMaze(out: DrawItem[], rise: number, flash: boolean): DrawItem[] {
  const h = MAZE_WALL_HEIGHT;
  const dy = -(h + 0.05) * (1 - rise);
  const rim = flash ? RIM_FLASH : RIM;
  const block = (r: Rect, y0: number, y1: number, grow: number, color: number[], emissive: boolean) => {
    out.push({
      mesh: 'box',
      model: mul(
        translation([(r.x0 + r.x1) / 2, dy + (y0 + y1) / 2, (r.z0 + r.z1) / 2]),
        scaling([r.x1 - r.x0 + grow * 2, y1 - y0, r.z1 - r.z0 + grow * 2]),
      ),
      color,
      pattern: emissive ? Pattern.emissive : undefined,
      spec: emissive ? undefined : 0.35,
      shadow: emissive ? false : undefined,
    });
  };
  const wall = (r: Rect) => {
    block(r, 0, h - RIM_HEIGHT, 0, BODY, false);
    // The outline: a glowing slab on top with a dark cap inset into it, and a second thin line
    // a little lower down the sides.
    block(r, h - RIM_HEIGHT, h, 0.004, rim, true);
    block({ x0: r.x0 + RIM_WIDTH, x1: r.x1 - RIM_WIDTH, z0: r.z0 + RIM_WIDTH, z1: r.z1 - RIM_WIDTH }, h - 0.02, h + 0.004, 0, BODY, false);
    block(r, h - 0.22, h - 0.19, 0.006, rim, true);
  };
  for (const r of WALL_RECTS) wall(r);
  for (const r of HOUSE_RECTS.walls) wall(r);
  // The door: a pink bar across the gap, and a faint pink field below it.
  const d = HOUSE_RECTS.door;
  block(d, h - 0.16, h - 0.04, 0, DOOR, true);
  out.push({
    mesh: 'box',
    model: mul(translation([(d.x0 + d.x1) / 2, dy + (h - 0.16) / 2, (d.z0 + d.z1) / 2]), scaling([d.x1 - d.x0, h - 0.16, 0.03])),
    color: [0.9, 0.3, 0.6],
    pattern: Pattern.emissive,
    opacity: 0.22,
    shadow: false,
  });
  return out;
}

/** Pushes a circle (the player) out of any wall it overlaps; returns the corrected position. */
export function pushOutOfWalls(pos: Vec3, radius: number): boolean {
  let moved = false;
  for (let iter = 0; iter < 4; iter++) {
    let any = false;
    for (const r of SOLID_RECTS) {
      const cx = Math.max(r.x0, Math.min(r.x1, pos[0]));
      const cz = Math.max(r.z0, Math.min(r.z1, pos[2]));
      const dx = pos[0] - cx, dz = pos[2] - cz;
      const d = Math.hypot(dx, dz);
      if (d >= radius) continue;
      any = moved = true;
      if (d > 1e-4) {
        pos[0] = cx + (dx / d) * radius;
        pos[2] = cz + (dz / d) * radius;
      } else {
        // The centre is inside: leave by the nearest side (never through the chamber's walls).
        const edge = CHAMBER_HALF - 0.01;
        const out = [
          r.x0 > -edge ? pos[0] - r.x0 : Infinity,
          r.x1 < edge ? r.x1 - pos[0] : Infinity,
          r.z0 > -edge ? pos[2] - r.z0 : Infinity,
          r.z1 < edge ? r.z1 - pos[2] : Infinity,
        ];
        const k = out.indexOf(Math.min(...out));
        if (k === 0) pos[0] = r.x0 - radius;
        else if (k === 1) pos[0] = r.x1 + radius;
        else if (k === 2) pos[2] = r.z0 - radius;
        else pos[2] = r.z1 + radius;
      }
    }
    const lim = CHAMBER_HALF - radius;
    pos[0] = Math.max(-lim, Math.min(lim, pos[0]));
    pos[2] = Math.max(-lim, Math.min(lim, pos[2]));
    if (!any) break;
  }
  return moved;
}
