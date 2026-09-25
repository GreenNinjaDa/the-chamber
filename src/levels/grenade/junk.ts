import { mul, rotationX, rotationY, rotationZ, scaling, translation, type Mat4, type Vec3 } from '../../engine/math';
import type { BodyModel } from '../../engine/physics';
import type { DrawItem, MeshName } from '../../engine/renderer';

/*
 * The junk that crashes into the grenade chamber. Each piece has a simple collision shape
 * (box, cylinder or ball) and a detailed model built from primitives in its local frame
 * (origin at the centre, front facing -z).
 */

export interface JunkDef {
  name: string;
  shape: 'box' | 'cylinder' | 'ball';
  /** box: full extents; cylinder: [radius, height, radius]; ball: [radius, radius, radius]. */
  size: Vec3;
  mass: number;
  model: BodyModel;
}

// --- Model helpers ----------------------------------------------------------------------------

type Extra = Partial<Pick<DrawItem, 'spec' | 'pattern' | 'param' | 'shadow'>>;

function part(out: DrawItem[], m: Mat4, mesh: MeshName, pos: Vec3, size: Vec3, color: number[], extra: Extra = {}, rot?: Mat4) {
  out.push({ mesh, model: rot ? mul(m, translation(pos), rot, scaling(size)) : mul(m, translation(pos), scaling(size)), color, ...extra });
}
const rbox = (out: DrawItem[], m: Mat4, pos: Vec3, size: Vec3, color: number[], extra?: Extra, rot?: Mat4) =>
  part(out, m, 'roundbox', pos, size, color, extra, rot);
const box = (out: DrawItem[], m: Mat4, pos: Vec3, size: Vec3, color: number[], extra?: Extra, rot?: Mat4) =>
  part(out, m, 'box', pos, size, color, extra, rot);
/** Crisp box with slightly softened edges, for the main bodies of appliances and furniture. */
const bbox = (out: DrawItem[], m: Mat4, pos: Vec3, size: Vec3, color: number[], extra?: Extra, rot?: Mat4) =>
  part(out, m, 'bevelbox', pos, size, color, extra, rot);
/** Cylinder along local y by default; pass rot to point it elsewhere. */
const cyl = (out: DrawItem[], m: Mat4, pos: Vec3, radius: number, height: number, color: number[], extra?: Extra, rot?: Mat4) =>
  part(out, m, 'cylinder', pos, [radius, height, radius], color, extra, rot);
const ball = (out: DrawItem[], m: Mat4, pos: Vec3, size: Vec3, color: number[], extra?: Extra) =>
  part(out, m, 'sphere', pos, size, color, extra);

const FACE_Z = rotationX(Math.PI / 2); // turns a y-axis cylinder to face along z
const SIDE_X = rotationZ(Math.PI / 2); // turns a y-axis cylinder to lie along x

const WHITE = [0.92, 0.93, 0.94];
const CHROME = [0.75, 0.77, 0.8];
const DARK = [0.08, 0.08, 0.09];
const WOOD = [0.62, 0.45, 0.26];
const WOOD_DARK = [0.42, 0.28, 0.15];
const shiny = { spec: 0.8 };

/** Tiny deterministic random, so every bookcase gets the same (but varied) books. */
function seeded(seed: number) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

// --- Models -----------------------------------------------------------------------------------

const fridge: BodyModel = (out, m) => {
  bbox(out, m, [0, 0, 0], [0.9, 1.9, 0.8], WHITE, { spec: 0.4 });
  box(out, m, [0, 0.42, -0.402], [0.86, 0.02, 0.01], [0.55, 0.56, 0.58]);
  rbox(out, m, [0.36, 0.7, -0.43], [0.04, 0.34, 0.05], CHROME, shiny);
  rbox(out, m, [0.36, -0.1, -0.43], [0.04, 0.5, 0.05], CHROME, shiny);
  rbox(out, m, [-0.2, 0.15, -0.405], [0.08, 0.06, 0.02], [0.9, 0.2, 0.2]); // magnets
  rbox(out, m, [-0.05, -0.05, -0.405], [0.07, 0.07, 0.02], [0.2, 0.5, 0.95]);
  rbox(out, m, [-0.25, -0.25, -0.405], [0.09, 0.05, 0.02], [0.95, 0.8, 0.1]);
  for (const x of [-0.38, 0.38]) for (const z of [-0.32, 0.32]) box(out, m, [x, -0.96, z], [0.06, 0.04, 0.06], DARK);
};

const washer: BodyModel = (out, m) => {
  bbox(out, m, [0, 0, 0], [0.7, 0.9, 0.7], WHITE, { spec: 0.4 });
  box(out, m, [0, 0.37, -0.352], [0.66, 0.12, 0.01], [0.6, 0.62, 0.65]);
  cyl(out, m, [0.22, 0.37, -0.36], 0.04, 0.03, DARK, {}, FACE_Z);
  part(out, m, 'tube', [0, -0.06, -0.35], [0.24, 0.05, 0.24], [0.7, 0.72, 0.75], shiny, FACE_Z);
  cyl(out, m, [0, -0.06, -0.352], 0.13, 0.02, [0.15, 0.22, 0.3], { spec: 1 }, FACE_Z);
};

const bathtub: BodyModel = (out, m) => {
  bbox(out, m, [0, 0.02, 0], [1.7, 0.56, 0.8], WHITE, { spec: 0.5 });
  box(out, m, [0, 0.29, 0], [1.5, 0.02, 0.6], [0.35, 0.62, 0.9], { spec: 1 }); // full of water, obviously
  cyl(out, m, [0.72, 0.4, 0], 0.03, 0.22, CHROME, shiny);
  cyl(out, m, [0.66, 0.5, 0], 0.025, 0.14, CHROME, shiny, SIDE_X);
  for (const x of [-0.7, 0.7]) for (const z of [-0.3, 0.3]) ball(out, m, [x, -0.27, z], [0.06, 0.05, 0.06], [0.85, 0.7, 0.25], shiny);
};

const couch: BodyModel = (out, m) => {
  const fabric = [0.45, 0.28, 0.18], cushion = [0.55, 0.36, 0.24];
  box(out, m, [0, -0.18, 0], [2.0, 0.34, 0.86], fabric);
  for (const x of [-0.66, 0, 0.66]) rbox(out, m, [x, 0.04, -0.06], [0.64, 0.16, 0.66], cushion);
  bbox(out, m, [0, 0.16, 0.33], [2.0, 0.46, 0.22], fabric);
  for (const x of [-0.99, 0.99]) rbox(out, m, [x, -0.02, 0], [0.22, 0.52, 0.9], fabric);
  for (const x of [-0.9, 0.9]) for (const z of [-0.36, 0.36]) box(out, m, [x, -0.37, z], [0.06, 0.06, 0.06], WOOD_DARK);
};

const mattress: BodyModel = (out, m) => {
  bbox(out, m, [0, 0, 0], [2.0, 0.25, 1.4], [0.93, 0.92, 0.88]);
  for (let i = -3; i <= 3; i++) box(out, m, [i * 0.27, 0.126, 0], [0.04, 0.005, 1.36], [0.55, 0.65, 0.85]);
  box(out, m, [0, 0, -0.702], [1.96, 0.05, 0.005], [0.55, 0.65, 0.85]);
};

const bookcase: BodyModel = (out, m) => {
  for (const x of [-0.48, 0.48]) box(out, m, [x, 0, 0], [0.04, 2.0, 0.35], WOOD);
  for (const y of [-0.98, -0.5, 0, 0.5, 0.98]) box(out, m, [0, y, 0], [0.92, 0.04, 0.35], WOOD);
  box(out, m, [0, 0, 0.165], [0.92, 2.0, 0.02], WOOD_DARK);
  const rand = seeded(7);
  const colors = [[0.7, 0.15, 0.12], [0.15, 0.35, 0.6], [0.2, 0.5, 0.25], [0.85, 0.7, 0.2], [0.35, 0.2, 0.45], [0.9, 0.9, 0.85]];
  for (const shelf of [-0.96, -0.48, 0.02, 0.52]) {
    let x = -0.44;
    while (x < 0.4) {
      const w = 0.035 + rand() * 0.05, h = 0.26 + rand() * 0.16;
      rbox(out, m, [x + w / 2, shelf + h / 2, -0.02], [w, h, 0.24], colors[Math.floor(rand() * colors.length)]);
      x += w + 0.004;
    }
  }
};

const filingCabinet: BodyModel = (out, m) => {
  const grey = [0.45, 0.47, 0.5];
  bbox(out, m, [0, 0, 0], [0.5, 1.3, 0.6], grey, { spec: 0.4 });
  for (const y of [-0.42, 0, 0.42]) {
    box(out, m, [0, y, -0.302], [0.44, 0.36, 0.01], [0.52, 0.54, 0.57]);
    rbox(out, m, [0, y + 0.08, -0.32], [0.16, 0.03, 0.03], CHROME, shiny);
  }
};

/** Wooden crate with darker plank edges. */
const crate = (s: number): BodyModel => (out, m) => {
  box(out, m, [0, 0, 0], [s * 0.96, s * 0.96, s * 0.96], WOOD);
  const e = s * 0.12, h = s / 2 - e / 2 + 0.005;
  for (const a of [-h, h]) for (const b of [-h, h]) {
    box(out, m, [0, a, b], [s, e, e], WOOD_DARK);
    box(out, m, [a, 0, b], [e, s, e], WOOD_DARK);
    box(out, m, [a, b, 0], [e, e, s], WOOD_DARK);
  }
};

const tire: BodyModel = (out, m) => {
  part(out, m, 'tube', [0, 0, 0], [0.4, 0.25, 0.4], [0.07, 0.07, 0.08]);
  cyl(out, m, [0, 0, 0], 0.21, 0.18, [0.6, 0.62, 0.66], shiny);
  cyl(out, m, [0, 0, 0], 0.06, 0.2, [0.3, 0.31, 0.33], shiny);
};

const gnome: BodyModel = (out, m) => {
  part(out, m, 'cone', [0, -0.13, 0], [0.15, 0.24, 0.15], [0.2, 0.35, 0.75]);
  ball(out, m, [0, 0.03, 0], [0.08, 0.08, 0.08], [0.95, 0.78, 0.65]);
  part(out, m, 'cone', [0, -0.03, -0.05], [0.07, 0.12, 0.05], [0.95, 0.95, 0.95], {}, rotationX(Math.PI));
  part(out, m, 'cone', [0, 0.16, 0.01], [0.09, 0.2, 0.09], [0.85, 0.12, 0.1]);
  ball(out, m, [0, 0.04, -0.075], [0.022, 0.022, 0.022], [0.95, 0.55, 0.5]);
};

const oilDrum: BodyModel = (out, m) => {
  cyl(out, m, [0, 0, 0], 0.3, 0.9, [0.1, 0.3, 0.65], { spec: 0.4 });
  for (const y of [-0.3, 0, 0.3]) part(out, m, 'tube', [0, y, 0], [0.31, 0.03, 0.31], [0.08, 0.22, 0.5]);
  cyl(out, m, [0.12, 0.455, 0.05], 0.04, 0.02, [0.7, 0.7, 0.7], shiny);
  box(out, m, [0, 0, -0.3], [0.2, 0.2, 0.01], [0.95, 0.8, 0.1]); // hazard label
};

const crtTv: BodyModel = (out, m) => {
  bbox(out, m, [0, 0, 0.03], [0.6, 0.5, 0.49], [0.22, 0.22, 0.24]);
  rbox(out, m, [0, 0.02, -0.235], [0.44, 0.34, 0.03], [0.25, 0.35, 0.33], { spec: 1 });
  cyl(out, m, [0.23, -0.18, -0.245], 0.02, 0.02, [0.8, 0.1, 0.1], {}, FACE_Z);
  cyl(out, m, [-0.08, 0.38, 0.05], 0.008, 0.35, CHROME, shiny, rotationZ(0.5));
  cyl(out, m, [0.08, 0.38, 0.05], 0.008, 0.35, CHROME, shiny, rotationZ(-0.5));
};

const microwave: BodyModel = (out, m) => {
  bbox(out, m, [0, 0, 0], [0.5, 0.3, 0.35], WHITE);
  box(out, m, [-0.06, 0, -0.176], [0.32, 0.22, 0.01], [0.1, 0.12, 0.14], { spec: 1 });
  box(out, m, [0.18, 0, -0.176], [0.1, 0.24, 0.01], [0.3, 0.32, 0.35]);
  box(out, m, [0.18, 0.08, -0.182], [0.06, 0.03, 0.005], [0.2, 0.9, 0.3], { pattern: 4 });
};

const toilet: BodyModel = (out, m) => {
  bbox(out, m, [0, 0.12, 0.24], [0.4, 0.5, 0.17], WHITE, { spec: 0.6 });
  cyl(out, m, [0, -0.2, -0.04], 0.18, 0.35, WHITE, { spec: 0.6 });
  part(out, m, 'tube', [0, -0.01, -0.06], [0.2, 0.04, 0.23], WHITE, { spec: 0.6 });
  rbox(out, m, [0, 0.22, 0.14], [0.36, 0.3, 0.03], WHITE, { spec: 0.6 }, rotationX(-0.25));
  rbox(out, m, [0.14, 0.33, 0.2], [0.06, 0.02, 0.04], CHROME, shiny);
};

const trafficCone: BodyModel = (out, m) => {
  box(out, m, [0, -0.33, 0], [0.36, 0.04, 0.36], DARK);
  part(out, m, 'cone', [0, 0.02, 0], [0.16, 0.66, 0.16], [1, 0.42, 0.05]);
  cyl(out, m, [0, 0.02, 0], 0.095, 0.1, WHITE);
};

const rubberDuck: BodyModel = (out, m) => {
  const yellow = [1, 0.85, 0.1];
  ball(out, m, [0, -0.05, 0.03], [0.22, 0.17, 0.25], yellow);
  ball(out, m, [0, 0.13, -0.12], [0.12, 0.12, 0.12], yellow);
  ball(out, m, [0, 0.11, -0.24], [0.06, 0.03, 0.06], [1, 0.45, 0.05]);
  for (const x of [-0.06, 0.06]) ball(out, m, [x, 0.17, -0.21], [0.02, 0.025, 0.02], DARK);
  part(out, m, 'cone', [0, 0.03, 0.26], [0.06, 0.1, 0.06], yellow, {}, rotationX(-1.2));
};

const beachBall: BodyModel = (out, m) => {
  ball(out, m, [0, 0, 0], [0.35, 0.35, 0.35], [0.95, 0.95, 0.95]);
  const colors = [[0.9, 0.15, 0.15], [0.15, 0.4, 0.9], [0.95, 0.8, 0.1]];
  // Coloured bands around the ball: thin discs through the centre, turned on their edge.
  colors.forEach((c, i) => part(out, m, 'cylinder', [0, 0, 0], [0.352, 0.12, 0.352], c, {}, mul(rotationY((i * Math.PI) / 3), rotationX(Math.PI / 2))));
  ball(out, m, [0, 0.35, 0], [0.05, 0.01, 0.05], [0.95, 0.95, 0.95]);
};

const cardboardBox: BodyModel = (out, m) => {
  box(out, m, [0, 0, 0], [0.6, 0.45, 0.45], [0.7, 0.55, 0.35]);
  box(out, m, [0, 0.226, 0], [0.6, 0.004, 0.08], [0.82, 0.72, 0.5]);
  box(out, m, [-0.1, 0.05, -0.226], [0.2, 0.12, 0.004], [0.2, 0.2, 0.2]); // "FRAGILE"
};

const pillow: BodyModel = (out, m) => {
  rbox(out, m, [0, 0, 0], [0.6, 0.15, 0.4], [0.95, 0.95, 0.97]);
  ball(out, m, [0, 0.03, 0], [0.26, 0.06, 0.16], [0.97, 0.97, 0.99]);
};

const pottedPlant: BodyModel = (out, m) => {
  cyl(out, m, [0, -0.22, 0], 0.18, 0.36, [0.72, 0.36, 0.2]);
  cyl(out, m, [0, -0.04, 0], 0.16, 0.02, [0.25, 0.17, 0.1]);
  for (const [x, y, z, r] of [[0, 0.15, 0, 0.14], [0.08, 0.25, 0.04, 0.1], [-0.07, 0.28, -0.03, 0.09], [0.02, 0.33, -0.06, 0.07]]) {
    ball(out, m, [x, y, z], [r, r * 1.2, r], [0.2, 0.55, 0.22]);
  }
};

const trashCan: BodyModel = (out, m) => {
  cyl(out, m, [0, -0.03, 0], 0.24, 0.64, [0.55, 0.57, 0.6], { spec: 0.6 });
  cyl(out, m, [0, 0.32, 0], 0.26, 0.06, [0.5, 0.52, 0.55], { spec: 0.6 });
  box(out, m, [0, 0.37, 0], [0.12, 0.04, 0.03], [0.4, 0.42, 0.45]);
};

const piano: BodyModel = (out, m) => {
  const lacquer = [0.1, 0.06, 0.05];
  bbox(out, m, [0, 0.05, 0.08], [1.5, 1.2, 0.44], lacquer, { spec: 0.8 });
  box(out, m, [0, -0.08, -0.2], [1.4, 0.06, 0.2], lacquer, { spec: 0.8 });
  box(out, m, [0, -0.04, -0.22], [1.3, 0.03, 0.16], [0.95, 0.94, 0.9]);
  for (let i = 0; i < 18; i++) if (i % 7 !== 2 && i % 7 !== 6) box(out, m, [-0.62 + i * 0.073, -0.02, -0.18], [0.03, 0.03, 0.09], DARK);
  for (const x of [-0.68, 0.68]) box(out, m, [x, -0.42, -0.22], [0.06, 0.46, 0.06], lacquer);
  for (const x of [-0.05, 0.08]) cyl(out, m, [x, -0.6, -0.28], 0.015, 0.06, [0.85, 0.7, 0.25], shiny, SIDE_X);
};

const vendingMachine: BodyModel = (out, m) => {
  bbox(out, m, [0, 0, 0], [0.9, 1.9, 0.8], [0.8, 0.12, 0.12], { spec: 0.4 });
  box(out, m, [-0.1, 0.25, -0.402], [0.6, 1.2, 0.01], [0.12, 0.16, 0.22], { spec: 1 });
  const rand = seeded(3);
  const snacks = [[0.95, 0.8, 0.1], [0.2, 0.6, 0.95], [0.95, 0.35, 0.1], [0.3, 0.8, 0.3], [0.8, 0.2, 0.6]];
  for (let r = 0; r < 5; r++) for (let c = 0; c < 4; c++) {
    rbox(out, m, [-0.34 + c * 0.16, -0.25 + r * 0.24, -0.412], [0.11, 0.14, 0.02], snacks[Math.floor(rand() * snacks.length)]);
  }
  box(out, m, [0.3, 0.35, -0.402], [0.16, 0.5, 0.01], [0.25, 0.25, 0.28]);
  box(out, m, [-0.1, -0.7, -0.402], [0.5, 0.18, 0.01], DARK);
};

const safe: BodyModel = (out, m) => {
  const steel = [0.22, 0.24, 0.26];
  bbox(out, m, [0, 0, 0], [0.6, 0.6, 0.6], steel, { spec: 0.6 });
  box(out, m, [0, 0, -0.302], [0.5, 0.5, 0.01], [0.28, 0.3, 0.32], { spec: 0.6 });
  cyl(out, m, [-0.08, 0.06, -0.32], 0.07, 0.04, CHROME, shiny, FACE_Z);
  rbox(out, m, [0.14, -0.05, -0.33], [0.04, 0.16, 0.04], CHROME, shiny);
};

const anvil: BodyModel = (out, m) => {
  const iron = [0.18, 0.19, 0.2];
  rbox(out, m, [0, -0.12, 0], [0.34, 0.1, 0.22], iron, { spec: 0.7 });
  rbox(out, m, [0, -0.02, 0], [0.18, 0.14, 0.14], iron, { spec: 0.7 });
  rbox(out, m, [0.02, 0.1, 0], [0.4, 0.12, 0.2], iron, { spec: 0.7 });
  part(out, m, 'cone', [-0.28, 0.1, 0], [0.08, 0.2, 0.08], iron, { spec: 0.7 }, rotationZ(Math.PI / 2));
};

// --- The pile ---------------------------------------------------------------------------------

export const JUNK: JunkDef[] = [
  { name: 'fridge', shape: 'box', size: [0.9, 1.9, 0.8], mass: 120, model: fridge },
  { name: 'vending machine', shape: 'box', size: [0.9, 1.9, 0.8], mass: 180, model: vendingMachine },
  { name: 'piano', shape: 'box', size: [1.5, 1.3, 0.6], mass: 200, model: piano },
  { name: 'safe', shape: 'box', size: [0.6, 0.6, 0.6], mass: 150, model: safe },
  { name: 'bathtub', shape: 'box', size: [1.7, 0.6, 0.8], mass: 90, model: bathtub },
  { name: 'washing machine', shape: 'box', size: [0.7, 0.9, 0.7], mass: 70, model: washer },
  { name: 'anvil', shape: 'box', size: [0.64, 0.34, 0.24], mass: 80, model: anvil },
  { name: 'filing cabinet', shape: 'box', size: [0.5, 1.3, 0.6], mass: 55, model: filingCabinet },
  { name: 'bookcase', shape: 'box', size: [1.0, 2.0, 0.35], mass: 45, model: bookcase },
  { name: 'oil drum', shape: 'cylinder', size: [0.3, 0.9, 0.3], mass: 40, model: oilDrum },
  { name: 'couch', shape: 'box', size: [2.2, 0.8, 0.9], mass: 60, model: couch },
  { name: 'toilet', shape: 'box', size: [0.4, 0.75, 0.65], mass: 25, model: toilet },
  { name: 'CRT TV', shape: 'box', size: [0.6, 0.5, 0.55], mass: 25, model: crtTv },
  { name: 'mattress', shape: 'box', size: [2.0, 0.25, 1.4], mass: 20, model: mattress },
  { name: 'crate', shape: 'box', size: [0.8, 0.8, 0.8], mass: 20, model: crate(0.8) },
  { name: 'crate', shape: 'box', size: [0.8, 0.8, 0.8], mass: 20, model: crate(0.8) },
  { name: 'small crate', shape: 'box', size: [0.6, 0.6, 0.6], mass: 12, model: crate(0.6) },
  { name: 'microwave', shape: 'box', size: [0.5, 0.3, 0.35], mass: 12, model: microwave },
  { name: 'trash can', shape: 'cylinder', size: [0.26, 0.7, 0.26], mass: 8, model: trashCan },
  { name: 'tire', shape: 'cylinder', size: [0.4, 0.25, 0.4], mass: 10, model: tire },
  { name: 'tire', shape: 'cylinder', size: [0.4, 0.25, 0.4], mass: 10, model: tire },
  { name: 'garden gnome', shape: 'cylinder', size: [0.15, 0.5, 0.15], mass: 5, model: gnome },
  { name: 'traffic cone', shape: 'cylinder', size: [0.18, 0.7, 0.18], mass: 3, model: trafficCone },
  { name: 'cardboard box', shape: 'box', size: [0.6, 0.45, 0.45], mass: 3, model: cardboardBox },
  { name: 'potted plant', shape: 'cylinder', size: [0.2, 0.8, 0.2], mass: 10, model: pottedPlant },
  { name: 'rubber duck', shape: 'ball', size: [0.25, 0.25, 0.25], mass: 1, model: rubberDuck },
  { name: 'beach ball', shape: 'ball', size: [0.35, 0.35, 0.35], mass: 0.5, model: beachBall },
  { name: 'pillow', shape: 'box', size: [0.6, 0.15, 0.4], mass: 1, model: pillow },
];
