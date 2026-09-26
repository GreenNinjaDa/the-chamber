import { mul, rotationX, rotationY, rotationZ, scaling, segment, translation, type Vec3 } from '../../engine/math';
import type { Physics, RAPIER } from '../../engine/physics';
import { HOLE_PLATE_RATIO, Pattern, type DrawItem } from '../../engine/renderer';
import { CHAMBER_HALF } from '../../game/chamber';

/*
 * The whack-a-mole cabinet the chamber turns out to be: a raised deck (fixed colliders) wall to
 * wall with a 4 x 3 grid of holes, and the dark burrow under it (dirt, roots, pit props, glowing
 * mushrooms). Before it boots up the deck is disguised as an ordinary chamber floor (grey panels,
 * the holes shut with lids); `boot(band)` turns it into bright arcade plastic band by band from
 * the north, and `openLids()` opens the holes. Every hole has a piston pad in the burrow under it
 * (`drawPads`: its height and a glowing ring the level colours).
 */

const H = CHAMBER_HALF;
export const DECK_TOP = 3.0;
export const DECK_T = 0.28;
/** The burrow's ceiling (the underside of the deck). */
export const UNDER = DECK_TOP - DECK_T;
/** The top plastic layer of the deck. */
const SKIN = 0.1;
export const HOLE_R = 0.78;
/** Side of the square hole plate around each hole. */
const PLATE = HOLE_R / HOLE_PLATE_RATIO;
/** The yellow rubber ring round each hole: outer radius and height above the deck. */
export const RIM_OUT = 1.52;
export const RIM_H = 0.1;
const HOLE_XS = [-7.5, -2.5, 2.5, 7.5];
const HOLE_ZS = [-6, 0, 6];
/** Hole centres, on the deck top. */
export const HOLES: Vec3[] = HOLE_ZS.flatMap((z) => HOLE_XS.map((x): Vec3 => [x, DECK_TOP, z]));
export const HOLE_COLS = HOLE_XS.length;
/** Wooden pit props holding the deck up (x, z), off the lines between holes. */
export const POSTS: [number, number][] = [[-5, -3], [0, -3], [5, -3], [-5, 3], [0, 3], [5, 3]];
export const POST_R = 0.3;

const GREY = [0.6, 0.61, 0.63];
const DECK = [0.025, 0.08, 0.46];
const RIM = [0.95, 0.56, 0.02];
const RIM_EDGE = [0.9, 0.08, 0.1];
const LID = [0.05, 0.05, 0.07];
const CEILING = [0.17, 0.115, 0.075];
const DIRT = [0.3, 0.2, 0.12];
const WALL_DIRT = [0.26, 0.17, 0.1];
const ROOT = [0.36, 0.25, 0.15];
const WOOD = [0.42, 0.28, 0.15];
const METAL = [0.5, 0.52, 0.56];
const CHROME = [0.75, 0.77, 0.8];
const BULB_COLORS = [[2.4, 0.35, 0.3], [2.4, 1.9, 0.35], [0.4, 2.2, 0.5], [0.45, 0.9, 2.6]];

/** A tiny seeded random generator, so the burrow looks the same every attempt. */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

export class Cabinet {
  /** Top-layer items of each band of the deck (north to south), switched by boot(). */
  private bands: DrawItem[][] = [];
  private booted: boolean[] = [];
  /** The rest of the deck, the burrow and its props: drawn as they are. */
  private statics: DrawItem[] = [];
  /** Arcade trim on the walls, shown once the deck boots. */
  private trim: DrawItem[] = [];
  private lidColliders: RAPIER.Collider[] = [];
  /** 0 = shut, 1 = open. */
  lidOpen = 0;
  private opening = false;
  /** Seconds since each band booted (for the rims popping up). */
  private bootAge: number[] = [];
  private edgesZ: number[] = [-H];

  constructor(private physics: Physics) {
    const edgesZ = this.edgesZ;
    for (const z of HOLE_ZS) edgesZ.push(z - PLATE / 2, z + PLATE / 2);
    edgesZ.push(H);
    const edgesX = [-H];
    for (const x of HOLE_XS) edgesX.push(x - PLATE / 2, x + PLATE / 2);
    edgesX.push(H);
    const yMid = DECK_TOP - DECK_T / 2;
    for (let b = 0; b + 1 < edgesZ.length; b++) {
      const z0 = edgesZ[b], z1 = edgesZ[b + 1];
      const items: DrawItem[] = [];
      const holeRow = b % 2 === 1;
      const slab = (x0: number, x1: number) => {
        items.push(box(x0, x1, DECK_TOP - SKIN, DECK_TOP, z0, z1, GREY));
        this.statics.push(box(x0, x1, UNDER, DECK_TOP - SKIN, z0, z1, CEILING));
        physics.addStaticBox([(x0 + x1) / 2, yMid, (z0 + z1) / 2], [x1 - x0, DECK_T, z1 - z0]);
      };
      if (!holeRow) {
        slab(-H, H);
      } else {
        const zc = (z0 + z1) / 2;
        for (let i = 0; i + 1 < edgesX.length; i++) {
          if (i % 2 === 0) {
            slab(edgesX[i], edgesX[i + 1]);
            continue;
          }
          const xc = (edgesX[i] + edgesX[i + 1]) / 2;
          items.push(plate([xc, DECK_TOP - SKIN / 2, zc], SKIN, GREY));
          this.statics.push(plate([xc, (UNDER + DECK_TOP - SKIN) / 2, zc], DECK_T - SKIN, CEILING));
          this.addHoleRing(xc, zc);
          this.lidColliders.push(physics.addStaticCylinder([xc, yMid, zc], HOLE_R, DECK_T));
        }
      }
      for (const it of items) {
        it.pattern = Pattern.panels;
        it.param = 2;
        it.spec = 0.15;
      }
      this.bands.push(items);
      this.booted.push(false);
      this.bootAge.push(0);
    }
    this.buildBurrow();
  }

  /** A ring of boxes round a hole, filling its plate square (so bodies can fall through the hole but not the plate). */
  private addHoleRing(x: number, z: number) {
    const sides = 12;
    const thick = 0.85;
    const r = HOLE_R + thick / 2;
    const len = ((2 * Math.PI * r) / sides) * 1.15;
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      const q = { x: 0, y: Math.sin(-a / 2), z: 0, w: Math.cos(-a / 2) };
      this.physics.addStaticBox([x + Math.cos(a) * r, DECK_TOP - DECK_T / 2, z + Math.sin(a) * r], [thick, DECK_T, len], q);
    }
  }

  private buildBurrow() {
    const s = this.statics;
    const r = rng(7);
    // Dirt floor and dirt-faced walls up to the deck.
    s.push({ mesh: 'box', model: mul(translation([0, 0.0, 0]), scaling([H * 2, 0.06, H * 2])), color: DIRT, pattern: Pattern.rock, param: 14 });
    const wall = (pos: Vec3, size: Vec3) => s.push({ mesh: 'box', model: mul(translation(pos), scaling(size)), color: WALL_DIRT, pattern: Pattern.rock, param: 9 });
    wall([0, UNDER / 2, -H + 0.03], [H * 2, UNDER, 0.06]);
    wall([0, UNDER / 2, H - 0.03], [H * 2, UNDER, 0.06]);
    wall([-H + 0.03, UNDER / 2, 0], [0.06, UNDER, H * 2]);
    wall([H - 0.03, UNDER / 2, 0], [0.06, UNDER, H * 2]);
    // Pit props with a beam under the deck.
    for (const [x, z] of POSTS) {
      s.push({ mesh: 'cylinder', model: mul(translation([x, UNDER / 2, z]), scaling([POST_R, UNDER, POST_R])), color: WOOD, spec: 0.1 });
      s.push({ mesh: 'box', model: mul(translation([x, UNDER - 0.14, z]), rotationY(x * 0.3), scaling([2.2, 0.26, 0.34])), color: WOOD, spec: 0.1 });
      this.physics.addStaticCylinder([x, UNDER / 2, z], POST_R, UNDER);
    }
    // Roots hanging from the ceiling (clear of the holes and props).
    const clear = (x: number, z: number, d: number) =>
      HOLES.every((h) => Math.hypot(h[0] - x, h[2] - z) > d) && POSTS.every(([px, pz]) => Math.hypot(px - x, pz - z) > 0.8);
    for (let n = 0; n < 40; n++) {
      const x = (r() * 2 - 1) * (H - 0.6), z = (r() * 2 - 1) * (H - 0.6);
      if (!clear(x, z, 1.7)) continue;
      const len1 = 0.2 + r() * 0.3, len2 = 0.15 + r() * 0.35;
      const a: Vec3 = [x, UNDER, z];
      const b: Vec3 = [x + (r() - 0.5) * 0.3, UNDER - len1, z + (r() - 0.5) * 0.3];
      const c: Vec3 = [b[0] + (r() - 0.5) * 0.35, b[1] - len2, b[2] + (r() - 0.5) * 0.35];
      const w = 0.035 + r() * 0.03;
      s.push({ mesh: 'cylinder', model: segment(a, b, w), color: ROOT });
      s.push({ mesh: 'cylinder', model: segment(b, c, w * 0.6), color: ROOT });
      if (r() < 0.4) s.push({ mesh: 'cylinder', model: segment(b, [b[0] + (r() - 0.5) * 0.5, b[1] - 0.1, b[2] + (r() - 0.5) * 0.5], w * 0.45), color: ROOT });
    }
    // Rocks along the walls, and glowing mushrooms here and there.
    for (let n = 0; n < 14; n++) {
      const side = n % 4, t = (r() * 2 - 1) * (H - 1);
      const d = H - 0.35 - r() * 0.3;
      const pos: Vec3 = side === 0 ? [t, 0, -d] : side === 1 ? [t, 0, d] : side === 2 ? [-d, 0, t] : [d, 0, t];
      if (side === 3 && Math.abs(t) < 3.5) continue; // not in front of the exit
      const sz = 0.25 + r() * 0.35;
      s.push({ mesh: 'bevelbox', model: mul(translation([pos[0], sz * 0.35, pos[2]]), rotationY(r() * 3), rotationZ((r() - 0.5) * 0.4), scaling([sz * 1.4, sz, sz * 1.1])), color: [0.35, 0.3, 0.26], pattern: Pattern.rock, param: 1.5 });
    }
    const glow = [0.35, 1.7, 1.35];
    for (let n = 0; n < 11; n++) {
      const around = n < 6 ? POSTS[n] : null;
      const cx = around ? around[0] : (r() * 2 - 1) * (H - 1), cz = around ? around[1] : (r() < 0.5 ? -1 : 1) * (H - 0.5);
      for (let k = 0; k < 3; k++) {
        const a = r() * Math.PI * 2, d = around ? POST_R + 0.1 + r() * 0.2 : r() * 0.5;
        const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
        const hgt = 0.08 + r() * 0.12, cap = 0.06 + r() * 0.07;
        s.push({ mesh: 'cylinder', model: mul(translation([x, hgt / 2, z]), scaling([0.025, hgt, 0.025])), color: [0.85, 0.85, 0.75] });
        s.push({ mesh: 'sphere', model: mul(translation([x, hgt, z]), scaling([cap, cap * 0.55, cap])), color: glow, pattern: Pattern.emissive, shadow: false });
      }
    }
    // A homely sign on the west wall.
    s.push({ mesh: 'box', model: mul(translation([-H + 0.1, 1.75, 4]), scaling([0.08, 0.7, 2.9])), color: [0.55, 0.38, 0.2], spec: 0.1 });
    s.push({ mesh: 'box', model: mul(translation([-H + 0.08, 1.75, 4]), scaling([0.06, 0.82, 3.02])), color: [0.3, 0.18, 0.08] });
    s.push({ mesh: 'box', model: mul(translation([H - 0.1, 1.9, -6.5]), scaling([0.08, 0.9, 1.6])), color: [0.92, 0.88, 0.78] });

    // Arcade trim above the deck: coloured stripes round the walls.
    for (const [y0, y1, color] of [[3.25, 3.55, [0.9, 0.1, 0.12]], [3.68, 3.82, [1, 0.78, 0.1]]] as [number, number, number[]][]) {
      const ym = (y0 + y1) / 2, hh = y1 - y0;
      this.trim.push({ mesh: 'box', model: mul(translation([0, ym, H - 0.02]), scaling([H * 2, hh, 0.04])), color, spec: 0.3 });
      this.trim.push({ mesh: 'box', model: mul(translation([-H + 0.02, ym, 0]), scaling([0.04, hh, H * 2])), color, spec: 0.3 });
      this.trim.push({ mesh: 'box', model: mul(translation([H - 0.02, ym, 0]), scaling([0.04, hh, H * 2])), color, spec: 0.3 });
    }
  }

  /** Switches band `b` (0 = the northmost) from plain chamber floor to arcade plastic. */
  boot(b: number) {
    if (b < 0 || b >= this.bands.length || this.booted[b]) return;
    this.booted[b] = true;
    for (const it of this.bands[b]) {
      it.color = DECK;
      it.pattern = Pattern.plain;
      it.param = 0;
      it.spec = 0.55;
    }
  }

  /** Which band of the deck `z` is in. */
  bandAt(z: number) {
    let b = 0;
    while (b + 2 < this.edgesZ.length && z > this.edgesZ[b + 1]) b++;
    return b;
  }

  get bandCount() {
    return this.bands.length;
  }

  isBooted(b: number) {
    return this.booted[b];
  }

  get fullyBooted() {
    return this.booted.every((b) => b);
  }

  /** Opens every hole (the lids iris away; their colliders go at once). */
  openLids() {
    for (const c of this.lidColliders) this.physics.world.removeCollider(c, false);
    this.lidColliders = [];
    this.opening = true;
  }

  update(dt: number) {
    for (let b = 0; b < this.bands.length; b++) if (this.booted[b]) this.bootAge[b] += dt;
    if (this.opening) this.lidOpen = Math.min(1, this.lidOpen + dt / 0.25);
  }

  draw(out: DrawItem[], time: number) {
    for (const band of this.bands) for (const it of band) out.push(it);
    for (const it of this.statics) out.push(it);
    if (this.booted[0]) for (const it of this.trim) out.push(it);
    // Rims pop up out of the deck as their band boots; lids shrink away when the holes open.
    for (let i = 0; i < HOLES.length; i++) {
      const [x, , z] = HOLES[i];
      const band = 1 + 2 * Math.floor(i / HOLE_COLS);
      const age = this.booted[band] ? this.bootAge[band] : -1;
      if (age >= 0) {
        const pop = Math.min(1, age / 0.18);
        const h = RIM_H * pop * (1 + 0.6 * Math.sin(Math.min(1, age / 0.35) * Math.PI));
        out.push({ mesh: 'tube', model: mul(translation([x, DECK_TOP + h / 2, z]), scaling([RIM_OUT, h, RIM_OUT])), color: RIM, spec: 0.45 });
        out.push({ mesh: 'tube', model: mul(translation([x, DECK_TOP + 0.012, z]), scaling([RIM_OUT + 0.12, 0.02, RIM_OUT + 0.12])), color: RIM_EDGE, spec: 0.4 });
      }
      const lid = 1 - this.lidOpen;
      if (lid > 0.01) {
        const booted = age >= 0;
        out.push({
          mesh: 'cylinder',
          model: mul(translation([x, DECK_TOP - SKIN / 2, z]), rotationY(this.lidOpen * 3), scaling([HOLE_R * lid, SKIN, HOLE_R * lid])),
          color: booted ? LID : GREY,
          pattern: booted ? Pattern.plain : Pattern.panels,
          param: booted ? 0 : 2,
          spec: booted ? 0.8 : 0.15,
        });
      }
    }
    // Chasing bulbs along the foot of the walls on the deck.
    if (this.booted[0]) {
      const chase = Math.floor(time * 7);
      let k = 0;
      for (let side = 0; side < 4; side++) {
        for (let i = 0; i < 15; i++, k++) {
          const t = -H + 1 + i * ((H * 2 - 2) / 14);
          const d = H - 0.3;
          const p: Vec3 = side === 0 ? [t, 0, -d] : side === 1 ? [d, 0, t] : side === 2 ? [-t, 0, d] : [-d, 0, -t];
          if (!this.booted[this.bandAt(p[2])]) continue;
          const lit = (k + chase) % 4 === 0;
          const c = BULB_COLORS[k % 4];
          out.push({
            mesh: 'sphere',
            model: mul(translation([p[0], DECK_TOP + 0.14, p[2]]), scaling([0.14, 0.14, 0.14])),
            color: lit ? c : [c[0] * 0.25, c[1] * 0.25, c[2] * 0.25],
            pattern: Pattern.emissive,
            shadow: false,
          });
        }
      }
    }
  }

  /**
   * The piston pads under the holes: `lift[i]` is how high hole i's pad is (m, 0 = on the burrow
   * floor), `glow[i]` the colour of the ring of light round its base.
   */
  drawPads(out: DrawItem[], lift: number[], glow: number[][]) {
    for (let i = 0; i < HOLES.length; i++) {
      const [x, , z] = HOLES[i];
      const y = lift[i];
      out.push({ mesh: 'cylinder', model: mul(translation([x, 0.03, z]), scaling([0.49, 0.06, 0.49])), color: [0.12, 0.12, 0.14], spec: 0.4 });
      out.push({ mesh: 'tube', model: mul(translation([x, 0.035, z]), scaling([1.0, 0.07, 1.0])), color: glow[i], pattern: Pattern.emissive, shadow: false });
      if (y > 0.04) {
        // A telescopic piston.
        const radii = [0.24, 0.18, 0.13];
        for (let k = 0; k < 3; k++) {
          const top = Math.min(y, (y * (k + 1)) / 3 + 0.05);
          out.push({ mesh: 'cylinder', model: mul(translation([x, top / 2, z]), scaling([radii[k], top, radii[k]])), color: CHROME, spec: 0.9 });
        }
      }
      out.push({ mesh: 'cylinder', model: mul(translation([x, y + 0.05, z]), scaling([0.7, 0.1, 0.7])), color: METAL, spec: 0.7 });
      // Hazard stripes round the edge of the pad's top.
      out.push({ mesh: 'tube', model: mul(translation([x, y + 0.102, z]), scaling([0.66, 0.006, 0.66])), color: [0.62, 0.62, 0.58], spec: 0.6, shadow: false });
      out.push({ mesh: 'cylinder', model: mul(translation([x, y + 0.103, z]), scaling([0.3, 0.004, 0.3])), color: [0.2, 0.2, 0.22], shadow: false });
    }
  }
}

function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, color: number[]): DrawItem {
  return { mesh: 'box', model: mul(translation([(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2]), scaling([x1 - x0, y1 - y0, z1 - z0])), color: [...color] };
}

/** A square plate with a round hole, lying flat, centred at `c`. */
function plate(c: Vec3, thick: number, color: number[]): DrawItem {
  return { mesh: 'holeplate', model: mul(translation(c), rotationX(Math.PI / 2), scaling([PLATE, PLATE, thick])), color: [...color] };
}
