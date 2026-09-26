import { mul, rotationX, rotationY, rotationZ, scaling, translation, type Mat4, type Vec3 } from '../engine/math';
import type { BodyModel } from '../engine/physics';
import type { DrawItem, MeshName } from '../engine/renderer';
import type { JunkDef } from './junk';

/*
 * Tiny household things (cans, mugs, books, shoes, pencils, dice...), a little larger than life so
 * they read from across a chamber. Each is a JunkDef, so `spawnJunk(physics, def, pos)` puts one in
 * the world. Cheap: two to seven primitives apiece.
 */

type Extra = Partial<Pick<DrawItem, 'spec' | 'pattern' | 'param'>>;

function part(out: DrawItem[], m: Mat4, mesh: MeshName, pos: Vec3, size: Vec3, color: number[], extra: Extra = {}, rot?: Mat4) {
  out.push({ mesh, model: rot ? mul(m, translation(pos), rot, scaling(size)) : mul(m, translation(pos), scaling(size)), color, ...extra });
}

const SIDE_X = rotationZ(Math.PI / 2); // a y-axis cylinder lying along x
const FACE_Z = rotationX(Math.PI / 2); // a y-axis cylinder facing along z
const WHITE = [0.93, 0.93, 0.92];
const BLACK = [0.05, 0.05, 0.06];
const SILVER = [0.78, 0.8, 0.83];
const shiny = { spec: 0.8 };

const sodaCan = (color: number[], band: number[]): BodyModel => (out, m) => {
  part(out, m, 'cylinder', [0, 0, 0], [0.05, 0.14, 0.05], color, { spec: 0.7 });
  part(out, m, 'cylinder', [0, 0.01, 0], [0.0505, 0.035, 0.0505], band, { spec: 0.7 });
  part(out, m, 'cylinder', [0, 0.072, 0], [0.043, 0.008, 0.043], SILVER, shiny);
};

const mug = (color: number[]): BodyModel => (out, m) => {
  part(out, m, 'cylinder', [0, 0, 0], [0.06, 0.11, 0.06], color, { spec: 0.5 });
  part(out, m, 'cylinder', [0, 0.052, 0], [0.052, 0.008, 0.052], [0.25, 0.13, 0.06], { spec: 0.9 }); // coffee
  part(out, m, 'tube', [0.068, 0.0, 0], [0.035, 0.018, 0.035], color, { spec: 0.5 }, FACE_Z);
};

const book = (cover: number[]): BodyModel => (out, m) => {
  part(out, m, 'box', [0, 0, 0], [0.2, 0.05, 0.26], cover);
  part(out, m, 'box', [0.006, 0, 0], [0.19, 0.04, 0.255], [0.95, 0.93, 0.85]); // pages
  part(out, m, 'box', [-0.098, 0, 0], [0.008, 0.052, 0.262], cover); // spine
};

const shoe = (upper: number[], sole: number[]): BodyModel => (out, m) => {
  part(out, m, 'box', [0, -0.045, 0], [0.12, 0.025, 0.3], sole);
  part(out, m, 'roundbox', [0, 0.005, 0.04], [0.11, 0.09, 0.2], upper);
  part(out, m, 'sphere', [0, -0.012, -0.08], [0.055, 0.045, 0.07], upper);
  for (const z of [-0.03, 0.0, 0.03]) part(out, m, 'box', [0, 0.05, z], [0.07, 0.008, 0.012], WHITE);
};

const pencil: BodyModel = (out, m) => {
  part(out, m, 'cylinder', [0, 0.01, 0], [0.015, 0.2, 0.015], [0.98, 0.78, 0.1]);
  part(out, m, 'cylinder', [0, 0.115, 0], [0.0155, 0.018, 0.0155], SILVER, shiny);
  part(out, m, 'cylinder', [0, 0.132, 0], [0.015, 0.02, 0.015], [0.95, 0.5, 0.55]); // eraser
  part(out, m, 'cone', [0, -0.11, 0], [0.015, 0.03, 0.015], [0.85, 0.68, 0.45], {}, rotationX(Math.PI));
};

const orange: BodyModel = (out, m) => {
  part(out, m, 'sphere', [0, 0, 0], [0.06, 0.058, 0.06], [0.98, 0.5, 0.05], { spec: 0.35 });
  part(out, m, 'sphere', [0.012, 0.058, 0], [0.022, 0.005, 0.01], [0.2, 0.5, 0.15]);
};

const die: BodyModel = (out, m) => {
  const s = 0.14, h = s / 2 + 0.001, pip = [0.02, 0.004, 0.02], red = [0.85, 0.08, 0.08];
  part(out, m, 'roundbox', [0, 0, 0], [s, s, s], WHITE, { spec: 0.4 });
  part(out, m, 'sphere', [0, h, 0], [0.024, 0.005, 0.024], red); // one on top
  for (const k of [-1, 1]) part(out, m, 'sphere', [k * 0.035, k * 0.035, -h], [pip[0], pip[2], pip[1]], BLACK); // two on the front
  for (const k of [-1, 0, 1]) part(out, m, 'sphere', [h, k * 0.035, k * 0.035], [pip[1], pip[0], pip[2]], BLACK); // three on the side
};

const cube: BodyModel = (out, m) => {
  const s = 0.12, f = 0.106, h = s / 2 + 0.001;
  part(out, m, 'roundbox', [0, 0, 0], [s, s, s], BLACK);
  part(out, m, 'box', [0, h, 0], [f, 0.004, f], [0.95, 0.95, 0.95]);
  part(out, m, 'box', [0, -h, 0], [f, 0.004, f], [0.98, 0.85, 0.1]);
  part(out, m, 'box', [0, 0, -h], [f, f, 0.004], [0.1, 0.65, 0.2]);
  part(out, m, 'box', [0, 0, h], [f, f, 0.004], [0.15, 0.3, 0.85]);
  part(out, m, 'box', [h, 0, 0], [0.004, f, f], [0.9, 0.12, 0.1]);
  part(out, m, 'box', [-h, 0, 0], [0.004, f, f], [0.98, 0.5, 0.08]);
};

const tennisBall: BodyModel = (out, m) => {
  part(out, m, 'sphere', [0, 0, 0], [0.07, 0.07, 0.07], [0.8, 0.92, 0.2]);
  part(out, m, 'tube', [0, 0, 0], [0.0705, 0.012, 0.0705], [0.96, 0.96, 0.9], {}, rotationX(0.5));
};

const donut = (icing: number[]): BodyModel => (out, m) => {
  part(out, m, 'tube', [0, -0.008, 0], [0.1, 0.06, 0.1], [0.82, 0.55, 0.28]);
  part(out, m, 'tube', [0, 0.018, 0], [0.098, 0.022, 0.098], icing, { spec: 0.5 });
  for (const [x, z, a] of [[0.07, 0.02, 0.3], [-0.05, 0.06, 1.2], [-0.03, -0.07, 2.1], [0.04, -0.06, 0.8]]) {
    part(out, m, 'box', [x, 0.03, z], [0.022, 0.006, 0.006], [0.3, 0.6, 0.95], {}, rotationY(a));
  }
};

const toyCar = (color: number[]): BodyModel => (out, m) => {
  part(out, m, 'roundbox', [0, -0.005, 0], [0.1, 0.045, 0.2], color, shiny);
  part(out, m, 'roundbox', [0, 0.03, 0.015], [0.085, 0.04, 0.1], [0.55, 0.75, 0.9], shiny);
  for (const x of [-0.052, 0.052]) for (const z of [-0.06, 0.065]) {
    part(out, m, 'cylinder', [x, -0.025, z], [0.022, 0.016, 0.022], BLACK, {}, SIDE_X);
  }
};

const alarmClock: BodyModel = (out, m) => {
  const red = [0.85, 0.12, 0.12];
  part(out, m, 'cylinder', [0, -0.01, 0], [0.07, 0.06, 0.07], red, shiny, FACE_Z);
  part(out, m, 'cylinder', [0, -0.01, -0.03], [0.058, 0.004, 0.058], WHITE, {}, FACE_Z);
  part(out, m, 'box', [0, 0.005, -0.034], [0.006, 0.04, 0.003], BLACK);
  part(out, m, 'box', [0.012, -0.01, -0.035], [0.028, 0.005, 0.003], BLACK);
  for (const x of [-0.045, 0.045]) part(out, m, 'sphere', [x, 0.065, 0], [0.026, 0.022, 0.026], SILVER, shiny);
};

const milkCarton: BodyModel = (out, m) => {
  part(out, m, 'box', [0, -0.02, 0], [0.09, 0.16, 0.09], WHITE);
  part(out, m, 'box', [0, -0.02, -0.0455], [0.07, 0.07, 0.002], [0.2, 0.45, 0.9]);
  part(out, m, 'box', [0, 0.06, 0], [0.0636, 0.0636, 0.088], WHITE, {}, rotationZ(Math.PI / 4)); // the gable top
  part(out, m, 'box', [0, 0.1, 0], [0.012, 0.012, 0.09], WHITE);
};

const toiletRoll: BodyModel = (out, m) => {
  part(out, m, 'tube', [0, 0, 0], [0.06, 0.1, 0.06], [0.97, 0.97, 0.97]);
  part(out, m, 'cylinder', [0, 0, 0], [0.031, 0.1, 0.031], [0.72, 0.58, 0.4]);
};

const rubberChicken: BodyModel = (out, m) => {
  const yellow = [0.98, 0.86, 0.25];
  part(out, m, 'sphere', [0, 0, 0.03], [0.05, 0.045, 0.12], yellow);
  part(out, m, 'cylinder', [0, 0.01, -0.1], [0.018, 0.1, 0.018], yellow, {}, rotationX(1.1));
  part(out, m, 'sphere', [0, 0.04, -0.15], [0.03, 0.028, 0.035], yellow);
  part(out, m, 'box', [0, 0.072, -0.15], [0.006, 0.022, 0.04], [0.9, 0.15, 0.1]); // comb
  part(out, m, 'cone', [0, 0.035, -0.19], [0.012, 0.03, 0.012], [0.98, 0.55, 0.1], {}, rotationX(-Math.PI / 2));
  for (const x of [-0.02, 0.02]) part(out, m, 'cylinder', [x, -0.02, 0.14], [0.008, 0.06, 0.008], [0.98, 0.55, 0.1], {}, rotationX(1.3));
};

const paintCan = (paint: number[]): BodyModel => (out, m) => {
  part(out, m, 'cylinder', [0, 0, 0], [0.09, 0.13, 0.09], SILVER, shiny);
  part(out, m, 'cylinder', [0, -0.005, 0], [0.0905, 0.07, 0.0905], paint);
  part(out, m, 'cylinder', [0, 0.067, 0], [0.078, 0.006, 0.078], paint); // a drip of it on the lid
};

const RED = [0.85, 0.1, 0.1], BLUE = [0.12, 0.35, 0.85], GREEN = [0.15, 0.6, 0.25];

/** The tiny things, one of each kind (with a few colour variants). All are well under 0.3 m. */
export const TRINKETS: JunkDef[] = [
  { name: 'cola', shape: 'cylinder', size: [0.05, 0.15, 0.05], mass: 0.35, model: sodaCan(RED, WHITE) },
  { name: 'lemonade', shape: 'cylinder', size: [0.05, 0.15, 0.05], mass: 0.35, model: sodaCan([0.95, 0.85, 0.2], GREEN) },
  { name: 'fizzy water', shape: 'cylinder', size: [0.05, 0.15, 0.05], mass: 0.35, model: sodaCan(BLUE, SILVER) },
  { name: 'mug', shape: 'cylinder', size: [0.06, 0.11, 0.06], mass: 0.3, model: mug(WHITE) },
  { name: 'mug', shape: 'cylinder', size: [0.06, 0.11, 0.06], mass: 0.3, model: mug([0.2, 0.5, 0.85]) },
  { name: 'book', shape: 'box', size: [0.2, 0.05, 0.26], mass: 0.6, model: book([0.7, 0.12, 0.1]) },
  { name: 'book', shape: 'box', size: [0.2, 0.05, 0.26], mass: 0.6, model: book([0.12, 0.3, 0.6]) },
  { name: 'book', shape: 'box', size: [0.2, 0.05, 0.26], mass: 0.6, model: book([0.18, 0.45, 0.2]) },
  { name: 'shoe', shape: 'box', size: [0.12, 0.11, 0.3], mass: 0.4, model: shoe([0.85, 0.2, 0.15], WHITE) },
  { name: 'shoe', shape: 'box', size: [0.12, 0.11, 0.3], mass: 0.4, model: shoe([0.2, 0.2, 0.25], [0.9, 0.9, 0.85]) },
  { name: 'pencil', shape: 'cylinder', size: [0.015, 0.26, 0.015], mass: 0.05, model: pencil },
  { name: 'orange', shape: 'ball', size: [0.06, 0.06, 0.06], mass: 0.2, model: orange },
  { name: 'die', shape: 'box', size: [0.14, 0.14, 0.14], mass: 0.2, model: die },
  { name: 'puzzle cube', shape: 'box', size: [0.12, 0.12, 0.12], mass: 0.15, model: cube },
  { name: 'tennis ball', shape: 'ball', size: [0.07, 0.07, 0.07], mass: 0.06, model: tennisBall },
  { name: 'donut', shape: 'cylinder', size: [0.1, 0.07, 0.1], mass: 0.1, model: donut([0.98, 0.55, 0.7]) },
  { name: 'donut', shape: 'cylinder', size: [0.1, 0.07, 0.1], mass: 0.1, model: donut([0.35, 0.2, 0.12]) },
  { name: 'toy car', shape: 'box', size: [0.1, 0.08, 0.2], mass: 0.3, model: toyCar(RED) },
  { name: 'toy car', shape: 'box', size: [0.1, 0.08, 0.2], mass: 0.3, model: toyCar(BLUE) },
  { name: 'alarm clock', shape: 'box', size: [0.14, 0.18, 0.08], mass: 0.4, model: alarmClock },
  { name: 'milk carton', shape: 'box', size: [0.09, 0.2, 0.09], mass: 0.5, model: milkCarton },
  { name: 'toilet roll', shape: 'cylinder', size: [0.06, 0.1, 0.06], mass: 0.1, model: toiletRoll },
  { name: 'rubber chicken', shape: 'box', size: [0.1, 0.12, 0.32], mass: 0.3, model: rubberChicken },
  { name: 'paint can', shape: 'cylinder', size: [0.09, 0.13, 0.09], mass: 1.0, model: paintCan([0.95, 0.35, 0.6]) },
  { name: 'paint can', shape: 'cylinder', size: [0.09, 0.13, 0.09], mass: 1.0, model: paintCan([0.3, 0.8, 0.85]) },
];
