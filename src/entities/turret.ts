import { mul, rotationX, rotationZ, scaling, translation, type Mat4 } from '../engine/math';
import { Pattern, type DrawItem } from '../engine/renderer';

/*
 * A sentry turret (Aperture-adjacent, legally distinct): a white egg on three thin legs with
 * a single red eye, and gun panels that swing out of its sides when it's awake. Drawn in its
 * own frame: standing on the origin, 1.25 m tall, looking along -z.
 */

const WHITE = [0.93, 0.94, 0.95];
const GREY = [0.3, 0.31, 0.33];
const DARK = [0.08, 0.08, 0.09];

/**
 * `open` 0-1 swings the side panels out; `eye` 0-1 is how brightly the eye glows (it blinks
 * while charging a shot).
 */
export function drawTurret(out: DrawItem[], m: Mat4, open: number, eye: number) {
  // Legs: one at the back, two splayed at the front.
  for (const [x, z, lean] of [[0, 0.32, 0.35], [-0.28, -0.18, -0.3], [0.28, -0.18, -0.3]] as const) {
    out.push({ mesh: 'cylinder', model: mul(m, translation([x * 0.55, 0.3, z * 0.55]), rotationX(z > 0 ? -lean : lean * 0.4), rotationZ(-x * 0.9), scaling([0.025, 0.62, 0.025])), color: GREY, spec: 0.5 });
  }
  // The body: a tall egg with a dark seam down each side.
  out.push({ mesh: 'sphere', model: mul(m, translation([0, 0.85, 0]), scaling([0.27, 0.42, 0.25])), color: WHITE, spec: 0.8 });
  for (const s of [-1, 1]) {
    out.push({ mesh: 'box', model: mul(m, translation([s * 0.255, 0.85, 0]), scaling([0.03, 0.58, 0.2])), color: DARK });
    // Gun panels swing out sideways when it's awake.
    const panel = mul(m, translation([s * (0.22 + open * 0.14), 0.85, -0.02]), rotationZ(s * open * 0.25));
    out.push({ mesh: 'bevelbox', model: mul(panel, scaling([0.08, 0.5, 0.2])), color: WHITE, spec: 0.7 });
    for (const y of [-0.1, 0.1]) out.push({ mesh: 'cylinder', model: mul(panel, translation([s * 0.02, y, -0.1]), rotationX(Math.PI / 2), scaling([0.025, 0.12 * open + 0.01, 0.025])), color: DARK });
  }
  // The eye.
  out.push({ mesh: 'cylinder', model: mul(m, translation([0, 0.95, -0.235]), rotationX(Math.PI / 2), scaling([0.075, 0.03, 0.075])), color: DARK });
  out.push({
    mesh: 'sphere',
    model: mul(m, translation([0, 0.95, -0.25]), scaling([0.045, 0.045, 0.02])),
    color: [0.4 + eye * 5, 0.02 + eye * 0.3, 0.02],
    pattern: Pattern.emissive,
    shadow: false,
  });
}
