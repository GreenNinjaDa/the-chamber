import { mul, rotationX, rotationY, rotationZ, scaling, transformPoint, translation, type Mat4, type Vec3 } from '../engine/math';
import { Pattern, type DrawItem } from '../engine/renderer';

/*
 * The King: an enormous royal head (with a crown, a moustache and a ruff) that rises up behind the
 * north wall to look down on the chamber and talk at it. Mostly scenery; `talk` flaps his mouth,
 * `tears` makes him weep with joy, `glow` lights his eyes up (just before something unpleasant).
 */

const SKIN = [0.96, 0.8, 0.66];
const CHEEK = [0.98, 0.55, 0.55];
const GOLD = [0.95, 0.72, 0.2];
const VELVET = [0.55, 0.12, 0.45];
const HAIR = [0.32, 0.2, 0.12];
const WHITE = [0.97, 0.97, 0.95];
const PUPIL = [0.04, 0.04, 0.05];
const JEWELS = [[0.9, 0.08, 0.12], [0.1, 0.35, 0.95], [0.1, 0.75, 0.3], [0.9, 0.08, 0.12], [0.1, 0.35, 0.95]];

export class King {
  /** Where the middle of his head is, and how big it is. He faces +z (south, into the chamber). */
  pos: Vec3 = [0, 22.5, -23];
  size = 1.6;
  /** How far he has risen into view (0 hidden behind the wall, 1 up). */
  rise = 0;
  /** 0-1 how far his mouth is open. */
  talk = 0;
  /** 0-1: weeping (tears roll down). */
  tears = 0;
  /** 0-1: eyes glowing. */
  glow = 0;
  /** What he's looking at. */
  lookAt: Vec3 = [0, 0, 0];
  private frame: Mat4 = translation([0, 0, 0]);

  /** His head's transform right now. */
  private head(time: number): Mat4 {
    const p = this.pos;
    const k = 1 - this.rise;
    const y = p[1] - k * k * 26 + Math.sin(time * 0.7) * 0.3;
    const dx = this.lookAt[0] - p[0], dz = this.lookAt[2] - p[2];
    const yaw = Math.atan2(dx, dz) * 0.35;
    const pitch = Math.atan2(y - this.lookAt[1], Math.hypot(dx, dz)) * 0.3;
    const s = this.size;
    this.frame = mul(translation([p[0], y, p[2]]), rotationY(yaw), rotationX(pitch), rotationZ(Math.sin(time * 0.5) * 0.03), scaling([s, s, s]));
    return this.frame;
  }

  /** World position of an eye (side -1 left, 1 right), e.g. for beams. */
  eye(side: 1 | -1): Vec3 {
    return transformPoint(this.frame, [side * 1.9, 1.3, 4.5]);
  }

  draw(out: DrawItem[], time: number) {
    if (this.rise <= 0.001) return;
    const m = this.head(time);
    const p = (mesh: DrawItem['mesh'], local: Mat4, color: number[], extra: Partial<DrawItem> = {}) =>
      out.push({ mesh, model: mul(m, local), color, spec: 0.25, ...extra });
    const at = (pos: Vec3, size: Vec3, rot?: Mat4) => (rot ? mul(translation(pos), rot, scaling(size)) : mul(translation(pos), scaling(size)));

    p('sphere', at([0, 0, 0], [5.2, 6.3, 5.0]), SKIN, { pattern: Pattern.skin });
    // The crown: a gold band, a velvet cap, five spikes with a jewel apiece.
    p('cylinder', at([0, 5.1, 0], [4.35, 1.6, 4.35]), GOLD, { spec: 0.9 });
    p('sphere', at([0, 5.9, 0], [4.0, 2.4, 4.0]), VELVET);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + Math.PI / 2;
      const x = Math.cos(a) * 4.0, z = Math.sin(a) * 4.0;
      p('cone', at([x, 7.1, z], [0.8, 2.6, 0.8]), GOLD, { spec: 0.9 });
      p('sphere', at([x, 8.5, z], [0.42, 0.42, 0.42]), GOLD, { spec: 0.9 });
      p('sphere', at([x * 1.1, 5.1, z * 1.1], [0.5, 0.5, 0.3], rotationY(-a + Math.PI / 2)), JEWELS[i], { spec: 1 });
    }
    // Eyes that follow you about the room (and glow, when it's bad news).
    const look = this.lookDir();
    for (const s of [-1, 1] as const) {
      p('sphere', at([s * 1.9, 1.3, 4.1], [1.15, 1.25, 0.7]), WHITE, { spec: 0.6 });
      const pupil = at([s * 1.9 + look[0] * 0.35, 1.2 + look[1] * 0.3, 4.72], [0.5, 0.55, 0.2]);
      if (this.glow > 0) p('sphere', pupil, [0.5 + 3.5 * this.glow, 0.3 + 1.2 * this.glow, 0.2 + 2.5 * this.glow], { pattern: Pattern.emissive, shadow: false });
      else p('sphere', pupil, PUPIL, { spec: 1 });
      // Bushy, disapproving eyebrows.
      p('roundbox', at([s * 1.95, 2.85, 4.25], [1.9, 0.45, 0.6], rotationZ(s * -0.18 - this.glow * s * 0.3)), HAIR);
      p('sphere', at([s * 2.9, -1.2, 3.7], [1.0, 0.7, 0.5]), CHEEK, { pattern: Pattern.skin });
    }
    p('sphere', at([0, -0.4, 4.9], [1.05, 1.2, 1.0]), [0.97, 0.66, 0.58], { pattern: Pattern.skin }); // nose
    // A magnificent moustache, curled at the ends.
    for (const s of [-1, 1] as const) {
      p('sphere', at([s * 1.4, -1.65, 4.55], [1.6, 0.42, 0.55], rotationZ(s * 0.25)), HAIR);
      p('sphere', at([s * 2.9, -1.2, 4.1], [0.45, 0.45, 0.45]), HAIR);
    }
    const open = 0.15 + this.talk * 0.85;
    p('sphere', at([0, -2.9, 4.35], [1.2, 0.75 * open, 0.4]), [0.35, 0.05, 0.08]);
    // A ruff collar and a velvet robe, mostly hidden behind the wall.
    p('tube', at([0, -6.0, 0], [6.4, 1.8, 6.4]), WHITE);
    p('sphere', at([0, -9.5, 0], [9, 4, 6]), VELVET);
    // Tears of joy.
    if (this.tears > 0) {
      for (const s of [-1, 1] as const) {
        for (let k = 0; k < 2; k++) {
          const f = (time * 0.9 + k * 0.5 + (s > 0 ? 0.25 : 0)) % 1;
          const r = 0.35 * this.tears;
          p('sphere', at([s * 2.1, 0.6 - f * 6, 4.6 + f * 0.8], [r, r * 1.3, r]), [0.55, 0.8, 1.0], { spec: 1, shadow: false });
        }
      }
    }
  }

  /** Which way his eyes look, in his head's frame (x right... well, left; y up), roughly. */
  private lookDir(): [number, number] {
    const p = this.pos;
    const dx = this.lookAt[0] - p[0], dy = this.lookAt[1] - p[1], dz = this.lookAt[2] - p[2];
    const d = Math.hypot(dx, dy, dz) || 1;
    return [dx / d, dy / d];
  }
}
