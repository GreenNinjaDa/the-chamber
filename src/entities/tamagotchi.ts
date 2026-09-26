import type { Vec3 } from '../engine/math';
import type { DrawItem } from '../engine/renderer';
import { textBitmap } from './pixelText';

/*
 * Pixel art for a giant virtual pet: `PixelSprite` turns a little bitmap (rows of characters, one
 * colour per character) into blocks on any plane, e.g. dots on an LCD in a wall, or a chunky
 * extruded voxel burger turning in the air. Rows of same-coloured pixels are merged into one
 * block each, and drawing reuses its items, so drawing every frame allocates nothing. Plus the
 * bitmaps: the pet itself, its menu icons, hearts, food, poop, a skull, a ghost...
 */

export type Palette = Record<string, number[]>;

export interface SpriteDraw {
  /** Gap between dots as a share of a pixel (an LCD look); 0 (the default) makes solid blocks. */
  gap?: number;
  /** Mirror it left to right. */
  flip?: boolean;
  /** One colour for every pixel instead of the palette's. */
  color?: number[];
  pattern?: number;
  opacity?: number;
  highlight?: number;
  /** Where the blocks sit along the normal: 0 centred on the origin, 0.5 (the default) standing out of it. */
  lift?: number;
  /** Squash / stretch: scales the pixel size along right / up. */
  sx?: number;
  sy?: number;
}

interface Run {
  x: number;
  y: number;
  len: number;
  color: number[];
}

/** A bitmap drawn as blocks: `rows` top to bottom, each character a palette colour (others are empty). */
export class PixelSprite {
  readonly w: number;
  readonly h: number;
  private runs: Run[] = [];
  private pool: DrawItem[] = [];
  private used = 0;
  private stamp = NaN;

  constructor(rows: string[], palette: Palette, private base: { pattern?: number; spec?: number; shadow?: boolean } = {}) {
    this.h = rows.length;
    this.w = Math.max(...rows.map((r) => r.length));
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      let c = 0;
      while (c < row.length) {
        const color = palette[row[c]];
        if (!color) {
          c++;
          continue;
        }
        let e = c + 1;
        while (e < row.length && row[e] === row[c]) e++;
        // Pixel units from the sprite's middle, y up.
        this.runs.push({ x: (c + e) / 2 - this.w / 2, y: this.h / 2 - r - 0.5, len: e - c, color });
        c = e;
      }
    }
  }

  /**
   * Draws it centred on `o`, along the unit vectors `right` and `up` (the blocks stick out along
   * `normal`), each pixel `pixel` metres and `depth` thick. `time` is the frame's time: the same
   * sprite can be drawn several times in one frame.
   */
  draw(out: DrawItem[], time: number, o: Vec3, right: Vec3, up: Vec3, normal: Vec3, pixel: number, depth: number, opts: SpriteDraw = {}) {
    if (time !== this.stamp) {
      this.stamp = time;
      this.used = 0;
    }
    const gap = opts.gap ?? 0;
    const lift = (opts.lift ?? 0.5) * depth;
    const px = pixel * (opts.sx ?? 1), py = pixel * (opts.sy ?? 1);
    const flip = opts.flip ? -1 : 1;
    for (const run of this.runs) {
      let item = this.pool[this.used];
      if (!item) {
        item = { mesh: 'box', model: new Float32Array(16), color: run.color };
        this.pool.push(item);
      }
      this.used++;
      const x = run.x * px * flip, y = run.y * py;
      const w = (run.len - gap) * px, h = (1 - gap) * py;
      const m = item.model;
      m[0] = right[0] * w; m[1] = right[1] * w; m[2] = right[2] * w; m[3] = 0;
      m[4] = up[0] * h; m[5] = up[1] * h; m[6] = up[2] * h; m[7] = 0;
      m[8] = normal[0] * depth; m[9] = normal[1] * depth; m[10] = normal[2] * depth; m[11] = 0;
      m[12] = o[0] + right[0] * x + up[0] * y + normal[0] * lift;
      m[13] = o[1] + right[1] * x + up[1] * y + normal[1] * lift;
      m[14] = o[2] + right[2] * x + up[2] * y + normal[2] * lift;
      m[15] = 1;
      item.color = opts.color ?? run.color;
      item.pattern = opts.pattern ?? this.base.pattern;
      item.spec = this.base.spec ?? 0.25;
      item.shadow = this.base.shadow;
      item.opacity = opts.opacity;
      item.highlight = opts.highlight;
      out.push(item);
    }
  }
}

/** A line of 5x7 text as a sprite (one colour). */
export function textSprite(text: string, color: number[], base: { pattern?: number; spec?: number; shadow?: boolean } = {}) {
  return new PixelSprite(textBitmap(text), { 1: color }, base);
}

// --- Bitmaps --------------------------------------------------------------------------------------
// One-colour LCD art uses '1' for a dark dot. Multi-colour art lists its palette next to it.

/** The baby: a round blob with feet (two walking frames), happy / asleep / sad / eating faces. */
export const PET_A = [
  '.....1......',
  '......1.....',
  '....1111....',
  '..11....11..',
  '.1........1.',
  '.1..1..1..1.',
  '1...1..1...1',
  '1..........1',
  '1...1..1...1',
  '1....11....1',
  '.1........1.',
  '..11111111..',
  '..1......1..',
  '.11......11.',
];
export const PET_B = [
  '.....1......',
  '......1.....',
  '....1111....',
  '..11....11..',
  '.1........1.',
  '.1..1..1..1.',
  '1...1..1...1',
  '1..........1',
  '1...1..1...1',
  '1....11....1',
  '.1........1.',
  '..11111111..',
  '...1....1...',
  '...11..11...',
];
export const PET_HAPPY = [
  '1....1.....1',
  '.1....1...1.',
  '....1111....',
  '..11....11..',
  '.1........1.',
  '.1.1....1.1.',
  '1.1.1..1.1.1',
  '1..........1',
  '1...1111...1',
  '1...1111...1',
  '.1...11...1.',
  '..11111111..',
  '..1......1..',
  '.11......11.',
];
export const PET_SLEEP = [
  '............',
  '............',
  '....1111....',
  '..11....11..',
  '.1........1.',
  '.1........1.',
  '1..11..11..1',
  '1..........1',
  '1..........1',
  '1....11....1',
  '.1........1.',
  '..11111111..',
  '..1......1..',
  '.11......11.',
];
export const PET_SAD = [
  '.....1......',
  '......1.....',
  '....1111....',
  '..11....11..',
  '.1........1.',
  '.1.1....1.1.',
  '1...1..1...1',
  '1...1..1...1',
  '1..........1',
  '1....11....1',
  '.1..1..1..1.',
  '..11111111..',
  '..1......1..',
  '.11......11.',
];
/** Evolved: taller, with a moustache and a tie. */
export const PET_ADULT = [
  '...111111...',
  '..1......1..',
  '.1........1.',
  '.1..1..1..1.',
  '.1..1..1..1.',
  '.1........1.',
  '.1.111111.1.',
  '.1.1....1.1.',
  '..1......1..',
  '...111111...',
  '..1..11..1..',
  '.1...11...1.',
  '.1..1111..1.',
  '.1...11...1.',
  '..11111111..',
  '..1......1..',
  '.11......11.',
];
export const EGG = [
  '....1111....',
  '...1....1...',
  '..1......1..',
  '..1.11...1..',
  '.1..11....1.',
  '.1........1.',
  '1.......11.1',
  '1.......11.1',
  '1..11......1',
  '1..11......1',
  '.1........1.',
  '.1....11..1.',
  '..1......1..',
  '...111111...',
];
export const EGG_CRACKED = [
  '....1111....',
  '...1....1...',
  '..1......1..',
  '..1.11...1..',
  '.1..11....1.',
  '.1.1.1..1.1.',
  '11.1.1.1.1.1',
  '1.1...1....1',
  '1..11......1',
  '1..11......1',
  '.1........1.',
  '.1....11..1.',
  '..1......1..',
  '...111111...',
];
export const HEART_FULL = ['.11.11.', '1111111', '1111111', '.11111.', '..111..', '...1...'];
export const HEART_EMPTY = ['.11.11.', '1..1..1', '1.....1', '.1...1.', '..1.1..', '...1...'];

/** The six menu icons along the top of the screen: FOOD, LIGHT, PLAY, MEDICINE, BATHROOM, DISCIPLINE. */
export const ICON_BITMAPS = [
  [
    '1.1.1..1.',
    '1.1.1..11',
    '1.1.1..11',
    '11111..11',
    '.111...11',
    '..1....11',
    '..1.....1',
    '..1.....1',
    '..1.....1',
  ],
  [
    '1...1...1',
    '.1.111.1.',
    '..1...1..',
    '.1.....1.',
    '.1.....1.',
    '..1...1..',
    '...111...',
    '...111...',
    '....1....',
  ],
  [
    '..11111..',
    '.1..1..1.',
    '1..1.1..1',
    '1.1...1.1',
    '11.....11',
    '1.1...1.1',
    '1..1.1..1',
    '.1..1..1.',
    '..11111..',
  ],
  [
    '...111...',
    '...1.1...',
    '...1.1...',
    '1111.1111',
    '1.......1',
    '1111.1111',
    '...1.1...',
    '...1.1...',
    '...111...',
  ],
  [
    '111......',
    '1.1......',
    '1.1......',
    '1.1111111',
    '1.......1',
    '.1.....1.',
    '..11111..',
    '...1.1...',
    '..11111..',
  ],
  [
    '.1111111.',
    '1.......1',
    '1.1...1.1',
    '1..1.1..1',
    '1.......1',
    '1..111..1',
    '1.1...1.1',
    '1.......1',
    '.1111111.',
  ],
];
export const ARROW_LEFT = [
  '...1.....',
  '..11.....',
  '.11111111',
  '111111111',
  '.11111111',
  '..11.....',
  '...1.....',
];
export const POOP_LCD = [
  '...1....',
  '...11...',
  '..1111..',
  '..1..1..',
  '.111111.',
  '.1....1.',
  '11111111',
  '.111111.',
];
export const SKULL = ['.11111.', '1111111', '1..1..1', '1111111', '.11.11.', '.1.1.1.', '.......'];
export const GHOST = [
  '..11111..',
  '.........',
  '...111...',
  '..1...1..',
  '.1.1.1.1.',
  '.1.....1.',
  '.1..1..1.',
  '.1.....1.',
  '.1.....1.',
  '.1.1.1.1.',
  '1.1.1.1.1',
];
export const GRAVE = [
  '..1111..',
  '.1....1.',
  '1..11..1',
  '1.1111.1',
  '1..11..1',
  '1..11..1',
  '1......1',
  '1......1',
  '11111111',
];
export const BURGER_LCD = ['..11111..', '.1.1.1.1.', '111111111', '.........', '111111111', '.1.1.1.1.', '.1111111.'];
export const CANDY_LCD = ['1..111..1', '11.1.1.11', '.1111111.', '11.1.1.11', '1..111..1'];
export const SYRINGE_LCD = [
  '.1...........',
  '.1.11111111..',
  '1111111111111',
  '.1.11111111..',
  '.1...........',
];
export const MOON = ['..111..', '.11....', '11.....', '11.....', '11.....', '.11....', '..111..'];
export const WAVE_LCD = ['.111..', '11.11.', '1...11', '111111', '111111'];
/** A squiggly stink line. */
export const STINK = ['.1.', '1..', '.1.', '..1', '.1.', '1..'];

// Multi-colour art for things in the room.

export const BURGER = [
  '...oooooo...',
  '.oobbsbbboo.',
  'obbsbbbbsbbo',
  'obbbbbbsbbbo',
  'oooooooooooo',
  'llllllllllll',
  'ccccccccccc.',
  'tttttttttttt',
  'pppppppppppp',
  'obbbbbbbbbbo',
  '.oooooooooo.',
];
export const BURGER_COLORS: Palette = {
  o: [0.35, 0.16, 0.05],
  b: [0.95, 0.58, 0.2],
  s: [1, 0.95, 0.75],
  l: [0.35, 0.8, 0.2],
  c: [1, 0.82, 0.12],
  t: [0.9, 0.18, 0.12],
  p: [0.42, 0.2, 0.08],
};
export const CANDY = [
  'p....ooo....p',
  'pp..orwro..pp',
  'ppppwrwrwpppp',
  'pppprwrwrpppp',
  'ppppwrwrwpppp',
  'pp..orwro..pp',
  'p....ooo....p',
];
export const CANDY_COLORS: Palette = {
  p: [1, 0.45, 0.75],
  o: [0.55, 0.05, 0.12],
  r: [0.95, 0.12, 0.18],
  w: [1, 0.97, 0.95],
};
export const POOP = [
  '....oo....',
  '...obbo...',
  '...obhbo..',
  '..obbbbo..',
  '..obhbbbo.',
  '.obbbbbbo.',
  '.obbhbbbbo',
  'obbbbbbbbo',
  'obhbbbbbbo',
  '.oooooooo.',
];
export const POOP_COLORS: Palette = {
  o: [0.2, 0.1, 0.04],
  b: [0.45, 0.25, 0.1],
  h: [0.62, 0.4, 0.2],
};
