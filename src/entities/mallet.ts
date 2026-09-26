import { add, basis, cross, normalize, scale, segment, sub, type Vec3 } from '../engine/math';
import { type DrawItem } from '../engine/renderer';

/*
 * A huge rubber whack-a-mole mallet, for a giant's hand: a fat red head with black rubber pads on
 * both striking faces and a yellow band, on a long wooden handle with grip tape. It's posed from
 * where it would strike (`aim`), how far it's swung back (`swing`: 0 = the face flat on the aim
 * point, about 1 = raised right back over the grip), how high the grip is lifted on top of that
 * (`lift`), and which way it comes in from (`from`: horizontal, from the giant toward the aim).
 * The handle meets the head at a rake (it slopes up toward the hand when the face is flat), so a
 * giant holding it from over a wall keeps his hand well above whatever it hits. `squash` (0-1)
 * flattens the rubber head against whatever it just hit.
 */

export const MALLET_HEAD_R = 1.25;
export const MALLET_HEAD_L = 2.3;
/** Grip to the middle of the head (m), and the handle's upward slope when the face is flat (rad). */
export const MALLET_HANDLE = 5.5;
export const MALLET_RAKE = 0.7;

const RED = [0.86, 0.07, 0.06];
const PAD = [0.09, 0.09, 0.1];
const BAND = [1.0, 0.78, 0.1];
const WOOD = [0.93, 0.7, 0.32];
const TAPE = [0.12, 0.1, 0.12];

export class Mallet {
  aim: Vec3 = [0, 0, 0];
  swing = 1;
  lift = 1.5;
  from: Vec3 = [0, 0, -1];
  squash = 0;

  /** Where the giant holds it. */
  grip(): Vec3 {
    const h = this.from, c = Math.cos(MALLET_RAKE), s = Math.sin(MALLET_RAKE);
    return [
      this.aim[0] - h[0] * c * MALLET_HANDLE,
      this.aim[1] + MALLET_HEAD_L / 2 + s * MALLET_HANDLE + this.lift,
      this.aim[2] - h[2] * c * MALLET_HANDLE,
    ];
  }

  /** Unit vector along the handle, from the grip to the head (down the rake when the face is flat). */
  handleDir(): Vec3 {
    const a = this.swing - MALLET_RAKE;
    const c = Math.cos(a), s = Math.sin(a);
    return [this.from[0] * c, s, this.from[2] * c];
  }

  /** The head's axis, pointing away from the face it strikes with. */
  axis(): Vec3 {
    const c = Math.cos(this.swing), s = Math.sin(this.swing);
    return [-this.from[0] * s, c, -this.from[2] * s];
  }

  private rawCentre(): Vec3 {
    return add(this.grip(), scale(this.handleDir(), MALLET_HANDLE));
  }

  /** Middle of the head (squashed toward the striking face). */
  headCentre(): Vec3 {
    const c = this.rawCentre();
    if (this.squash <= 0) return c;
    return add(c, scale(this.axis(), -MALLET_HEAD_L * 0.5 * 0.3 * this.squash));
  }

  /** Centre of the striking face. */
  face(): Vec3 {
    return sub(this.rawCentre(), scale(this.axis(), MALLET_HEAD_L / 2));
  }

  draw(out: DrawItem[]) {
    const g = this.grip(), d = this.handleDir(), a = this.axis();
    const c = this.headCentre();
    const helper: Vec3 = Math.abs(a[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const x = normalize(cross(helper, a));
    const z = cross(x, a);
    const len = MALLET_HEAD_L * (1 - 0.3 * this.squash);
    const r = MALLET_HEAD_R * (1 + 0.18 * this.squash);
    const cyl = (centre: Vec3, radius: number, height: number, color: number[], spec: number) =>
      out.push({ mesh: 'cylinder', model: basis(scale(x, radius), scale(a, height), scale(z, radius), centre), color, spec });
    cyl(c, r, len - 0.36, RED, 0.45);
    for (const s of [-1, 1]) {
      // A rounded-off black pad on each face.
      cyl(add(c, scale(a, s * (len / 2 - 0.13))), r * 1.02, 0.26, PAD, 0.3);
      cyl(add(c, scale(a, s * (len / 2 - 0.01))), r * 0.9, 0.04, PAD, 0.3);
    }
    cyl(c, r * 1.025, 0.34, BAND, 0.5);
    // The handle, from just behind the hand into the head, taped where it's held, with a collar.
    const end = sub(this.rawCentre(), scale(d, r * 0.4));
    const back = sub(g, scale(d, 1.1));
    out.push({ mesh: 'cylinder', model: segment(back, end, 0.17), color: WOOD, spec: 0.35 });
    out.push({ mesh: 'cylinder', model: segment(sub(back, scale(d, 0.05)), add(g, scale(d, 1.0)), 0.2), color: TAPE, spec: 0.2 });
    // Where the handle comes out of the head's side (it meets the axis at a constant angle).
    const exit = Math.min(r / Math.cos(MALLET_RAKE), len / 2 / Math.sin(MALLET_RAKE));
    const collar = sub(this.rawCentre(), scale(d, exit - 0.02));
    out.push({ mesh: 'cylinder', model: segment(sub(collar, scale(d, 0.35)), collar, 0.26), color: BAND, spec: 0.6 });
  }
}
