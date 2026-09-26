import { mul, rotationX, rotationY, rotationZ, scaling, translation, type Mat4, type Vec3 } from '../engine/math';
import { Pattern, type DrawItem, type MeshName } from '../engine/renderer';

/*
 * Things with wheels (and a few that float), built from primitives. Each model is drawn in its
 * own frame: front facing -z, origin on the ground (or, for rafts, at the centre of the top face).
 */

export type VehicleKind = 'forklift' | 'golf cart' | 'roomba' | 'office chair' | 'steamroller' | 'sports car';

/** Half width (x), half length (z) and height of each vehicle, for hit tests. */
export const VEHICLE_SIZE: Record<VehicleKind, { hw: number; hl: number; h: number }> = {
  forklift: { hw: 0.65, hl: 1.35, h: 2.2 },
  'golf cart': { hw: 0.65, hl: 1.15, h: 1.9 },
  roomba: { hw: 0.8, hl: 0.8, h: 0.34 },
  'office chair': { hw: 0.36, hl: 0.36, h: 1.15 },
  steamroller: { hw: 0.95, hl: 1.85, h: 2.5 },
  'sports car': { hw: 0.85, hl: 1.9, h: 1.1 },
};

const TYRE = [0.07, 0.07, 0.08];
const METAL = [0.35, 0.36, 0.38];
const DARK = [0.12, 0.12, 0.13];
const YELLOW = [0.95, 0.7, 0.08];

type Extra = Partial<Pick<DrawItem, 'spec' | 'pattern' | 'opacity' | 'shadow'>>;

function part(out: DrawItem[], m: Mat4, mesh: MeshName, pos: Vec3, size: Vec3, color: number[], extra: Extra = {}, rot?: Mat4) {
  out.push({ mesh, model: rot ? mul(m, translation(pos), rot, scaling(size)) : mul(m, translation(pos), scaling(size)), color, ...extra });
}
const box = (out: DrawItem[], m: Mat4, pos: Vec3, size: Vec3, color: number[], extra?: Extra, rot?: Mat4) =>
  part(out, m, 'box', pos, size, color, extra, rot);
const bbox = (out: DrawItem[], m: Mat4, pos: Vec3, size: Vec3, color: number[], extra?: Extra, rot?: Mat4) =>
  part(out, m, 'bevelbox', pos, size, color, extra, rot);
/** A wheel with its axle along x. */
const wheel = (out: DrawItem[], m: Mat4, pos: Vec3, r: number, w: number, spin = 0) => {
  part(out, m, 'cylinder', pos, [r, w, r], TYRE, {}, mul(rotationX(spin), rotationZ(Math.PI / 2)));
  part(out, m, 'cylinder', pos, [r * 0.55, w + 0.02, r * 0.55], METAL, { spec: 0.6 }, rotationZ(Math.PI / 2));
};

/** Draws a vehicle at `m` (ground frame, front -z). `t` animates wheels, blinkers and spinning chairs. */
export function drawVehicle(out: DrawItem[], kind: VehicleKind, m: Mat4, t: number) {
  const spin = t * 6;
  switch (kind) {
    case 'forklift': {
      bbox(out, m, [0, 0.62, 0.3], [1.2, 0.75, 1.6], YELLOW, { spec: 0.4 });
      box(out, m, [0, 0.7, 1.02], [1.22, 0.7, 0.35], DARK);
      box(out, m, [0, 1.05, 0.45], [0.5, 0.12, 0.45], DARK);
      box(out, m, [0, 1.35, 0.7], [0.5, 0.5, 0.1], DARK);
      for (const x of [-0.52, 0.52]) for (const z of [-0.25, 0.95]) box(out, m, [x, 1.5, z], [0.06, 1.1, 0.06], DARK);
      box(out, m, [0, 2.05, 0.35], [1.15, 0.06, 1.3], DARK);
      for (const x of [-0.36, 0.36]) box(out, m, [x, 1.15, -0.62], [0.1, 2.1, 0.12], METAL, { spec: 0.5 });
      box(out, m, [0, 0.35, -0.66], [0.8, 0.3, 0.08], METAL);
      for (const x of [-0.3, 0.3]) box(out, m, [x, 0.1, -1.2], [0.12, 0.06, 1.1], METAL, { spec: 0.6 });
      for (const x of [-0.6, 0.6]) {
        wheel(out, m, [x, 0.3, -0.35], 0.3, 0.22, spin);
        wheel(out, m, [x, 0.25, 0.85], 0.25, 0.2, spin);
      }
      const on = Math.sin(t * 9) > 0;
      part(out, m, 'sphere', [0.4, 2.14, 0.9], [0.09, 0.09, 0.09], on ? [4, 1.6, 0.1] : [0.5, 0.25, 0.05], on ? { pattern: Pattern.emissive } : {});
      break;
    }
    case 'golf cart': {
      bbox(out, m, [0, 0.5, 0], [1.2, 0.45, 2.2], [0.95, 0.95, 0.93], { spec: 0.4 });
      bbox(out, m, [0, 0.8, -0.85], [1.15, 0.35, 0.5], [0.95, 0.95, 0.93], { spec: 0.4 });
      box(out, m, [0, 0.85, 0.3], [1.05, 0.2, 0.55], [0.55, 0.35, 0.2]);
      box(out, m, [0, 1.15, 0.6], [1.05, 0.5, 0.12], [0.55, 0.35, 0.2]);
      for (const x of [-0.55, 0.55]) for (const z of [-0.65, 0.8]) box(out, m, [x, 1.4, z], [0.05, 1.0, 0.05], DARK);
      box(out, m, [0, 1.92, 0.05], [1.3, 0.07, 1.7], [0.12, 0.45, 0.2]);
      box(out, m, [0, 1.35, -0.66], [1.05, 0.7, 0.03], [0.7, 0.85, 0.95], { opacity: 0.35, spec: 1 });
      box(out, m, [0.45, 2.2, 0.85], [0.02, 0.6, 0.02], DARK);
      box(out, m, [0.55, 2.4, 0.85], [0.2, 0.14, 0.02], [1, 0.4, 0.05]);
      for (const x of [-0.58, 0.58]) for (const z of [-0.75, 0.75]) wheel(out, m, [x, 0.22, z], 0.22, 0.16, spin);
      break;
    }
    case 'roomba': {
      part(out, m, 'cylinder', [0, 0.17, 0], [0.8, 0.28, 0.8], [0.14, 0.14, 0.16], { spec: 0.6 });
      part(out, m, 'cylinder', [0, 0.315, 0], [0.72, 0.02, 0.72], [0.22, 0.22, 0.25], { spec: 0.8 });
      part(out, m, 'cylinder', [0, 0.33, 0.05], [0.16, 0.03, 0.16], [0.3, 0.3, 0.33]);
      part(out, m, 'cylinder', [0, 0.35, 0.05], [0.05, 0.02, 0.05], [0.3, 2.2, 0.5], { pattern: Pattern.emissive });
      // The bumper round the front, and a spinning side brush.
      part(out, m, 'wedge', [0, 0.12, 0], [0.82, 0.16, 0.82], [0.4, 0.4, 0.43], {}, rotationY(Math.PI * 0.75));
      const brush = mul(m, translation([-0.55, 0.03, -0.5]), rotationY(t * 14));
      for (let k = 0; k < 3; k++) part(out, brush, 'box', [0, 0, 0], [0.5, 0.02, 0.03], DARK, {}, rotationY((k * Math.PI) / 3));
      break;
    }
    case 'office chair': {
      const c = mul(m, rotationY(t * 5)); // it spins as it rolls, obviously
      for (let k = 0; k < 5; k++) {
        const r = rotationY((k * Math.PI * 2) / 5);
        part(out, c, 'box', [0, 0.1, 0], [0.06, 0.05, 0.62], DARK, {}, mul(r, translation([0, 0, 0.3])));
        const a = (k * Math.PI * 2) / 5;
        part(out, c, 'sphere', [Math.sin(a) * 0.3, 0.05, Math.cos(a) * 0.3], [0.05, 0.05, 0.05], DARK);
      }
      part(out, c, 'cylinder', [0, 0.32, 0], [0.04, 0.4, 0.04], METAL, { spec: 0.7 });
      bbox(out, c, [0, 0.56, 0], [0.55, 0.1, 0.55], [0.08, 0.08, 0.09]);
      bbox(out, c, [0, 0.95, 0.27], [0.5, 0.62, 0.08], [0.08, 0.08, 0.09]);
      for (const x of [-0.29, 0.29]) box(out, c, [x, 0.75, 0], [0.05, 0.05, 0.35], DARK);
      break;
    }
    case 'steamroller': {
      part(out, m, 'cylinder', [0, 0.78, -1.1], [0.78, 1.8, 0.78], [0.45, 0.46, 0.48], { spec: 0.7 }, mul(rotationX(spin * 0.5), rotationZ(Math.PI / 2)));
      for (const x of [-0.97, 0.97]) box(out, m, [x, 1.0, -1.0], [0.12, 0.9, 1.5], YELLOW);
      box(out, m, [0, 1.5, -1.0], [2.0, 0.16, 1.5], YELLOW);
      bbox(out, m, [0, 1.1, 0.75], [1.6, 1.0, 1.9], YELLOW, { spec: 0.4 });
      box(out, m, [0, 1.75, 0.95], [0.6, 0.3, 0.5], DARK);
      for (const x of [-0.7, 0.7]) for (const z of [0.2, 1.6]) box(out, m, [x, 2.05, z], [0.07, 1.1, 0.07], DARK);
      box(out, m, [0, 2.6, 0.9], [1.6, 0.08, 1.6], YELLOW);
      part(out, m, 'cylinder', [0.55, 2.3, 1.5], [0.07, 0.9, 0.07], DARK);
      for (const x of [-0.85, 0.85]) wheel(out, m, [x, 0.55, 1.2], 0.55, 0.35, spin * 0.7);
      break;
    }
    case 'sports car': {
      bbox(out, m, [0, 0.45, 0], [1.7, 0.45, 3.8], [0.85, 0.06, 0.05], { spec: 0.9 });
      bbox(out, m, [0, 0.82, 0.25], [1.3, 0.38, 1.6], [0.12, 0.16, 0.25], { spec: 1 });
      box(out, m, [0, 0.95, 1.8], [1.6, 0.06, 0.25], [0.1, 0.02, 0.02]);
      for (const x of [-0.55, 0.55]) {
        box(out, m, [x, 0.5, -1.9], [0.3, 0.1, 0.04], [5, 5, 4.2], { pattern: Pattern.emissive });
        box(out, m, [x, 0.55, 1.9], [0.3, 0.08, 0.04], [3, 0.2, 0.1], { pattern: Pattern.emissive });
      }
      for (const x of [-0.82, 0.82]) for (const z of [-1.25, 1.25]) wheel(out, m, [x, 0.33, z], 0.33, 0.25, spin * 2);
      break;
    }
  }
}

/** An old wooden door lying flat, floating. Origin at the centre of its top face; 1.1 x 2.2 m. */
export function drawDoorRaft(out: DrawItem[], m: Mat4) {
  const wood = [0.5, 0.3, 0.16], dark = [0.38, 0.22, 0.11];
  bbox(out, m, [0, -0.06, 0], [1.1, 0.12, 2.2], wood);
  for (const z of [-0.5, 0.5]) box(out, m, [0, 0.005, z], [0.8, 0.02, 0.8], dark);
  part(out, m, 'sphere', [0.4, 0.03, 0.05], [0.05, 0.05, 0.05], [0.85, 0.65, 0.2], { spec: 1 });
}

/** A wooden pallet, floating. Origin at the centre of its top face; 1.4 x 1.4 m. */
export function drawPalletRaft(out: DrawItem[], m: Mat4) {
  const wood = [0.72, 0.56, 0.36];
  for (let k = 0; k < 5; k++) box(out, m, [-0.56 + k * 0.28, -0.025, 0], [0.2, 0.05, 1.4], wood);
  for (const z of [-0.6, 0, 0.6]) box(out, m, [0, -0.1, z], [1.4, 0.1, 0.12], [0.6, 0.45, 0.28]);
}
