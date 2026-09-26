import { RAPIER, type Physics } from '../engine/physics';
import { Pattern, type DrawItem } from '../engine/renderer';

/*
 * A floor of hexagonal tiles that fall away once stood on (Fall Guys' Hex-A-Gone): touch a
 * tile and it flashes for `armTime`, then drops, spinning and shrinking, and its collider is
 * gone. Tiles are flat-top hexagons on an axial grid covering a square, each a real static
 * collider. A frozen floor stops dropping tiles; gone tiles can be grown back.
 */

const SQRT3 = Math.sqrt(3);
/** Seconds a dropped tile takes to fall and shrink away, and a regrown one to pop back in. */
const FALL_TIME = 0.45;
const GROW_TIME = 0.3;
/** Drawn slightly smaller than the collider, so there's a visible seam between tiles. */
const VISUAL_SCALE = 0.965;

export type HexTileState = 'solid' | 'armed' | 'falling' | 'gone' | 'growing';

export interface HexTile {
  q: number;
  r: number;
  x: number;
  z: number;
  state: HexTileState;
  /** Seconds in the current state. */
  t: number;
  collider: RAPIER.Collider | null;
  /** Seconds until it grows back (while gone), or -1. */
  regrowIn: number;
  readonly base: number[];
  readonly item: DrawItem;
  /** The flashing blink's phase while armed. */
  blink: number;
  /** Which way it spins as it falls. */
  spin: number;
}

export interface HexFloorOptions {
  /** Height of the tile tops. */
  top: number;
  /** Corner radius of each hexagon (m). */
  radius: number;
  thickness: number;
  /** Tiles cover the square [-half, half] on x and z (edge tiles poke into whatever is beyond). */
  half: number;
  /** Tile colours, given out so that no two neighbours share one (1-3 of them). */
  colors: number[][];
  /** Seconds between a tile being touched and dropping. */
  armTime: number;
}

export class HexFloor {
  readonly tiles: HexTile[] = [];
  readonly top: number;
  /** While frozen, touching does nothing and nothing drops. */
  frozen = false;
  /** Optional veto for regrowing a tile (e.g. something is standing where it would appear). */
  canRegrow: ((tile: HexTile) => boolean) | null = null;
  private byKey = new Map<number, HexTile>();
  private hull: Float32Array;
  private readonly inradius: number;

  constructor(private physics: Physics, readonly opts: HexFloorOptions) {
    this.top = opts.top;
    const R = opts.radius;
    this.inradius = (R * SQRT3) / 2;
    const pts: number[] = [];
    for (const y of [-opts.thickness / 2, opts.thickness / 2]) {
      for (let k = 0; k < 6; k++) pts.push(Math.cos((k * Math.PI) / 3) * R, y, Math.sin((k * Math.PI) / 3) * R);
    }
    this.hull = new Float32Array(pts);
    const half = opts.half;
    const qMax = Math.ceil((half + R) / (1.5 * R));
    for (let q = -qMax; q <= qMax; q++) {
      const x = 1.5 * R * q;
      if (Math.abs(x) - R > half - 0.05) continue;
      const rLo = Math.floor((-half - this.inradius) / (SQRT3 * R) - q / 2) - 1;
      const rHi = Math.ceil((half + this.inradius) / (SQRT3 * R) - q / 2) + 1;
      for (let r = rLo; r <= rHi; r++) {
        const z = SQRT3 * R * (r + q / 2);
        if (Math.abs(z) - this.inradius > half - 0.05) continue;
        const shade = opts.colors[(((q - r) % 3) + 3) % 3 % opts.colors.length];
        const color = [...shade];
        const model = new Float32Array(16);
        const tile: HexTile = {
          q, r, x, z, state: 'solid', t: 0, collider: null, regrowIn: -1, base: shade,
          item: { mesh: 'hextile', model, color, spec: 0.55 },
          blink: 0, spin: Math.random() < 0.5 ? -1 : 1,
        };
        this.setModel(tile, 0, 1, 0);
        tile.collider = this.makeCollider(tile);
        this.tiles.push(tile);
        this.byKey.set(key(q, r), tile);
      }
    }
  }

  private makeCollider(tile: HexTile) {
    const desc = RAPIER.ColliderDesc.convexHull(this.hull);
    if (!desc) return null;
    desc.setTranslation(tile.x, this.top - this.opts.thickness / 2, tile.z);
    return this.physics.world.createCollider(desc);
  }

  /** Solid underfoot: whole, flashing or growing back (not falling or gone). */
  static solid(tile: HexTile | undefined | null): boolean {
    return !!tile && (tile.state === 'solid' || tile.state === 'armed' || tile.state === 'growing');
  }

  /** The tile whose hexagon contains (x, z), if there is one there (in any state). */
  tileAt(x: number, z: number): HexTile | undefined {
    const R = this.opts.radius;
    const fq = ((2 / 3) * x) / R;
    const fr = ((-1 / 3) * x + (SQRT3 / 3) * z) / R;
    const fs = -fq - fr;
    let q = Math.round(fq), r = Math.round(fr);
    const s = Math.round(fs);
    const dq = Math.abs(q - fq), dr = Math.abs(r - fr), ds = Math.abs(s - fs);
    if (dq > dr && dq > ds) q = -r - s;
    else if (dr > ds) r = -q - s;
    return this.byKey.get(key(q, r));
  }

  /** How far (x, z) is outside the tile's hexagon (negative inside). */
  distance(tile: HexTile, x: number, z: number) {
    const px = x - tile.x, pz = z - tile.z;
    const c = SQRT3 / 2;
    const d = Math.max(Math.abs(px * c + pz * 0.5), Math.abs(pz), Math.abs(-px * c + pz * 0.5));
    return d - this.inradius;
  }

  /** Neighbours of a tile position (axial), those that exist. */
  private neighbour(q: number, r: number, i: number) {
    const d = NEIGHBOURS[i];
    return this.byKey.get(key(q + d[0], r + d[1]));
  }

  /**
   * A solid tile holding up a foot (a disc of `radius`) at (x, z): the one under its centre, or
   * one it overlaps the edge of. Null means there's nothing to stand on.
   */
  support(x: number, z: number, radius: number): HexTile | null {
    const t = this.tileAt(x, z);
    if (t && HexFloor.solid(t)) return t;
    if (!t) return null;
    for (let i = 0; i < 6; i++) {
      const n = this.neighbour(t.q, t.r, i);
      if (n && HexFloor.solid(n) && this.distance(n, x, z) < radius) return n;
    }
    return null;
  }

  /** Something (a foot of `radius`) is standing at (x, z): arm whatever it's standing on. */
  touch(x: number, z: number, radius: number) {
    if (this.frozen) return;
    const t = this.tileAt(x, z);
    if (t && HexFloor.solid(t)) {
      this.arm(t);
      return;
    }
    if (!t) return;
    for (let i = 0; i < 6; i++) {
      const n = this.neighbour(t.q, t.r, i);
      if (n && HexFloor.solid(n) && this.distance(n, x, z) < radius) this.arm(n);
    }
  }

  /** Starts a tile's countdown (if it isn't already counting down or gone). */
  arm(tile: HexTile) {
    if (this.frozen || tile.state !== 'solid') return;
    tile.state = 'armed';
    tile.t = 0;
    tile.blink = 0;
  }

  /** Stops the floor: nothing drops any more, and tiles counting down go back to normal. */
  freeze() {
    this.frozen = true;
    for (const tile of this.tiles) {
      if (tile.state !== 'armed') continue;
      tile.state = 'solid';
      tile.t = 0;
      this.restore(tile);
    }
  }

  /** Back to its normal look. */
  private restore(tile: HexTile) {
    this.setModel(tile, 0, 1, 0);
    tile.item.pattern = Pattern.plain;
    const col = tile.item.color as number[];
    for (let i = 0; i < 3; i++) col[i] = tile.base[i];
  }

  /** Grows back every missing tile, in a ripple spreading from (x, z) at `speed` m/s. */
  regrowFrom(x: number, z: number, speed: number) {
    for (const tile of this.tiles) {
      if (tile.state !== 'gone' && tile.state !== 'falling') continue;
      tile.regrowIn = 0.2 + Math.hypot(tile.x - x, tile.z - z) / speed;
    }
  }

  /** Solid tiles with nothing counting down (good to step on for a while). */
  fresh(tile: HexTile | undefined): boolean {
    return !!tile && (tile.state === 'solid' || tile.state === 'growing');
  }

  update(dt: number) {
    const arm = this.opts.armTime;
    for (const tile of this.tiles) {
      switch (tile.state) {
        case 'armed': {
          tile.t += dt;
          const k = Math.min(1, tile.t / arm);
          tile.blink += dt * (5 + 16 * k);
          if (tile.t >= arm) {
            tile.state = 'falling';
            tile.t = 0;
            if (tile.collider) this.physics.world.removeCollider(tile.collider, false);
            tile.collider = null;
          }
          break;
        }
        case 'falling':
          tile.t += dt;
          if (tile.t >= FALL_TIME) {
            tile.state = 'gone';
            tile.t = 0;
          }
          if (tile.regrowIn >= 0) tile.regrowIn -= dt;
          break;
        case 'gone':
          tile.t += dt;
          if (tile.regrowIn >= 0) {
            tile.regrowIn = Math.max(0, tile.regrowIn - dt);
            if (tile.regrowIn <= 0 && (!this.canRegrow || this.canRegrow(tile))) {
              tile.regrowIn = -1;
              tile.state = 'growing';
              tile.t = 0;
              tile.collider = this.makeCollider(tile);
            }
          }
          break;
        case 'growing':
          tile.t += dt;
          if (tile.t >= GROW_TIME) {
            tile.state = 'solid';
            tile.t = 0;
            this.restore(tile);
          }
          break;
      }
    }
  }

  /** Writes the tile's model: dropped by `drop` m, scaled by `s`, spun by `spin` rad. */
  private setModel(tile: HexTile, drop: number, s: number, spin: number) {
    const m = tile.item.model as Float32Array;
    const R = this.opts.radius * VISUAL_SCALE * s;
    const c = Math.cos(spin) * R, sn = Math.sin(spin) * R;
    m[0] = c; m[1] = 0; m[2] = -sn; m[3] = 0;
    m[4] = 0; m[5] = this.opts.thickness * s; m[6] = 0; m[7] = 0;
    m[8] = sn; m[9] = 0; m[10] = c; m[11] = 0;
    m[12] = tile.x; m[13] = this.top - this.opts.thickness / 2 - drop; m[14] = tile.z; m[15] = 1;
  }

  draw(out: DrawItem[]) {
    const arm = this.opts.armTime;
    for (const tile of this.tiles) {
      const item = tile.item, col = item.color as number[], base = tile.base;
      switch (tile.state) {
        case 'solid':
          break;
        case 'armed': {
          // Flashing faster and faster, going pale, and trembling a little lower.
          const k = Math.min(1, tile.t / arm);
          const on = Math.sin(tile.blink * Math.PI * 2) > 0;
          const pale = on ? 0.75 : 0.25 + 0.3 * k;
          const glow = on ? 1.35 : 1;
          for (let i = 0; i < 3; i++) col[i] = (base[i] + (1 - base[i]) * pale) * glow;
          item.pattern = on ? Pattern.emissive : Pattern.plain;
          this.setModel(tile, 0.04 * k + Math.sin(tile.t * 70) * 0.012 * k, 1, Math.sin(tile.t * 53) * 0.03 * k);
          break;
        }
        case 'falling': {
          const k = tile.t / FALL_TIME;
          item.pattern = Pattern.plain;
          for (let i = 0; i < 3; i++) col[i] = base[i] + (1 - base[i]) * 0.4;
          this.setModel(tile, 0.08 + 12 * tile.t * tile.t, Math.max(0, 1 - k * k), tile.spin * tile.t * 5);
          break;
        }
        case 'gone':
          continue;
        case 'growing': {
          // Pops back in with a little overshoot.
          const k = Math.min(1, tile.t / GROW_TIME);
          const s = 1 + 2.7 * Math.pow(k - 1, 3) + 1.7 * Math.pow(k - 1, 2);
          item.pattern = Pattern.plain;
          for (let i = 0; i < 3; i++) col[i] = base[i];
          this.setModel(tile, 0, Math.max(0.01, s), 0);
          break;
        }
      }
      out.push(item);
    }
  }

  /** How many tiles are still there to stand on. */
  get solidCount() {
    let n = 0;
    for (const t of this.tiles) if (HexFloor.solid(t)) n++;
    return n;
  }
}

const NEIGHBOURS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1]];

function key(q: number, r: number) {
  return (q + 512) * 1024 + (r + 512);
}
