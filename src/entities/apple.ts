import { mul, rotationZ, scaling, translation, type Mat4, type Vec3 } from '../engine/math';
import type { Body, Physics } from '../engine/physics';
import type { DrawItem } from '../engine/renderer';

/*
 * A big shiny red apple (a loose, grabbable ball) with a stem and a leaf. `pop` (0-1) scales it
 * up from nothing, for apples that appear out of thin air.
 */

export const APPLE_RADIUS = 0.3;
const RED = [0.72, 0.04, 0.03];
const STEM = [0.25, 0.14, 0.05];
const LEAF = [0.16, 0.5, 0.08];

export interface Apple {
  body: Body;
  /** 0-1: how far it has popped into existence. */
  pop: number;
}

export function spawnApple(physics: Physics, pos: Vec3): Apple {
  const apple: Apple = { body: null as unknown as Body, pop: 0 };
  apple.body = physics.addBall(pos, APPLE_RADIUS, {
    mass: 1,
    restitution: 0.35,
    color: RED,
    model: (out, m) => drawApple(out, m, apple.pop),
  });
  return apple;
}

function drawApple(out: DrawItem[], m: Mat4, pop: number) {
  // Pops in with a little overshoot (ease-out-back).
  const q = pop - 1;
  const s = pop >= 1 ? 1 : Math.max(0.01, 1 + 2.70158 * q * q * q + 1.70158 * q * q);
  const base = s === 1 ? m : mul(m, scaling([s, s, s]));
  const r = APPLE_RADIUS;
  out.push({ mesh: 'sphere', model: mul(base, scaling([r, r * 0.92, r])), color: RED, spec: 0.7 });
  out.push({ mesh: 'cylinder', model: mul(base, translation([0.015, r * 0.95, 0]), rotationZ(-0.25), scaling([0.022, 0.16, 0.022])), color: STEM, spec: 0.1 });
  out.push({ mesh: 'sphere', model: mul(base, translation([-0.07, r * 0.98, 0]), rotationZ(0.5), scaling([0.09, 0.018, 0.045])), color: LEAF, spec: 0.3 });
}
