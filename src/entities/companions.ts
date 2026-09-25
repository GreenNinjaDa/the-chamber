import { add, basis, cross, mul, normalize, scale, scaling, sub, translation, type Mat4, type Quat, type Vec3 } from '../engine/math';
import type { Body, BodyModel, Physics } from '../engine/physics';
import type { DrawItem } from '../engine/renderer';

/*
 * Companion shapes: loving parodies of Portal's Weighted Companion Cube, in every shape except a
 * cube. Light grey bodies with darker trim and pink hearts on round badges.
 */

const BODY = [0.66, 0.68, 0.71];
const TRIM = [0.42, 0.44, 0.47];
const BADGE = [0.3, 0.31, 0.33];
const HEART = [0.95, 0.18, 0.5];

/**
 * A heart on a round badge, drawn in model space `m`: centred on surface point `at`, facing
 * `normal`, with the heart pointing down along -`up`. The badge is thick so its edges sink into
 * curved surfaces instead of floating off them.
 */
export function heartBadge(out: DrawItem[], m: Mat4, at: Vec3, normal: Vec3, up: Vec3, size: number) {
  const n = normalize(normal);
  const u = normalize(sub(up, scale(n, up[0] * n[0] + up[1] * n[1] + up[2] * n[2])));
  const r = cross(u, n);
  const thick = size * 0.3;
  const disc = (centre: Vec3, radius: number, height: number, color: number[]) =>
    out.push({ mesh: 'cylinder', model: mul(m, basis(scale(r, radius), scale(n, height), scale(cross(r, n), radius), centre)), color, spec: 0.3 });
  disc(add(at, scale(n, 0.008 - thick / 2)), size * 0.62, thick, BADGE);
  // The heart: a square turned 45° with two circles on its upper edges.
  const a = size / 1.707;
  const lift = add(at, scale(n, 0.012));
  const centre = sub(lift, scale(u, 0.073 * a));
  const d1 = normalize(add(r, u)), d2 = cross(d1, n);
  out.push({ mesh: 'box', model: mul(m, basis(scale(d1, a), scale(n, 0.01), scale(d2, a), centre)), color: HEART, spec: 0.4 });
  for (const side of [-1, 1]) {
    const c = add(centre, add(scale(r, side * 0.354 * a), scale(u, 0.354 * a)));
    disc(c, a / 2, 0.01, HEART);
  }
}

const sphereModel = (radius: number): BodyModel => (out, m) => {
  out.push({ mesh: 'sphere', model: mul(m, scaling([radius, radius, radius])), color: BODY, spec: 0.35 });
  const dirs: [Vec3, Vec3][] = [
    [[1, 0, 0], [0, 1, 0]], [[-1, 0, 0], [0, 1, 0]], [[0, 0, 1], [0, 1, 0]],
    [[0, 0, -1], [0, 1, 0]], [[0, 1, 0], [0, 0, -1]], [[0, -1, 0], [0, 0, 1]],
  ];
  for (const [n, up] of dirs) heartBadge(out, m, scale(n, radius), n, up, radius * 0.62);
};

const cylinderModel = (radius: number, height: number, hearts: number): BodyModel => (out, m) => {
  out.push({ mesh: 'cylinder', model: mul(m, scaling([radius, height, radius])), color: BODY, spec: 0.35 });
  // Dark rims around both ends.
  for (const y of [-1, 1]) {
    out.push({
      mesh: 'cylinder',
      model: mul(m, translation([0, y * (height / 2 - 0.03), 0]), scaling([radius * 1.03, 0.07, radius * 1.03])),
      color: TRIM,
      spec: 0.3,
    });
  }
  const size = Math.min(radius * 0.9, height * 0.5);
  for (let i = 0; i < hearts; i++) {
    const a = (i / hearts) * Math.PI * 2;
    const n: Vec3 = [Math.cos(a), 0, Math.sin(a)];
    heartBadge(out, m, scale(n, radius), n, [0, 1, 0], size);
  }
  heartBadge(out, m, [0, height / 2, 0], [0, 1, 0], [0, 0, -1], radius * 0.9);
  heartBadge(out, m, [0, -height / 2, 0], [0, -1, 0], [0, 0, 1], radius * 0.9);
};

const coneModel = (radius: number, height: number): BodyModel => (out, m) => {
  out.push({ mesh: 'cone', model: mul(m, scaling([radius, height, radius])), color: BODY, spec: 0.35 });
  out.push({
    mesh: 'cylinder',
    model: mul(m, translation([0, -height / 2 + 0.03, 0]), scaling([radius * 1.03, 0.07, radius * 1.03])),
    color: TRIM,
    spec: 0.3,
  });
  // Three hearts around the sloping side, a third of the way up.
  const y = -height / 2 + height * 0.33;
  const rAt = radius * (1 - 0.33);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const c = Math.cos(a), s = Math.sin(a);
    const n = normalize([c * height, radius, s * height]);
    const up = normalize([-c * radius, height, -s * radius]);
    heartBadge(out, m, [c * rAt, y, s * rAt], n, up, radius * 0.55);
  }
  heartBadge(out, m, [0, -height / 2, 0], [0, -1, 0], [0, 0, 1], radius * 0.9);
  // A little cap on the point.
  out.push({ mesh: 'sphere', model: mul(m, translation([0, height / 2 - 0.05, 0]), scaling([0.05, 0.05, 0.05])), color: TRIM });
};

const capsuleModel = (radius: number, length: number): BodyModel => (out, m) => {
  out.push({ mesh: 'cylinder', model: mul(m, scaling([radius, length, radius])), color: BODY, spec: 0.35 });
  for (const y of [-1, 1]) {
    out.push({ mesh: 'sphere', model: mul(m, translation([0, (y * length) / 2, 0]), scaling([radius, radius, radius])), color: BODY, spec: 0.35 });
    out.push({
      mesh: 'cylinder',
      model: mul(m, translation([0, (y * length) / 2, 0]), scaling([radius * 1.03, 0.07, radius * 1.03])),
      color: TRIM,
      spec: 0.3,
    });
  }
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const n: Vec3 = [Math.cos(a), 0, Math.sin(a)];
    heartBadge(out, m, scale(n, radius), n, [0, 1, 0], Math.min(radius * 0.85, length * 0.6));
  }
};

export type CompanionShape = 'sphere' | 'cylinder' | 'cone' | 'capsule' | 'wheel';

export const COMPANION_SHAPES: CompanionShape[] = ['sphere', 'cylinder', 'cone', 'capsule', 'wheel'];

/** Adds a companion shape as a loose, carryable object (about 15 kg). */
export function spawnCompanion(physics: Physics, shape: CompanionShape, pos: Vec3, rotation?: Quat): Body {
  const opts = { mass: 15, rotation, color: BODY };
  switch (shape) {
    case 'sphere':
      return physics.addBall(pos, 0.42, { ...opts, model: sphereModel(0.42) });
    case 'cylinder':
      return physics.addCylinder(pos, 0.36, 0.8, { ...opts, model: cylinderModel(0.36, 0.8, 4) });
    case 'cone':
      return physics.addCone(pos, 0.48, 0.95, { ...opts, model: coneModel(0.48, 0.95) });
    case 'capsule':
      return physics.addCapsule(pos, 0.3, 0.5, { ...opts, model: capsuleModel(0.3, 0.5) });
    case 'wheel':
      return physics.addCylinder(pos, 0.5, 0.3, { ...opts, model: cylinderModel(0.5, 0.3, 6) });
  }
}
