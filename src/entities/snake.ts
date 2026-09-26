import { RAPIER, type Physics } from '../engine/physics';
import type { DrawItem, MeshName } from '../engine/renderer';

/*
 * The snake from the old phone game, life-size: a chain of dark pixel blocks on a 16 x 16 grid of
 * 1.5 m cells covering the chamber floor. It moves one cell per step (with a very short slide),
 * never turns back on itself, and heads greedily for its `target` cell. Each block is a solid
 * static collider that jumps to its new cell on every step. If it has nowhere safe to go it
 * crashes: the classic blink, then its blocks pop away one by one from the head.
 */

export const SNAKE_GRID = 16;
export const SNAKE_CELL = 1.5;
const HALF = (SNAKE_GRID * SNAKE_CELL) / 2;
/** World x (for a column) or z (for a row) of a cell's centre. */
export const cellCentre = (k: number) => -HALF + (k + 0.5) * SNAKE_CELL;
/** The column (from x) or row (from z) a world position is in, clamped to the grid. */
export const cellAt = (v: number) => Math.min(SNAKE_GRID - 1, Math.max(0, Math.floor((v + HALF) / SNAKE_CELL)));

/** Directions: 0 north (-z), 1 east (+x), 2 south (+z), 3 west (-x). */
const DI = [0, 1, 0, -1];
const DJ = [-1, 0, 1, 0];
/** Yaw that turns the head's local -z (its front) toward each direction. */
const DIR_YAW = [0, -Math.PI / 2, Math.PI, Math.PI / 2];

/** A block's width and height: too tall to jump onto, with small gaps between neighbours. */
export const SNAKE_BLOCK = 1.35;
export const SNAKE_HEIGHT = 1.6;
const BODY = [0.024, 0.03, 0.011];
const EYE = [0.74, 0.8, 0.46];
const PUPIL = [0.01, 0.01, 0.01];
const TONGUE = [0.85, 0.07, 0.1];

/** The slide from one cell to the next (s), at most this share of a step. */
const SLIDE_TIME = 0.06;
const SLIDE_SHARE = 0.4;
/** Crash: how far the head lurches into what it hit, the blinking, and popping away. */
const LURCH = 0.3;
const BLINK_TIME = 1.6;
const BLINK_PERIOD = 0.2;
const POP_GAP_MAX = 0.08;
const POP_TOTAL = 2.6;
const POP_TIME = 0.14;
/** A swallowed lump travels down the body this fast (segments/s) and swells it this much. */
const BULGE_SPEED = 14;
const BULGE_SWELL = 0.3;

export type SnakeState = 'waiting' | 'moving' | 'crashed' | 'popping' | 'gone';

/** Knobs for how clever the snake is. */
export interface SnakeBrain {
  /** Chance per step of picking a random safe move instead of the best one. */
  blunder: number;
  /** Chance per step of looking ahead for dead ends at all. */
  foresight: number;
  /** Pockets with fewer free cells than this (counting cells its tail will have left) count as dead ends. */
  pocket: number;
}

export class Snake {
  /** Cells, head first: column i (west to east) and row j (north to south). Rows < 0 are behind the north wall. */
  readonly ci: number[] = [];
  readonly cj: number[] = [];
  /** Where each segment was before the current step (it slides from there). */
  private pi: number[] = [];
  private pj: number[] = [];
  dir: number;
  state: SnakeState = 'waiting';
  /** Seconds per step. */
  interval = 0.32;
  /** The cell it's heading for. */
  targetI = 8;
  targetJ = 8;
  /** Grows one block every this many steps. */
  growEvery = 5;
  brain: SnakeBrain = { blunder: 0.08, foresight: 0.75, pocket: 10 };
  /** Seconds to hold still (e.g. for a gulp) before stepping on. */
  pauseFor = 0;
  /** Blocks still to be added (one per step, at the tail). */
  pendingGrowth = 0;
  /** Steps taken so far. */
  steps = 0;
  /** Set on the step it crashed: the cell it tried to go into. */
  crashedInto: [number, number] | null = null;
  private timer = 0;
  private slide = 1;
  private slideTime = SLIDE_TIME;
  private stateT = 0;
  private popped = 0;
  private bulges: number[] = [];
  private gulp = 0;
  private time = 0;
  private colliders: RAPIER.Collider[] = [];
  private occ = new Uint8Array(SNAKE_GRID * SNAKE_GRID);
  /** Steps until the segment in each cell will have moved out of it (0: free). */
  private vacate = new Int16Array(SNAKE_GRID * SNAKE_GRID);
  // Flood fill scratch space (no allocations while thinking).
  private queue = new Int16Array(SNAKE_GRID * SNAKE_GRID);
  private depth = new Int16Array(SNAKE_GRID * SNAKE_GRID);
  private seen = new Uint32Array(SNAKE_GRID * SNAKE_GRID);
  private stamp = 0;
  // Draw pool: items and their matrices are reused every frame.
  private pool: DrawItem[] = [];
  private used = 0;
  /** Where the eyes look (world x, z). */
  lookX = 0;
  lookZ = 0;

  /** A snake of `length` blocks with its head in cell (i, j) facing `dir`, the rest trailing straight behind. */
  constructor(private physics: Physics, i: number, j: number, dir: number, length: number) {
    this.dir = dir;
    for (let s = 0; s < length; s++) {
      const si = i - DI[dir] * s, sj = j - DJ[dir] * s;
      this.ci.push(si);
      this.cj.push(sj);
      this.pi.push(si);
      this.pj.push(sj);
      this.setOcc(si, sj, 1);
      this.colliders.push(this.makeCollider(si, sj));
    }
  }

  get length() {
    return this.ci.length;
  }

  get alive() {
    return this.state === 'waiting' || this.state === 'moving';
  }

  /** Starts it moving. */
  go() {
    if (this.state === 'waiting') this.state = 'moving';
  }

  /** Swallowed something: grow by `blocks`, gulp, and send a lump down the body. */
  eat(blocks: number) {
    this.pendingGrowth += blocks;
    this.bulges.push(0);
    this.gulp = 1;
  }

  /** Where the head is drawn right now (x, z), mid-slide included. */
  headX() {
    return this.segX(0);
  }

  headZ() {
    return this.segZ(0);
  }

  /** The direction the head faces as a unit (x, z). */
  get forwardX() {
    return DI[this.dir];
  }

  get forwardZ() {
    return DJ[this.dir];
  }

  update(dt: number) {
    this.time += dt;
    this.stateT += dt;
    this.slide = Math.min(1, this.slide + dt / this.slideTime);
    this.gulp = Math.max(0, this.gulp - dt * 3);
    for (let b = this.bulges.length - 1; b >= 0; b--) {
      this.bulges[b] += dt * BULGE_SPEED;
      if (this.bulges[b] > this.length + 1) this.bulges.splice(b, 1);
    }
    if (this.state === 'moving') {
      if (this.pauseFor > 0) this.pauseFor -= dt;
      else this.timer += dt;
      if (this.timer >= this.interval) {
        this.timer -= this.interval;
        this.step();
      }
    } else if (this.state === 'crashed') {
      if (this.stateT >= BLINK_TIME) {
        this.state = 'popping';
        this.stateT = 0;
      }
    } else if (this.state === 'popping') {
      const gap = Math.min(POP_GAP_MAX, POP_TOTAL / this.length);
      // Pop blocks from the head down; each one's collider goes as it vanishes.
      while (this.popped < this.length && this.stateT >= this.popped * gap + POP_TIME) {
        this.physics.world.removeCollider(this.colliders[this.popped], false);
        this.setOcc(this.ci[this.popped], this.cj[this.popped], 0);
        this.popped++;
      }
      if (this.popped >= this.length) this.state = 'gone';
    }
  }

  // --- Moving -----------------------------------------------------------------------------------

  private step() {
    if (this.steps > 0 && this.steps % this.growEvery === 0) this.pendingGrowth++;
    const grow = this.pendingGrowth > 0;
    const d = this.think(grow);
    if (d < 0) {
      this.crash();
      return;
    }
    if (grow) this.pendingGrowth--;
    this.steps++;
    this.advance(d, grow);
  }

  /** Stops dead: it has nowhere to go. */
  private crash() {
    const d = this.dir;
    this.crashedInto = [this.ci[0] + DI[d], this.cj[0] + DJ[d]];
    this.state = 'crashed';
    this.stateT = 0;
  }

  private advance(d: number, grow: boolean) {
    const n = this.length;
    const ni = this.ci[0] + DI[d], nj = this.cj[0] + DJ[d];
    for (let s = 0; s < n; s++) {
      this.pi[s] = this.ci[s];
      this.pj[s] = this.cj[s];
    }
    const ti = this.ci[n - 1], tj = this.cj[n - 1];
    if (grow) {
      // A new block appears where the tail is, and stays put while the rest moves on.
      this.ci.push(ti);
      this.cj.push(tj);
      this.pi.push(ti);
      this.pj.push(tj);
      this.colliders.push(this.makeCollider(ti, tj));
    } else {
      this.setOcc(ti, tj, 0);
    }
    for (let s = n - 1; s > 0; s--) {
      this.ci[s] = this.ci[s - 1];
      this.cj[s] = this.cj[s - 1];
    }
    this.ci[0] = ni;
    this.cj[0] = nj;
    this.setOcc(ni, nj, 1);
    this.dir = d;
    for (let s = 0; s < n; s++) {
      if (this.ci[s] === this.pi[s] && this.cj[s] === this.pj[s]) continue;
      this.colliders[s].setTranslation({ x: cellCentre(this.ci[s]), y: SNAKE_HEIGHT / 2, z: cellCentre(this.cj[s]) });
    }
    this.slide = 0;
    this.slideTime = Math.min(SLIDE_TIME, this.interval * SLIDE_SHARE);
  }

  /**
   * Picks the next direction: never straight back, never into a wall or its own body (the tail's
   * cell counts as free when the tail is about to leave it). Prefers getting closer to the target
   * (Manhattan distance), then going straight on; sometimes looks ahead to avoid dead ends, and
   * now and then just blunders. Returns -1 if there's no safe move at all.
   */
  private think(grow: boolean): number {
    const hi = this.ci[0], hj = this.cj[0];
    // Still coming out of the wall: straight on.
    if (hj < 0) return this.free(hi, hj + 1, grow) || hj + 1 < 0 ? 2 : -1;
    const back = (this.dir + 2) % 4;
    let count = 0;
    let best = -1, bestScore = Infinity;
    const lookAhead = Math.random() < this.brain.foresight;
    if (lookAhead) this.markVacate();
    const blunder = Math.random() < this.brain.blunder;
    const pick = blunder ? Math.floor(Math.random() * 3) : -1;
    let fallback = -1;
    for (let d = 0; d < 4; d++) {
      if (d === back) continue;
      const ni = hi + DI[d], nj = hj + DJ[d];
      if (!this.free(ni, nj, grow)) continue;
      if (count++ === pick) return d;
      fallback = d;
      let score = (Math.abs(ni - this.targetI) + Math.abs(nj - this.targetJ)) * 10 + (d === this.dir ? 0 : 1) + Math.random() * 0.5;
      if (lookAhead) {
        const room = this.room(ni, nj, this.brain.pocket);
        if (room < this.brain.pocket) score += (this.brain.pocket - room) * 100;
      }
      if (score < bestScore) {
        bestScore = score;
        best = d;
      }
    }
    return best >= 0 ? best : fallback;
  }

  private free(i: number, j: number, grow: boolean) {
    if (i < 0 || j < 0 || i >= SNAKE_GRID || j >= SNAKE_GRID) return false;
    if (!this.occ[i + j * SNAKE_GRID]) return true;
    // The tail moves out of the way this very step (unless it's growing).
    const n = this.length;
    return !grow && i === this.ci[n - 1] && j === this.cj[n - 1];
  }

  /** How many steps until each body cell is free again (ignoring future growth). */
  private markVacate() {
    this.vacate.fill(0);
    const n = this.length;
    for (let s = 0; s < n; s++) {
      const i = this.ci[s], j = this.cj[s];
      if (j < 0) continue;
      this.vacate[i + j * SNAKE_GRID] = n - s + this.pendingGrowth;
    }
  }

  /**
   * Counts the cells reachable from (i, j) (up to `cap`), treating body cells as passable once the
   * tail will have left them by the time the head could get there.
   */
  private room(i: number, j: number, cap: number) {
    const G = SNAKE_GRID;
    this.stamp++;
    let head = 0, tail = 0, count = 0;
    const start = i + j * G;
    this.queue[tail++] = start;
    this.depth[start] = 1;
    this.seen[start] = this.stamp;
    while (head < tail && count < cap) {
      const c = this.queue[head++];
      count++;
      const ci = c % G, cj = (c - ci) / G, dn = this.depth[c] + 1;
      for (let d = 0; d < 4; d++) {
        const ni = ci + DI[d], nj = cj + DJ[d];
        if (ni < 0 || nj < 0 || ni >= G || nj >= G) continue;
        const k = ni + nj * G;
        if (this.seen[k] === this.stamp) continue;
        if (this.occ[k] && this.vacate[k] > dn) continue;
        this.seen[k] = this.stamp;
        this.depth[k] = dn;
        this.queue[tail++] = k;
      }
    }
    return count;
  }

  private setOcc(i: number, j: number, v: number) {
    if (i < 0 || j < 0 || i >= SNAKE_GRID || j >= SNAKE_GRID) return;
    this.occ[i + j * SNAKE_GRID] = v;
  }

  /** True if a snake block is in (or about to leave) cell (i, j). */
  occupied(i: number, j: number) {
    if (i < 0 || j < 0 || i >= SNAKE_GRID || j >= SNAKE_GRID) return true;
    return this.occ[i + j * SNAKE_GRID] > 0;
  }

  private makeCollider(i: number, j: number) {
    return this.physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(SNAKE_BLOCK / 2, SNAKE_HEIGHT / 2, SNAKE_BLOCK / 2)
        .setTranslation(cellCentre(i), SNAKE_HEIGHT / 2, cellCentre(j)),
    );
  }

  // --- Drawing ----------------------------------------------------------------------------------

  private slideK() {
    const t = this.slide;
    return 1 - (1 - t) * (1 - t);
  }

  private segX(s: number) {
    const k = this.slideK();
    return cellCentre(this.pi[s] + (this.ci[s] - this.pi[s]) * k);
  }

  private segZ(s: number) {
    const k = this.slideK();
    return cellCentre(this.pj[s] + (this.cj[s] - this.pj[s]) * k);
  }

  /** A pooled draw item with a Y-rotated, scaled box-ish mesh at (x, y, z). */
  private put(out: DrawItem[], mesh: MeshName, color: number[], spec: number, x: number, y: number, z: number, yaw: number, sx: number, sy: number, sz: number) {
    let d = this.pool[this.used];
    if (!d) {
      d = { mesh, model: new Float32Array(16), color };
      this.pool.push(d);
    }
    this.used++;
    d.mesh = mesh;
    d.color = color;
    d.spec = spec;
    const m = d.model, c = Math.cos(yaw), s = Math.sin(yaw);
    m[0] = c * sx; m[1] = 0; m[2] = -s * sx; m[3] = 0;
    m[4] = 0; m[5] = sy; m[6] = 0; m[7] = 0;
    m[8] = s * sz; m[9] = 0; m[10] = c * sz; m[11] = 0;
    m[12] = x; m[13] = y; m[14] = z; m[15] = 1;
    out.push(d);
  }

  draw(out: DrawItem[]) {
    this.used = 0;
    if (this.state === 'gone') return;
    // The death blink: the whole snake flicks off and on.
    if (this.state === 'crashed' && Math.floor(this.stateT / BLINK_PERIOD) % 2 === 1) return;
    const n = this.length;
    const gap = Math.min(POP_GAP_MAX, POP_TOTAL / n);
    for (let s = 0; s < n; s++) {
      let x = this.segX(s), z = this.segZ(s);
      // Behind the north wall (still coming in): not drawn.
      if (z < -HALF - SNAKE_BLOCK / 2) continue;
      let size = 1;
      if (this.state === 'popping') {
        const age = this.stateT - s * gap;
        if (age >= POP_TIME) continue;
        if (age > 0) size = 1 + 0.35 * (age / POP_TIME);
      }
      for (const b of this.bulges) {
        const w = 1 - Math.abs(s - b) / 1.3;
        if (w > 0) size += BULGE_SWELL * w;
      }
      if (s === 0) {
        size += this.gulp * 0.25;
        if (this.state === 'crashed') {
          // Lurch into whatever it hit, then sag back.
          const k = Math.min(1, this.stateT / 0.08) * Math.max(0, 1 - (this.stateT - 0.08) / 0.3);
          x += DI[this.dir] * LURCH * k;
          z += DJ[this.dir] * LURCH * k;
        }
        this.drawHead(out, x, z, size);
        continue;
      }
      const w = SNAKE_BLOCK * size, h = SNAKE_HEIGHT * Math.min(size, 1 + (size - 1) * 0.6);
      this.put(out, 'bevelbox', BODY, 0.25, x, h / 2, z, 0, w, h, w);
    }
  }

  private drawHead(out: DrawItem[], x: number, z: number, size: number) {
    const yaw = DIR_YAW[this.dir];
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const w = SNAKE_BLOCK * size, h = SNAKE_HEIGHT * Math.min(size, 1 + (size - 1) * 0.6);
    this.put(out, 'bevelbox', BODY, 0.3, x, h / 2, z, yaw, w, h, w);
    // Local (lx, ly, lz) in the head's frame (front = -z) to world.
    const wx = (lx: number, lz: number) => x + c * lx + s * lz;
    const wz = (lx: number, lz: number) => z - s * lx + c * lz;
    // Eyes: two pale cubes on top at the front, pupils glancing toward whatever it's after.
    const fx = DI[this.dir], fz = DJ[this.dir];
    const tx = this.lookX - x, tz = this.lookZ - z;
    const tl = Math.hypot(tx, tz) || 1;
    // Right of the head is (-fz, fx) in world (x, z) terms; how far to the side the target is.
    const side = ((-fz * tx + fx * tz) / tl) * 0.07;
    const eye = 0.36 * size;
    for (let e = -1; e <= 1; e += 2) {
      const lx = e * 0.33 * size, lz = -0.3 * size, ly = h + eye / 2 - 0.04;
      this.put(out, 'box', EYE, 0.4, wx(lx, lz), ly, wz(lx, lz), yaw, eye, eye, eye);
      const px = lx + side, pz = lz - eye / 2 - 0.012;
      this.put(out, 'box', PUPIL, 0.6, wx(px, pz), ly - 0.03, wz(px, pz), yaw, eye * 0.5, eye * 0.62, 0.03);
    }
    // The forked tongue flicks out now and then.
    if (this.state !== 'moving' && this.state !== 'waiting') return;
    const cycle = (this.time % 1.3) / 0.38;
    if (cycle >= 1) return;
    const out1 = Math.sin(cycle * Math.PI);
    const len = 0.6 * out1;
    if (len < 0.04) return;
    const ly = 0.45, front = -w / 2;
    const stemZ = front - len / 2 + 0.02;
    this.put(out, 'box', TONGUE, 0.5, wx(0, stemZ), ly, wz(0, stemZ), yaw, 0.13, 0.05, len);
    const wiggle = Math.sin(this.time * 40) * 0.25;
    for (let side2 = -1; side2 <= 1; side2 += 2) {
      const a = side2 * 0.55 + wiggle;
      const pl = 0.3 * out1;
      // Each prong starts at the stem's tip and angles outward (a yaw of `a` points it along (-sin a, -cos a)).
      const lx = (-Math.sin(a) * pl) / 2, lz = front - len - (Math.cos(a) * pl) / 2;
      this.put(out, 'box', TONGUE, 0.5, wx(lx, lz), ly, wz(lx, lz), yaw + a, 0.09, 0.045, pl);
    }
  }
}
