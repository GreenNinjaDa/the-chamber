import { tone } from '../../engine/audio';
import type { Vec3 } from '../../engine/math';
import { Pattern, type DrawItem } from '../../engine/renderer';
import { APPLE_RADIUS, spawnApple, type Apple } from '../../entities/apple';
import { PixelText } from '../../entities/pixelText';
import { ExitPortal, PortalArrival } from '../../entities/portal';
import { cellAt, cellCentre, Snake, SNAKE_BLOCK, SNAKE_GRID, SNAKE_HEIGHT } from '../../entities/snake';
import { CHAMBER_HALF } from '../../game/chamber';
import { PLAYER_RADIUS, type Circle } from '../../game/player';
import { DEFAULT_ENV, type CameraShot, type Level, type LevelContext, type LevelStatus, type TrackedTarget, type WorldLabel } from '../level';

/*
 * Snake. Once you're in, the floor boots up as an old monochrome phone screen, a panel in the
 * north wall slides open and the snake from the phone game comes out after you: life-size pixel
 * blocks, one cell per step, growing all the time and speeding up. You are the apple. It's greedy
 * and never turns back, so the way to beat it is to lure it into tying itself in a knot; when it
 * has nowhere left to go it crashes, blinks, pops away, and the exit opens.
 */

// --- Tunables -------------------------------------------------------------------------------------

/** Blocks the snake starts with, and one more every this many steps. */
const START_LENGTH = 5;
const GROW_EVERY = 7;
/** Seconds per step: from this at the start down to STEP_MIN over RAMP_TIME seconds. */
const STEP_START = 0.32;
const STEP_MIN = 0.2;
const RAMP_TIME = 80;
/** It aims where the player will be this far ahead (s). */
const LEAD = 0.25;
/**
 * How often it looks ahead for dead ends: usually, but hardly ever with the player within this
 * many cells (Manhattan), so luring it in close is how to make it blunder into its own coils.
 */
const GREEDY_RANGE = 4;
const FORESIGHT_FAR = 0.7;
const FORESIGHT_NEAR = 0.1;
/** For this long after it comes out it always looks ahead (no early accidents). */
const CAREFUL_FOR = 20;
/** A bite: the player is within this of the front of the head (m), or this close to its sides (overlapping). */
const BITE_REACH = PLAYER_RADIUS + 0.05;
const SIDE_REACH = PLAYER_RADIUS - 0.05;
/** Blocks gained from a player. */
const PLAYER_MEAL = 3;
/** Seconds to swallow the player whole, and the pause for a gulp before it moves on. */
const SWALLOW_TIME = 0.35;
const GULP_PAUSE = 0.6;
const DEATH_SCREEN_DELAY = 1.6;
/** The apple: blocks it's worth, the gulp, how long until the next one, and its pop-in time. */
const APPLE_MEAL = 3;
const APPLE_GULP = 0.3;
const APPLE_RESPAWN = 3;
const APPLE_POP_TIME = 0.35;
/** `?noApple` leaves the apple out (to test the snake on its own). */
const NO_APPLE = new URLSearchParams(location.search).has('noApple');

// --- Timeline (seconds after the arrival is done) -------------------------------------------------

const ROW_GAP = 0.05;
const ROW_FLASH = 0.14;
const LOGO_AT = 0.9;
const DOOR_AT = 1.6;
const GO_AT = 2.3;
const APPLE_AT = 1.2;
/** How long the head stays marked on screen after it comes out. */
const MARK_HEAD_FOR = 4;

// --- Looks ----------------------------------------------------------------------------------------

const LCD = [0.19, 0.235, 0.085];
const LCD_FLASH = [0.9, 1.15, 0.45];
const LCD_TOP = 0.012;
const PIXEL_DARK = [0.03, 0.038, 0.014];
const WALL = [0.86, 0.87, 0.88];
const HOLE = [0.015, 0.018, 0.012];
/** The snake comes in through a door in the north wall above this column. */
const DOOR_I = 7;
const DOOR_W = 1.5;
const DOOR_H = 2.05;
const DOOR_SLIDE = 0.5;
const NORTH = -CHAMBER_HALF;
const WALL_TEXT_Z = -CHAMBER_HALF + 0.05;

const EATEN_QUIPS = [
  'You were the apple all along.',
  'Part of a balanced breakfast.',
  'The snake would like to thank you for your contribution.',
  'Nutritious. Delicious. Deceased.',
  'There was a perfectly good apple right there.',
];

const WIN_QUIPS = [
  'NEW HIGH SCORE: YOU',
  'Snake? Snake?! SNAAAAAKE!',
  'It tied itself in a knot. Relatable.',
  'Please do not tell the other snakes.',
];

const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
const pad = (n: number) => String(n).padStart(4, '0');
const NO_OBSTACLES: Circle[] = [];

export class SnakeLevel implements Level {
  readonly number: number;
  readonly title = 'Snake';
  status: LevelStatus = 'playing';
  private arrival: PortalArrival;
  private exit = new ExitPortal(0);
  private snake: Snake;
  /** Seconds since the arrival finished (-1 until then). */
  private t = -1;
  /** Seconds the snake has been out hunting. */
  private huntT = 0;
  private door = 0;
  private doorOpen = false;
  /** Seconds since the player was eaten (-1: not yet). */
  private eatenT = -1;
  /** The length the score on the wall shows. */
  private shownLength = -1;
  /** The snake died: seconds since it finished popping away (-1: not yet). */
  private overT = -1;
  private wanderI = 8;
  private wanderJ = 8;
  private wanderT = 0;
  private apple: Apple | null = null;
  /** Seconds until the next apple appears. */
  private appleT = 0;
  /** Apples the snake has eaten (for play-testing). */
  private applesEaten = 0;

  private plate: DrawItem;
  private rows: DrawItem[] = [];
  private rowFlash: DrawItem[] = [];
  private doorHole: DrawItem;
  private doorPanel: DrawItem;
  private score: PixelText;
  private gameOver: PixelText;
  private logo: WorldLabel = { pos: [0, 8.3, WALL_TEXT_Z], text: '', size: 1.5, color: '#2456d6' };
  private tagline: WorldLabel = { pos: [0, 7.25, WALL_TEXT_Z], text: '', size: 0.5, color: '#2456d6' };
  private quip: WorldLabel = { pos: [0, 2.8, WALL_TEXT_Z], text: '', size: 0.9, color: '#2456d6' };
  private labelList: WorldLabel[] = [this.logo, this.tagline, this.quip];
  private targets: TrackedTarget[] = [];
  private headTarget: TrackedTarget = { pos: [0, 0, 0], radius: 1.1 };

  constructor(private ctx: LevelContext) {
    this.number = ctx.number;
    const { hud, physics } = ctx;
    hud.setLevel(`The Chamber · Level ${this.number}`);
    hud.show(`LEVEL ${this.number}`, '', 2.5);
    hud.hint('');
    this.arrival = new PortalArrival(ctx, [0, 0, 6]);

    // The snake waits behind the north wall, head first, lined up with its door.
    this.snake = new Snake(physics, DOOR_I, -1, 2, START_LENGTH);
    this.snake.growEvery = GROW_EVERY;
    this.snake.interval = STEP_START;

    // The phone screen: a plate over the floor with a faint pixel grid, switched on row by row.
    const size = SNAKE_GRID * 1.5;
    this.plate = {
      mesh: 'box',
      model: box([0, LCD_TOP / 2, 0], [size, LCD_TOP, size]),
      color: LCD,
      pattern: Pattern.panels,
      param: 1.5,
      spec: 0.12,
    };
    for (let r = 0; r < SNAKE_GRID; r++) {
      const model = box([0, LCD_TOP / 2, cellCentre(r)], [size, LCD_TOP, 1.5]);
      this.rows.push({ mesh: 'box', model, color: LCD, pattern: Pattern.panels, param: 1.5, spec: 0.12 });
      this.rowFlash.push({ mesh: 'box', model, color: LCD_FLASH, pattern: Pattern.emissive, shadow: false });
    }

    const doorX = cellCentre(DOOR_I);
    this.doorHole = { mesh: 'box', model: box([doorX, DOOR_H / 2, NORTH + 0.011], [DOOR_W - 0.04, DOOR_H, 0.02]), color: HOLE, shadow: false };
    const panel = box([doorX, DOOR_H / 2, NORTH + 0.03], [DOOR_W + 0.05, DOOR_H + 0.05, 0.06]);
    this.doorPanel = { mesh: 'box', model: panel, color: WALL, pattern: Pattern.panels, param: 2, spec: 0.15 };

    this.score = new PixelText({ centre: [-8.6, 8.9, NORTH], right: [1, 0, 0], up: [0, 1, 0], pixel: 0.15, color: PIXEL_DARK });
    this.score.reveal = 0;
    this.gameOver = new PixelText({ centre: [0, 4.6, NORTH], right: [1, 0, 0], up: [0, 1, 0], pixel: 0.32, color: PIXEL_DARK, depth: 0.08 }, 'GAME OVER');
    this.gameOver.reveal = 0;
  }

  /** The head reached the player: swallowed whole. */
  private eatPlayer() {
    const { player, camera } = this.ctx;
    const s = this.snake;
    const hx = s.headX(), hz = s.headZ();
    const mouth: Vec3 = [hx + s.forwardX * (SNAKE_BLOCK / 2 + 0.1), 0.6, hz + s.forwardZ * (SNAKE_BLOCK / 2 + 0.1)];
    s.eat(PLAYER_MEAL);
    s.pauseFor = GULP_PAUSE;
    player.mode = 'held';
    player.facing = Math.atan2(player.pos[0] - hx, player.pos[2] - hz);
    player.shrinkInto(mouth, SWALLOW_TIME);
    camera.addShake(0.45);
    this.ctx.hud.hide();
    this.eatenT = 0;
  }

  update(dt: number) {
    const { player, hud } = this.ctx;
    if (this.eatenT >= 0) {
      this.eatenT += dt;
      if (this.eatenT >= SWALLOW_TIME && player.mode === 'held') player.hide();
      if (this.eatenT > DEATH_SCREEN_DELAY && this.status === 'playing') {
        this.status = 'lost';
        const score = this.snake.length + this.snake.pendingGrowth;
        hud.show('GAME OVER', `${pick(EATEN_QUIPS)}\nSCORE: ${pad(score)}\nPress R to try again.`);
        hud.tips([
          ['Hint', 'The snake is greedy and never turns back. Circle it and let it tie itself in a knot. It goes for the apple when that is nearer than you.'],
          ['Controls', 'WASD move · Shift sprint · Hold click carry · Right-click throw'],
        ]);
      }
    }

    this.arrival.update(dt);
    if (this.t < 0 && this.arrival.done) this.t = 0;
    if (this.t >= 0) this.t += dt;
    const t = this.t;

    if (t >= LOGO_AT && !this.logo.text) {
      this.logo.text = 'NOKLA';
      this.tagline.text = 'Connecting people.';
    }
    if (t >= DOOR_AT && !this.doorOpen && this.snake.state === 'waiting') this.doorOpen = true;
    // Shut the door behind it once it's all the way in.
    if (this.doorOpen && this.snake.state !== 'waiting' && this.snake.cj[this.snake.length - 1] >= 0) this.doorOpen = false;
    this.door = Math.min(DOOR_SLIDE, Math.max(0, this.door + (this.doorOpen ? dt : -dt)));
    if (t >= GO_AT && this.snake.state === 'waiting') {
      this.snake.go();
      this.score.reveal = 1;
    }

    const s = this.snake;
    if (s.state === 'moving') {
      this.huntT += dt;
      s.interval = STEP_START - (STEP_START - STEP_MIN) * Math.min(1, this.huntT / RAMP_TIME);
      this.aim(dt);
    }
    this.updateApple(dt);
    const wasAlive = s.alive;
    s.update(dt);
    if (wasAlive && !s.alive) this.ctx.camera.addShake(0.35);
    if (s.length !== this.shownLength) {
      this.shownLength = s.length;
      this.score.setText(pad(s.length));
    }

    if (s.state === 'moving' && player.mode === 'control' && !player.inPortal && s.cj[0] >= 0 && this.bitten()) this.eatPlayer();

    // It crashed: once it has blinked and popped away, game over (for the snake).
    if (s.state === 'gone' && this.overT < 0) {
      this.overT = 0;
      if (this.eatenT < 0) {
        this.quip.text = pick(WIN_QUIPS);
        this.tagline.text = 'Disconnecting snakes.';
        this.exit.openNow();
      }
    }
    if (this.overT >= 0) {
      this.overT += dt;
      this.gameOver.reveal = Math.min(1, this.overT / 0.5);
    }

    this.exit.update(dt, player);
    if (this.exit.entered && this.status === 'playing') this.status = 'exited';
  }

  /**
   * The head got the player: it moved into their cell, they're right in front of its mouth, or it
   * has pushed into them from the side (merely standing next to it is fine).
   */
  private bitten() {
    const p = this.ctx.player.pos;
    const s = this.snake;
    if (cellAt(p[0]) === s.ci[0] && cellAt(p[2]) === s.cj[0]) return true;
    const rx = p[0] - s.headX(), rz = p[2] - s.headZ();
    const ahead = rx * s.forwardX + rz * s.forwardZ;
    const across = Math.abs(rx * -s.forwardZ + rz * s.forwardX);
    const half = SNAKE_BLOCK / 2;
    if (ahead > 0 && ahead < half + BITE_REACH && across < half + 0.1) return true;
    const dx = Math.max(0, Math.abs(rx) - half), dz = Math.max(0, Math.abs(rz) - half);
    return dx * dx + dz * dz < SIDE_REACH * SIDE_REACH;
  }

  /** The apple: pops into being, gets eaten, and comes back somewhere else. */
  private updateApple(dt: number) {
    const s = this.snake;
    if (!this.apple) {
      if (this.t < APPLE_AT || !s.alive || NO_APPLE) return;
      this.appleT -= dt;
      if (this.appleT <= 0) this.apple = spawnApple(this.ctx.physics, this.appleSpot());
      return;
    }
    const apple = this.apple;
    apple.pop = Math.min(1, apple.pop + dt / APPLE_POP_TIME);
    // Thrown out of the chamber (or through the floor): gone, and a new one grows back.
    const at = apple.body.rb.translation();
    if (Math.abs(at.x) > CHAMBER_HALF || Math.abs(at.z) > CHAMBER_HALF || at.y < -2) {
      this.ctx.physics.remove(apple.body);
      this.apple = null;
      this.appleT = APPLE_RESPAWN;
      return;
    }
    if (s.state !== 'moving' || s.cj[0] < 0) return;
    // Eaten if the head's box reaches it.
    const p = apple.body.rb.translation();
    const reach = SNAKE_BLOCK / 2 + APPLE_RADIUS;
    if (Math.abs(p.x - s.headX()) < reach && Math.abs(p.z - s.headZ()) < reach && p.y < SNAKE_HEIGHT + APPLE_RADIUS * 2) {
      this.ctx.physics.remove(apple.body);
      this.apple = null;
      this.appleT = APPLE_RESPAWN;
      s.eat(APPLE_MEAL);
      s.pauseFor = APPLE_GULP;
      tone(520, 0.08, { wave: 'square', vol: 0.12 });
      tone(780, 0.12, { wave: 'square', vol: 0.12, at: 0.08 });
      this.applesEaten++;
    }
  }

  /** A free cell for a new apple: not against the walls, clear of the snake and the player. */
  private appleSpot(): Vec3 {
    const s = this.snake, p = this.ctx.player.pos;
    let bi = 8, bj = 8, best = -Infinity;
    for (let tries = 0; tries < 40; tries++) {
      const i = 1 + Math.floor(Math.random() * (SNAKE_GRID - 2));
      const j = 2 + Math.floor(Math.random() * (SNAKE_GRID - 3));
      if (s.occupied(i, j)) continue;
      const fromHead = Math.abs(i - s.ci[0]) + Math.abs(j - Math.max(0, s.cj[0]));
      const fromPlayer = Math.hypot(cellCentre(i) - p[0], cellCentre(j) - p[2]);
      const score = Math.min(fromHead, 8) + Math.min(fromPlayer, 6) + Math.random();
      if (score > best) {
        best = score;
        bi = i;
        bj = j;
      }
    }
    return [cellCentre(bi), APPLE_RADIUS + 0.03, cellCentre(bj)];
  }

  /** Points the snake at the player (a little ahead of them) or the apple, whichever is nearer, or anywhere once they're gone. */
  private aim(dt: number) {
    const { player } = this.ctx;
    const s = this.snake;
    const hi = s.ci[0], hj = Math.max(0, s.cj[0]);
    const alive = player.mode === 'control' && !player.inPortal;
    let far = Infinity;
    if (alive) {
      const x = player.pos[0] + player.vel[0] * LEAD, z = player.pos[2] + player.vel[2] * LEAD;
      s.targetI = cellAt(x);
      s.targetJ = cellAt(z);
      s.lookX = player.pos[0];
      s.lookZ = player.pos[2];
      far = Math.abs(s.targetI - hi) + Math.abs(s.targetJ - hj);
    }
    if (this.apple && this.apple.pop >= 1) {
      const p = this.apple.body.rb.translation();
      const ai = cellAt(p.x), aj = cellAt(p.z);
      const d = Math.abs(ai - hi) + Math.abs(aj - hj);
      if (d < far) {
        s.targetI = ai;
        s.targetJ = aj;
        s.lookX = p.x;
        s.lookZ = p.z;
        far = d;
      }
    }
    if (far < Infinity) {
      // Tunnel vision: with its dinner close, it stops looking where it's going.
      // (Except at first: it starts out on its best behaviour.)
      s.brain.foresight = this.huntT < CAREFUL_FOR ? 1 : far <= GREEDY_RANGE ? FORESIGHT_NEAR : FORESIGHT_FAR;
      s.brain.blunder = this.huntT < CAREFUL_FOR ? 0 : 0.1;
      return;
    }
    // Nobody left to chase: wander about, content.
    this.wanderT -= dt;
    if (this.wanderT <= 0 || (s.ci[0] === this.wanderI && s.cj[0] === this.wanderJ)) {
      this.wanderI = Math.floor(Math.random() * SNAKE_GRID);
      this.wanderJ = Math.floor(Math.random() * SNAKE_GRID);
      this.wanderT = 4;
    }
    s.targetI = this.wanderI;
    s.targetJ = this.wanderJ;
    s.lookX = cellCentre(this.wanderI);
    s.lookZ = cellCentre(this.wanderJ);
  }

  draw(out: DrawItem[]) {
    this.arrival.draw(out);
    this.exit.draw(out);
    // The screen boots up row by row, each row flashing as it comes on.
    const t = this.t;
    if (t >= SNAKE_GRID * ROW_GAP + ROW_FLASH) out.push(this.plate);
    else if (t >= 0) {
      for (let r = 0; r < SNAKE_GRID; r++) {
        const on = t - r * ROW_GAP;
        if (on < 0) continue;
        out.push(on < ROW_FLASH ? this.rowFlash[r] : this.rows[r]);
      }
    }
    if (this.door > 0) {
      out.push(this.doorHole);
      // The panel slides aside (east) to let it in.
      const k = this.door / DOOR_SLIDE;
      const slide = k * k * (3 - 2 * k);
      this.doorPanel.model[12] = cellCentre(DOOR_I) + slide * (DOOR_W + 0.1);
      out.push(this.doorPanel);
    }
    this.snake.draw(out);
    this.score.draw(out);
    this.gameOver.draw(out);
  }

  labels(): WorldLabel[] {
    return this.labelList;
  }

  trackedTargets(): TrackedTarget[] {
    this.targets.length = 0;
    const s = this.snake;
    if (s.state === 'moving' && this.huntT < MARK_HEAD_FOR && s.cj[0] >= 0) {
      const p = this.headTarget.pos;
      p[0] = s.headX();
      p[1] = 0.9;
      p[2] = s.headZ();
      this.targets.push(this.headTarget);
    }
    const exit = this.exit.target();
    if (exit) this.targets.push(exit);
    return this.targets;
  }

  environment() {
    return DEFAULT_ENV;
  }

  obstacles() {
    return NO_OBSTACLES;
  }

  cameraShot(): CameraShot | null {
    return this.arrival.cameraShot();
  }
}

/** Translation + scale matrix for the unit box. */
function box(centre: Vec3, size: Vec3): Float32Array {
  return new Float32Array([size[0], 0, 0, 0, 0, size[1], 0, 0, 0, 0, size[2], 0, centre[0], centre[1], centre[2], 1]);
}
