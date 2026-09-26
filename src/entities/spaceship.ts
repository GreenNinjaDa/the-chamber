import { basis, clamp, cross, mul, rotationX, rotationY, rotationZ, scaling, translation, type Mat4, type Vec3 } from '../engine/math';
import type { Physics, RAPIER } from '../engine/physics';
import { Pattern, type DrawItem } from '../engine/renderer';

/*
 * Spaceship furniture for crewmates: wall-mounted task stations (wiring panels, a card swipe, a
 * garbage chute, a data terminal, a dial panel) whose screens light up only while someone is
 * really doing the task, floor vents with a flap that clanks open, and the round cafeteria table
 * with the big red EMERGENCY button under a glass dome.
 */

export type StationKind = 'wires' | 'terminal' | 'swipe' | 'chute' | 'dials';

const METAL = [0.45, 0.47, 0.5];
const DARK_METAL = [0.2, 0.21, 0.23];
const RECESS = [0.07, 0.07, 0.08];
const SCREEN_OFF = [0.02, 0.025, 0.03];
const SCREEN_ON = [0.2, 1.1, 0.6];
const SCREEN_BAR = [0.8, 2.6, 1.3];
const LED_OFF = [0.5, 0.05, 0.04];
const LED_ON = [0.3, 2.6, 0.5];
const WIRE_COLORS = [[0.85, 0.08, 0.06], [0.1, 0.25, 0.9], [0.95, 0.8, 0.1], [0.9, 0.3, 0.7]];

/** Collider size (along the wall, up, out of the wall) and how far out the model reaches. */
const SIZES: Record<StationKind, { size: Vec3; depth: number }> = {
  wires: { size: [1.45, 2.5, 0.35], depth: 0.2 },
  terminal: { size: [1.35, 2.45, 0.8], depth: 0.75 },
  swipe: { size: [0.8, 2.2, 0.3], depth: 0.2 },
  chute: { size: [1.15, 2.4, 0.95], depth: 0.92 },
  dials: { size: [1.35, 2.5, 0.35], depth: 0.2 },
};

/**
 * A task station on a chamber wall. `anchor` is the foot of the wall under it, `normal` points
 * out of the wall into the room (axis-aligned). `lit` (0-1, set by the level) lights the screen;
 * `progress` (0-1) fills its bar.
 */
export class TaskStation {
  lit = 0;
  progress = 0;
  readonly frame: Mat4;
  readonly collider: RAPIER.Collider;
  /** The spot in front of it where whoever does the task stands, and the way they face. */
  readonly stand: Vec3;
  readonly faceYaw: number;
  private t = Math.random() * 5;

  constructor(physics: Physics, readonly kind: StationKind, readonly name: string, readonly anchor: Vec3, readonly normal: Vec3) {
    const up: Vec3 = [0, 1, 0];
    const x = cross(up, normal);
    this.frame = basis(x, up, normal, anchor);
    const { size, depth } = SIZES[kind];
    const alongX = Math.abs(normal[0]) > 0.5;
    const world: Vec3 = alongX ? [size[2], size[1], size[0]] : [size[0], size[1], size[2]];
    const centre: Vec3 = [anchor[0] + normal[0] * size[2] / 2, size[1] / 2, anchor[2] + normal[2] * size[2] / 2];
    this.collider = physics.addStaticBox(centre, world);
    this.stand = [anchor[0] + normal[0] * (depth + 0.8), 0, anchor[2] + normal[2] * (depth + 0.8)];
    this.faceYaw = Math.atan2(normal[0], normal[2]);
  }

  /** Where a floating label goes. */
  labelPos(): Vec3 {
    return [this.anchor[0] + this.normal[0] * 0.5, 2.85, this.anchor[2] + this.normal[2] * 0.5];
  }

  update(dt: number) {
    this.t += dt;
  }

  draw(out: DrawItem[]) {
    const f = this.frame;
    const box = (pos: Vec3, size: Vec3, color: ArrayLike<number>, spec = 0.3, pattern?: number, m: Mat4 = f) =>
      out.push({ mesh: 'box', model: mul(m, translation(pos), scaling(size)), color, spec, pattern });
    const on = this.lit > 0.5;
    const t = this.t;
    // The screen every station has: dark and glossy, or lit with a filling bar.
    const screen = (m: Mat4, w: number, h: number) => {
      if (!on) {
        out.push({ mesh: 'box', model: mul(m, scaling([w, h, 0.02])), color: SCREEN_OFF, spec: 0.9 });
        return;
      }
      out.push({ mesh: 'box', model: mul(m, scaling([w, h, 0.02])), color: SCREEN_ON, pattern: Pattern.emissive });
      const p = clamp(this.progress, 0.02, 1);
      const bw = (w - 0.1) * p;
      out.push({ mesh: 'box', model: mul(m, translation([-(w - 0.1) / 2 + bw / 2, -h * 0.2, 0.012]), scaling([bw, h * 0.22, 0.01])), color: SCREEN_BAR, pattern: Pattern.emissive });
      // A blinking cursor line of "text".
      const tw = (w - 0.2) * (0.4 + 0.3 * Math.abs(Math.sin(t * 2.3)));
      out.push({ mesh: 'box', model: mul(m, translation([-(w - 0.2) / 2 + tw / 2, h * 0.22, 0.012]), scaling([tw, h * 0.1, 0.01])), color: SCREEN_BAR, pattern: Pattern.emissive });
    };
    const led = (pos: Vec3) =>
      out.push({ mesh: 'sphere', model: mul(f, translation(pos), scaling([0.045, 0.045, 0.045])), color: on ? LED_ON : LED_OFF, pattern: Pattern.emissive });
    // A soft green glow on the floor in front of a station in use (seen from across the room).
    if (on) {
      const d = SIZES[this.kind].depth + 0.7;
      out.push({ mesh: 'cylinder', model: mul(f, translation([0, 0.012, d]), scaling([1.1, 0.01, 1.1])), color: [0.3, 1.5, 0.7], pattern: Pattern.blob, param: 0.45, shadow: false });
    }

    switch (this.kind) {
      case 'wires': {
        box([0, 1.35, 0.07], [1.4, 1.2, 0.14], METAL);
        box([0, 1.35, 0.145], [1.2, 1.0, 0.02], RECESS);
        for (let i = 0; i < 4; i++) {
          const y = 0.98 + i * 0.25;
          // Lit: the wires get connected one after another as the task goes on.
          const done = on && this.progress > (i + 0.5) / 4;
          const c = WIRE_COLORS[(i * 3) % 4];
          const rgb = done ? [c[0] * 2.2 + 0.1, c[1] * 2.2 + 0.1, c[2] * 2.2 + 0.1] : c;
          const sag = done ? 0 : 0.05 * Math.sin(i * 1.7);
          out.push({ mesh: 'cylinder', model: mul(f, translation([done ? 0 : -0.25, y - sag, 0.17]), rotationZ(Math.PI / 2 + sag), scaling([0.03, done ? 1.05 : 0.5, 0.03])), color: rgb, pattern: done ? Pattern.emissive : undefined, spec: 0.5 });
          if (!done) out.push({ mesh: 'cylinder', model: mul(f, translation([0.42, y, 0.17]), rotationZ(Math.PI / 2), scaling([0.03, 0.2, 0.03])), color: WIRE_COLORS[i], spec: 0.5 });
        }
        box([0, 2.2, 0.06], [0.95, 0.4, 0.12], DARK_METAL);
        screen(mul(f, translation([0, 2.2, 0.13])), 0.8, 0.28);
        led([0.6, 1.9, 0.15]);
        break;
      }
      case 'dials': {
        box([0, 1.4, 0.07], [1.3, 1.15, 0.14], METAL);
        for (let i = 0; i < 3; i++) {
          const x = -0.4 + i * 0.4;
          out.push({ mesh: 'cylinder', model: mul(f, translation([x, 1.25, 0.16]), rotationX(Math.PI / 2), scaling([0.15, 0.05, 0.15])), color: [0.9, 0.9, 0.86], spec: 0.4 });
          const ang = on ? t * (2 + i) : 0.6 - i * 0.5;
          box([0, 0.06, 0], [0.018, 0.12, 0.01], [0.8, 0.1, 0.05], 0.3, undefined, mul(f, translation([x, 1.25, 0.19]), rotationZ(ang)));
        }
        box([0, 2.2, 0.06], [0.95, 0.4, 0.12], DARK_METAL);
        screen(mul(f, translation([0, 2.2, 0.13])), 0.8, 0.28);
        led([0.55, 1.7, 0.15]);
        break;
      }
      case 'terminal': {
        box([0, 0.45, 0.36], [1.3, 0.9, 0.72], DARK_METAL);
        box([0, 0.93, 0.42], [1.2, 0.06, 0.6], METAL);
        // Keyboard.
        box([0, 0.975, 0.55], [0.8, 0.03, 0.22], [0.12, 0.12, 0.13]);
        // The monitor on a tall stand, so it shows over the head of whoever is typing.
        const mon = mul(f, translation([0, 2.0, 0.22]), rotationX(-0.12));
        out.push({ mesh: 'box', model: mul(mon, scaling([1.15, 0.75, 0.1])), color: [0.16, 0.17, 0.19], spec: 0.4 });
        screen(mul(mon, translation([0, 0, 0.055])), 1.02, 0.6);
        box([0, 1.3, 0.2], [0.12, 0.8, 0.08], [0.16, 0.17, 0.19]);
        led([0.5, 0.93, 0.73]);
        break;
      }
      case 'swipe': {
        box([0, 1.45, 0.09], [0.7, 1.25, 0.18], METAL);
        box([0, 1.15, 0.19], [0.52, 0.06, 0.04], RECESS);
        screen(mul(f, translation([0, 1.88, 0.19])), 0.55, 0.28);
        // A card: parked in its holder, or swiping back and forth through the slot.
        const sx = on ? Math.sin(t * 4) * 0.2 : -0.18;
        const sy = on ? 1.22 : 0.95;
        box([sx, sy, 0.21], [0.22, 0.14, 0.012], [0.9, 0.9, 0.85]);
        box([sx - 0.04, sy + 0.02, 0.217], [0.06, 0.06, 0.004], [0.15, 0.4, 0.8]);
        box([-0.18, 0.95, 0.19], [0.28, 0.08, 0.06], DARK_METAL);
        led([0.28, 1.72, 0.19]);
        break;
      }
      case 'chute': {
        box([0, 1.2, 0.45], [1.1, 2.4, 0.9], [0.36, 0.4, 0.37]);
        box([0, 2.45, 0.45], [1.2, 0.12, 1.0], DARK_METAL);
        // The hatch, which jiggles open while someone empties it.
        const open = on ? 0.25 + 0.15 * Math.abs(Math.sin(t * 5)) : 0;
        box([0, -0.35, 0.01], [0.8, 0.7, 0.04], [0.26, 0.29, 0.27], 0.3, undefined, mul(f, translation([0, 1.65, 0.9]), rotationX(open)));
        box([0, 1.65, 0.899], [0.72, 0.62, 0.01], RECESS);
        // Lever on the side: pulled down while it's in use.
        const lever = on ? 0.9 : -0.2;
        const lm = mul(f, translation([0.6, 1.3, 0.6]), rotationX(lever));
        out.push({ mesh: 'cylinder', model: mul(lm, translation([0.04, 0.25, 0]), scaling([0.035, 0.5, 0.035])), color: DARK_METAL, spec: 0.5 });
        out.push({ mesh: 'sphere', model: mul(lm, translation([0.04, 0.5, 0]), scaling([0.08, 0.08, 0.08])), color: [0.85, 0.1, 0.06], spec: 0.6 });
        screen(mul(f, translation([0, 2.12, 0.91])), 0.55, 0.24);
        led([-0.4, 2.12, 0.91]);
        break;
      }
    }
  }
}

/** A floor vent: a slatted flap that clanks open (`open` 0-1, the level animates it) over a dark hole. */
export class Vent {
  open = 0;
  /** Where the flap is heading (the level sets it; `update` eases toward it). */
  target = 0;

  constructor(readonly pos: Vec3, readonly yaw = 0) {}

  update(dt: number) {
    const k = this.target > this.open ? 18 : 7;
    this.open += (this.target - this.open) * (1 - Math.exp(-dt * k));
  }

  draw(out: DrawItem[]) {
    const base = mul(translation(this.pos), rotationY(this.yaw));
    const W = 1.25, D = 0.9;
    out.push({ mesh: 'box', model: mul(base, translation([0, 0.004, 0]), scaling([W, 0.008, D])), color: [0.005, 0.005, 0.006], shadow: false });
    // The frame.
    for (const [x, z, w, d] of [[0, -D / 2, W + 0.1, 0.07], [0, D / 2, W + 0.1, 0.07], [-W / 2, 0, 0.07, D], [W / 2, 0, 0.07, D]]) {
      out.push({ mesh: 'box', model: mul(base, translation([x, 0.03, z]), scaling([w, 0.06, d])), color: DARK_METAL, spec: 0.5 });
    }
    // The flap, hinged at the back edge.
    const flap = mul(base, translation([0, 0.045, D / 2]), rotationX(-this.open * 1.7), translation([0, 0, -D / 2]));
    out.push({ mesh: 'box', model: mul(flap, translation([0, 0, 0]), scaling([W - 0.06, 0.03, D - 0.06])), color: [0.38, 0.4, 0.43], spec: 0.6 });
    for (let i = 0; i < 6; i++) {
      const z = -D / 2 + 0.12 + i * ((D - 0.24) / 5);
      out.push({ mesh: 'box', model: mul(flap, translation([0, 0.02, z]), scaling([W - 0.2, 0.02, 0.05])), color: [0.12, 0.12, 0.13], spec: 0.2 });
    }
  }
}

export const TABLE_RADIUS = 2.3;
export const TABLE_HEIGHT = 0.82;

/**
 * The round cafeteria table with the EMERGENCY button in the middle (under a glass dome). Adds its
 * colliders; the button's collider is returned for `registerUsable`. `pressed` (s since the last
 * press) pushes the button in.
 */
export function addMeetingTable(physics: Physics, centre: Vec3): RAPIER.Collider {
  physics.addStaticCylinder([centre[0], TABLE_HEIGHT / 2, centre[2]], TABLE_RADIUS, TABLE_HEIGHT);
  return physics.addStaticBox([centre[0], TABLE_HEIGHT + 0.3, centre[2]], [1.1, 0.6, 1.1]);
}

export function drawMeetingTable(out: DrawItem[], centre: Vec3, pressedAgo: number, highlight: number, glow: number) {
  const c = centre;
  out.push({ mesh: 'cylinder', model: mul(translation([c[0], TABLE_HEIGHT / 2 - 0.05, c[2]]), scaling([0.55, TABLE_HEIGHT - 0.1, 0.55])), color: DARK_METAL, spec: 0.4 });
  out.push({ mesh: 'cylinder', model: mul(translation([c[0], 0.03, c[2]]), scaling([1.1, 0.06, 1.1])), color: DARK_METAL, spec: 0.4 });
  out.push({ mesh: 'cylinder', model: mul(translation([c[0], TABLE_HEIGHT - 0.06, c[2]]), scaling([TABLE_RADIUS, 0.12, TABLE_RADIUS])), color: [0.78, 0.8, 0.84], spec: 0.5 });
  out.push({ mesh: 'cylinder', model: mul(translation([c[0], TABLE_HEIGHT - 0.1, c[2]]), scaling([TABLE_RADIUS + 0.06, 0.08, TABLE_RADIUS + 0.06])), color: [0.3, 0.33, 0.4], spec: 0.5 });
  // The button: a grey base, the big red button, and a glass dome over it all.
  const top = TABLE_HEIGHT;
  const depress = pressedAgo < 0.3 ? 0.06 : 0;
  out.push({ mesh: 'cylinder', model: mul(translation([c[0], top + 0.06, c[2]]), scaling([0.55, 0.12, 0.55])), color: [0.55, 0.57, 0.6], spec: 0.5, highlight });
  out.push({ mesh: 'cylinder', model: mul(translation([c[0], top + 0.17 - depress, c[2]]), scaling([0.36, 0.16, 0.36])), color: glow > 0 ? [0.9 + glow * 1.5, 0.08, 0.06] : [0.85, 0.06, 0.05], pattern: glow > 0.5 ? Pattern.emissive : undefined, spec: 0.8, highlight });
  out.push({ mesh: 'sphere', model: mul(translation([c[0], top + 0.1, c[2]]), scaling([0.5, 0.42, 0.5])), color: [0.7, 0.85, 0.95], spec: 1.4, opacity: 0.25, shadow: false, highlight });
}
