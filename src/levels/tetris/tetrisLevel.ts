import { add, mul, scaling, translation, type Vec3 } from '../../engine/math';
import type { RAPIER } from '../../engine/physics';
import { Pattern, type DrawItem } from '../../engine/renderer';
import { CHAMBER_HALF } from '../../game/chamber';
import { ExitPortal, PortalArrival } from '../../entities/portal';
import { DEFAULT_ENV, type CameraShot, type Level, type LevelContext, type LevelStatus, type TrackedTarget, type WorldLabel } from '../level';

/*
 * Falling blocks. Against the east wall stands a glass-fronted well one cell deep and ten wide,
 * and you're in it. Tetrominoes fall a row at a time, steering toward wherever you stand; what
 * lands is what you climb, to reach the exit high up on the east wall (open from the start).
 * Full rows still clear (and drop everything above, you included). A block landing on you:
 * game over.
 */

const COLS = 10;
const ROWS = 14; // visible well is 11 rows; pieces appear above
const CELL = 1;
/** The well: columns run along z (west edge at Z0), rows up from the floor, one cell deep in x. */
const Z0 = -COLS / 2;
const X_BACK = CHAMBER_HALF;
const X_FRONT = CHAMBER_HALF - CELL;
const WELL_TOP = 11;
const EXIT_ROW = 5;
const EXIT_COL = 8;
const DEATH_SCREEN_DELAY = 1.8;
/** Seconds per row, from the start to its fastest. */
const STEP_START = 0.55;
const STEP_FASTEST = 0.28;
const STEP_RAMP = 70;
/** Pieces stop steering this many rows above where they'll land. */
const COMMIT_ROWS = 4;

type Shape = [number, number][];
/** The seven tetrominoes (cells as [column, row] offsets, row up), with their classic colours. */
const PIECES: { cells: Shape; color: number[] }[] = [
  { cells: [[0, 0], [1, 0], [2, 0], [3, 0]], color: [0.1, 0.85, 0.9] }, // I
  { cells: [[0, 0], [1, 0], [0, 1], [1, 1]], color: [0.95, 0.85, 0.1] }, // O
  { cells: [[0, 0], [1, 0], [2, 0], [1, 1]], color: [0.62, 0.2, 0.85] }, // T
  { cells: [[0, 0], [1, 0], [1, 1], [2, 1]], color: [0.2, 0.85, 0.25] }, // S
  { cells: [[1, 0], [2, 0], [0, 1], [1, 1]], color: [0.92, 0.15, 0.12] }, // Z
  { cells: [[0, 0], [1, 0], [2, 0], [0, 1]], color: [0.15, 0.3, 0.95] }, // J
  { cells: [[0, 0], [1, 0], [2, 0], [2, 1]], color: [0.98, 0.55, 0.1] }, // L
];

interface Piece {
  kind: number;
  cells: Shape;
  col: number;
  row: number;
  /** Column it's steering for. */
  target: number;
}

interface Death {
  t: number;
  big: string;
  small: string;
}

const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

function rotate(cells: Shape, turns: number): Shape {
  let out = cells;
  for (let k = 0; k < turns; k++) out = out.map(([c, r]) => [r, -c] as [number, number]);
  const minC = Math.min(...out.map((c) => c[0])), minR = Math.min(...out.map((c) => c[1]));
  return out.map(([c, r]) => [c - minC, r - minR] as [number, number]);
}

export class TetrisLevel implements Level {
  readonly number: number;
  readonly title = 'Falling Blocks';
  status: LevelStatus = 'playing';
  private arrival: PortalArrival;
  private exit = new ExitPortal(Z0 + (EXIT_COL + 0.5) * CELL, EXIT_ROW);
  /** Landed blocks: colour index + 1, or 0 for empty; [row][col]. */
  private grid: number[][] = [];
  private colliders: (RAPIER.Collider | null)[][] = [];
  private piece: Piece | null = null;
  private pieceColliders: RAPIER.Collider[] = [];
  private next = Math.floor(Math.random() * 7);
  private stepT = 0;
  private time = 0;
  private started = false;
  private lines = 0;
  private clearing: { rows: number[]; t: number } | null = null;
  private death: Death | null = null;
  private labelList: WorldLabel[];
  private linesLabel: WorldLabel = { pos: [X_FRONT - 0.2, 9.4, Z0 - 2.2], text: 'LINES 0', size: 0.5, color: '#ffffff' };
  private flash: WorldLabel = { pos: [X_FRONT - 0.5, 6, 0], text: '', size: 1.2, color: '#ffd166' };

  constructor(private ctx: LevelContext) {
    this.number = ctx.number;
    const { physics, hud } = ctx;
    hud.setLevel(`The Chamber · Level ${this.number}`);
    hud.show(`LEVEL ${this.number}`, '', 2.5);
    hud.hint('');
    this.arrival = new PortalArrival(ctx, [X_FRONT + CELL / 2, 0, 0.5], { minElevationDeg: 88 });
    for (let r = 0; r < ROWS; r++) {
      this.grid.push(new Array(COLS).fill(0));
      this.colliders.push(new Array(COLS).fill(null));
    }
    // The well: glass in front (a wall you can't see), sides beyond the columns.
    const midX = (X_FRONT + X_BACK) / 2;
    physics.addStaticBox([X_FRONT - 0.6, 6, 0], [1.2, 12, COLS * CELL + 2]);
    for (const side of [-1, 1]) physics.addStaticBox([midX, 6, side * (COLS / 2 + 0.25)], [CELL + 0.2, 12, 0.5]);
    for (let k = 0; k < 4; k++) this.pieceColliders.push(physics.addStaticBox([0, -50, 0], [CELL, CELL, CELL]));
    this.labelList = [
      { pos: [X_FRONT - 0.2, 10.95, 0], text: 'BLOCK PARTY', size: 0.9, color: '#ffd166' },
      { pos: [X_FRONT - 0.2, 10.35, 0], text: 'everything is falling. mostly on you.', size: 0.34, color: '#cfd8ff' },
      { pos: [X_FRONT - 0.2, 10.2, Z0 - 2.2], text: 'NEXT', size: 0.45, color: '#ffffff' },
      this.linesLabel,
      this.flash,
    ];
    this.exit.openAlready();
  }

  private cellCentre(col: number, row: number): Vec3 {
    return [(X_FRONT + X_BACK) / 2, row * CELL + CELL / 2, Z0 + col * CELL + CELL / 2];
  }

  private fits(cells: Shape, col: number, row: number) {
    for (const [c, r] of cells) {
      const cc = col + c, rr = row + r;
      if (cc < 0 || cc >= COLS || rr < 0) return false;
      if (rr < ROWS && this.grid[rr][cc]) return false;
    }
    return true;
  }

  /** The player's column and the rows their body spans. */
  private playerCells() {
    const p = this.ctx.player.pos;
    const cols = new Set<number>();
    for (const dz of [-0.28, 0, 0.28]) cols.add(Math.floor((p[2] + dz - Z0) / CELL));
    const r0 = Math.floor((p[1] + 0.05) / CELL), r1 = Math.floor((p[1] + 1.75) / CELL);
    return { cols, r0, r1, col: Math.floor((p[2] - Z0) / CELL) };
  }

  private overlapsPlayer(cells: Shape, col: number, row: number) {
    const { player } = this.ctx;
    if (player.mode !== 'control' || player.pos[0] < X_FRONT - 0.3) return false;
    const pc = this.playerCells();
    return cells.some(([c, r]) => pc.cols.has(col + c) && row + r >= pc.r0 && row + r <= pc.r1);
  }

  private spawn() {
    const kind = this.next;
    this.next = Math.floor(Math.random() * 7);
    const cells = rotate(PIECES[kind].cells, Math.floor(Math.random() * 4));
    const col = Math.max(0, Math.min(COLS - this.width(cells), Math.floor(Math.random() * (COLS - this.width(cells) + 1))));
    this.aimOffset = Math.random() < 0.5 ? 0 : pick([-2, -1, 1, 2]);
    this.piece = { kind, cells, col, row: WELL_TOP + 1, target: col };
    this.piece.target = this.aimFor(this.piece.cells);
  }

  private width(cells: Shape) {
    return Math.max(...cells.map((c) => c[0])) + 1;
  }

  /** Stack height of each column (first empty row from the top down). */
  private heights(): number[] {
    const h = new Array(COLS).fill(0);
    for (let c = 0; c < COLS; c++) for (let r = ROWS - 1; r >= 0; r--) if (this.grid[r][c]) { h[c] = r + 1; break; }
    return h;
  }

  /**
   * Where to steer: at (or a column or two beside) the player, but never onto a column that
   * already sticks up well above the rest (so the stack grows into something climbable).
   */
  private aimFor(cells: Shape) {
    const w = this.width(cells);
    const h = this.heights();
    const mean = h.reduce((a, b) => a + b, 0) / COLS;
    let want = this.playerCells().col + this.aimOffset - Math.floor(w / 2);
    for (let tries = 0; tries < COLS; tries++) {
      const col = Math.max(0, Math.min(COLS - w, want));
      const top = Math.max(...h.slice(col, col + w));
      if (top <= mean + 3) return col;
      want = Math.floor(Math.random() * (COLS - w + 1));
    }
    return Math.max(0, Math.min(COLS - w, want));
  }

  private aimOffset = 0;
  private steps = 0;
  private flashUntil = 0;

  update(dt: number) {
    const { player, hud, camera } = this.ctx;
    const death = this.death;
    if (death && this.status === 'playing') {
      death.t += dt;
      if (death.t > DEATH_SCREEN_DELAY) {
        this.status = 'lost';
        hud.show(death.big, `${death.small}\nPress R to try again.`);
        hud.tips([
          ['Hint', 'The blocks aim for you: step aside, then climb what lands. Stand where you want the tower to grow. The shadow shows where a block will land.'],
          ['Controls', 'A / D move along the well · Space jump · W / S step in or out'],
        ]);
      }
    }
    this.arrival.update(dt);
    this.exit.update(dt, player);
    if (this.exit.entered && this.status === 'playing') this.status = 'exited';
    this.time += dt;
    if (!this.arrival.done) return;
    this.started = true;
    // Side-on, like the real thing: the camera stands back from the well (see cameraShot), and
    // A / D always move along it.
    camera.yaw = -Math.PI / 2;
    camera.pitch = 0;
    if (this.flash.text && this.time > this.flashUntil) this.flash.text = '';

    if (this.clearing) {
      this.clearing.t += dt;
      if (this.clearing.t > 0.35) this.finishClear();
      return;
    }
    if (!this.piece) {
      this.spawn();
      this.stepT = 0;
    }
    const piece = this.piece!;
    const interval = STEP_START + (STEP_FASTEST - STEP_START) * Math.min(1, this.time / STEP_RAMP);
    this.stepT += dt;
    if (this.stepT >= interval) {
      this.stepT = 0;
      // Steer toward the player (a column every other row) while there's height to do it, then
      // commit: the landing shadow stops moving a few rows up, so there's time to step aside.
      const alive = player.mode === 'control' && !this.death;
      const land = this.landingRow(piece.cells, piece.col);
      if (alive && piece.row - land > COMMIT_ROWS) piece.target = this.aimFor(piece.cells);
      else piece.target = piece.col;
      this.steps++;
      const dc = this.steps % 2 ? 0 : Math.sign(piece.target - piece.col);
      if (dc && this.fits(piece.cells, piece.col + dc, piece.row) && !this.overlapsPlayer(piece.cells, piece.col + dc, piece.row)) piece.col += dc;
      // Then down a row, or land.
      if (this.fits(piece.cells, piece.col, piece.row - 1)) {
        if (this.overlapsPlayer(piece.cells, piece.col, piece.row - 1)) {
          this.crush();
          piece.row -= 1;
        } else {
          piece.row -= 1;
        }
      } else {
        this.lock(piece);
      }
    }
    this.placePieceColliders();
  }

  private landingRow(cells: Shape, col: number) {
    let row = this.piece ? this.piece.row : WELL_TOP;
    while (this.fits(cells, col, row - 1)) row--;
    return row;
  }

  private placePieceColliders() {
    const p = this.piece;
    for (let k = 0; k < 4; k++) {
      const c = this.pieceColliders[k];
      if (!p) {
        c.setTranslation({ x: 0, y: -50, z: 0 });
        continue;
      }
      const [dc, dr] = p.cells[k];
      const pos = this.cellCentre(p.col + dc, p.row + dr);
      c.setTranslation({ x: pos[0], y: pos[1], z: pos[2] });
    }
  }

  private lock(p: Piece) {
    const { physics } = this.ctx;
    for (const [c, r] of p.cells) {
      const cc = p.col + c, rr = p.row + r;
      if (rr >= ROWS) continue;
      this.grid[rr][cc] = p.kind + 1;
      const pos = this.cellCentre(cc, rr);
      this.colliders[rr][cc] = physics.addStaticBox(pos, [CELL, CELL, CELL]);
    }
    this.piece = null;
    this.placePieceColliders();
    const full: number[] = [];
    for (let r = 0; r < ROWS; r++) if (this.grid[r].every((v) => v)) full.push(r);
    if (full.length) this.clearing = { rows: full, t: 0 };
    // Stacked up past the top of the well: the classic game over.
    else if (this.grid[WELL_TOP].some((v) => v)) this.crush('TOPPED OUT', 'The well is full. You were supposed to be on top of it, not in it.');
  }

  /** Full rows vanish and everything above drops (the player falls with it, naturally). */
  private finishClear() {
    const { physics } = this.ctx;
    const rows = this.clearing!.rows;
    this.clearing = null;
    for (const r of rows) for (let c = 0; c < COLS; c++) {
      const col = this.colliders[r][c];
      if (col) physics.world.removeCollider(col, true);
    }
    const keepGrid = this.grid.filter((_, r) => !rows.includes(r));
    const keepCols = this.colliders.filter((_, r) => !rows.includes(r));
    while (keepGrid.length < ROWS) {
      keepGrid.push(new Array(COLS).fill(0));
      keepCols.push(new Array(COLS).fill(null));
    }
    this.grid = keepGrid;
    this.colliders = keepCols;
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      const col = this.colliders[r][c];
      if (col) {
        const pos = this.cellCentre(c, r);
        col.setTranslation({ x: pos[0], y: pos[1], z: pos[2] });
      }
    }
    // Anything that dropped onto the player lands on them.
    const pc = this.playerCells();
    const { player } = this.ctx;
    if (player.mode === 'control' && player.pos[0] > X_FRONT - 0.3) {
      for (let r = pc.r0; r <= pc.r1 && r < ROWS; r++) for (const c of pc.cols) if (c >= 0 && c < COLS && this.grid[r]?.[c]) this.crush();
    }
    this.lines += rows.length;
    this.linesLabel.text = `LINES ${this.lines}`;
    this.flash.text = rows.length >= 4 ? 'TETRIS!' : rows.length > 1 ? `${rows.length} LINES!` : 'LINE!';
    this.flashUntil = this.time + 1.2;
  }

  private crush(big = 'GAME OVER', small?: string) {
    const { player, camera } = this.ctx;
    if (this.death) return;
    player.kill([0, -2, (Math.random() - 0.5) * 2], { violence: 6 });
    camera.addShake(0.8);
    this.death = {
      t: 0,
      big,
      small: small ?? pick([
        'You were the missing piece.',
        'It fit perfectly. That was the problem.',
        'Somewhere, a Russian folk song plays in a minor key.',
        `Lines cleared: ${this.lines}. Test subjects cleared: 1.`,
      ]),
    };
  }

  // --- Drawing ------------------------------------------------------------------------------------

  draw(out: DrawItem[]) {
    this.arrival.draw(out);
    this.exit.draw(out);
    const clearing = this.clearing;
    const flashOn = clearing && Math.floor(clearing.t * 16) % 2 === 0;
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      const v = this.grid[r][c];
      if (!v) continue;
      const white = clearing && clearing.rows.includes(r) && flashOn;
      this.block(out, this.cellCentre(c, r), white ? [2.5, 2.5, 2.5] : PIECES[v - 1].color, !!white);
    }
    const p = this.piece;
    if (p) {
      // The falling piece, and its ghost where it will land.
      for (const [dc, dr] of p.cells) this.block(out, this.cellCentre(p.col + dc, p.row + dr), PIECES[p.kind].color, false);
      const land = this.landingRow(p.cells, p.col);
      if (land < p.row) {
        for (const [dc, dr] of p.cells) {
          const c = this.cellCentre(p.col + dc, land + dr);
          out.push({ mesh: 'box', model: mul(translation(c), scaling([CELL * 0.96, CELL * 0.96, CELL * 0.96])), color: PIECES[p.kind].color, opacity: 0.22, shadow: false });
        }
      }
    }
    // The next piece, in a little window by the well.
    const nx = PIECES[this.next];
    for (const [c, r] of nx.cells) {
      out.push({ mesh: 'bevelbox', model: mul(translation([X_BACK - 0.35, 8.6 + r * 0.45, Z0 - 2.9 + c * 0.45]), scaling([0.3, 0.42, 0.42])), color: nx.color, spec: 0.5 });
    }
    // The well's frame: posts either side and a glass front you can just about see.
    const midX = (X_FRONT + X_BACK) / 2;
    for (const side of [-1, 1]) {
      out.push({ mesh: 'box', model: mul(translation([midX, 6, side * (COLS / 2 + 0.25)]), scaling([CELL + 0.2, 12, 0.5])), color: [0.18, 0.19, 0.24], spec: 0.4 });
    }
    out.push({ mesh: 'box', model: mul(translation([X_FRONT - 0.05, 6, 0]), scaling([0.04, 12, COLS * CELL])), color: [0.7, 0.85, 1], opacity: 0.08, spec: 1, shadow: false });
    for (let r = 1; r < WELL_TOP; r++) {
      out.push({ mesh: 'box', model: mul(translation(add([X_BACK - 0.01, r * CELL, 0], [0, 0, 0])), scaling([0.01, 0.02, COLS * CELL])), color: [0.75, 0.76, 0.8], shadow: false });
    }
  }

  private block(out: DrawItem[], c: Vec3, color: number[], glow: boolean) {
    out.push({ mesh: 'bevelbox', model: mul(translation(c), scaling([CELL * 0.98, CELL * 0.98, CELL * 0.98])), color, spec: 0.55, pattern: glow ? Pattern.emissive : Pattern.plain });
  }

  labels(): WorldLabel[] {
    return this.labelList;
  }

  trackedTargets(): TrackedTarget[] {
    const exit = this.exit.target();
    return exit ? [exit] : [];
  }

  environment() {
    return DEFAULT_ENV;
  }

  obstacles() {
    return [];
  }

  cameraShot(): CameraShot | null {
    const arrival = this.arrival.cameraShot();
    if (arrival || !this.started) return arrival;
    // Far enough back to see the whole well, drifting a little with the player.
    const p = this.ctx.player.pos;
    const y = Math.max(0, Math.min(8, p[1]));
    return {
      pos: [X_FRONT - 10.5, 5.2 + y * 0.35, Math.max(-2.5, Math.min(2.5, p[2] * 0.4))],
      target: [X_BACK, 4.6 + y * 0.35, Math.max(-1.5, Math.min(1.5, p[2] * 0.25))],
      sharpness: 3,
    };
  }
}
