import { mul, rotationY, scaling, translation, type Vec3 } from '../../engine/math';
import type { Physics } from '../../engine/physics';
import { Pattern, type DrawItem } from '../../engine/renderer';
import { CHAMBER_HALF, WALL_HEIGHT } from '../../game/chamber';

/*
 * The bowling chamber (its own map, same size as the test chamber): a honey-wood lane running
 * north-south, sunken gutters along the east and west walls, a dark pit across the north end,
 * and a hatch in the south wall for the ball launcher.
 */

export const HALF = CHAMBER_HALF;
/** Gutters: channels along the east and west walls, this wide and this deep. */
export const GUTTER_W = 2.7;
export const LANE_HALF = HALF - GUTTER_W;
export const GUTTER_Y = -0.7;
/** The lane (and the pin deck) ends here; north of it is the pit. */
export const PIT_EDGE = -9.2;
export const PIT_Y = -6;
/** The ball hatch in the south wall. */
export const HATCH_HALF = 1.8;
export const HATCH_H = 3.1;
export const TUNNEL_END = 16;
/** Head pin position (the pin triangle points south toward the hatch). */
export const HEAD_PIN_Z = PIT_EDGE + 1.0 + 3 * 1.6 * Math.sqrt(3) / 2;

const WALL = [0.86, 0.87, 0.88];
const WOOD = [0.5, 0.29, 0.11];
const WOOD_DECK = [0.58, 0.36, 0.15];
const GUTTER = [0.1, 0.1, 0.11];
const PIT = [0.015, 0.015, 0.018];
const CURTAIN = [0.02, 0.02, 0.03];
const INK = [0.18, 0.08, 0.04];
const TUNNEL = [0.1, 0.1, 0.11];
const STEEL = [0.2, 0.21, 0.23];
const BOARDS = 39;

/** Top of the lane's scoreboard-coloured curtain on the north wall. */
export const CURTAIN_TOP = 2.4;

/** Adds the map's static colliders. */
export function addLaneColliders(physics: Physics) {
  const box = (min: Vec3, max: Vec3) =>
    physics.addStaticBox([(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2], [max[0] - min[0], max[1] - min[1], max[2] - min[2]]);
  // Lane, gutters, the pit's floor and front wall.
  box([-LANE_HALF, -1, PIT_EDGE], [LANE_HALF, 0, HALF]);
  box([-HALF, GUTTER_Y - 0.5, PIT_EDGE], [-LANE_HALF, GUTTER_Y, HALF]);
  box([LANE_HALF, GUTTER_Y - 0.5, PIT_EDGE], [HALF, GUTTER_Y, HALF]);
  box([-HALF, PIT_Y - 0.5, -HALF], [HALF, PIT_Y, PIT_EDGE]);
  box([-HALF, PIT_Y, PIT_EDGE], [HALF, -1, PIT_EDGE + 0.5]);
  // Walls, tall enough to line the pit; the south wall goes around the hatch.
  const low = PIT_Y - 0.5, top = WALL_HEIGHT;
  box([-HALF - 1, low, -HALF - 1], [-HALF, top, HALF + 1]);
  box([HALF, low, -HALF - 1], [HALF + 1, top, HALF + 1]);
  box([-HALF - 1, low, -HALF - 1], [HALF + 1, top, -HALF]);
  box([-HALF - 1, low, HALF], [-HATCH_HALF, top, HALF + 1]);
  box([HATCH_HALF, low, HALF], [HALF + 1, top, HALF + 1]);
  box([-HATCH_HALF, HATCH_H, HALF], [HATCH_HALF, top, HALF + 1]);
  // The launcher tunnel behind the hatch.
  box([-HATCH_HALF, -1, HALF], [HATCH_HALF, 0, TUNNEL_END]);
  box([-HATCH_HALF - 0.5, 0, HALF], [-HATCH_HALF, HATCH_H + 0.5, TUNNEL_END]);
  box([HATCH_HALF, 0, HALF], [HATCH_HALF + 0.5, HATCH_H + 0.5, TUNNEL_END]);
  box([-HATCH_HALF, HATCH_H, HALF], [HATCH_HALF, HATCH_H + 0.5, TUNNEL_END]);
  box([-HATCH_HALF, 0, TUNNEL_END], [HATCH_HALF, HATCH_H, TUNNEL_END + 0.5]);
}

/** Tone variation per board, fixed so the lane looks the same every attempt. */
function boardTone(i: number) {
  const h = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return 0.92 + (h - Math.floor(h)) * 0.14;
}

/** Everything static, built once. */
export function buildLaneDraws(): DrawItem[] {
  const out: DrawItem[] = [];
  const box = (min: Vec3, max: Vec3, color: number[], extra: Partial<DrawItem> = {}) =>
    out.push({
      mesh: 'box',
      model: mul(translation([(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]), scaling([max[0] - min[0], max[1] - min[1], max[2] - min[2]])),
      color,
      ...extra,
    });
  const wall = (min: Vec3, max: Vec3) => box(min, max, WALL, { pattern: Pattern.panels, param: 2, spec: 0.15 });

  // The lane: a slab under 39 boards, each a slightly different honey tone, glossy. The pin
  // deck (from just in front of the head pin) is a lighter maple.
  box([-LANE_HALF, -1, PIT_EDGE], [LANE_HALF, -0.02, HALF], [0.42, 0.27, 0.13], { spec: 0.2 });
  const bw = (LANE_HALF * 2) / BOARDS;
  const deckFrom = HEAD_PIN_Z + 1.3;
  for (let i = 0; i < BOARDS; i++) {
    const x0 = -LANE_HALF + i * bw + 0.004, x1 = x0 + bw - 0.008;
    const tone = boardTone(i);
    box([x0, -0.03, deckFrom], [x1, 0, HALF], WOOD.map((c) => c * tone), { spec: 0.75 });
    box([x0, -0.03, PIT_EDGE], [x1, 0, deckFrom - 0.006], WOOD_DECK.map((c) => c * tone), { spec: 0.75 });
  }
  // Gutters, the pit, and the lining of the pit's walls.
  for (const s of [-1, 1]) {
    const [a, b] = s < 0 ? [-HALF, -LANE_HALF] : [LANE_HALF, HALF];
    box([a, GUTTER_Y - 0.5, PIT_EDGE], [b, GUTTER_Y, HALF], GUTTER, { spec: 0.5 });
  }
  box([-HALF, PIT_Y - 0.5, -HALF], [HALF, PIT_Y, PIT_EDGE], PIT, { spec: 0 });
  box([-HALF, PIT_Y, PIT_EDGE], [HALF, -1, PIT_EDGE + 0.5], PIT, { spec: 0 });
  box([-HALF - 0.02, PIT_Y, -HALF - 0.02], [HALF + 0.02, CURTAIN_TOP, -HALF + 0.01], CURTAIN, { spec: 0.1 });
  for (const s of [-1, 1]) {
    const x = s * (HALF - 0.005);
    box([x - 0.01, PIT_Y, -HALF], [x + 0.01, GUTTER_Y, PIT_EDGE], PIT, { spec: 0 });
  }
  // A neon strip along the top of the curtain, and another under the scoreboard.
  box([-HALF, CURTAIN_TOP - 0.08, -HALF + 0.01], [HALF, CURTAIN_TOP + 0.04, -HALF + 0.06], [0.4, 3.2, 3.6], { pattern: Pattern.emissive, shadow: false });

  // Walls: west, east and north run down to the gutters (the curtain covers the north wall's foot).
  wall([-HALF - 1, GUTTER_Y, -HALF - 1], [-HALF, WALL_HEIGHT, HALF + 1]);
  wall([HALF, GUTTER_Y, -HALF - 1], [HALF + 1, WALL_HEIGHT, HALF + 1]);
  wall([-HALF - 1, CURTAIN_TOP, -HALF - 1], [HALF + 1, WALL_HEIGHT, -HALF]);
  wall([-HALF - 1, GUTTER_Y, HALF], [-HATCH_HALF, WALL_HEIGHT, HALF + 1]);
  wall([HATCH_HALF, GUTTER_Y, HALF], [HALF + 1, WALL_HEIGHT, HALF + 1]);
  wall([-HATCH_HALF, HATCH_H, HALF], [HATCH_HALF, WALL_HEIGHT, HALF + 1]);

  // The launcher tunnel.
  box([-HATCH_HALF, -1, HALF], [HATCH_HALF, 0, TUNNEL_END], TUNNEL, { spec: 0.3 });
  box([-HATCH_HALF - 0.5, 0, HALF + 1], [-HATCH_HALF, HATCH_H + 0.5, TUNNEL_END], TUNNEL, { spec: 0.3 });
  box([HATCH_HALF, 0, HALF + 1], [HATCH_HALF + 0.5, HATCH_H + 0.5, TUNNEL_END], TUNNEL, { spec: 0.3 });
  box([-HATCH_HALF, HATCH_H, HALF + 1], [HATCH_HALF, HATCH_H + 0.5, TUNNEL_END], TUNNEL, { spec: 0.3 });
  box([-HATCH_HALF, 0, TUNNEL_END], [HATCH_HALF, HATCH_H, TUNNEL_END + 0.5], [0.05, 0.05, 0.06], { spec: 0.3 });
  // Hazard stripes around the hatch.
  const stripe = (i: number) => (i % 2 ? [0.05, 0.05, 0.05] : [0.95, 0.72, 0.05]);
  const z0 = HALF - 0.03, z1 = HALF + 0.001;
  const seg = 0.42;
  for (let i = 0; i * seg < HATCH_H + 0.3; i++) {
    const y0 = i * seg, y1 = Math.min(HATCH_H + 0.3, y0 + seg);
    box([-HATCH_HALF - 0.3, y0, z0], [-HATCH_HALF, y1, z1], stripe(i), { spec: 0.3 });
    box([HATCH_HALF, y0, z0], [HATCH_HALF + 0.3, y1, z1], stripe(i + 1), { spec: 0.3 });
  }
  for (let i = 0; -HATCH_HALF + i * seg < HATCH_HALF; i++) {
    const x0 = -HATCH_HALF + i * seg, x1 = Math.min(HATCH_HALF, x0 + seg);
    box([x0, HATCH_H, z0], [x1, HATCH_H + 0.3, z1], stripe(i + 1), { spec: 0.3 });
  }

  // Lane markings: the foul line, the dots, the arrows (pointing at the pins), and the pin spots.
  box([-LANE_HALF, 0, 10.1], [LANE_HALF, 0.004, 10.22], INK, { spec: 0.3 });
  const boardX = (b: number) => -LANE_HALF + (b - 0.5) * bw;
  for (const b of [3, 5, 8, 11, 14, 26, 29, 32, 35, 37]) {
    out.push({ mesh: 'cylinder', model: mul(translation([boardX(b), 0.002, 8.3]), scaling([0.09, 0.004, 0.09])), color: INK, spec: 0.3 });
  }
  for (let k = -3; k <= 3; k++) {
    const x = boardX(20 + k * 5);
    const tipZ = 3.4 + Math.abs(k) * 0.55;
    // The wedge's point is its origin; turned so its curved base faces the hatch (south).
    out.push({ mesh: 'wedge', model: mul(translation([x, 0.002, tipZ]), scaling([0.55, 0.004, 1.3]), rotationY(-3 * Math.PI / 8)), color: INK, spec: 0.3 });
  }
  return out;
}

/** Dark board with glowing trim, as a list of boxes (for the north wall and above the hatch). */
export function scoreboardDraws(centre: Vec3, w: number, h: number, facing: 1 | -1): DrawItem[] {
  const out: DrawItem[] = [];
  const d = 0.12;
  const z = centre[2] + facing * d / 2;
  out.push({ mesh: 'box', model: mul(translation([centre[0], centre[1], z]), scaling([w, h, d])), color: [0.02, 0.025, 0.05], spec: 0.4 });
  const trim = [0.5, 1.4, 3.2];
  const t = 0.08;
  const edge = (x: number, y: number, sx: number, sy: number) =>
    out.push({ mesh: 'box', model: mul(translation([x, y, z + facing * 0.04]), scaling([sx, sy, d])), color: trim, pattern: Pattern.emissive, shadow: false });
  edge(centre[0], centre[1] + h / 2, w + t, t);
  edge(centre[0], centre[1] - h / 2, w + t, t);
  edge(centre[0] - w / 2, centre[1], t, h);
  edge(centre[0] + w / 2, centre[1], t, h);
  return out;
}

export { STEEL };
