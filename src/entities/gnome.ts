import { basis, cross, mul, normalize, rotationX, rotationZ, scaling, segment, sub, translation, type Mat4, type Quat, type Vec3 } from '../engine/math';
import type { Body, Physics } from '../engine/physics';
import { Pattern, type DrawItem, type MeshName } from '../engine/renderer';

/*
 * A big garden gnome (about 0.95 m: menacing, but still cute), the kind that moves when nobody is
 * looking. Blue coat, red pointy hat, white beard, and arms that can hold a few poses, so it can
 * be caught in a different one every time you look back. Its eyes can glow in the dark.
 * `spawnGnome` adds one as a loose physics object (8 kg: carried and thrown like anything light).
 */

export const GNOME_HEIGHT = 0.95;
export const GNOME_RADIUS = 0.24;
export const GNOME_MASS = 8;

/** Hand offsets from each shoulder ([right, left], in the gnome's frame: +x right... -z forward). */
type ArmPose = [Vec3, Vec3];
const DOWN_R: Vec3 = [0.06, -0.17, -0.03];
const BEHIND_R: Vec3 = [0.01, -0.13, 0.13];
const HIPS_R: Vec3 = [0.1, -0.1, 0.02];
const WAVE_R: Vec3 = [0.09, 0.17, -0.03];
const POINT_R: Vec3 = [-0.03, 0.04, -0.21];
const SHUSH_R: Vec3 = [-0.15, 0.08, -0.14];
const REACH_R: Vec3 = [-0.02, 0.07, -0.2];
const CLAWS_R: Vec3 = [0.06, 0.18, -0.08];
const mirror = (v: Vec3): Vec3 => [-v[0], v[1], v[2]];

/** Poses by how close the gnome is: innocent from afar, rude up close, grabby within reach. */
export const GNOME_POSES = {
  far: [
    [DOWN_R, mirror(DOWN_R)],
    [BEHIND_R, mirror(BEHIND_R)],
    [HIPS_R, mirror(HIPS_R)],
    [WAVE_R, mirror(DOWN_R)],
  ] as ArmPose[],
  mid: [
    [POINT_R, mirror(HIPS_R)],
    [SHUSH_R, mirror(BEHIND_R)],
    [WAVE_R, mirror(HIPS_R)],
    [POINT_R, mirror(DOWN_R)],
  ] as ArmPose[],
  near: [
    [REACH_R, mirror(REACH_R)],
    [CLAWS_R, mirror(CLAWS_R)],
    [REACH_R, mirror(CLAWS_R)],
  ] as ArmPose[],
  /** Waving you off. */
  bye: [
    [WAVE_R, mirror(DOWN_R)],
    [WAVE_R, mirror(WAVE_R)],
    [WAVE_R, mirror(HIPS_R)],
  ] as ArmPose[],
};

/** Per-gnome look, changed by the level while nobody's watching. */
export interface GnomeLook {
  arms: ArmPose;
  /** 0 = friendly eyebrows, 1 = furious. */
  menace: number;
  /** 0..1: red glowing eyes (in the dark). */
  glow: number;
}

export const newGnomeLook = (): GnomeLook => ({ arms: GNOME_POSES.far[0], menace: 0, glow: 0 });

const COAT = [0.06, 0.16, 0.52];
const HAT = [0.82, 0.09, 0.07];
const HAT_BRIM = [0.66, 0.06, 0.05];
const BEARD = [0.95, 0.95, 0.93];
const SKIN = [0.97, 0.76, 0.62];
const CHEEK = [0.96, 0.52, 0.47];
const NOSE = [0.96, 0.6, 0.52];
const PANTS = [0.36, 0.23, 0.12];
const BOOT = [0.24, 0.13, 0.06];
const BELT = [0.2, 0.12, 0.06];
const GOLD = [0.95, 0.76, 0.2];
const EYE = [0.04, 0.04, 0.05];
const glaze = { spec: 0.55 }; // painted ceramic

function put(out: DrawItem[], m: Mat4, mesh: MeshName, pos: Vec3, size: Vec3, color: ArrayLike<number>, spec = 0.55, rot?: Mat4) {
  out.push({ mesh, model: rot ? mul(m, translation(pos), rot, scaling(size)) : mul(m, translation(pos), scaling(size)), color, spec });
}

/** A cone (or cylinder) from `base` to `tip`, `rx` wide and `rz` deep, with its width along x. */
function taper(out: DrawItem[], m: Mat4, mesh: MeshName, base: Vec3, tip: Vec3, rx: number, rz: number, color: ArrayLike<number>) {
  const y = sub(tip, base);
  const z = normalize(cross([1, 0, 0], y));
  const x = normalize(cross(y, z));
  const mid: Vec3 = [(base[0] + tip[0]) / 2, (base[1] + tip[1]) / 2, (base[2] + tip[2]) / 2];
  out.push({ mesh, model: mul(m, basis([x[0] * rx, x[1] * rx, x[2] * rx], y, [z[0] * rz, z[1] * rz, z[2] * rz], mid)), color, ...glaze });
}

/** Draws a gnome in its body frame `m` (origin at the middle of its 0.95 m height, facing -z). */
export function drawGnome(out: DrawItem[], m: Mat4, look: GnomeLook) {
  const h = GNOME_HEIGHT / 2;
  // Boots and stubby legs.
  for (const s of [-1, 1]) {
    put(out, m, 'roundbox', [s * 0.085, -h + 0.042, -0.035], [0.12, 0.085, 0.21], BOOT, 0.3);
    put(out, m, 'cylinder', [s * 0.085, -h + 0.12, 0], [0.058, 0.1, 0.058], PANTS, 0.3);
  }
  // Pot belly in a blue coat, with a belt.
  put(out, m, 'sphere', [0, -0.17, 0], [0.22, 0.225, 0.19], COAT);
  put(out, m, 'cylinder', [0, -0.2, 0], [0.222, 0.05, 0.192], BELT, 0.3);
  put(out, m, 'roundbox', [0, -0.2, -0.19], [0.075, 0.06, 0.025], GOLD, 0.9);
  // Head.
  put(out, m, 'sphere', [0, 0.1, -0.01], [0.125, 0.125, 0.12], SKIN, 0.45);
  for (const s of [-1, 1]) put(out, m, 'sphere', [s * 0.064, 0.082, -0.1], [0.037, 0.033, 0.03], CHEEK, 0.45);
  put(out, m, 'sphere', [0, 0.095, -0.136], [0.045, 0.041, 0.045], NOSE, 0.6);
  // Eyes: glossy black beads, or glowing red in the dark.
  const glow = look.glow;
  for (const s of [-1, 1]) {
    const pos: Vec3 = [s * 0.047, 0.133, -0.112];
    if (glow > 0.01) {
      out.push({
        mesh: 'sphere', model: mul(m, translation(pos), scaling([0.024, 0.026, 0.02])),
        color: [0.04 + 2.4 * glow, 0.04 + 0.06 * glow, 0.05 + 0.03 * glow], pattern: Pattern.emissive, shadow: false,
      });
    } else {
      put(out, m, 'sphere', pos, [0.022, 0.026, 0.018], EYE, 1);
    }
    // Eyebrows: they tilt into a frown as the gnome gets closer (inner ends down).
    const tilt = -s * (0.12 + 0.6 * look.menace);
    put(out, m, 'roundbox', [s * 0.05, 0.168 - 0.012 * look.menace, -0.108], [0.06, 0.018, 0.024], BEARD, 0.3, rotationZ(tilt));
  }
  // Beard: a fluffy jaw, a moustache and a long point resting on the belly.
  put(out, m, 'sphere', [0, 0.045, -0.06], [0.115, 0.075, 0.085], BEARD, 0.3);
  for (const s of [-1, 1]) put(out, m, 'sphere', [s * 0.04, 0.066, -0.126], [0.045, 0.022, 0.026], BEARD, 0.3, rotationZ(s * 0.25));
  taper(out, m, 'cone', [0, 0.06, -0.085], [0, -0.17, -0.21], 0.115, 0.07, BEARD);
  // Pointy hat, leaning back a little.
  put(out, m, 'cylinder', [0, 0.196, 0.005], [0.14, 0.032, 0.14], HAT_BRIM, 0.5);
  taper(out, m, 'cone', [0, 0.196, 0.005], [0, 0.53, 0.1], 0.13, 0.13, HAT);
  // Arms: a sleeve from each shoulder to a mitten-hand, in whatever pose the level picked.
  for (let i = 0; i < 2; i++) {
    const s = i === 0 ? 1 : -1;
    const shoulder: Vec3 = [s * 0.155, -0.02, -0.01];
    const o = look.arms[i];
    const hand: Vec3 = [shoulder[0] + o[0], shoulder[1] + o[1], shoulder[2] + o[2]];
    put(out, m, 'sphere', shoulder, [0.058, 0.058, 0.058], COAT);
    out.push({ mesh: 'cylinder', model: mul(m, segment(shoulder, hand, 0.047)), color: COAT, ...glaze });
    put(out, m, 'sphere', hand, [0.046, 0.046, 0.046], SKIN, 0.45);
  }
}

/** The gnome's pointy red hat on someone else's head (`head`: that head's frame, e.g. the player's). */
export function drawGnomeHat(out: DrawItem[], head: Mat4) {
  put(out, head, 'cylinder', [0, 0.14, 0.02], [0.215, 0.05, 0.225], HAT_BRIM, 0.5, rotationX(-0.12));
  taper(out, head, 'cone', [0, 0.14, 0.02], [0, 0.66, 0.16], 0.21, 0.21, HAT);
}

/** Adds a gnome standing upright at `pos` (its feet), facing `rotation`. Its look can be changed any time. */
export function spawnGnome(physics: Physics, feet: Vec3, look: GnomeLook, rotation?: Quat): Body {
  return physics.addCylinder([feet[0], feet[1] + GNOME_HEIGHT / 2 + 0.01, feet[2]], GNOME_RADIUS, GNOME_HEIGHT, {
    mass: GNOME_MASS,
    rotation,
    friction: 0.6,
    model: (out, m) => drawGnome(out, m, look),
  });
}
