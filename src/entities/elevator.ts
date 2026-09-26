import { add, clamp, cross, easeInOut, mul, rotationZ, scale, scaling, segment, translation, type Vec3 } from '../engine/math';
import type { Physics, Usable } from '../engine/physics';
import { Pattern, type DrawItem } from '../engine/renderer';
import { CHAMBER_HALF, WALL_HEIGHT } from '../game/chamber';
import { PixelText } from './pixelText';

/*
 * The test chamber as an elevator car: sliding steel doors in the east wall, handrails round the
 * walls, a retro LED floor indicator, a steel crosshead and grate over the top (the cable hangs
 * from it), and the shaft it rides in, drawn scrolling past above the walls.
 */

// --- The car --------------------------------------------------------------------------------------

/** Handrail height (m) and how far it stands off the wall. */
export const RAIL_Y = 1.0;
const RAIL_OFF = 0.12;
const RAIL_R = 0.035;
/** Rails stop this far short of the corners (and of the door frame). */
const RAIL_END = 0.9;
/** The doors: centred on the east wall at this z, this wide (both panels) and tall. */
export const DOOR_Z = 0;
export const DOOR_W = 4;
export const DOOR_H = 4.2;
const DOOR_X = CHAMBER_HALF - 0.1;
const JAMB = 0.3;
/** The grate over the top of the car stops anything floating out. */
export const CEILING_Y = WALL_HEIGHT + 0.1;
/** Where the hoist cables hang from (the middle of the crosshead). */
export const HITCH: Vec3 = [0, WALL_HEIGHT + 0.75, 0];

const STEEL = [0.55, 0.57, 0.6];
const DOOR_STEEL = [0.62, 0.64, 0.67];
const DARK = [0.06, 0.06, 0.07];
const BRASS = [0.85, 0.66, 0.3];
const BEAM = [0.82, 0.6, 0.08];
const GRATE = [0.3, 0.31, 0.33];

/** A handrail: from `a` to `b` along a wall, `normal` pointing into the room. */
export interface Rail {
  a: Vec3;
  b: Vec3;
  normal: Vec3;
  length: number;
}

function rail(a: Vec3, b: Vec3, normal: Vec3): Rail {
  return { a, b, normal, length: Math.hypot(b[0] - a[0], b[2] - a[2]) };
}

/** A point along a rail, `s` metres from its start. */
export function railPoint(r: Rail, s: number): Vec3 {
  const k = clamp(s / r.length, 0, 1);
  return [r.a[0] + (r.b[0] - r.a[0]) * k, r.a[1], r.a[2] + (r.b[2] - r.a[2]) * k];
}

/** Distance along a rail (from its start) of the point nearest `p`. */
export function railNearest(r: Rail, p: Vec3): number {
  const dx = r.b[0] - r.a[0], dz = r.b[2] - r.a[2];
  const k = ((p[0] - r.a[0]) * dx + (p[2] - r.a[2]) * dz) / (dx * dx + dz * dz);
  return clamp(k, 0, 1) * r.length;
}

/** Handrails round all four walls, broken for the doors. */
export function carRails(): Rail[] {
  const h = CHAMBER_HALF - RAIL_OFF, e = CHAMBER_HALF - RAIL_END, y = RAIL_Y;
  const doorEdge = DOOR_W / 2 + JAMB + 0.35;
  return [
    rail([-e, y, -h], [e, y, -h], [0, 0, 1]), // north
    rail([e, y, h], [-e, y, h], [0, 0, -1]), // south
    rail([-h, y, e], [-h, y, -e], [1, 0, 0]), // west
    rail([h, y, -e], [h, y, DOOR_Z - doorEdge], [-1, 0, 0]), // east, north of the doors
    rail([h, y, DOOR_Z + doorEdge], [h, y, e], [-1, 0, 0]), // east, south of the doors
  ];
}

/** Colliders for the car: the grate over the top, and the door and its frame. */
export function addCarColliders(physics: Physics) {
  const size = CHAMBER_HALF * 2;
  physics.addStaticBox([0, CEILING_Y + 0.25, 0], [size, 0.5, size]);
  // The doors stand a little proud of the wall; their frame more so.
  physics.addStaticBox([CHAMBER_HALF - 0.07, DOOR_H / 2, DOOR_Z], [0.14, DOOR_H, DOOR_W]);
  for (const side of [-1, 1]) {
    physics.addStaticBox([CHAMBER_HALF - 0.15, (DOOR_H + 0.4) / 2, DOOR_Z + side * (DOOR_W / 2 + JAMB / 2)], [0.3, DOOR_H + 0.4, JAMB]);
  }
}

/** The rails, their wall brackets. */
export function drawRails(out: DrawItem[], rails: Rail[]) {
  for (const r of rails) {
    out.push({ mesh: 'cylinder', model: segment(r.a, r.b, RAIL_R), color: BRASS, spec: 0.9 });
    // End caps bend back into the wall, and brackets every couple of metres.
    const n = Math.max(1, Math.round(r.length / 2.2));
    for (let i = 0; i <= n; i++) {
      const p = railPoint(r, (i / n) * r.length);
      const wall = add(p, scale(r.normal, -RAIL_OFF));
      const end = i === 0 || i === n;
      out.push({ mesh: 'cylinder', model: segment(wall, p, end ? RAIL_R : 0.018), color: end ? BRASS : STEEL, spec: 0.8 });
      if (end) out.push({ mesh: 'sphere', model: mul(translation(p), scaling([RAIL_R, RAIL_R, RAIL_R])), color: BRASS, spec: 0.9 });
    }
  }
}

/**
 * The sliding doors (0 = shut, 1 = open), their frame, and the dark gap behind them. They're in
 * front of where an ExitPortal sits in the east wall.
 */
export function drawDoors(out: DrawItem[], open: number) {
  const x = DOOR_X;
  const k = easeInOut(clamp(open, 0, 1));
  // Behind the doors: nothing but a dark gap.
  if (k > 0) out.push({ mesh: 'box', model: mul(translation([CHAMBER_HALF - 0.0025, DOOR_H / 2, DOOR_Z]), scaling([0.005, DOOR_H, DOOR_W])), color: [0.01, 0.01, 0.012], shadow: false });
  for (const side of [-1, 1]) {
    // Each panel slides sideways into a pocket behind the frame: only the part still in the doorway shows.
    const width = (DOOR_W / 2) * (1 - k);
    if (width > 0.02) {
      const centre = DOOR_Z + side * (DOOR_W / 4) * (1 + k);
      out.push({ mesh: 'box', model: mul(translation([x, DOOR_H / 2, centre]), scaling([0.08, DOOR_H, width])), color: DOOR_STEEL, spec: 0.7 });
      // A brushed band across each panel.
      out.push({ mesh: 'box', model: mul(translation([x - 0.045, DOOR_H * 0.55, centre]), scaling([0.01, 0.06, width])), color: STEEL, spec: 0.9 });
    }
    // The seam where they meet, and a dark edge on each.
    if (width > 0.02) out.push({ mesh: 'box', model: mul(translation([x - 0.041, DOOR_H / 2, DOOR_Z + side * (DOOR_W / 2) * k]), scaling([0.01, DOOR_H, 0.03])), color: DARK });
    // Jambs.
    out.push({ mesh: 'box', model: mul(translation([CHAMBER_HALF - 0.15, (DOOR_H + 0.4) / 2, DOOR_Z + side * (DOOR_W / 2 + JAMB / 2)]), scaling([0.3, DOOR_H + 0.4, JAMB])), color: STEEL, spec: 0.6 });
  }
  // Header and sill.
  out.push({ mesh: 'box', model: mul(translation([CHAMBER_HALF - 0.15, DOOR_H + 0.2, DOOR_Z]), scaling([0.3, 0.4, DOOR_W + JAMB * 2])), color: STEEL, spec: 0.6 });
  out.push({ mesh: 'box', model: mul(translation([CHAMBER_HALF - 0.3, 0.01, DOOR_Z]), scaling([0.6, 0.02, DOOR_W + JAMB * 2])), color: [0.4, 0.41, 0.43], spec: 0.9 });
  // Mind the gap.
  out.push({ mesh: 'box', model: mul(translation([CHAMBER_HALF - 0.52, 0.012, DOOR_Z]), scaling([0.1, 0.022, DOOR_W])), color: [0.95, 0.75, 0.05] });
}

/** The button panel beside the doors (south of them), and where its big red button is. */
const PANEL_Z = DOOR_Z + DOOR_W / 2 + JAMB + 0.5;
const PANEL_Y = 1.8;
export const STOP_BUTTON: Vec3 = [CHAMBER_HALF - 0.08, PANEL_Y - 0.38, PANEL_Z];

/**
 * The car's button panel: two columns of little floor buttons and a big red EMERGENCY STOP that
 * E presses (it calls `onPress`; what that achieves is up to the level. Usually nothing).
 */
export class CarPanel implements Usable {
  highlight = 0;
  private time = 0;
  private pressedAt = -10;
  private items: DrawItem[] = [];

  constructor(physics: Physics, private onPress: () => void) {
    const collider = physics.addStaticBox(STOP_BUTTON, [0.24, 0.3, 0.3]);
    physics.registerUsable(collider, this);
    const x = CHAMBER_HALF - 0.03;
    const face = rotationZ(Math.PI / 2); // cylinders facing out of the east wall
    this.items.push({ mesh: 'box', model: mul(translation([x, PANEL_Y, PANEL_Z]), scaling([0.05, 1.1, 0.5])), color: STEEL, spec: 0.8 });
    for (let row = 0; row < 7; row++) {
      for (const dz of [-0.1, 0.1]) {
        const lit = row === 6 && dz > 0; // the top floor, where we are
        this.items.push({ mesh: 'cylinder', model: mul(translation([x - 0.03, PANEL_Y - 0.1 + row * 0.08, PANEL_Z + dz]), face, scaling([0.028, 0.02, 0.028])), color: lit ? [2.4, 1.2, 0.2] : [0.8, 0.8, 0.78], pattern: lit ? Pattern.emissive : undefined, spec: 0.8 });
      }
    }
    // A keyhole nobody has the key for.
    this.items.push({ mesh: 'box', model: mul(translation([x - 0.03, PANEL_Y + 0.46, PANEL_Z]), scaling([0.01, 0.05, 0.015])), color: DARK });
  }

  use() {
    this.pressedAt = this.time;
    this.onPress();
  }

  update(dt: number) {
    this.time += dt;
  }

  draw(out: DrawItem[]) {
    for (const item of this.items) out.push(item);
    const depress = this.time - this.pressedAt < 0.25 ? 0.03 : 0;
    const [bx, by, bz] = STOP_BUTTON;
    out.push({ mesh: 'cylinder', model: mul(translation([bx + 0.02, by, bz]), rotationZ(Math.PI / 2), scaling([0.12, 0.06, 0.12])), color: [0.85, 0.75, 0.1], spec: 0.5 });
    out.push({ mesh: 'cylinder', model: mul(translation([bx - 0.04 + depress, by, bz]), rotationZ(Math.PI / 2), scaling([0.085, 0.08, 0.085])), color: [0.8, 0.06, 0.04], spec: 0.8, highlight: this.highlight });
  }
}

/**
 * The top of the car: a yellow steel crosshead from wall to wall with the cable hitch in the
 * middle, a grate of thin bars, and strip lights hanging under it. It never moves, so build it once;
 * the lights glow `glow` (an emissive colour the caller can change in place to dim them).
 */
export function drawCarTop(out: DrawItem[], glow: number[]) {
  const y = WALL_HEIGHT, span = CHAMBER_HALF * 2 + 1.2;
  // I-beam: flanges and web.
  out.push({ mesh: 'box', model: mul(translation([0, y + 0.13, 0]), scaling([span, 0.06, 0.5])), color: BEAM, spec: 0.3 });
  out.push({ mesh: 'box', model: mul(translation([0, y + 0.4, 0]), scaling([span, 0.5, 0.08])), color: BEAM, spec: 0.3 });
  out.push({ mesh: 'box', model: mul(translation([0, y + 0.67, 0]), scaling([span, 0.06, 0.5])), color: BEAM, spec: 0.3 });
  // Hitch plate and cable sockets.
  out.push({ mesh: 'box', model: mul(translation([0, y + 0.72, 0]), scaling([1.2, 0.08, 0.7])), color: DARK, spec: 0.5 });
  for (const [dx, dz] of CABLE_OFFSETS) {
    out.push({ mesh: 'cylinder', model: mul(translation([dx, y + 0.86, dz]), scaling([0.07, 0.22, 0.07])), color: STEEL, spec: 0.8 });
  }
  // The grate: thin bars both ways.
  for (let i = -3; i <= 3; i++) {
    const c = i * 3.4;
    out.push({ mesh: 'box', model: mul(translation([c, y + 0.06, 0]), scaling([0.08, 0.08, CHAMBER_HALF * 2])), color: GRATE, spec: 0.4 });
    out.push({ mesh: 'box', model: mul(translation([0, y + 0.02, c]), scaling([CHAMBER_HALF * 2, 0.06, 0.06])), color: GRATE, spec: 0.4 });
  }
  // Strip lights hanging under the grate.
  for (const x of [-6.8, 6.8]) {
    for (const z of [-6.8, 6.8]) {
      out.push({ mesh: 'box', model: mul(translation([x, y - 0.12, z]), scaling([3.4, 0.08, 0.4])), color: [0.2, 0.2, 0.22] });
      out.push({ mesh: 'box', model: mul(translation([x, y - 0.18, z]), scaling([3.2, 0.05, 0.3])), color: glow, pattern: Pattern.emissive, shadow: false });
    }
  }
}

/** Where each hoist cable leaves the hitch (x, z offsets). */
export const CABLE_OFFSETS: [number, number][] = [[-0.3, -0.12], [-0.1, 0.12], [0.1, -0.12], [0.3, 0.12]];

// --- The floor indicator -------------------------------------------------------------------------

const AMBER = [2.6, 1.0, 0.12];
const RED = [3.2, 0.18, 0.08];
const LED_OFF = [0.05, 0.012, 0.004];
/** A down arrow with a stem, 7 x 7 LEDs, scrolled through a 9-row cycle so it seems to move. */
const ARROW = ['..###..', '..###..', '..###..', '#######', '.#####.', '..###..', '...#...', '.......', '.......'];

/**
 * A retro elevator floor indicator: amber LEDs on a black panel (an arrow, the floor, and a short
 * message line under them), mounted flat on a wall. `right` and `up` lie along the wall; the panel
 * faces out along right x up.
 */
export class FloorIndicator {
  /** 0 (dark) to 1: multiplies the LEDs' glow (for flickering). */
  brightness = 0;
  /** Red instead of amber. */
  alarm = false;
  /** How fast the arrow scrolls down (rows per second); 0 hides it. */
  arrowSpeed = 0;
  private color = [...LED_OFF];
  private floorText: PixelText;
  private msgText: PixelText;
  private arrowFrames: DrawItem[][] = [];
  private panel: DrawItem[] = [];
  private arrowT = 0;

  constructor(centre: Vec3, right: Vec3, up: Vec3) {
    const normal = cross(right, up);
    const at = (u: number, v: number, n: number): Vec3 => add(add(add(centre, scale(right, u)), scale(up, v)), scale(normal, n));
    const W = 5.2, H = 2.5;
    const box = (c: Vec3, w: number, h: number, d: number): Float32Array =>
      new Float32Array([right[0] * w, right[1] * w, right[2] * w, 0, up[0] * h, up[1] * h, up[2] * h, 0, normal[0] * d, normal[1] * d, normal[2] * d, 0, c[0], c[1], c[2], 1]);
    this.panel.push({ mesh: 'box', model: box(at(0, 0, 0.04), W + 0.3, H + 0.3, 0.08), color: STEEL, spec: 0.7 });
    this.panel.push({ mesh: 'box', model: box(at(0, 0, 0.09), W, H, 0.1), color: [0.02, 0.02, 0.025], spec: 1 });
    const face = 0.14;
    this.floorText = new PixelText({ centre: at(0.85, 0.3, face), right, up, pixel: 0.16, color: this.color, depth: 0.03, pattern: Pattern.emissive });
    this.msgText = new PixelText({ centre: at(0, -0.8, face), right, up, pixel: 0.07, color: this.color, depth: 0.03, pattern: Pattern.emissive });
    const px = 0.14, size = px * 0.86;
    for (let f = 0; f < ARROW.length; f++) {
      const items: DrawItem[] = [];
      for (let row = 0; row < 7; row++) {
        const line = ARROW[(row - f + ARROW.length * 4) % ARROW.length];
        for (let col = 0; col < 7; col++) {
          if (line[col] !== '#') continue;
          const c = at(-1.55 + (col - 3) * px, 0.3 + (3 - row) * px, face + 0.015);
          items.push({ mesh: 'box', model: box(c, size, size, 0.03), color: this.color, pattern: Pattern.emissive, shadow: false });
        }
      }
      this.arrowFrames.push(items);
    }
  }

  setFloor(label: string) {
    this.floorText.setText(label);
  }

  setMessage(text: string) {
    this.msgText.setText(text);
  }

  update(dt: number) {
    this.arrowT += dt * this.arrowSpeed;
    const base = this.alarm ? RED : AMBER;
    const k = clamp(this.brightness, 0, 1.5);
    for (let i = 0; i < 3; i++) this.color[i] = LED_OFF[i] + base[i] * k;
  }

  draw(out: DrawItem[]) {
    for (const p of this.panel) out.push(p);
    if (this.brightness <= 0.02) return;
    this.floorText.draw(out);
    this.msgText.draw(out);
    if (this.arrowSpeed > 0) for (const item of this.arrowFrames[Math.floor(this.arrowT) % ARROW.length]) out.push(item);
  }
}

/** The indicator's text for a floor: 12, G for ground, B3 for three below. */
export function floorLabel(floor: number): string {
  return floor > 0 ? `${floor}` : floor === 0 ? 'G' : `B${-floor}`;
}

// --- The shaft ------------------------------------------------------------------------------------

/** Inner faces of the shaft walls (the car's walls are 1 m thick, then a gap). */
export const SHAFT_HALF = CHAMBER_HALF + 1.3;
/** Height of one storey (m), and the top floor. */
export const FLOOR_H = 4;
export const TOP_FLOOR = 99;
/** Shaft details are drawn this far above the car (fog hides the rest). */
const VIEW_ABOVE = 64;
const SHAFT_WALL = [0.13, 0.125, 0.12];
const SLAB = [0.24, 0.23, 0.22];
const LAMP = [3.2, 2.4, 1.3];

/** The hoist stands this high over the roof; the cables go up to its sheave. */
export const HOIST_H = 5;

/** Where the hoist cables go up to (world y) when the car has gone down `depth`. */
export function cableTop(depth: number): number {
  return WALL_HEIGHT + depth + HOIST_H - 1.1;
}

/**
 * The hoist on the roof over the shaft: a steel frame on four legs, the motor, and the big grooved
 * sheave the cables hang from. `roof` is the roof's height.
 */
function drawHoist(out: DrawItem[], roof: number) {
  const h = HOIST_H, c = SHAFT_HALF + 0.8, top = roof + h;
  const steel = [0.3, 0.32, 0.3];
  for (const x of [-c, c]) for (const z of [-c, c]) {
    out.push({ mesh: 'box', model: mul(translation([x, roof + h / 2, z]), scaling([0.4, h, 0.4])), color: steel, shadow: false, spec: 0.3 });
  }
  for (const z of [-1.1, 1.1]) {
    out.push({ mesh: 'box', model: mul(translation([0, top, z]), scaling([c * 2 + 0.4, 0.5, 0.35])), color: BEAM, shadow: false, spec: 0.3 });
  }
  for (const x of [-c, c]) out.push({ mesh: 'box', model: mul(translation([x, top, 0]), scaling([0.4, 0.5, c * 2 + 0.4])), color: steel, shadow: false, spec: 0.3 });
  // The sheave (a big wheel on an axle along x), its hub, and the motor beside it.
  const wheel = mul(translation([0, top - 0.3, 0]), rotationZ(Math.PI / 2));
  out.push({ mesh: 'cylinder', model: mul(wheel, scaling([0.85, 0.9, 0.85])), color: [0.2, 0.2, 0.21], shadow: false, spec: 0.7 });
  out.push({ mesh: 'cylinder', model: mul(wheel, scaling([0.25, 1.4, 0.25])), color: [0.6, 0.6, 0.62], shadow: false, spec: 0.8 });
  out.push({ mesh: 'box', model: mul(translation([1.6, top + 0.55, 0]), scaling([1.6, 1.2, 1.3])), color: [0.25, 0.42, 0.3], shadow: false, spec: 0.3 });
}

/** Which landing the car is level with (nearest) after going down `depth` metres from the top floor. */
export function floorAt(depth: number): number {
  return TOP_FLOOR - Math.round(depth / FLOOR_H);
}

/** Height (world y, in the car's frame) of floor `n`'s landing when the car has gone down `depth`. */
export function landingY(n: number, depth: number): number {
  return depth - (TOP_FLOOR - n) * FLOOR_H;
}

/**
 * The shaft, in the car's frame (the car stays put; the shaft slides up past it). `depth` is how
 * far the car has gone down from the top floor (whose roof is level with the top of the car);
 * `speed` streaks the lamps.
 */
export function drawShaft(out: DrawItem[], depth: number, speed: number) {
  const top = WALL_HEIGHT + depth; // the building's roof
  drawHoist(out, top);
  if (depth < 0.02) return;
  const bottom = WALL_HEIGHT - 0.6;
  const h = top - bottom, cy = (top + bottom) / 2, w = SHAFT_HALF * 2 + 2;
  const wall = (pos: Vec3, size: Vec3) => out.push({ mesh: 'box', model: mul(translation(pos), scaling(size)), color: SHAFT_WALL, shadow: false, spec: 0.02 });
  wall([0, cy, -SHAFT_HALF - 0.5], [w, h, 1]);
  wall([0, cy, SHAFT_HALF + 0.5], [w, h, 1]);
  wall([-SHAFT_HALF - 0.5, cy, 0], [1, h, w]);
  wall([SHAFT_HALF + 0.5, cy, 0], [1, h, w]);
  // The roof's parapet round the top of the shaft.
  const pw = w + 1.4;
  for (const [pos, size] of [
    [[0, top + 0.5, -SHAFT_HALF - 1.2], [pw, 1, 0.4]], [[0, top + 0.5, SHAFT_HALF + 1.2], [pw, 1, 0.4]],
    [[-SHAFT_HALF - 1.2, top + 0.5, 0], [0.4, 1, pw]], [[SHAFT_HALF + 1.2, top + 0.5, 0], [0.4, 1, pw]],
  ] as [Vec3, Vec3][]) out.push({ mesh: 'box', model: mul(translation(pos), scaling(size)), color: [0.5, 0.49, 0.46], shadow: false });

  // Guide rails (north and south, fixed to the shaft: continuous, so they don't seem to move) and a conduit on the west wall.
  for (const side of [-1, 1]) {
    out.push({ mesh: 'box', model: mul(translation([0, cy, side * (SHAFT_HALF - 0.12)]), scaling([0.14, h, 0.24])), color: [0.2, 0.21, 0.22], shadow: false, spec: 0.8 });
  }
  for (const z of [-5, -4.6]) {
    out.push({ mesh: 'cylinder', model: mul(translation([-SHAFT_HALF + 0.15, cy, z]), scaling([0.08, h, 0.08])), color: [0.45, 0.35, 0.2], shadow: false });
  }

  // Everything that belongs to a storey, from just below the top of the car walls up out of view.
  const hi = Math.min(top - 0.5, WALL_HEIGHT + VIEW_ABOVE);
  const nMin = Math.ceil(TOP_FLOOR + (bottom - 4.5 - depth) / FLOOR_H);
  const nMax = Math.min(TOP_FLOOR, Math.floor(TOP_FLOOR + (hi - depth) / FLOOR_H));
  const streak = Math.min(3.5, speed * 0.06);
  for (let n = nMin; n <= nMax; n++) {
    const y = landingY(n, depth);
    // Floor slabs: a concrete ledge round all four walls.
    const s = SHAFT_HALF - 0.08;
    for (const [pos, size] of [
      [[0, y - 0.2, -s], [SHAFT_HALF * 2, 0.4, 0.16]], [[0, y - 0.2, s], [SHAFT_HALF * 2, 0.4, 0.16]],
      [[-s, y - 0.2, 0], [0.16, 0.4, SHAFT_HALF * 2]], [[s, y - 0.2, 0], [0.16, 0.4, SHAFT_HALF * 2]],
    ] as [Vec3, Vec3][]) out.push({ mesh: 'box', model: mul(translation(pos), scaling(size)), color: SLAB, shadow: false, spec: 0.02 });
    // Landing doors on the east wall, facing the car's doors.
    const dx = SHAFT_HALF - 0.05;
    out.push({ mesh: 'box', model: mul(translation([dx, y + DOOR_H / 2, DOOR_Z]), scaling([0.06, DOOR_H, DOOR_W])), color: [0.48, 0.5, 0.53], shadow: false, spec: 0.6 });
    out.push({ mesh: 'box', model: mul(translation([dx - 0.02, y + DOOR_H / 2, DOOR_Z]), scaling([0.04, DOOR_H, 0.03])), color: DARK, shadow: false });
    out.push({ mesh: 'box', model: mul(translation([dx - 0.03, y + DOOR_H + 0.15, DOOR_Z]), scaling([0.08, 0.3, DOOR_W + 0.6])), color: [0.35, 0.36, 0.38], shadow: false });
    // A caged work lamp on the north or south wall (alternating), streaking when it whizzes by.
    const lz = (n % 2 ? -1 : 1) * (SHAFT_HALF - 0.12);
    const lx = n % 2 ? 6 : -6;
    const ly = y + 2.6;
    out.push({ mesh: 'box', model: mul(translation([lx, ly, lz]), scaling([0.55, 0.6, 0.3])), color: [0.12, 0.12, 0.13], shadow: false });
    out.push({ mesh: 'box', model: mul(translation([lx, ly - streak / 2, lz - Math.sign(lz) * 0.17]), scaling([0.34, 0.36 + streak, 0.12])), color: LAMP, pattern: Pattern.emissive, shadow: false });
    // Guide rail brackets, twice a storey.
    for (const k of [0.8, 2.8]) {
      for (const side of [-1, 1]) {
        out.push({ mesh: 'box', model: mul(translation([0, y + k, side * (SHAFT_HALF - 0.15)]), scaling([0.7, 0.14, 0.3])), color: [0.25, 0.26, 0.27], shadow: false });
      }
      out.push({ mesh: 'box', model: mul(translation([-SHAFT_HALF + 0.12, y + k + 0.6, -4.8]), scaling([0.12, 0.08, 0.7])), color: [0.25, 0.26, 0.27], shadow: false });
    }
  }
}
