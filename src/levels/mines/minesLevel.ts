import { sfx, tone } from '../../engine/audio';
import { add, clamp, mul, normalize, rotationX, rotationY, rotationZ, scaling, sub, translation, type Vec3 } from '../../engine/math';
import type { RAPIER } from '../../engine/physics';
import { Pattern, type DrawItem } from '../../engine/renderer';
import { CHAMBER_HALF } from '../../game/chamber';
import { ExitPortal, PortalArrival } from '../../entities/portal';
import { DEFAULT_ENV, type CameraShot, type Level, type LevelContext, type LevelStatus, type TrackedTarget, type WorldLabel } from '../level';

/*
 * Minesweeper. The floor is a board of raised grey tiles, and the exit is open on the far side.
 * Stepping on a tile reveals it: a number (how many mines touch it, diagonals included) or, if you
 * weren't paying attention, a mine. Right-click or E plants a flag. Boards are generated until a
 * simple logical solver can get from the start to the exit without guessing, so it's always fair.
 */

const N = 12;
const TILE = (CHAMBER_HALF * 2) / N;
const MINES = 28;
/** Unrevealed tiles stick up this much (and step down when revealed). */
const RAISED = 0.14;
/** A revealed tile's collider centre: its top level with the drawn plate. */
const REVEALED_Y = 0.015 - (RAISED + 0.04) / 2;
const DEATH_SCREEN_DELAY = 2;
/** Nothing explodes within this distance (m) of the arrival spot, wherever the portal drops you. */
const SAFE_START = 4.6;

const TILE_UP = [0.66, 0.67, 0.7];
const TILE_LIGHT = [0.97, 0.97, 0.98];
const TILE_DARK = [0.3, 0.31, 0.34];
const TILE_DOWN = [0.24, 0.25, 0.28];
/** A softer, office-lit day, so the greys stay apart. */
const ENV = { ...DEFAULT_ENV, sunColor: [1.35, 1.3, 1.2] as Vec3, skyColor: [0.24, 0.3, 0.42] as Vec3 };
const TILE_BOOM = [0.85, 0.08, 0.06];
const NUMBER_COLORS = ['', '#2b4cff', '#1f9a2a', '#e8231d', '#1a1a8f', '#8f1414', '#128a8a', '#111111', '#888888'];

const JOKES = [
  'You stepped on a mine. In Minesweeper. The one rule.',
  'That was a 50/50. Just kidding. It really, really was not.',
  'Should have right-clicked.',
  'Somewhere, a 1990s office worker winces.',
];

const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

interface Tile {
  i: number;
  j: number;
  mine: boolean;
  /** Mines touching this tile. */
  count: number;
  revealed: boolean;
  /** Level time at which it's shown revealed (cascades ripple outward). */
  revealAt: number;
  flag: boolean;
  collider: RAPIER.Collider;
  /** Cached draw items, and the state they were built for. */
  items: DrawItem[];
  key: number;
  label: WorldLabel | null;
}

type Face = 'smile' | 'oh' | 'dead' | 'cool';

interface Death {
  t: number;
}

export class MinesLevel implements Level {
  readonly number: number;
  readonly title = 'Minesweeper';
  status: LevelStatus = 'playing';
  private arrival: PortalArrival;
  private exit: ExitPortal;
  private tiles: Tile[] = [];
  private labelList: WorldLabel[] = [];
  private counter: WorldLabel = { pos: [-5.2, 7.2, -CHAMBER_HALF + 0.35], text: '', size: 1.4, color: '#ff2a1a' };
  private clock: WorldLabel = { pos: [5.2, 7.2, -CHAMBER_HALF + 0.35], text: '000', size: 1.4, color: '#ff2a1a' };
  private time = 0;
  private started = false;
  private face: Face = 'smile';
  private ohFor = 0;
  private death: Death | null = null;
  private boom: { pos: Vec3; t: number } | null = null;
  private lastTile: Tile | null = null;
  private exitRow: number;
  private spawn: Vec3;

  constructor(private ctx: LevelContext) {
    this.number = ctx.number;
    const { physics, hud } = ctx;
    hud.setLevel(`The Chamber · Level ${this.number}`);
    hud.show(`LEVEL ${this.number}`, '', 2.5);
    hud.hint('');
    const startRow = 3 + Math.floor(Math.random() * 6);
    this.exitRow = 3 + Math.floor(Math.random() * 6);
    const spawn: Vec3 = [centre(1), 0, centre(startRow)];
    this.spawn = spawn;
    this.arrival = new PortalArrival(ctx, spawn);
    this.exit = new ExitPortal(centre(this.exitRow));

    const mines = makeBoard(spawn, [N - 1, this.exitRow]);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const collider = physics.addStaticBox([centre(i), RAISED / 2 - 0.02, centre(j)], [TILE, RAISED + 0.04, TILE]);
        this.tiles.push({ i, j, mine: mines[j * N + i], count: 0, revealed: false, revealAt: Infinity, flag: false, collider, label: null, items: [], key: -1 });
      }
    }
    for (const t of this.tiles) t.count = this.neighbours(t).filter((n) => n.mine).length;
    this.labelList.push(this.counter, this.clock);
    this.updateCounter();
  }

  private tile(i: number, j: number): Tile | null {
    return i >= 0 && j >= 0 && i < N && j < N ? this.tiles[j * N + i] : null;
  }

  private neighbours(t: Tile): Tile[] {
    const out: Tile[] = [];
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const n = this.tile(t.i + di, t.j + dj);
        if (n) out.push(n);
      }
    }
    return out;
  }

  private tileAt(x: number, z: number): Tile | null {
    return this.tile(Math.floor((x + CHAMBER_HALF) / TILE), Math.floor((z + CHAMBER_HALF) / TILE));
  }

  /** Reveals a tile; zeros open up their neighbours in a ripple. */
  private reveal(start: Tile) {
    if (!start.revealed) {
      tone(700, 0.05, { wave: 'square', vol: 0.08 });
      if (start.count === 0) for (let k = 1; k < 5; k++) tone(700 + k * 150, 0.05, { wave: 'square', vol: 0.05, at: k * 0.05 });
    }
    const queue: [Tile, number][] = [[start, 0]];
    while (queue.length) {
      const [t, ring] = queue.shift()!;
      if (t.revealed) continue;
      t.revealed = true;
      t.flag = false;
      t.revealAt = this.time + ring * 0.045;
      t.collider.setTranslation({ x: centre(t.i), y: REVEALED_Y, z: centre(t.j) });
      if (t.count > 0 && !t.mine) {
        t.label = { pos: [centre(t.i), 0.35, centre(t.j)], text: String(t.count), size: 1.05, color: NUMBER_COLORS[t.count] };
        this.labelList.push(t.label);
      }
      if (t.count === 0 && !t.mine) for (const n of this.neighbours(t)) if (!n.revealed) queue.push([n, ring + 1]);
    }
    this.updateCounter();
  }

  private updateCounter() {
    const flags = this.tiles.filter((t) => t.flag).length;
    this.counter.text = String(Math.max(0, MINES - flags)).padStart(3, '0');
  }

  update(dt: number) {
    const { player, hud, input, camera, physics } = this.ctx;
    const death = this.death;
    if (death && this.status === 'playing') {
      death.t += dt;
      if (death.t > DEATH_SCREEN_DELAY) {
        this.status = 'lost';
        hud.show('BOOM', `${pick(JOKES)}\nPress R to try again.`);
        hud.tips([
          ['Hint', 'Each number counts the mines touching that tile, diagonals included. Tiles you have stepped on are safe; work out the rest before you step. Right-click or E plants a flag.'],
          ['Controls', 'WASD move · Right-click or E flag the tile you aim at · Shift sprint (bold choice)'],
        ]);
      }
    }
    this.arrival.update(dt);
    this.exit.update(dt, player);
    if (this.exit.entered && this.status === 'playing') this.status = 'exited';
    this.time += dt;
    if (this.boom) this.boom.t += dt;
    this.ohFor = Math.max(0, this.ohFor - dt);
    if (this.face === 'oh' && this.ohFor <= 0) this.face = 'smile';

    if (!this.arrival.done) return;
    if (!this.started) {
      // Open up where the player landed, and slide the exit open on the far side.
      this.started = true;
      const spawnTile = this.tileAt(this.spawn[0], this.spawn[2]);
      const here = this.tileAt(player.pos[0], player.pos[2]);
      if (here && here.mine && spawnTile) this.moveMine(here, spawnTile);
      if (spawnTile) this.reveal(spawnTile);
      if (here) this.reveal(here);
      this.exit.openNow();
    }
    if (!this.death && this.status === 'playing') {
      this.clock.text = String(Math.min(999, Math.floor(this.time - (this.startTime ??= this.time)))).padStart(3, '0');
    }
    if (this.exit.entered || player.inPortal) this.face = 'cool';
    if (player.mode !== 'control' || this.death) return;

    // Stepping on a tile (feet down) reveals it.
    const t = this.tileAt(player.pos[0], player.pos[2]);
    if (t && player.onGround && t !== this.lastTile) {
      this.lastTile = t;
      if (!t.revealed) {
        if (t.mine) this.explode(t);
        else {
          this.reveal(t);
          this.face = 'oh';
          this.ohFor = 0.35;
        }
      }
    }

    // Right-click (with empty hands) or E: flag the tile under the crosshair.
    if (input.wasPressed('KeyE') || (input.rightPressed && !player.carrying)) {
      const origin = camera.pos;
      const dir = normalize(sub(camera.target, camera.pos));
      const hit = physics.raycast(origin, dir, 14, player.collider ?? undefined);
      const chest = add(player.pos, [0, 1.2, 0]);
      if (hit && Math.hypot(hit.point[0] - chest[0], hit.point[2] - chest[2]) < 7) {
        const f = this.tileAt(hit.point[0], hit.point[2]);
        if (f && !f.revealed) {
          f.flag = !f.flag;
          tone(f.flag ? 900 : 500, 0.08, { to: f.flag ? 1300 : 350, wave: 'triangle', vol: 0.15 });
          this.updateCounter();
        }
      }
    }
  }

  private startTime: number | undefined;

  /** The portal dropped you on a mine (it can happen, just): quietly move it somewhere far away. */
  private moveMine(t: Tile, start: Tile) {
    const exit: [number, number] = [N - 1, this.exitRow];
    const far = this.tiles.filter((o) => !o.mine && Math.hypot(o.i - t.i, o.j - t.j) > 4 && !(o.i === exit[0] && o.j === exit[1]));
    if (!far.length) return;
    t.mine = false;
    // Somewhere that keeps the board solvable by logic, if there is one.
    const layout = () => {
      const m: boolean[] = new Array(N * N).fill(false);
      for (const o of this.tiles) m[o.j * N + o.i] = o.mine;
      return m;
    };
    let chosen = pick(far);
    for (let tries = 0; tries < 40; tries++) {
      const o = pick(far);
      o.mine = true;
      const ok = solvable(layout(), [start.i, start.j], exit);
      o.mine = false;
      if (ok) {
        chosen = o;
        break;
      }
    }
    chosen.mine = true;
    for (const o of this.tiles) o.count = this.neighbours(o).filter((n) => n.mine).length;
  }

  private explode(t: Tile) {
    const { player, camera } = this.ctx;
    sfx.explosion(0.7);
    t.revealed = true;
    t.revealAt = this.time;
    t.collider.setTranslation({ x: centre(t.i), y: REVEALED_Y, z: centre(t.j) });
    const pos: Vec3 = [centre(t.i), 0.1, centre(t.j)];
    this.boom = { pos, t: 0 };
    player.kill([(Math.random() - 0.5) * 6, 15, (Math.random() - 0.5) * 6], { violence: 30, origin: add(player.pos, [0, 0.2, 0]) });
    camera.addShake(1.2);
    this.face = 'dead';
    this.death = { t: 0 };
    // Show where all the other mines were, Minesweeper-style.
    for (const m of this.tiles) if (m.mine && !m.revealed) m.revealAt = this.time + 0.6 + Math.random() * 0.6;
  }

  // --- Drawing ------------------------------------------------------------------------------------

  draw(out: DrawItem[]) {
    this.arrival.draw(out);
    this.exit.draw(out);
    const now = this.time;
    for (const t of this.tiles) {
      const shown = t.revealed && now >= t.revealAt;
      const minesShown = !!this.death && t.mine && now >= t.revealAt;
      const boom = !!this.boom && t.mine && t.revealed;
      if (t.label) t.label.text = shown ? String(t.count) : '';
      // Tiles only change when revealed, flagged or blown up: rebuild their draw items only then.
      const key = (shown ? 1 : 0) | (minesShown ? 2 : 0) | (boom ? 4 : 0) | (t.flag ? 8 : 0);
      if (key !== t.key) {
        t.key = key;
        t.items.length = 0;
        this.drawTile(t.items, t, shown || minesShown, boom);
      }
      for (const item of t.items) out.push(item);
    }
    this.drawRest(out);
  }

  private drawTile(out: DrawItem[], t: Tile, down: boolean, boom: boolean) {
    const x = centre(t.i), z = centre(t.j);
    if (down) {
      out.push({ mesh: 'box', model: mul(translation([x, 0.005, z]), scaling([TILE - 0.05, 0.02, TILE - 0.05])), color: boom ? TILE_BOOM : TILE_DOWN, spec: 0.1 });
      if (t.mine) drawMine(out, [x, 0.02, z]);
    } else {
      // A raised Windows 95 button: light edges top-left (north, west), dark bottom-right.
      const w = TILE - 0.06, e = 0.14, h = RAISED;
      out.push({ mesh: 'box', model: mul(translation([x, h / 2, z]), scaling([w - 2 * e, h, w - 2 * e])), color: TILE_UP, spec: 0.2 });
      out.push({ mesh: 'box', model: mul(translation([x, h / 2, z - w / 2 + e / 2]), scaling([w, h, e])), color: TILE_LIGHT });
      out.push({ mesh: 'box', model: mul(translation([x - w / 2 + e / 2, h / 2, z + e / 2]), scaling([e, h, w - e])), color: TILE_LIGHT });
      out.push({ mesh: 'box', model: mul(translation([x + e / 2, h / 2, z + w / 2 - e / 2]), scaling([w - e, h, e])), color: TILE_DARK });
      out.push({ mesh: 'box', model: mul(translation([x + w / 2 - e / 2, h / 2, z - e / 2]), scaling([e, h, w - 2 * e])), color: TILE_DARK });
      if (t.flag) drawFlag(out, [x, RAISED, z]);
    }
  }

  private drawRest(out: DrawItem[]) {
    // The face button, with the mine counter and the clock either side, on the north wall.
    const wallZ = -CHAMBER_HALF + 0.12;
    out.push({ mesh: 'bevelbox', model: mul(translation([0, 7, wallZ]), scaling([3.4, 3.4, 0.3])), color: TILE_UP, spec: 0.2 });
    for (const x of [-5.2, 5.2]) out.push({ mesh: 'box', model: mul(translation([x, 7, wallZ]), scaling([4.2, 1.9, 0.26])), color: [0.06, 0.02, 0.02] });
    this.drawFace(out, [0, 7, wallZ + 0.2]);

    if (this.boom) this.drawBoom(out, this.boom.pos, this.boom.t);
  }

  private drawFace(out: DrawItem[], c: Vec3) {
    const disc = (p: Vec3, r: number, color: number[], depth = 0.1) =>
      out.push({ mesh: 'cylinder', model: mul(translation(p), rotationX(Math.PI / 2), scaling([r, depth, r])), color, spec: 0.3 });
    const black = [0.02, 0.02, 0.02];
    disc(c, 1.35, [1, 0.86, 0.08], 0.12);
    const f = add(c, [0, 0, 0.08]);
    if (this.face === 'dead') {
      for (const x of [-0.45, 0.45]) {
        for (const a of [0.785, -0.785]) out.push({ mesh: 'box', model: mul(translation(add(f, [x, 0.35, 0])), rotationZ(a), scaling([0.4, 0.09, 0.05])), color: black });
      }
    } else if (this.face === 'cool') {
      out.push({ mesh: 'box', model: mul(translation(add(f, [0, 0.38, 0.02])), scaling([1.5, 0.12, 0.05])), color: black });
      for (const x of [-0.42, 0.42]) out.push({ mesh: 'roundbox', model: mul(translation(add(f, [x, 0.3, 0.02])), scaling([0.55, 0.36, 0.06])), color: black });
    } else {
      for (const x of [-0.45, 0.45]) disc(add(f, [x, 0.35, 0]), 0.13, black, 0.05);
    }
    if (this.face === 'oh') {
      disc(add(f, [0, -0.45, 0]), 0.22, black, 0.05);
    } else {
      // A smile (or, dead, a frown): an arc of little black dots.
      const frown = this.face === 'dead';
      for (let k = 0; k < 9; k++) {
        const a = -0.9 + (k / 8) * 1.8;
        const y = frown ? -0.75 + Math.cos(a) * 0.35 : -0.25 - Math.cos(a) * 0.4;
        disc(add(f, [Math.sin(a) * 0.55, y, 0]), 0.07, black, 0.05);
      }
    }
  }

  private drawBoom(out: DrawItem[], p: Vec3, t: number) {
    // Crater, fireball, and a smoke column.
    out.push({ mesh: 'cylinder', model: mul(translation(add(p, [0, -0.07, 0])), scaling([1.3, 0.02, 1.3])), color: [0.03, 0.03, 0.03], shadow: false });
    if (t < 0.5) {
      const r = 0.6 + t * 7;
      out.push({ mesh: 'sphere', model: mul(translation(add(p, [0, r * 0.4, 0])), scaling([r, r * 0.8, r])), color: [7, 3.2, 0.8], pattern: Pattern.emissive, opacity: 1 - t * 1.6, shadow: false });
    }
    for (let k = 0; k < 7; k++) {
      const age = t - k * 0.12;
      if (age < 0 || age > 3.5) continue;
      const r = 0.4 + age * 0.5;
      const g = 0.15 + k * 0.03;
      out.push({ mesh: 'sphere', model: mul(translation(add(p, [Math.sin(k * 2.1) * 0.3, 0.6 + age * 1.6, Math.cos(k * 1.7) * 0.3])), scaling([r, r, r])), color: [g, g, g], opacity: 0.7 * (1 - age / 3.5), shadow: false });
    }
  }

  labels(): WorldLabel[] {
    return this.labelList;
  }

  trackedTargets(): TrackedTarget[] {
    const exit = this.exit.target();
    return exit ? [exit] : [];
  }

  environment() {
    return ENV;
  }

  obstacles() {
    return [];
  }

  cameraShot(): CameraShot | null {
    return this.arrival.cameraShot();
  }
}

function centre(k: number) {
  return -CHAMBER_HALF + TILE * (k + 0.5);
}

/** The classic mine: a black ball with spikes and a shine. */
function drawMine(out: DrawItem[], p: Vec3) {
  const c = add(p, [0, 0.35, 0]);
  const black = [0.03, 0.03, 0.03];
  out.push({ mesh: 'sphere', model: mul(translation(c), scaling([0.34, 0.34, 0.34])), color: black, spec: 0.8 });
  for (let k = 0; k < 4; k++) {
    out.push({ mesh: 'cylinder', model: mul(translation(c), rotationY((k * Math.PI) / 4), rotationZ(Math.PI / 2), scaling([0.05, 1.05, 0.05])), color: black });
  }
  out.push({ mesh: 'cylinder', model: mul(translation(c), scaling([0.05, 1.05, 0.05])), color: black });
  out.push({ mesh: 'sphere', model: mul(translation(add(c, [-0.1, 0.12, 0.2])), scaling([0.08, 0.08, 0.08])), color: [1, 1, 1] });
}

/** A little red flag on a pole. */
function drawFlag(out: DrawItem[], p: Vec3) {
  out.push({ mesh: 'cylinder', model: mul(translation(add(p, [0, 0.55, 0])), scaling([0.03, 1.1, 0.03])), color: [0.1, 0.1, 0.1] });
  out.push({ mesh: 'box', model: mul(translation(add(p, [0, 0.12, 0])), scaling([0.5, 0.12, 0.5])), color: [0.1, 0.1, 0.1] });
  out.push({ mesh: 'box', model: mul(translation(add(p, [0.22, 0.9, 0.12])), rotationY(-0.4), scaling([0.5, 0.32, 0.03])), color: [0.9, 0.06, 0.05] });
}

// --- Board generation ---------------------------------------------------------------------------

/**
 * Places the mines: none near the arrival spot, and the board must be solvable by plain logic
 * from the opening round the start to the exit tile. Tries until one is (falls back to the last).
 */
function makeBoard(spawn: Vec3, exitTile: [number, number]): boolean[] {
  let mines: boolean[] = [];
  for (let attempt = 0; attempt < 400; attempt++) {
    mines = new Array(N * N).fill(false);
    const free = [];
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        // Nearest point of the tile to the spawn, not its centre.
        const nx = clamp(spawn[0], centre(i) - TILE / 2, centre(i) + TILE / 2), nz = clamp(spawn[2], centre(j) - TILE / 2, centre(j) + TILE / 2);
        const near = Math.hypot(nx - spawn[0], nz - spawn[2]) < SAFE_START;
        const exitSide = i === exitTile[0] && Math.abs(j - exitTile[1]) <= 0;
        if (!near && !exitSide) free.push(j * N + i);
      }
    }
    for (let k = 0; k < MINES; k++) {
      const idx = free.splice(Math.floor(Math.random() * free.length), 1)[0];
      mines[idx] = true;
    }
    const startI = clamp(Math.floor((spawn[0] + CHAMBER_HALF) / TILE), 0, N - 1);
    const startJ = clamp(Math.floor((spawn[2] + CHAMBER_HALF) / TILE), 0, N - 1);
    if (solvable(mines, [startI, startJ], exitTile)) return mines;
  }
  return mines;
}

/** Whether single-tile deductions (and the subset rule) can reveal the exit tile from the start. */
function solvable(mines: boolean[], start: [number, number], exitTile: [number, number]): boolean {
  const idx = (i: number, j: number) => j * N + i;
  const nb = (k: number): number[] => {
    const i = k % N, j = Math.floor(k / N), out: number[] = [];
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if ((di || dj) && i + di >= 0 && i + di < N && j + dj >= 0 && j + dj < N) out.push(idx(i + di, j + dj));
    }
    return out;
  };
  const count = mines.map((_, k) => nb(k).filter((n) => mines[n]).length);
  const open = new Array(N * N).fill(false);
  const flagged = new Array(N * N).fill(false);
  const reveal = (k: number) => {
    const stack = [k];
    while (stack.length) {
      const c = stack.pop()!;
      if (open[c]) continue;
      open[c] = true;
      if (count[c] === 0) for (const n of nb(c)) if (!open[n]) stack.push(n);
    }
  };
  // The player lands anywhere near the start; assume the whole safe patch there gets walked on.
  reveal(idx(start[0], start[1]));
  const target = idx(exitTile[0], exitTile[1]);
  for (let pass = 0; pass < 60 && !open[target]; pass++) {
    let progress = false;
    const unknown = (k: number) => nb(k).filter((n) => !open[n] && !flagged[n]);
    const need = (k: number) => count[k] - nb(k).filter((n) => flagged[n]).length;
    for (let k = 0; k < N * N; k++) {
      if (!open[k] || mines[k]) continue;
      const u = unknown(k);
      if (!u.length) continue;
      const m = need(k);
      if (m === u.length) { for (const n of u) flagged[n] = true; progress = true; }
      else if (m === 0) { for (const n of u) reveal(n); progress = true; }
    }
    if (!progress) {
      // Subset rule: if A's unknowns are inside B's, the difference holds B's extra mines.
      for (let a = 0; a < N * N && !progress; a++) {
        if (!open[a] || mines[a]) continue;
        const ua = unknown(a);
        if (!ua.length) continue;
        for (const b of nb(a)) {
          if (!open[b] || mines[b]) continue;
          const ub = unknown(b);
          if (ub.length <= ua.length || !ua.every((x) => ub.includes(x))) continue;
          const diff = ub.filter((x) => !ua.includes(x));
          const extra = need(b) - need(a);
          if (extra === diff.length) { for (const n of diff) flagged[n] = true; progress = true; }
          else if (extra === 0) { for (const n of diff) reveal(n); progress = true; }
          if (progress) break;
        }
      }
    }
    if (!progress) return false;
  }
  return open[target];
}

