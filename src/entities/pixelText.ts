import type { Vec3 } from '../engine/math';
import type { DrawItem } from '../engine/renderer';

/*
 * Chunky dot-matrix text made of little blocks, like an old phone screen: 5x7 pixel glyphs laid
 * out on a plane (e.g. flat on a wall). The blocks are built once per text, so drawing it every
 * frame allocates nothing.
 */

const GLYPH_W = 5;
const GLYPH_H = 7;
/** Pixels from one character to the next (glyph width plus a one-pixel gap). */
const ADVANCE = GLYPH_W + 1;

// prettier-ignore
const GLYPHS: Record<string, string[]> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '10001', '11001', '10101', '10011', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '10001', '01010', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  '!': ['00100', '00100', '00100', '00100', '00100', '00000', '00100'],
  '?': ['01110', '10001', '00001', '00010', '00100', '00000', '00100'],
  ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
};

export interface PixelTextOptions {
  /** Where the middle of the text goes. */
  centre: Vec3;
  /** Unit vectors along the text (left to right) and up it; the blocks stick out along right x up. */
  right: Vec3;
  up: Vec3;
  /** Size of one pixel (m). */
  pixel: number;
  color: number[];
  /** How far each block sticks out of the surface (m). */
  depth?: number;
}

/** A line of block-pixel text. `reveal` (0-1) switches its pixels on in a scattered order. */
export class PixelText {
  /** 0-1: the fraction of pixels showing (they switch on in a fixed pseudo-random order). */
  reveal = 1;
  private items: DrawItem[] = [];
  private order: number[] = [];
  private text = '';

  constructor(private opts: PixelTextOptions, text = '') {
    this.setText(text);
  }

  get value() {
    return this.text;
  }

  setText(text: string) {
    text = text.toUpperCase();
    if (text === this.text && this.items.length) return;
    this.text = text;
    this.items = [];
    this.order = [];
    const { centre, right, up, pixel, color } = this.opts;
    const depth = this.opts.depth ?? 0.06;
    const normal: Vec3 = [
      right[1] * up[2] - right[2] * up[1],
      right[2] * up[0] - right[0] * up[2],
      right[0] * up[1] - right[1] * up[0],
    ];
    const widthPx = text.length * ADVANCE - 1;
    const size = pixel * 0.86;
    for (let c = 0; c < text.length; c++) {
      const glyph = GLYPHS[text[c]];
      if (!glyph) continue;
      for (let row = 0; row < GLYPH_H; row++) {
        for (let col = 0; col < GLYPH_W; col++) {
          if (glyph[row][col] !== '1') continue;
          // Pixel centre in text space, from the middle of the whole line.
          const x = (c * ADVANCE + col + 0.5 - widthPx / 2) * pixel;
          const y = (GLYPH_H / 2 - row - 0.5) * pixel;
          const p: Vec3 = [
            centre[0] + right[0] * x + up[0] * y + normal[0] * depth / 2,
            centre[1] + right[1] * x + up[1] * y + normal[1] * depth / 2,
            centre[2] + right[2] * x + up[2] * y + normal[2] * depth / 2,
          ];
          const model = new Float32Array([
            right[0] * size, right[1] * size, right[2] * size, 0,
            up[0] * size, up[1] * size, up[2] * size, 0,
            normal[0] * depth, normal[1] * depth, normal[2] * depth, 0,
            p[0], p[1], p[2], 1,
          ]);
          this.items.push({ mesh: 'box', model, color, spec: 0.25 });
          this.order.push(hash(this.items.length * 7.13 + c * 1.7));
        }
      }
    }
  }

  draw(out: DrawItem[]) {
    if (this.reveal <= 0) return;
    const all = this.reveal >= 1;
    for (let i = 0; i < this.items.length; i++) {
      if (all || this.order[i] < this.reveal) out.push(this.items[i]);
    }
  }
}

function hash(n: number) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}
