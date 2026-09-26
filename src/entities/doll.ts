import { mul, rotationY, rotationZ, scaling, segment, transformDir, transformPoint, translation, type Mat4, type Vec3 } from '../engine/math';
import { RAPIER, type Physics } from '../engine/physics';
import { Pattern, type DrawItem, type MeshName } from '../engine/renderer';

/*
 * The giant doll from a certain Korean playground game (about 7 m tall): orange pinafore over a
 * yellow shirt, white socks, black shoes, a black bob with two little pigtails and big dark eyes
 * that can glow red. Her head swivels on its own (`headYaw`, relative to the body: 0 = the way
 * she faces, PI = right behind her). Built from primitives, facing -z in her own frame.
 */

const ORANGE = [0.92, 0.32, 0.04];
const ORANGE_DARK = [0.72, 0.22, 0.03];
const YELLOW = [1.0, 0.78, 0.16];
const SKIN = [1.0, 0.8, 0.68];
const HAIR = [0.02, 0.018, 0.02];
const SOCK = [0.95, 0.95, 0.93];
const SHOE = [0.05, 0.05, 0.06];
const EYE = [0.02, 0.015, 0.015];
const CHEEK = [1.0, 0.56, 0.54];
const LIP = [0.86, 0.3, 0.3];
const HALO = [1.6, 0.04, 0.03];

/** Height of the head's centre above her feet, and its radius (m). */
export const DOLL_HEAD_Y = 6.15;
const HEAD_R = 1.0;
/** Where each eye sits in the head's frame (x mirrored). */
const EYE_POS: Vec3 = [0.33, 0.0, -0.9];

type Extra = Partial<Pick<DrawItem, 'spec' | 'pattern' | 'shadow' | 'opacity'>>;

function part(out: DrawItem[], m: Mat4, mesh: MeshName, pos: Vec3, size: Vec3, color: ArrayLike<number>, extra: Extra = {}, rot?: Mat4) {
  out.push({ mesh, model: rot ? mul(m, translation(pos), rot, scaling(size)) : mul(m, translation(pos), scaling(size)), color, ...extra });
}

export class Doll {
  /** Head turn relative to the body (radians, same sense as a yaw): PI looks straight behind her. */
  headYaw = 0;
  /** A little sideways cock of the head (radians). */
  headTilt = 0;
  /** 0-1: how red her eyes glow. */
  eyeGlow = 0;
  private root: Mat4;
  private head: Mat4;
  private eyeColor = [0, 0.02, 0.01];

  /** `yaw`: which way her body faces (0 = -z, -PI/2 = +x). */
  constructor(readonly pos: Vec3, readonly yaw: number) {
    this.root = mul(translation(pos), rotationY(yaw));
    this.head = this.root;
    this.update();
  }

  /** Call after changing the head's pose (before drawing or asking where the eyes are). */
  update() {
    this.head = mul(this.root, translation([0, DOLL_HEAD_Y, 0]), rotationY(this.headYaw), rotationZ(this.headTilt));
  }

  /** World position of an eye (side -1 = her left... well, one of them). */
  eye(side: 1 | -1): Vec3 {
    return transformPoint(this.head, [EYE_POS[0] * side, EYE_POS[1], EYE_POS[2] - 0.06]);
  }

  /** Between the eyes, on the face: where she looks from. */
  eyeCentre(): Vec3 {
    return transformPoint(this.head, [0, 0, -HEAD_R + 0.02]);
  }

  /** The way her face points (world). */
  lookDir(): Vec3 {
    return transformDir(this.head, [0, 0, -1]);
  }

  /** Static colliders for her legs and skirt (the head is out of reach anyway). */
  addColliders(physics: Physics): RAPIER.Collider[] {
    return [
      physics.world.createCollider(
        RAPIER.ColliderDesc.cylinder(2.2, 1.3).setTranslation(this.pos[0], 2.2, this.pos[2]),
      ),
    ];
  }

  draw(out: DrawItem[]) {
    const m = this.root;
    // Shoes, socks and legs.
    for (const sx of [-1, 1]) {
      const x = 0.4 * sx;
      part(out, m, 'roundbox', [x, 0.17, -0.12], [0.46, 0.34, 0.82], SHOE, { spec: 0.8 });
      part(out, m, 'box', [x, 0.33, -0.22], [0.48, 0.06, 0.12], SHOE, { spec: 0.8 });
      part(out, m, 'cylinder', [x, 0.9, 0], [0.22, 1.1, 0.22], SOCK);
      part(out, m, 'cylinder', [x, 1.42, 0], [0.235, 0.1, 0.235], SOCK);
      part(out, m, 'cylinder', [x, 2.0, 0], [0.2, 1.2, 0.2], SKIN, { pattern: Pattern.skin });
    }
    // Pinafore: a flared skirt (a cone whose tip hides in the bodice) and the bodice.
    part(out, m, 'cone', [0, 4.01, 0], [1.55, 3.42, 1.55], ORANGE);
    part(out, m, 'cylinder', [0, 2.36, 0], [1.57, 0.12, 1.57], ORANGE_DARK);
    part(out, m, 'roundbox', [0, 4.45, 0], [1.4, 1.2, 0.95], ORANGE);
    for (const sx of [-1, 1]) part(out, m, 'sphere', [0.34 * sx, 4.72, -0.47], [0.07, 0.07, 0.04], ORANGE_DARK, { spec: 0.6 });
    // The yellow shirt shows at the shoulders (puffy sleeves) and collar.
    part(out, m, 'cylinder', [0, 5.06, 0], [0.44, 0.16, 0.4], YELLOW);
    for (const sx of [-1, 1]) {
      part(out, m, 'sphere', [0.28 * sx, 5.08, -0.28], [0.3, 0.07, 0.2], YELLOW, {}, rotationY(0.5 * sx));
      part(out, m, 'sphere', [0.7 * sx, 4.78, 0], [0.36, 0.4, 0.36], YELLOW);
    }
    part(out, m, 'cylinder', [0, 5.25, 0], [0.24, 0.4, 0.24], SKIN, { pattern: Pattern.skin });
    // Arms hanging by her sides.
    for (const sx of [-1, 1]) {
      const shoulder: Vec3 = [0.78 * sx, 4.7, 0];
      const elbow: Vec3 = [0.98 * sx, 3.75, 0.05];
      const wrist: Vec3 = [1.04 * sx, 2.9, -0.06];
      const tm = (p: Vec3) => transformPoint(m, p);
      out.push({ mesh: 'cylinder', model: segment(tm(shoulder), tm(elbow), 0.17), color: SKIN, pattern: Pattern.skin });
      out.push({ mesh: 'cylinder', model: segment(tm(elbow), tm(wrist), 0.155), color: SKIN, pattern: Pattern.skin });
      part(out, m, 'sphere', elbow, [0.17, 0.17, 0.17], SKIN, { pattern: Pattern.skin });
      part(out, m, 'sphere', [1.05 * sx, 2.72, -0.08], [0.19, 0.25, 0.14], SKIN, { pattern: Pattern.skin });
    }

    // The head.
    const h = this.head;
    part(out, h, 'sphere', [0, 0, 0], [HEAD_R, 0.95, 0.96], SKIN, { pattern: Pattern.skin });
    // Bob: the back and top, locks down the sides, straight-cut bangs, two little pigtails.
    part(out, h, 'sphere', [0, 0.1, 0.2], [1.07, 1.02, 0.92], HAIR, { spec: 0.35 });
    for (const sx of [-1, 1]) {
      part(out, h, 'sphere', [0.84 * sx, -0.08, -0.22], [0.28, 0.78, 0.52], HAIR, { spec: 0.35 });
      part(out, h, 'sphere', [1.02 * sx, -0.32, 0.38], [0.22, 0.34, 0.22], HAIR, { spec: 0.35 }, rotationZ(-0.5 * sx));
      part(out, h, 'sphere', [0.97 * sx, -0.06, 0.32], [0.1, 0.1, 0.1], ORANGE);
    }
    part(out, h, 'roundbox', [0, 0.62, -0.63], [1.36, 0.42, 0.5], HAIR, { spec: 0.35 });
    // Face: big glossy eyes (red when she's looking for movement), brows, blush, nose, mouth.
    const g = this.eyeGlow;
    const glowing = g > 0.02;
    if (glowing) this.eyeColor[0] = 0.4 + 2.2 * g;
    for (const sx of [-1, 1]) {
      const ex = EYE_POS[0] * sx;
      part(out, h, 'sphere', [ex, EYE_POS[1], EYE_POS[2]], [0.16, 0.2, 0.07], EYE, { spec: 1 });
      if (glowing) {
        // A red iris burning in the black, and a faint glow around it (visible across the room).
        part(out, h, 'sphere', [ex, EYE_POS[1], EYE_POS[2] - 0.03], [0.09, 0.12, 0.045], this.eyeColor, { pattern: Pattern.emissive, shadow: false });
        part(out, h, 'sphere', [ex, EYE_POS[1], EYE_POS[2] + 0.01], [0.27, 0.31, 0.08], HALO, { pattern: Pattern.emissive, shadow: false, opacity: 0.3 * g });
      } else {
        part(out, h, 'sphere', [ex - 0.05, 0.08, -0.955], [0.045, 0.05, 0.02], [1.6, 1.6, 1.6], { pattern: Pattern.emissive, shadow: false });
      }
      part(out, h, 'roundbox', [0.33 * sx, 0.33, -0.845], [0.2, 0.035, 0.04], HAIR, {}, rotationZ(-0.12 * sx));
      part(out, h, 'sphere', [0.52 * sx, -0.3, -0.755], [0.15, 0.09, 0.04], CHEEK);
    }
    part(out, h, 'sphere', [0, -0.2, -0.95], [0.05, 0.05, 0.04], SKIN, { pattern: Pattern.skin });
    part(out, h, 'sphere', [0, -0.47, -0.84], [0.1, 0.035, 0.03], LIP);
  }
}

/** A bare, dead-looking tree (every playground game needs one), about 6 m tall. */
export function drawBareTree(out: DrawItem[], pos: Vec3) {
  const bark = [0.3, 0.22, 0.16];
  const m = translation(pos);
  const tm = (p: Vec3) => transformPoint(m, p);
  const limb = (a: Vec3, b: Vec3, r: number) => {
    out.push({ mesh: 'cylinder', model: segment(tm(a), tm(b), r), color: bark });
    out.push({ mesh: 'sphere', model: mul(m, translation(b), scaling([r, r, r])), color: bark });
  };
  limb([0, -0.1, 0], [0.1, 3.2, 0.05], 0.32);
  limb([0.1, 3.1, 0.05], [-0.3, 5.4, 0.2], 0.2);
  limb([0.1, 2.6, 0.05], [1.4, 4.3, -0.4], 0.15);
  limb([-0.1, 2.2, 0], [-1.3, 3.6, 0.7], 0.13);
  limb([-0.2, 4.4, 0.15], [-1.2, 5.6, -0.5], 0.1);
  limb([0.4, 3.6, -0.1], [0.9, 5.8, 0.3], 0.1);
  limb([1.0, 3.9, -0.3], [1.8, 4.5, 0.4], 0.07);
  part(out, m, 'cylinder', [0, 0.05, 0], [0.7, 0.1, 0.7], [0.36, 0.3, 0.24]);
}
