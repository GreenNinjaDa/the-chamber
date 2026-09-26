import { mul, rotationX, rotationY, scaling, segment, translation, type Mat4, type Vec3 } from '../engine/math';
import { Pattern, type DrawItem } from '../engine/renderer';

/*
 * An arcade ghost, about 2 m tall: a dome on a short sheet with a wavy, scalloped hem, floating
 * a little off the floor, and big white eyes whose pupils look where it's going. Scared ghosts go
 * dark blue with a wobbly zigzag mouth (flashing white when the scare is wearing off); eaten ones
 * are just a pair of eyes.
 */

/** The classic four. */
export const GHOST_COLORS = {
  blinky: [1.0, 0.04, 0.03],
  pinky: [1.0, 0.5, 0.78],
  inky: [0.0, 0.9, 1.0],
  clyde: [1.0, 0.56, 0.08],
} as const;

export type GhostLook = 'normal' | 'scared' | 'flash' | 'eyes';

/** Body radius (m) and full height. */
export const GHOST_RADIUS = 0.62;
export const GHOST_HEIGHT = 2.0;

const R = GHOST_RADIUS;
const DOME_Y = GHOST_HEIGHT - R;
const HEM_Y = 0.52;
const HEM_COUNT = 9;
const HEM_RING = R - 0.2;
const HEM_WIDTH = 0.24;
const EYE_Y = DOME_Y + 0.05;
const EYE_X = 0.25;
const EYE_Z = -0.5;

const SCARED_BODY = [0.07, 0.1, 0.85];
const FLASH_BODY = [1.0, 1.0, 1.0];
const SCARED_FACE = [2.2, 1.35, 0.95];
const FLASH_FACE = [1.8, 0.08, 0.05];
const EYE_WHITE = [1.35, 1.35, 1.45];
const PUPIL = [0.08, 0.14, 1.3];

// Parts that never change shape, in the ghost's own frame (forward = -z, feet at the origin).
const DOME = mul(translation([0, DOME_Y, 0]), scaling([R, R, R]));
const SHEET = mul(translation([0, (HEM_Y + DOME_Y) / 2, 0]), scaling([R, DOME_Y - HEM_Y, R]));
const EYE_WHITES = [-1, 1].map((s) => mul(translation([s * EYE_X, EYE_Y, EYE_Z]), scaling([0.19, 0.25, 0.14])));
const SCARED_EYES = [-1, 1].map((s) => mul(translation([s * 0.2, EYE_Y + 0.08, -0.56]), scaling([0.11, 0.11, 0.1])));
/** The scared face's zigzag mouth, as segments hugging the front of the sheet. */
const MOUTH: [Vec3, Vec3][] = [];
{
  const points: Vec3[] = [];
  for (let k = 0; k <= 6; k++) {
    const x = -0.33 + k * 0.11;
    points.push([x, DOME_Y - 0.22 + (k % 2 ? 0.06 : -0.04), -Math.sqrt(R * R - x * x) - 0.015]);
  }
  for (let k = 0; k < 6; k++) MOUTH.push([points[k], points[k + 1]]);
}
const FLIP = rotationX(Math.PI);

export interface GhostDraw {
  /** Feet position (the hem floats a little above it). */
  pos: Vec3;
  /** Which way the body faces (yaw, 0 = toward -z). */
  yaw: number;
  /** World direction the eyes look (usually where it's going). */
  look: Vec3;
  color: ArrayLike<number>;
  mode: GhostLook;
  time: number;
  /** Overall size (1 = full size; for popping in and out). */
  size?: number;
  /** Per-ghost offset so four ghosts don't wave in lockstep. */
  phase?: number;
  /** Multiplies the body colour: lets a ghost stand out in a dark room (1 = as is). */
  bright?: number;
  /** See-through-ness (1 = solid), e.g. when the camera is inside it. */
  opacity?: number;
}

/** Draws one ghost. */
export function drawGhost(out: DrawItem[], g: GhostDraw) {
  const start = out.length;
  drawParts(out, g);
  const o = g.opacity ?? 1;
  if (o < 1) for (let i = start; i < out.length; i++) out[i].opacity = o;
}

function drawParts(out: DrawItem[], g: GhostDraw) {
  const t = g.time + (g.phase ?? 0);
  const size = g.size ?? 1;
  if (size <= 0.01) return;
  const scared = g.mode === 'scared' || g.mode === 'flash';
  // Scared ghosts wobble like a jelly.
  const wob = scared ? Math.sin(t * 14) * 0.06 : Math.sin(t * 3) * 0.015;
  const base = mul(
    translation(g.pos),
    rotationY(g.yaw),
    scaling([size * (1 + wob), size * (1 - wob), size * (1 + wob)]),
  );
  const at = (m: Mat4) => mul(base, m);

  if (g.mode !== 'eyes') {
    const c = g.mode === 'scared' ? SCARED_BODY : g.mode === 'flash' ? FLASH_BODY : g.color;
    const b = g.bright ?? 1;
    const body = [c[0] * b, c[1] * b, c[2] * b];
    out.push({ mesh: 'sphere', model: at(DOME), color: body, spec: 0.45 });
    out.push({ mesh: 'cylinder', model: at(SHEET), color: body, spec: 0.45 });
    // The hem: downward points around the bottom edge, rippling round like a flapping sheet.
    const speed = scared ? 16 : 9;
    for (let k = 0; k < HEM_COUNT; k++) {
      const a = (k / HEM_COUNT) * Math.PI * 2;
      const len = 0.34 + 0.12 * Math.sin(t * speed - k * 2.1);
      out.push({
        mesh: 'cone',
        model: at(mul(translation([Math.cos(a) * HEM_RING, HEM_Y + 0.02 - len / 2, Math.sin(a) * HEM_RING]), FLIP, scaling([HEM_WIDTH, len, HEM_WIDTH]))),
        color: body,
        spec: 0.45,
      });
    }
  }

  if (scared) {
    const face = g.mode === 'flash' ? FLASH_FACE : SCARED_FACE;
    for (const e of SCARED_EYES) out.push({ mesh: 'box', model: at(e), color: face, pattern: Pattern.emissive, shadow: false });
    for (const [a, b] of MOUTH) out.push({ mesh: 'cylinder', model: at(segment(a, b, 0.028)), color: face, pattern: Pattern.emissive, shadow: false });
    return;
  }

  // Eyes: the pupils slide toward where the ghost is heading, relative to where its face points.
  const c = Math.cos(g.yaw), s = Math.sin(g.yaw);
  const lx = g.look[0] * c - g.look[2] * s; // look direction in the ghost's frame
  const lz = g.look[0] * s + g.look[2] * c;
  const ly = g.look[1];
  const side = Math.max(-1, Math.min(1, lx));
  const up = Math.max(-1, Math.min(1, ly - Math.max(0, lz) * 0.5)); // looking back: roll the eyes up
  const eyeShadow = g.mode === 'eyes';
  for (let i = 0; i < 2; i++) {
    const sx = i === 0 ? -1 : 1;
    out.push({ mesh: 'sphere', model: at(EYE_WHITES[i]), color: EYE_WHITE, pattern: Pattern.emissive, shadow: eyeShadow });
    const pupil = mul(
      translation([sx * EYE_X + side * 0.09, EYE_Y + up * 0.12, EYE_Z - 0.1 + Math.abs(side) * 0.025]),
      scaling([0.1, 0.11, 0.07]),
    );
    out.push({ mesh: 'sphere', model: at(pupil), color: PUPIL, pattern: Pattern.emissive, shadow: false });
  }
}
