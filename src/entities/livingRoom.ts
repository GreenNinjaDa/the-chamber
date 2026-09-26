import { mul, rotationX, rotationY, scaling, translation, type Mat4, type Quat, type Vec3 } from '../engine/math';
import { RAPIER, type Body, type BodyModel, type Physics } from '../engine/physics';
import type { DrawItem, MeshName } from '../engine/renderer';

/*
 * Living-room furniture for any level: a sofa and an armchair in any colour, a coffee table, a
 * beanbag and a piano bench (all loose, draggable objects), plus things that only draw: a rug and
 * framed paintings. Sofas and armchairs have compound colliders (seat, back, arms), so you stand
 * on the seat cushions rather than on an invisible box over the whole thing.
 *
 * Models are built in the body's local frame (front facing -z) from `floor` heights: y = 0 is the
 * floor under the piece, shifted down by `lift` (the height of the body's centre).
 */

type Extra = Partial<Pick<DrawItem, 'spec' | 'pattern' | 'param' | 'shadow'>>;

function part(out: DrawItem[], m: Mat4, mesh: MeshName, pos: Vec3, size: Vec3, color: number[], extra: Extra = {}, rot?: Mat4) {
  out.push({ mesh, model: rot ? mul(m, translation(pos), rot, scaling(size)) : mul(m, translation(pos), scaling(size)), color, ...extra });
}

const WOOD = [0.5, 0.33, 0.18];
const WOOD_DARK = [0.28, 0.17, 0.09];
const CREAM = [0.9, 0.86, 0.76];

const lighter = (c: number[], k: number) => c.map((v) => Math.min(1, v * k));

// --- Furniture definitions ------------------------------------------------------------------------

export interface FurnitureDef {
  name: string;
  /** Full extents of the bounding box. */
  size: Vec3;
  mass: number;
  model: BodyModel;
  /**
   * The body's main collider: a box of this size, centred this high over the floor (the body's
   * centre). Omitted: the whole bounding box.
   */
  core?: { size: Vec3; y: number };
  /** Extra box colliders: size and centre over the floor (x, y, z in the piece's frame). */
  extras?: { size: Vec3; pos: Vec3 }[];
}

/**
 * A sofa (2.2 m) in `fabric`: stand on the seat (0.5 m), the arms (0.7 m) or the back (0.9 m).
 */
export function sofa(fabric: number[]): FurnitureDef {
  const lift = 0.25;
  const cushion = lighter(fabric, 1.16);
  const model: BodyModel = (out, m) => {
    const y = (h: number) => h - lift;
    for (const x of [-0.95, 0.95]) for (const z of [-0.36, 0.36]) part(out, m, 'box', [x, y(0.04), z], [0.07, 0.08, 0.07], WOOD_DARK);
    part(out, m, 'bevelbox', [0, y(0.23), 0], [2.2, 0.3, 0.92], fabric);
    for (const x of [-0.64, 0, 0.64]) part(out, m, 'roundbox', [x, y(0.44), -0.08], [0.62, 0.14, 0.72], cushion);
    part(out, m, 'bevelbox', [0, y(0.63), 0.35], [2.2, 0.54, 0.22], fabric);
    for (const x of [-0.62, 0, 0.62]) part(out, m, 'roundbox', [x, y(0.67), 0.2], [0.6, 0.36, 0.14], cushion, {}, rotationX(-0.18));
    for (const x of [-0.99, 0.99]) part(out, m, 'roundbox', [x, y(0.53), 0], [0.24, 0.36, 0.94], fabric);
  };
  return {
    name: 'sofa',
    size: [2.2, 0.9, 0.95],
    mass: 60,
    model,
    core: { size: [2.2, 0.5, 0.95], y: lift },
    extras: [
      { size: [2.2, 0.42, 0.24], pos: [0, 0.69, 0.35] },
      { size: [0.24, 0.22, 0.94], pos: [-0.99, 0.6, 0] },
      { size: [0.24, 0.22, 0.94], pos: [0.99, 0.6, 0] },
    ],
  };
}

/** A fat armchair (1.05 m wide): seat at 0.5 m, arms at 0.72 m, back at 1.0 m. */
export function armchair(fabric: number[]): FurnitureDef {
  const lift = 0.25;
  const cushion = lighter(fabric, 1.16);
  const model: BodyModel = (out, m) => {
    const y = (h: number) => h - lift;
    for (const x of [-0.42, 0.42]) for (const z of [-0.36, 0.36]) part(out, m, 'box', [x, y(0.04), z], [0.07, 0.08, 0.07], WOOD_DARK);
    part(out, m, 'bevelbox', [0, y(0.23), 0], [1.05, 0.3, 0.92], fabric);
    part(out, m, 'roundbox', [0, y(0.44), -0.08], [0.66, 0.14, 0.72], cushion);
    part(out, m, 'bevelbox', [0, y(0.7), 0.36], [1.05, 0.66, 0.22], fabric);
    part(out, m, 'roundbox', [0, y(0.72), 0.21], [0.62, 0.42, 0.14], cushion, {}, rotationX(-0.16));
    for (const x of [-0.43, 0.43]) part(out, m, 'roundbox', [x, y(0.55), 0], [0.2, 0.4, 0.94], fabric);
  };
  return {
    name: 'armchair',
    size: [1.05, 1.0, 0.95],
    mass: 30,
    model,
    core: { size: [1.05, 0.5, 0.95], y: lift },
    extras: [
      { size: [1.05, 0.5, 0.24], pos: [0, 0.75, 0.36] },
      { size: [0.2, 0.22, 0.94], pos: [-0.43, 0.61, 0] },
      { size: [0.2, 0.22, 0.94], pos: [0.43, 0.61, 0] },
    ],
  };
}

/** A low wooden coffee table (0.45 m) with a shelf, a mug and a magazine on it. */
export const COFFEE_TABLE: FurnitureDef = {
  name: 'coffee table',
  size: [1.3, 0.45, 0.75],
  mass: 22,
  model: (out, m) => {
    const y = (h: number) => h - 0.225;
    part(out, m, 'bevelbox', [0, y(0.42), 0], [1.3, 0.06, 0.75], WOOD, { spec: 0.4 });
    for (const x of [-0.58, 0.58]) for (const z of [-0.3, 0.3]) part(out, m, 'box', [x, y(0.2), z], [0.07, 0.4, 0.07], WOOD_DARK);
    part(out, m, 'box', [0, y(0.12), 0], [1.16, 0.03, 0.6], WOOD_DARK);
    part(out, m, 'cylinder', [0.35, y(0.5), -0.1], [0.05, 0.1, 0.05], [0.85, 0.2, 0.15], { spec: 0.6 });
    part(out, m, 'box', [-0.25, y(0.455), 0.08], [0.32, 0.01, 0.24], [0.2, 0.55, 0.75], {}, rotationY(0.3));
  },
};

/** A squashy beanbag (0.55 m): light enough to carry and throw. */
export function beanbag(color: number[]): FurnitureDef {
  return {
    name: 'beanbag',
    size: [0.9, 0.55, 0.9],
    mass: 5,
    model: (out, m) => {
      part(out, m, 'sphere', [0, -0.03, 0], [0.47, 0.3, 0.47], color, { spec: 0.35 });
      part(out, m, 'sphere', [0.02, 0.14, 0.06], [0.33, 0.14, 0.3], lighter(color, 1.1), { spec: 0.35 });
    },
  };
}

/** A padded piano bench (0.5 m): the step up onto the piano. */
export const PIANO_BENCH: FurnitureDef = {
  name: 'piano bench',
  size: [0.9, 0.5, 0.38],
  mass: 12,
  model: (out, m) => {
    const y = (h: number) => h - 0.25;
    part(out, m, 'roundbox', [0, y(0.45), 0], [0.9, 0.1, 0.38], [0.1, 0.06, 0.05], { spec: 0.4 });
    for (const x of [-0.4, 0.4]) for (const z of [-0.14, 0.14]) part(out, m, 'box', [x, y(0.2), z], [0.05, 0.4, 0.05], [0.1, 0.06, 0.05], { spec: 0.6 });
  },
};

/**
 * Adds a piece of furniture as a loose object standing on the floor at (x, z), turned by `yaw`
 * (0: front facing -z). Returns the body and all its colliders.
 */
export function spawnFurniture(physics: Physics, def: FurnitureDef, x: number, z: number, yaw = 0): { body: Body; colliders: RAPIER.Collider[] } {
  const core = def.core ?? { size: def.size, y: def.size[1] / 2 };
  const rotation: Quat = { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
  const body = physics.addBox([x, core.y + 0.01, z], core.size, { mass: def.mass, rotation, model: def.model });
  const colliders = [body.collider];
  for (const e of def.extras ?? []) {
    const desc = RAPIER.ColliderDesc.cuboid(e.size[0] / 2, e.size[1] / 2, e.size[2] / 2)
      .setTranslation(e.pos[0], e.pos[1] - core.y, e.pos[2])
      .setMass(def.mass * 0.1)
      .setFriction(0.7)
      .setRestitution(0.1);
    colliders.push(physics.world.createCollider(desc, body.rb));
  }
  return { body, colliders };
}

// --- Things that only draw -------------------------------------------------------------------------

/** A rug lying on the floor: `size` is [width (x), depth (z)]. Blue, with a cream border and a pattern. */
export function drawRug(out: DrawItem[], centre: Vec3, size: [number, number], base = [0.1, 0.2, 0.58]) {
  const [w, d] = size;
  const at = (x: number, z: number, h: number): Vec3 => [centre[0] + x, centre[1] + h, centre[2] + z];
  const flat = { shadow: false, spec: 0.02 };
  out.push({ mesh: 'box', model: mul(translation(at(0, 0, 0.006)), scaling([w, 0.012, d])), color: base, ...flat });
  // A cream border band, then a darker blue field with a diamond medallion.
  const b = 0.22, bw = 0.12;
  const border = CREAM;
  for (const s of [-1, 1]) {
    out.push({ mesh: 'box', model: mul(translation(at(0, s * (d / 2 - b), 0.0125)), scaling([w - 2 * b + bw, 0.002, bw])), color: border, ...flat });
    out.push({ mesh: 'box', model: mul(translation(at(s * (w / 2 - b), 0, 0.0125)), scaling([bw, 0.002, d - 2 * b + bw])), color: border, ...flat });
  }
  const dark = base.map((c) => c * 0.55);
  out.push({ mesh: 'box', model: mul(translation(at(0, 0, 0.0122)), scaling([w - 2 * b - 0.3, 0.002, d - 2 * b - 0.3])), color: dark, ...flat });
  const medallion = Math.min(w, d) * 0.28;
  out.push({ mesh: 'box', model: mul(translation(at(0, 0, 0.0135)), rotationY(Math.PI / 4), scaling([medallion, 0.002, medallion])), color: [0.75, 0.55, 0.2], ...flat });
  out.push({ mesh: 'box', model: mul(translation(at(0, 0, 0.0145)), rotationY(Math.PI / 4), scaling([medallion * 0.6, 0.002, medallion * 0.6])), color: base, ...flat });
  // Tassels along the short ends.
  for (const s of [-1, 1]) {
    for (let i = 0; i < 14; i++) {
      const z = (i / 13 - 0.5) * (d - 0.2);
      out.push({ mesh: 'box', model: mul(translation(at(s * (w / 2 + 0.06), z, 0.004)), scaling([0.12, 0.006, 0.03])), color: border, ...flat });
    }
  }
}

export type PaintingKind = 'volcano' | 'duck';

/**
 * A framed painting hanging on a wall: `pos` is its centre, `normal` the way it faces (into the
 * room, along x or z), `w` x `h` its size. Something appropriate is painted on it.
 */
export function drawPainting(out: DrawItem[], pos: Vec3, normal: Vec3, w: number, h: number, kind: PaintingKind) {
  // Local frame: x across the painting, y up, z out of the wall.
  const across: Vec3 = [normal[2], 0, -normal[0]];
  const frame = (x: number, y: number, z: number): Mat4 => new Float32Array([
    across[0], across[1], across[2], 0,
    0, 1, 0, 0,
    normal[0], normal[1], normal[2], 0,
    pos[0] + across[0] * x + normal[0] * z, pos[1] + y, pos[2] + across[2] * x + normal[2] * z, 1,
  ]);
  const box = (x: number, y: number, z: number, sx: number, sy: number, sz: number, color: number[], extra: Extra = {}) =>
    out.push({ mesh: 'box', model: mul(frame(x, y, z), scaling([sx, sy, sz])), color, ...extra });
  const gold = [0.72, 0.52, 0.18];
  box(0, 0, 0.03, w + 0.24, h + 0.24, 0.06, gold, { spec: 0.7 });
  if (kind === 'volcano') {
    box(0, 0, 0.065, w, h, 0.01, [0.95, 0.62, 0.35]);
    box(0, h * 0.25, 0.07, w, h * 0.5, 0.01, [0.98, 0.78, 0.45]);
    // The mountain: a wedge of boxes getting narrower, lava running down it.
    for (let i = 0; i < 6; i++) {
      const t = i / 6;
      box(0, -h / 2 + h * 0.08 * (i + 0.5), 0.075, w * (0.9 - t * 0.7), h * 0.08, 0.01, [0.3 - t * 0.1, 0.2 - t * 0.08, 0.16 - t * 0.06]);
    }
    box(0, -h / 2 + h * 0.5, 0.082, w * 0.12, h * 0.06, 0.01, [2.2, 0.7, 0.1], { pattern: 4 });
    box(-w * 0.04, -h / 2 + h * 0.33, 0.082, w * 0.04, h * 0.3, 0.01, [1.8, 0.5, 0.08], { pattern: 4 });
    box(w * 0.07, -h / 2 + h * 0.36, 0.082, w * 0.035, h * 0.26, 0.01, [1.8, 0.5, 0.08], { pattern: 4 });
    for (let i = 0; i < 3; i++) box(w * (i - 1) * 0.08, h * (0.14 + i * 0.1), 0.08, w * 0.12, h * 0.07, 0.01, [0.35, 0.33, 0.33]);
  } else {
    box(0, 0, 0.065, w, h, 0.01, [0.55, 0.8, 0.95]);
    box(0, -h * 0.3, 0.07, w, h * 0.4, 0.01, [0.2, 0.45, 0.85]);
    const yellow = [1, 0.82, 0.1];
    out.push({ mesh: 'sphere', model: mul(frame(0, -h * 0.12, 0.08), scaling([w * 0.24, h * 0.16, 0.01])), color: yellow });
    out.push({ mesh: 'sphere', model: mul(frame(-w * 0.12, h * 0.12, 0.085), scaling([w * 0.12, w * 0.12, 0.01])), color: yellow });
    out.push({ mesh: 'sphere', model: mul(frame(-w * 0.26, h * 0.1, 0.09), scaling([w * 0.08, h * 0.035, 0.01])), color: [1, 0.45, 0.05] });
    out.push({ mesh: 'sphere', model: mul(frame(-w * 0.15, h * 0.16, 0.092), scaling([0.03, 0.03, 0.01])), color: [0.05, 0.05, 0.05] });
  }
}
