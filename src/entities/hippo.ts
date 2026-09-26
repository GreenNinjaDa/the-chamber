import { add, mul, rotationX, rotationY, scale, scaling, segment, translation, type Mat4, type Vec3 } from '../engine/math';
import type { DrawItem } from '../engine/renderer';

/*
 * A giant toy hippo head on a long extending neck, Hungry Hungry Hippos style: shiny plastic,
 * a big hinged mouth with a row of teeth, nostrils and goggly eyes. Drawn from the neck's base
 * (at a wall) out along +z to the head.
 */

export interface HippoPose {
  /** Where the neck starts (at the wall) and where the back of the head is. */
  base: Vec3;
  head: Vec3;
  /** Which way the head faces (yaw, 0 = +z). */
  yaw: number;
  /** 0 = shut, 1 = wide open. */
  jaw: number;
  /** 0-1: eyes shut (asleep, full). */
  sleepy: number;
  /** No back to the throat (there's something to see through it, like a portal). */
  hollow?: boolean;
}

const TEETH = [0.95, 0.95, 0.9];
const MOUTH = [0.35, 0.05, 0.12];

export function drawHippo(out: DrawItem[], pose: HippoPose, color: number[]) {
  const spec = 0.8;
  // The neck: a thick ribbed tube from the wall to the head.
  out.push({ mesh: 'cylinder', model: segment(pose.base, pose.head, 0.95), color, spec });
  const ring = [color[0] * 0.8, color[1] * 0.8, color[2] * 0.8];
  for (let k = 1; k < 6; k++) {
    const p = add(pose.base, scale([pose.head[0] - pose.base[0], pose.head[1] - pose.base[1], pose.head[2] - pose.base[2]], k / 6));
    out.push({ mesh: 'cylinder', model: segment(add(p, scale(dirOf(pose.base, pose.head), -0.12)), add(p, scale(dirOf(pose.base, pose.head), 0.12)), 1.05), color: ring, spec });
  }

  const h: Mat4 = mul(translation(pose.head), rotationY(pose.yaw));
  const part = (mesh: DrawItem['mesh'], m: Mat4, c: number[] = color, s = spec) => out.push({ mesh, model: mul(h, m), color: c, spec: s });
  // The back of the head, ears and eyes.
  part('sphere', mul(translation([0, 0.5, 0.2]), scaling([1.6, 1.35, 1.6])));
  for (const s of [-1, 1]) {
    part('sphere', mul(translation([1.05 * s, 1.75, -0.1]), scaling([0.3, 0.35, 0.22])));
    part('sphere', mul(translation([0.62 * s, 1.55, 0.75]), scaling([0.42, 0.42, 0.42])), [0.97, 0.97, 0.95], 0.9);
    part('sphere', mul(translation([0.66 * s, 1.6, 1.12]), scaling([0.16, 0.16, 0.12])), [0.03, 0.03, 0.04], 1);
    // Eyelids come down when it's full.
    if (pose.sleepy > 0) part('sphere', mul(translation([0.62 * s, 1.55 + 0.4 * (1 - pose.sleepy), 0.78]), scaling([0.45, 0.45 * pose.sleepy + 0.02, 0.45])));
  }
  // The mouth: upper jaw hinged up, lower jaw hinged down, both from the back of the mouth.
  const hinge: Vec3 = [0, 0.2, 0.9];
  const upper = mul(translation(hinge), rotationX(-0.95 * pose.jaw));
  const lower = mul(translation(hinge), rotationX(0.4 * pose.jaw));
  part('sphere', mul(upper, translation([0, 0.3, 1.3]), scaling([1.45, 0.62, 1.55])));
  // Nostrils on top of the snout.
  for (const s of [-1, 1]) part('sphere', mul(upper, translation([0.42 * s, 0.86, 2.2]), scaling([0.2, 0.12, 0.16])), [color[0] * 0.5, color[1] * 0.5, color[2] * 0.5]);
  part('sphere', mul(lower, translation([0, -0.35, 1.25]), scaling([1.35, 0.5, 1.45])));
  // Inside of the mouth, and teeth along both jaws.
  if (pose.jaw > 0.05 && !pose.hollow) part('sphere', mul(translation(hinge), translation([0, -0.02, 0.9]), scaling([1.1, 0.3 + 0.7 * pose.jaw, 1.0])), MOUTH, 0.2);
  for (let k = 0; k < 6; k++) {
    const x = -1.05 + k * 0.42;
    const z = 2.25 - Math.abs(x) * 0.55;
    part('box', mul(upper, translation([x, -0.12, z]), scaling([0.22, 0.3, 0.22])), TEETH, 0.6);
    part('box', mul(lower, translation([x * 0.94, 0.05, z - 0.08]), scaling([0.2, 0.26, 0.2])), TEETH, 0.6);
  }
}

function dirOf(a: Vec3, b: Vec3): Vec3 {
  const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const l = Math.hypot(d[0], d[1], d[2]) || 1;
  return [d[0] / l, d[1] / l, d[2] / l];
}
