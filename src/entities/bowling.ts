import { basis, cross, mul, normalize, scale, scaling, translation, type Mat4, type Quat, type Vec3 } from '../engine/math';
import { RAPIER, type Body, type BodyModel, type Physics } from '../engine/physics';
import type { DrawItem } from '../engine/renderer';

/*
 * Bowling: player-sized pins (2 m, white with red neck stripes) and huge glossy bowling balls
 * with three finger holes.
 */

/** Pin height, and how far its origin (the middle of its belly) sits above its base. */
export const PIN_HEIGHT = 2.0;
export const PIN_BELLY = 0.62;
/** Widest radius (the belly). */
export const PIN_RADIUS = 0.32;
export const PIN_MASS = 27;
/** Centre-to-centre spacing of the pin triangle (real pins: 12 in apart at 15 in tall). */
export const PIN_SPACING = 1.6;

const PIN_WHITE = [0.93, 0.92, 0.88];
const PIN_RED = [0.78, 0.05, 0.04];

/** The ten pin spots, numbered 1-10 as a bowler sees them, with the head pin at `headZ` and the triangle pointing south (+z). */
export function pinSpots(headZ: number, spacing = PIN_SPACING): Vec3[] {
  const row = spacing * Math.sqrt(3) / 2;
  const spots: Vec3[] = [];
  for (let r = 0; r < 4; r++) {
    for (let i = 0; i <= r; i++) spots.push([(i - r / 2) * spacing, 0, headZ - r * row]);
  }
  return spots;
}

/** A bowling pin drawn in model space `m` (origin at the middle of the belly, PIN_BELLY above the base). */
export const pinModel: BodyModel = (out, m) => {
  const spec = 0.55;
  const part = (mesh: DrawItem['mesh'], pos: Vec3, size: Vec3, color = PIN_WHITE) =>
    out.push({ mesh, model: mul(m, translation(pos), scaling(size)), color, spec });
  // Belly, the flared base, the shoulders tapering into the neck, and the head.
  part('sphere', [0, 0, 0], [PIN_RADIUS, 0.6, PIN_RADIUS]);
  part('cylinder', [0, -0.5, 0], [0.17, 0.24, 0.17]);
  part('cone', [0, 0.725, 0], [0.25, 0.85, 0.25]);
  part('cylinder', [0, 0.8, 0], [0.12, 0.6, 0.12]);
  part('sphere', [0, 1.15, 0], [0.17, 0.23, 0.17]);
  // Two red neck stripes.
  part('cylinder', [0, 0.6, 0], [0.172, 0.055, 0.172], PIN_RED);
  part('cylinder', [0, 0.72, 0], [0.143, 0.045, 0.143], PIN_RED);
};

/**
 * Adds a loose pin standing with its base at `base`. The body's own collider is the belly
 * (a capsule); the base and the neck/head are extra colliders on the same body.
 */
export function spawnPin(physics: Physics, base: Vec3, rotation?: Quat): Body {
  const body = physics.addCapsule([base[0], base[1] + PIN_BELLY, base[2]], 0.3, 0.5, {
    mass: 19, model: pinModel, rotation, restitution: 0.35, friction: 0.5, color: PIN_WHITE,
  });
  const world = physics.world;
  world.createCollider(
    RAPIER.ColliderDesc.cylinder(0.12, 0.17).setTranslation(0, -0.5, 0).setMass(3).setFriction(0.5).setRestitution(0.35),
    body.rb,
  );
  world.createCollider(
    RAPIER.ColliderDesc.capsule(0.34, 0.15).setTranslation(0, 0.89, 0).setMass(5).setFriction(0.5).setRestitution(0.35),
    body.rb,
  );
  // Tall and top-light: a little tumbling damping keeps them from spinning like propellers.
  body.rb.setAngularDamping(0.4);
  body.angularDamping = 0.4;
  return body;
}

/** How upright a body is: 1 standing straight, 0 lying on its side (its local y against world up). */
export function uprightness(body: Body): number {
  const q = body.rb.rotation();
  return 1 - 2 * (q.x * q.x + q.z * q.z);
}

export const BALL_COLORS: Record<string, number[]> = {
  black: [0.025, 0.022, 0.03],
  purple: [0.16, 0.03, 0.22],
  red: [0.42, 0.02, 0.03],
  blue: [0.02, 0.08, 0.32],
  green: [0.02, 0.2, 0.08],
};

const HOLE = [0.004, 0.004, 0.005];
/** Finger holes around the ball's local +y: two fingers side by side, the thumb below them. */
const HOLES: { dir: Vec3; size: number }[] = [
  { dir: normalize([-0.2, 1, -0.12]), size: 0.13 },
  { dir: normalize([0.2, 1, -0.12]), size: 0.13 },
  { dir: normalize([0, 1, 0.34]), size: 0.15 },
];

const SWIRLS: Vec3[] = [normalize([0.7, -0.35, 0.5]).map((c) => c * 0.21) as Vec3, normalize([-0.5, -0.6, -0.4]).map((c) => c * 0.24) as Vec3];

/** A bowling ball of radius `r` drawn in model space `m` (origin at its centre). */
export function drawBowlingBall(out: DrawItem[], m: Mat4, r: number, color: number[], opacity?: number) {
  out.push({ mesh: 'sphere', model: mul(m, scaling([r, r, r])), color, spec: 1.2, opacity });
  // Lighter marbled patches: big spheres poking just through the surface, so the spin reads.
  for (let i = 0; i < SWIRLS.length; i++) {
    const o = SWIRLS[i];
    const k = 0.79 - i * 0.03 + 0.012;
    const tint = color.map((c, j) => c * (i ? 1.9 : 2.6) + (j === 2 ? 0.03 : 0.015));
    out.push({ mesh: 'sphere', model: mul(m, translation(scale(o, r)), scaling([r * k, r * k, r * k])), color: tint, spec: 1.2, opacity });
  }
  for (const { dir, size } of HOLES) {
    const helper: Vec3 = Math.abs(dir[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1];
    const x = normalize(cross(helper, dir));
    const z = cross(x, dir);
    const hr = r * size;
    // A black disc set into the surface along the hole's axis.
    out.push({
      mesh: 'cylinder',
      model: mul(m, basis(scale(x, hr), scale(dir, r * 0.155), scale(z, hr), scale(dir, r * 0.9275))),
      color: HOLE,
      spec: 0,
      opacity,
    });
  }
}
