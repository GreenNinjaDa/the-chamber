import { mul, rotationX, rotationY, rotationZ, scaling, translation, type Mat4 } from '../engine/math';
import type { DrawItem } from '../engine/renderer';

/*
 * Giant chess pieces, built from primitives: pawn, knight, bishop, rook, queen and king. Each is
 * drawn from a base frame at the floor (y up, the knight looking along +z), and they're all about
 * as wide as a 3 m board square allows.
 */

export type PieceKind = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';

/** Radius of every piece's base (m). */
export const PIECE_RADIUS = 1.25;

export const PIECE_NAME: Record<PieceKind, string> = { p: 'PAWN', n: 'KNIGHT', b: 'BISHOP', r: 'ROOK', q: 'QUEEN', k: 'KING' };

/** Draws a piece standing on `base` (its origin at the middle of its foot). */
export function drawChessPiece(out: DrawItem[], kind: PieceKind, base: Mat4, color: number[], spec = 0.9) {
  const push = (mesh: DrawItem['mesh'], m: Mat4) => out.push({ mesh, model: mul(base, m), color, spec });
  const cyl = (r: number, y0: number, y1: number) => push('cylinder', mul(translation([0, (y0 + y1) / 2, 0]), scaling([r, y1 - y0, r])));
  const cone = (r: number, y0: number, y1: number) => push('cone', mul(translation([0, (y0 + y1) / 2, 0]), scaling([r, y1 - y0, r])));
  const ball = (r: number, y: number, sy = 1) => push('sphere', mul(translation([0, y, 0]), scaling([r, r * sy, r])));

  // The foot: a wide step and a smaller one.
  cyl(PIECE_RADIUS, 0, 0.32);
  cyl(PIECE_RADIUS * 0.84, 0.32, 0.52);
  switch (kind) {
    case 'p':
      cone(0.82, 0.5, 2.0);
      cyl(0.62, 1.66, 1.8);
      ball(0.55, 2.12);
      break;
    case 'r':
      cyl(0.8, 0.5, 2.35);
      cyl(1.0, 2.3, 2.8);
      // Battlements: four blocks with gaps between.
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
        push('box', mul(translation([Math.sin(a) * 0.72, 3.0, Math.cos(a) * 0.72]), rotationY(a), scaling([0.62, 0.42, 0.5])));
      }
      break;
    case 'b':
      cone(0.9, 0.5, 2.6);
      cyl(0.66, 2.05, 2.2);
      ball(0.6, 2.78, 1.42);
      ball(0.2, 3.62);
      // The slit in the mitre.
      push('box', mul(translation([0.15, 2.95, 0.4]), rotationZ(0.6), scaling([0.08, 0.7, 0.4])));
      out[out.length - 1].color = [color[0] + 0.25, color[1] + 0.25, color[2] + 0.25];
      break;
    case 'q':
      cone(0.98, 0.5, 3.1);
      cyl(0.7, 2.6, 2.76);
      ball(0.62, 3.1, 0.62);
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        push('sphere', mul(translation([Math.sin(a) * 0.58, 3.44, Math.cos(a) * 0.58]), scaling([0.15, 0.15, 0.15])));
      }
      ball(0.24, 3.78);
      break;
    case 'k':
      cone(1.0, 0.5, 3.4);
      cyl(0.72, 2.9, 3.06);
      ball(0.64, 3.4, 0.62);
      cyl(0.62, 3.5, 3.85);
      push('box', mul(translation([0, 4.3, 0]), scaling([0.2, 0.8, 0.2])));
      push('box', mul(translation([0, 4.35, 0]), scaling([0.6, 0.2, 0.2])));
      break;
    case 'n': {
      cyl(0.78, 0.5, 1.35);
      // Neck leaning forward, the head sticking out further, ears and a mane.
      push('box', mul(translation([0, 1.9, 0.1]), rotationX(0.35), scaling([0.85, 1.5, 1.05])));
      push('box', mul(translation([0, 2.62, 0.55]), rotationX(-0.4), scaling([0.76, 0.66, 1.5])));
      push('box', mul(translation([0, 2.3, 1.2]), rotationX(-0.4), scaling([0.66, 0.5, 0.5])));
      for (const s of [-1, 1]) push('cone', mul(translation([0.24 * s, 3.1, 0.15]), rotationX(-0.2), scaling([0.13, 0.42, 0.13])));
      push('box', mul(translation([0, 2.35, -0.45]), rotationX(0.35), scaling([0.25, 1.6, 0.3])));
      // Eyes, a little lighter so the horse has a face.
      for (const s of [-1, 1]) {
        push('sphere', mul(translation([0.39 * s, 2.78, 0.82]), scaling([0.08, 0.08, 0.08])));
        out[out.length - 1].color = [0.8, 0.8, 0.8];
      }
      break;
    }
  }
}

/** Piece height (m): how high a crown on top would sit, roughly. */
export const PIECE_HEIGHT: Record<PieceKind, number> = { p: 2.7, n: 3.3, b: 3.8, r: 3.2, q: 4.0, k: 4.7 };

/** A small gold crown on a head frame (for a pawn that made it). */
export function drawCrown(out: DrawItem[], head: Mat4) {
  const gold = [1.0, 0.76, 0.2];
  out.push({ mesh: 'cylinder', model: mul(head, translation([0, 0.24, 0]), scaling([0.17, 0.1, 0.17])), color: gold, spec: 1 });
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2;
    out.push({ mesh: 'cone', model: mul(head, translation([Math.sin(a) * 0.14, 0.34, Math.cos(a) * 0.14]), scaling([0.05, 0.12, 0.05])), color: gold, spec: 1 });
  }
  out.push({ mesh: 'sphere', model: mul(head, translation([0, 0.3, 0.17]), scaling([0.035, 0.035, 0.035])), color: [0.9, 0.1, 0.2], spec: 1 });
}

