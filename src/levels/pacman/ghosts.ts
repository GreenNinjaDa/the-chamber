import { approachAngle, clamp, type Vec3 } from '../../engine/math';
import type { DrawItem } from '../../engine/renderer';
import { drawGhost, GHOST_COLORS, GHOST_HEIGHT, GHOST_RADIUS, type GhostLook } from '../../entities/ghost';
import { CELL, cellX, cellZ, COLS, EXIT_CELL, HOUSE_INSIDE, ROWS, toCellX, toCellZ, walkable } from './maze';

/*
 * The four ghosts and their arcade brains. They roam the grid cell by cell and, at every cell,
 * take whichever turn (never straight back) brings them closest to their target:
 *   Blinky (red)    the player's cell
 *   Pinky (pink)    four cells ahead of the player
 *   Inky (cyan)     the cell two ahead of the player, mirrored through Blinky: a pincer
 *   Clyde (orange)  the player, until he gets close; then he loses his nerve and heads for his corner
 * Scatter phases send each one to its own corner for a few seconds. Scared ghosts run away (mostly).
 */

export type GhostName = keyof typeof GHOST_COLORS;
type State = 'house' | 'leaving' | 'maze' | 'eyes' | 'entering' | 'reviving';

// --- Tunables --------------------------------------------------------------------------------
/** m/s. Walking is 5 and sprinting 8.5. */
export const GHOST_SPEED = 4.0;
const SCARED_SPEED = 2.4;
/** How often a scared ghost takes the turn away from the player (otherwise any turn). */
const SCARED_FLEE = 0.75;
const EYES_SPEED = 10;
const HOUSE_SPEED = 2.4;
/** Blinky speeds up ("Cruise Elroy") when this few pellets are left, and again at the second count. */
const ELROY_PELLETS = [20, 8];
const ELROY_SPEED = [4.4, 4.8];
/** Scatter / chase phases (s), alternating, starting with scatter; the last one lasts forever. */
const SCHEDULE = [7, 18, 7, 18, 6, Infinity];
/** Seconds after the start that each ghost leaves the house. */
const RELEASE: Record<GhostName, number> = { blinky: 0, pinky: 2.5, inky: 6, clyde: 10 };
/** Clyde gives up the chase this close to the player (cells). */
const CLYDE_SHY = 5;
/** Last seconds of a scare, when scared ghosts flash white. */
const FLASH_TIME = 2;
const REVIVE_TIME = 1.2;
/** Ghosts are lit brighter than the moonlit room, so they stand out like the arcade sprites. */
const GHOST_BRIGHT = 5.5;

/** Up (north), left, down, right: the arcade's tie-break order. */
const DIRS: [number, number][] = [[0, -1], [-1, 0], [0, 1], [1, 0]];

const houseX = (HOUSE_INSIDE.x0 + HOUSE_INSIDE.x1) / 2;
const houseZ = (HOUSE_INSIDE.z0 + HOUSE_INSIDE.z1) / 2;
const exitX = cellX(EXIT_CELL.i), exitZ = cellZ(EXIT_CELL.j);

export class Ghost {
  state: State = 'house';
  /** Grid movement: heading from cell (ci, cj) along (di, dj), `prog` metres along. */
  ci = 0;
  cj = 0;
  di = -1;
  dj = 0;
  prog = 0;
  /** Feet position (without the hover). */
  pos: Vec3;
  yaw = Math.PI;
  look: Vec3 = [0, 0, 1];
  scared = false;
  private reviveT = 0;
  constructor(
    readonly name: GhostName,
    readonly home: Vec3,
    readonly corner: [number, number],
    readonly phase: number,
  ) {
    this.pos = [...home];
  }

  get color() {
    return GHOST_COLORS[this.name];
  }

  /** Dangerous or edible (not just a pair of eyes). */
  get solid() {
    return this.state === 'house' || this.state === 'leaving' || this.state === 'maze';
  }

  /** Where it is in (continuous) cell coordinates. */
  get cellPos(): [number, number] {
    return [toCellX(this.pos[0]), toCellZ(this.pos[2])];
  }

  /** Turns round on the spot (mode changes and scares do this). */
  reverse() {
    if (this.state !== 'maze') return;
    if (this.prog < 1e-4) {
      if (walkable(this.ci - this.di, this.cj - this.dj)) {
        this.di = -this.di;
        this.dj = -this.dj;
      }
      return;
    }
    this.ci += this.di;
    this.cj += this.dj;
    this.di = -this.di;
    this.dj = -this.dj;
    this.prog = CELL - this.prog;
  }

  /** Eaten: back to the house as a pair of eyes. */
  eaten() {
    this.scared = false;
    // Still on the way out of the house: just go back in.
    this.state = this.state === 'leaving' || this.state === 'house' ? 'entering' : 'eyes';
  }

  update(dt: number, crew: GhostCrew, time: number) {
    const moveDir = (dx: number, dz: number) => {
      this.look = [dx, 0, dz];
      this.yaw = approachAngle(this.yaw, Math.atan2(-dx, -dz), dt * 9);
    };
    switch (this.state) {
      case 'house': {
        // Bobbing up and down, waiting for their turn.
        this.pos = [this.home[0], this.home[1], this.home[2]];
        this.look = [0, Math.cos(time * 4 + this.phase), 0];
        this.yaw = approachAngle(this.yaw, Math.PI, dt * 6);
        if (crew.time >= RELEASE[this.name] && crew.running) this.state = 'leaving';
        break;
      }
      case 'leaving':
      case 'entering': {
        // Out: across to the door, then up through it. In: down through it to the middle.
        const leaving = this.state === 'leaving';
        let step = (leaving ? HOUSE_SPEED : EYES_SPEED * 0.5) * dt;
        const p = this.pos;
        if (leaving && Math.abs(p[0] - houseX) > 1e-3) {
          const d = Math.min(step, Math.abs(houseX - p[0])) * Math.sign(houseX - p[0]);
          p[0] += d;
          moveDir(Math.sign(d), 0);
          step -= Math.abs(d);
        }
        if (step > 0) {
          const goalZ = leaving ? exitZ : houseZ;
          const d = Math.min(step, Math.abs(goalZ - p[2])) * Math.sign(goalZ - p[2]);
          p[2] += d;
          if (d !== 0) moveDir(0, Math.sign(d));
          if (Math.abs(goalZ - p[2]) < 1e-4) {
            if (leaving) {
              this.state = 'maze';
              this.ci = EXIT_CELL.i;
              this.cj = EXIT_CELL.j;
              this.di = 0;
              this.dj = -1;
              this.prog = 0;
              this.choose(crew.targetFor(this), this.scared);
            } else {
              this.state = 'reviving';
              this.reviveT = 0;
            }
          }
        }
        break;
      }
      case 'reviving':
        this.reviveT += dt;
        this.look = [0, 0, 1];
        this.yaw = approachAngle(this.yaw, Math.PI, dt * 6);
        if (this.reviveT >= REVIVE_TIME) this.state = 'leaving';
        break;
      case 'maze':
      case 'eyes': {
        const speed = this.state === 'eyes' ? EYES_SPEED : this.scared ? SCARED_SPEED : crew.speedOf(this);
        let dist = speed * dt;
        while (dist > 0) {
          const left = CELL - this.prog;
          if (dist < left) {
            this.prog += dist;
            break;
          }
          dist -= left;
          this.ci += this.di;
          this.cj += this.dj;
          this.prog = 0;
          if (this.state === 'eyes' && this.ci === EXIT_CELL.i && this.cj === EXIT_CELL.j) {
            this.state = 'entering';
            break;
          }
          this.choose(crew.targetFor(this), this.scared);
        }
        this.pos = [cellX(this.ci) + this.di * this.prog, 0, cellZ(this.cj) + this.dj * this.prog];
        if (this.state === 'entering') this.pos = [exitX, 0, exitZ];
        moveDir(this.di, this.dj);
        break;
      }
    }
  }

  /**
   * At a cell centre: the turn (never back) that gets closest to the target. Scared ones (`flee`)
   * mostly take the turn that gets furthest from it (the player), and sometimes just any turn.
   */
  private choose(target: [number, number], flee: boolean) {
    const options: [number, number][] = [];
    for (const d of DIRS) {
      if (d[0] === -this.di && d[1] === -this.dj) continue;
      if (walkable(this.ci + d[0], this.cj + d[1])) options.push(d);
    }
    if (!options.length) {
      this.di = -this.di;
      this.dj = -this.dj;
      return;
    }
    let pick = options[0];
    if (flee && Math.random() > SCARED_FLEE) {
      pick = options[Math.floor(Math.random() * options.length)];
    } else {
      const sign = flee ? -1 : 1;
      let best = Infinity;
      for (const d of options) {
        const dx = this.ci + d[0] - target[0], dz = this.cj + d[1] - target[1];
        const score = sign * (dx * dx + dz * dz);
        if (score < best - 1e-6) {
          best = score;
          pick = d;
        }
      }
    }
    this.di = pick[0];
    this.dj = pick[1];
  }

  draw(out: DrawItem[], time: number, dy: number, crew: GhostCrew, camPos: Vec3) {
    const eyes = this.state === 'eyes' || this.state === 'entering' ||
      (this.state === 'reviving' && this.reviveT < REVIVE_TIME * 0.6 && Math.floor(this.reviveT * 10) % 2 === 0);
    let mode: GhostLook = 'normal';
    if (eyes) mode = 'eyes';
    else if (this.scared) mode = crew.frightLeft < FLASH_TIME && Math.floor(crew.frightLeft * 5) % 2 === 0 ? 'flash' : 'scared';
    let hover = this.state === 'house' ? 0.25 + 0.2 * Math.sin(time * 4 + this.phase) : 0.1 + 0.07 * Math.sin(time * 2.5 + this.phase);
    if (mode === 'eyes') hover += 0.45; // bare eyes fly high enough to be seen over the walls
    // See-through with the camera in (or right up against) it.
    const d = Math.hypot(camPos[0] - this.pos[0], camPos[2] - this.pos[2]);
    const opacity = camPos[1] < GHOST_HEIGHT + 0.3 ? clamp((d - GHOST_RADIUS + 0.1) / 0.7, 0.35, 1) : 1;
    drawGhost(out, {
      pos: [this.pos[0], dy + hover, this.pos[2]],
      yaw: this.yaw,
      look: this.look,
      color: this.color,
      bright: 1 + (GHOST_BRIGHT - 1) * crew.darkness,
      mode,
      time,
      phase: this.phase,
      opacity,
    });
  }
}

/** What the ghosts need to know about the player: where they are and which way they're heading. */
export interface Quarry {
  x: number;
  z: number;
  /** Grid direction of travel (one of the four). */
  hi: number;
  hj: number;
}

export class GhostCrew {
  readonly ghosts: Ghost[];
  /** Seconds since the ghosts were let loose. */
  time = 0;
  /** False until the round starts (and after it ends): nobody moves. */
  running = false;
  private phaseIndex = 0;
  private phaseT = 0;
  /** Seconds left on a power pellet. */
  frightLeft = 0;
  /** Ghosts eaten on the current power pellet (for 200, 400, 800, 1600). */
  eatChain = 0;
  pelletsLeft = Infinity;
  /** How dark the room is (0-1): the darker, the brighter the ghosts are drawn. */
  darkness = 1;
  private quarry: Quarry = { x: 0, z: 0, hi: 0, hj: -1 };

  constructor() {
    // Blinky waits by the door, the rest side by side behind him.
    const midZ = houseZ + 0.45;
    const front = HOUSE_INSIDE.z0 + 0.75;
    const spread = 1.42;
    this.ghosts = [
      new Ghost('blinky', [houseX, 0, front], [COLS + 1, -3], 0),
      new Ghost('pinky', [houseX, 0, midZ], [-2, -3], 1.7),
      new Ghost('inky', [houseX - spread, 0, midZ], [COLS + 1, ROWS + 2], 3.1),
      new Ghost('clyde', [houseX + spread, 0, midZ], [-2, ROWS + 2], 4.6),
    ];
  }

  get scatter() {
    return this.phaseIndex % 2 === 0;
  }

  get blinky() {
    return this.ghosts[0];
  }

  /** Power pellet: everyone out and about turns blue, and turns round. */
  frighten(seconds: number) {
    this.frightLeft = seconds;
    this.eatChain = 0;
    for (const g of this.ghosts) {
      if (!g.solid) continue;
      if (!g.scared) g.reverse();
      g.scared = true;
    }
  }

  speedOf(g: Ghost) {
    if (g.name !== 'blinky') return GHOST_SPEED;
    if (this.pelletsLeft <= ELROY_PELLETS[1]) return ELROY_SPEED[1];
    if (this.pelletsLeft <= ELROY_PELLETS[0]) return ELROY_SPEED[0];
    return GHOST_SPEED;
  }

  targetFor(g: Ghost): [number, number] {
    if (g.state === 'eyes') return [EXIT_CELL.i, EXIT_CELL.j];
    const q = this.quarry;
    const px = toCellX(q.x), pz = toCellZ(q.z);
    if (g.scared) return [px, pz]; // what it runs from
    const elroy = g.name === 'blinky' && this.pelletsLeft <= ELROY_PELLETS[0];
    if (this.scatter && !elroy) return g.corner;
    switch (g.name) {
      case 'blinky':
        return [px, pz];
      case 'pinky':
        return [px + q.hi * 4, pz + q.hj * 4];
      case 'inky': {
        const [bx, bz] = this.blinky.cellPos;
        const ax = px + q.hi * 2, az = pz + q.hj * 2;
        return [ax * 2 - bx, az * 2 - bz];
      }
      case 'clyde': {
        const [cx, cz] = g.cellPos;
        return Math.hypot(cx - px, cz - pz) > CLYDE_SHY ? [px, pz] : g.corner;
      }
    }
  }

  update(dt: number, quarry: Quarry, time: number) {
    this.quarry = quarry;
    if (!this.running) {
      for (const g of this.ghosts) if (g.state === 'house') g.update(dt, this, time);
      return;
    }
    this.time += dt;
    if (this.frightLeft > 0) {
      this.frightLeft = Math.max(0, this.frightLeft - dt);
      if (this.frightLeft === 0) for (const g of this.ghosts) g.scared = false;
    } else {
      // The scatter / chase clock only runs while nobody is scared.
      this.phaseT += dt;
      if (this.phaseT >= SCHEDULE[this.phaseIndex]) {
        this.phaseT = 0;
        this.phaseIndex = Math.min(this.phaseIndex + 1, SCHEDULE.length - 1);
        for (const g of this.ghosts) g.reverse();
      }
    }
    for (const g of this.ghosts) g.update(dt, this, time);
  }

  draw(out: DrawItem[], time: number, dy: number, camPos: Vec3) {
    for (const g of this.ghosts) g.draw(out, time, dy, this, camPos);
  }
}
