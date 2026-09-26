import { clamp, mul, rotationX, rotationY, scaling, translation, type Vec3 } from '../engine/math';
import type { DrawItem } from '../engine/renderer';

/**
 * A floor panel that turns out to be a catapult: it snaps up on its hinge (over 0.1 s), leaving a
 * dark hole. `pos` is the floor point under whoever it flung, `t` the seconds since it fired.
 * The level does the flinging.
 */
export function drawTrapdoor(out: DrawItem[], pos: Vec3, yaw: number, t: number) {
  const angle = 1.15 * clamp(t / 0.1, 0, 1);
  const base = mul(translation(pos), rotationY(yaw));
  out.push({ mesh: 'box', model: mul(base, translation([0, 0.004, 0]), scaling([1.5, 0.01, 1.5])), color: [0.01, 0.01, 0.01] });
  out.push({
    mesh: 'bevelbox',
    model: mul(base, translation([0, 0, -0.75]), rotationX(-angle), translation([0, -0.04, 0.75]), scaling([1.5, 0.08, 1.5])),
    color: [0.45, 0.47, 0.5],
    spec: 0.6,
  });
  out.push({ mesh: 'cylinder', model: mul(base, translation([0, 0.1, -0.2]), rotationX(-angle * 0.5), translation([0, 0.3, 0]), scaling([0.06, 0.7, 0.06])), color: [0.2, 0.2, 0.22] });
}
