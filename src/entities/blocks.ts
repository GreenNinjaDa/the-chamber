import { mul, rotationX, rotationY, rotationZ, scaling, translation, type Mat4, type Quat, type Vec3 } from '../engine/math';
import type { Body, Physics } from '../engine/physics';
import { Pattern, type DrawItem } from '../engine/renderer';

/*
 * An Angry Birds-style building kit: wooden planks and posts, glass panes, stone blocks and TNT
 * crates, each a loose physics box with its own model and hit points. The level decides how
 * much damage they take (see `MATERIALS` for the tunables it reads) and breaks them; a block
 * only remembers how battered it is (`hp`, drawn as darkening) and draws itself.
 */

export type Material = 'wood' | 'glass' | 'stone' | 'tnt';

export interface MaterialDef {
  /** kg per m³ (game scale: planks are carryable, stone is only dragged). TNT crates are a fixed mass. */
  density: number;
  friction: number;
  restitution: number;
  /** Points the birds score for breaking one (the level adds a little for damage too). */
  points: number;
  /**
   * Damage from a sudden change in the block's own speed (m/s): (dv - dv0) / dvScale. A block
   * breaks once it has taken 1 in all (TNT goes off instead).
   */
  dv0: number;
  dvScale: number;
  /** Damage from being hit or landed on, by the impulse (N·s) that went through it: (J - j0) / jScale. */
  j0: number;
  jScale: number;
  /** Damage from an explosion at distance d (m): blast / max(d, 0.5)² × this. */
  blast: number;
}

export const MATERIALS: Record<Material, MaterialDef> = {
  wood: { density: 50, friction: 0.7, restitution: 0.1, points: 500, dv0: 4.5, dvScale: 5, j0: 40, jScale: 120, blast: 7 },
  glass: { density: 60, friction: 0.5, restitution: 0.05, points: 500, dv0: 3, dvScale: 2.5, j0: 15, jScale: 40, blast: 12 },
  stone: { density: 160, friction: 0.5, restitution: 0.02, points: 1000, dv0: 7, dvScale: 9, j0: 300, jScale: 900, blast: 2.5 },
  tnt: { density: 0, friction: 0.7, restitution: 0.1, points: 2000, dv0: 6.5, dvScale: 1, j0: 150, jScale: 60, blast: 8 },
};

export const TNT_MASS = 18;
export const TNT_SIZE = 0.8;

export interface Block {
  body: Body;
  material: Material;
  size: Vec3;
  /** 1 = as good as new; at 0 (or below) the level breaks it. */
  hp: number;
  /** Set once the level has broken it (the body is gone). */
  broken: boolean;
  /** TNT only: seconds until it goes off once lit (-1 = not lit). */
  fuse: number;
  /** Velocity after the last physics step (for spotting sudden hits). */
  lastVel: Vec3;
}

const WOOD = [0.74, 0.46, 0.2];
const WOOD_GRAIN = [0.45, 0.26, 0.1];
const GLASS = [0.45, 0.75, 0.98];
const GLASS_SHINE = [0.95, 0.99, 1.0];
const STONE = [0.6, 0.6, 0.64];
const TNT_WOOD = [0.72, 0.4, 0.18];
const TNT_FRAME = [0.4, 0.2, 0.08];
const TNT_RED = [0.95, 0.12, 0.05];

/** Colours darkened by damage (reused arrays, one per material and damage step). */
const DAMAGE_STEPS = 5;
const shades = new Map<number[], number[][]>();
function damaged(color: number[], hp: number): number[] {
  let list = shades.get(color);
  if (!list) {
    list = [];
    for (let i = 0; i <= DAMAGE_STEPS; i++) {
      const k = 1 - 0.4 * (i / DAMAGE_STEPS);
      list.push([color[0] * k, color[1] * k, color[2] * k]);
    }
    shades.set(color, list);
  }
  const i = Math.max(0, Math.min(DAMAGE_STEPS, Math.round((1 - hp) * DAMAGE_STEPS)));
  return list[i];
}

/** A loose block of `material`, `size` (full extents, m) centred at `center`. */
export function spawnBlock(physics: Physics, material: Material, center: Vec3, size: Vec3, rotation?: Quat): Block {
  const def = MATERIALS[material];
  const s: Vec3 = material === 'tnt' ? [TNT_SIZE, TNT_SIZE, TNT_SIZE] : size;
  const mass = material === 'tnt' ? TNT_MASS : Math.max(1, s[0] * s[1] * s[2] * def.density);
  const block: Block = { body: null!, material, size: s, hp: 1, broken: false, fuse: -1, lastVel: [0, 0, 0] };
  const model = material === 'wood' ? woodModel(block) : material === 'glass' ? glassModel(block) : material === 'stone' ? stoneModel(block) : tntModel(block);
  block.body = physics.addBox(center, s, { mass, friction: def.friction, restitution: def.restitution, rotation, model });
  return block;
}

// --- Models (each in the block's frame, origin at its centre) -------------------------------------

/** The two axes of the block's biggest faces and the axis they face along. */
function faceAxes(size: Vec3): { long: number; across: number; normal: number } {
  const order = [0, 1, 2].sort((a, b) => size[b] - size[a]);
  return { long: order[0], across: order[1], normal: order[2] };
}

function woodModel(b: Block) {
  const { long, across, normal } = faceAxes(b.size);
  // Grain grooves along the long axis on both big faces.
  const grooves: Mat4[] = [];
  for (const side of [-1, 1]) {
    for (const off of [-0.22, 0.2]) {
      const pos: Vec3 = [0, 0, 0];
      const sz: Vec3 = [0, 0, 0];
      pos[normal] = side * (b.size[normal] / 2 + 0.004);
      pos[across] = off * b.size[across];
      sz[long] = b.size[long] * 0.86;
      sz[across] = Math.min(0.035, b.size[across] * 0.08);
      sz[normal] = 0.01;
      grooves.push(mul(translation(pos), scaling(sz)));
    }
  }
  const main = scaling(b.size);
  return (out: DrawItem[], m: Mat4) => {
    out.push({ mesh: 'bevelbox', model: mul(m, main), color: damaged(WOOD, b.hp), spec: 0.12 });
    const grain = damaged(WOOD_GRAIN, b.hp);
    for (const g of grooves) out.push({ mesh: 'box', model: mul(m, g), color: grain, shadow: false });
  };
}

function glassModel(b: Block) {
  const { long, across, normal } = faceAxes(b.size);
  // Two diagonal shine streaks on each big face.
  const streaks: Mat4[] = [];
  for (const side of [-1, 1]) {
    for (const [off, w] of [[-0.12, 0.09], [0.12, 0.04]]) {
      const pos: Vec3 = [0, 0, 0];
      pos[normal] = side * (b.size[normal] / 2 + 0.003);
      pos[long] = off * b.size[long];
      const sz: Vec3 = [0, 0, 0];
      sz[long] = w * Math.min(b.size[long], 2);
      sz[across] = b.size[across] * 0.7;
      sz[normal] = 0.006;
      // Tilt the streak within the face (about the face's normal axis).
      const tilt = normal === 0 ? rotationX(0.5) : normal === 1 ? rotationY(0.5) : null;
      const base = translation(pos);
      streaks.push(tilt ? mul(base, tilt, scaling(sz)) : mul(base, scaling(sz)));
    }
  }
  const main = scaling(b.size);
  return (out: DrawItem[], m: Mat4) => {
    const cracked = b.hp < 0.999;
    out.push({ mesh: 'box', model: mul(m, main), color: damaged(GLASS, b.hp), spec: 1.4, opacity: cracked ? 0.72 : 0.6, shadow: false });
    for (const s of streaks) out.push({ mesh: 'box', model: mul(m, s), color: GLASS_SHINE, spec: 1, opacity: 0.75, shadow: false });
  };
}

function stoneModel(b: Block) {
  const main = scaling(b.size);
  const grain = 1.4 * Math.max(b.size[0], b.size[1], b.size[2]);
  return (out: DrawItem[], m: Mat4) => {
    out.push({ mesh: 'bevelbox', model: mul(m, main), color: damaged(STONE, b.hp), pattern: Pattern.rock, param: grain, spec: 0.06 });
  };
}

/** Block letters T, N, T as bars on a face: [x, y, w, h] in units of the face size. */
const TNT_BARS: [number, number, number, number][] = [
  // T
  [-0.3, 0.16, 0.24, 0.07], [-0.3, -0.03, 0.07, 0.34],
  // N (the middle bar is the diagonal, tilted when drawn)
  [-0.09, 0, 0.06, 0.4], [0.09, 0, 0.06, 0.4], [0, 0, 0.06, 0.43],
  // T
  [0.3, 0.16, 0.24, 0.07], [0.3, -0.03, 0.07, 0.34],
];

function tntModel(b: Block) {
  const s = b.size[0];
  const parts: { mat: Mat4; color: number[]; mesh: 'box' | 'bevelbox'; glow?: boolean }[] = [];
  // A dark crate with lighter panels inset on every side (one box per pair of opposite faces).
  parts.push({ mat: scaling([s, s, s]), color: TNT_FRAME, mesh: 'bevelbox' });
  parts.push({ mat: scaling([s * 1.006, s * 0.8, s * 0.8]), color: TNT_WOOD, mesh: 'box' });
  parts.push({ mat: scaling([s * 0.8, s * 1.006, s * 0.8]), color: TNT_WOOD, mesh: 'box' });
  parts.push({ mat: scaling([s * 0.8, s * 0.8, s * 1.006]), color: TNT_WOOD, mesh: 'box' });
  // TNT in red on all four sides (the N's diagonal is a tilted middle bar).
  for (let side = 0; side < 4; side++) {
    const yaw = rotationY((side * Math.PI) / 2);
    TNT_BARS.forEach(([x, y, w, h], i) => {
      const base = mul(yaw, translation([x * s, y * s, -s / 2 - 0.01]));
      const size = scaling([w * s, h * s, 0.012]);
      parts.push({ mat: i === 4 ? mul(base, rotationZ(-0.45), size) : mul(base, size), color: TNT_RED, mesh: 'box', glow: true });
    });
  }
  const lit = [3.2, 0.6, 0.15];
  return (out: DrawItem[], m: Mat4) => {
    // Lit crates flash before they go.
    const flash = b.fuse >= 0 && Math.floor(b.fuse * 30) % 2 === 0;
    for (const p of parts) {
      const glow = flash && p.glow;
      out.push({
        mesh: p.mesh, model: mul(m, p.mat), color: glow ? lit : p.color,
        pattern: glow ? Pattern.emissive : undefined, spec: 0.1, shadow: p.mesh === 'bevelbox' ? undefined : false,
      });
    }
  };
}
