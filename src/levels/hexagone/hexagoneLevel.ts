import { add, clamp, mul, scale, scaling, sub, translation, type Vec3 } from '../../engine/math';
import { Pattern, type DrawItem, type Environment } from '../../engine/renderer';
import { CHAMBER_HALF } from '../../game/chamber';
import { Contestant, type ContestantLook } from '../../entities/contestant';
import { HexFloor, type HexTile } from '../../entities/hexFloor';
import { PixelText } from '../../entities/pixelText';
import { ExitPortal, PortalArrival } from '../../entities/portal';
import { DEFAULT_ENV, type CameraShot, type Level, type LevelContext, type LevelStatus, type TrackedTarget, type WorldLabel } from '../level';

/*
 * Hex-A-Gone (Fall Guys' disappearing floor). The chamber is a tall shaft with three floors of
 * candy-coloured hexagonal tiles stacked in it and glowing toxic goo at the bottom. Any tile
 * anyone stands on flashes and drops away half a second later, so standing still means falling
 * through. Six other test subjects are eating the floor too. Last one standing, or still
 * standing when the clock on the north wall runs out, wins: the floor you're on grows back and
 * the exit opens beside it.
 */

const H = CHAMBER_HALF;
/** Tile tops of the three floors, top to bottom. */
const TOPS = [13.5, 9, 4.5];
const TILE_R = 1.05;
const TILE_T = 0.4;
/** Seconds between a tile being stood on and dropping away. */
const ARM_TIME = 0.5;
const GOO_TOP = 1.2;
const WALL_H = 18;
const ROUND_TIME = 60;
const COUNTDOWN = 3;
const DEATH_SCREEN_DELAY = 1.8;
const SPAWN: Vec3 = [0, TOPS[0], 5];
/** The contestants' feet: they stand on whatever is within this of their centre (m). */
const FOOT = 0.18;
/** The player's capsule radius: they stand on tiles this close. */
const PLAYER_FOOT = 0.33;
const NPC_GRAVITY = 22;
const NPC_JUMP = 7.5;

const LAYER_COLORS = [
  [[0.9, 0.12, 0.42], [0.97, 0.26, 0.55], [0.8, 0.08, 0.36]], // bubblegum
  [[0.98, 0.66, 0.03], [0.94, 0.52, 0.03], [1.0, 0.78, 0.16]], // lemon sherbet
  [[0.06, 0.46, 0.95], [0.16, 0.6, 1.0], [0.04, 0.38, 0.84]], // blue raspberry
];
const WALL = [0.86, 0.87, 0.88];
const OUTSIDE = [0.42, 0.44, 0.42];
const LED = [2.6, 1.5, 0.35];
const LED_RED = [3.0, 0.35, 0.2];
const LED_GREEN = [0.5, 2.6, 0.4];
const GOO_GLOW = [0.5, 1.6, 0.25];

interface Persona {
  look: ContestantLook;
  /** Running and sprinting speed (m/s). */
  speed: number;
  sprint: number;
  /** Chance of spotting a gap in time and jumping it properly (0-1). */
  jump: number;
  /** Jump strength (1 = the player's). */
  power: number;
  /** Voluntary hops per second (saves tiles), when there's somewhere good to land. */
  hop: number;
  /** Panics per second: a blind sprint in a random direction. */
  panic: number;
  /** Chance of stopping to cheer when someone else goes out. */
  cheer: number;
  /** How erratic their choice of direction is. */
  noise: number;
}

const CAST: Persona[] = [
  // Old 001 shuffles. The floor does not wait for him.
  { look: { number: '001', hair: [0.86, 0.86, 0.83], old: true }, speed: 1.5, sprint: 1.5, jump: 0, power: 0.5, hop: 0, panic: 0, cheer: 0, noise: 0.3 },
  { look: { number: '067', hair: [0.1, 0.07, 0.05] }, speed: 5.0, sprint: 7.0, jump: 0.95, power: 1, hop: 0.6, panic: 0.02, cheer: 0, noise: 0.4 },
  { look: { number: '218', hair: [0.35, 0.2, 0.1] }, speed: 7.2, sprint: 8, jump: 0.55, power: 1, hop: 0.1, panic: 0.15, cheer: 0, noise: 0.9 },
  { look: { number: '324', hair: [0.8, 0.65, 0.3], girth: 1.3 }, speed: 4.0, sprint: 4.6, jump: 0.45, power: 0.75, hop: 0, panic: 0.06, cheer: 0.2, noise: 0.6 },
  { look: { number: '101', hair: [0.05, 0.05, 0.05] }, speed: 4.7, sprint: 6.2, jump: 0.8, power: 1, hop: 0.2, panic: 0.03, cheer: 0.85, noise: 0.5 },
  { look: { number: '456', hair: [0.12, 0.1, 0.08] }, speed: 4.9, sprint: 6.5, jump: 0.85, power: 1, hop: 0.35, panic: 0.04, cheer: 0.1, noise: 0.5 },
];

type Air = 'ground' | 'jump' | 'fall';

interface Runner {
  c: Contestant;
  p: Persona;
  label: WorldLabel;
  layer: number;
  y: number;
  vy: number;
  air: Air;
  /** The layer they fell off (so they don't land straight back on it). */
  fellFrom: number;
  heading: number;
  plan: number;
  goal: [number, number] | null;
  goalT: number;
  panicT: number;
  /** Standing still to cheer (seconds left). */
  idleT: number;
  /** Decided whether to jump the gap ahead (null: no gap ahead). */
  gapRoll: boolean | null;
  out: 'no' | 'sinking' | 'gone';
  outT: number;
  seed: number;
}

interface Splash {
  pos: Vec3;
  t: number;
  size: number;
}

type Phase = 'arrive' | 'ready' | 'round' | 'won';

interface Death {
  t: number;
  big: string;
  small: string;
}

const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
const rand = (a: number, b: number) => a + Math.random() * (b - a);

export class HexagoneLevel implements Level {
  readonly number = 15;
  readonly title = 'Hex-A-Gone';
  status: LevelStatus = 'playing';
  private arrival: PortalArrival;
  private exit: ExitPortal | null = null;
  private exitLayer = -1;
  private floors: HexFloor[];
  private runners: Runner[] = [];
  private phase: Phase = 'arrive';
  private phaseT = 0;
  private roundT = 0;
  private time = 0;
  private death: Death | null = null;
  private splashes: Splash[] = [];
  private bubbles: { pos: Vec3; age: number }[] = [];
  private outLabels: (WorldLabel & { ttl: number })[] = [];
  private labelList: WorldLabel[] = [];
  private board: PixelText;
  private countBoard: PixelText;
  private boardColor = [...LED];
  private countColor = [...LED];
  private shown = '';
  private statics: DrawItem[] = [];
  /** Dev: why each contestant fell. */
  private fallLog: string[] = [];
  private env: Environment = {
    ...DEFAULT_ENV,
    pointLight: { pos: [0, GOO_TOP + 1.2, 0], color: [0.5, 2.2, 0.35], range: 17 },
  };

  readonly chamber = { none: true };

  constructor(private ctx: LevelContext) {
    const { hud, physics } = ctx;
    hud.setLevel(`The Chamber · Level ${this.number}`);
    hud.show(`LEVEL ${this.number}`, '', 2.5);
    hud.hint('');
    this.arrival = new PortalArrival(ctx, SPAWN, { minElevationDeg: 55 });

    // The shaft: goo floor, tall walls and the ground outside.
    const boxes: [Vec3, Vec3, number[], number][] = [
      [[0, -0.6, 0], [900, 1, 900], OUTSIDE, 8],
      [[0, -0.25, 0], [H * 2, 0.5, H * 2], WALL, 2],
      [[0, WALL_H / 2 - 0.1, H + 0.5], [H * 2 + 2, WALL_H + 0.2, 1], WALL, 2],
      [[0, WALL_H / 2 - 0.1, -H - 0.5], [H * 2 + 2, WALL_H + 0.2, 1], WALL, 2],
      [[H + 0.5, WALL_H / 2 - 0.1, 0], [1, WALL_H + 0.2, H * 2], WALL, 2],
      [[-H - 0.5, WALL_H / 2 - 0.1, 0], [1, WALL_H + 0.2, H * 2], WALL, 2],
    ];
    for (const [pos, size, color, panel] of boxes) {
      physics.addStaticBox(pos, size);
      this.statics.push({ mesh: 'box', model: mul(translation(pos), scaling(size)), color, pattern: Pattern.panels, param: panel, spec: 0.15 });
    }
    this.statics.push({ mesh: 'box', model: mul(translation([0, GOO_TOP / 2, 0]), scaling([H * 2, GOO_TOP, H * 2])), color: [0, 0, 0], pattern: Pattern.lava, param: 1, shadow: false });
    // A dark backing for the scoreboards on the north wall.
    this.statics.push({ mesh: 'box', model: mul(translation([-4.6, 15.9, -H + 0.04]), scaling([9.6, 3.4, 0.08])), color: [0.04, 0.04, 0.05], spec: 0.5 });
    this.statics.push({ mesh: 'box', model: mul(translation([5.4, 15.9, -H + 0.04]), scaling([8.6, 3.4, 0.08])), color: [0.04, 0.04, 0.05], spec: 0.5 });

    this.floors = TOPS.map((top, i) => new HexFloor(physics, { top, radius: TILE_R, thickness: TILE_T, half: H, colors: LAYER_COLORS[i], armTime: ARM_TIME }));
    for (const f of this.floors) f.canRegrow = (tile) => this.clearOf(f, tile);

    this.board = new PixelText({ centre: [-4.6, 15.9, -H + 0.08], right: [1, 0, 0], up: [0, 1, 0], pixel: 0.34, color: this.boardColor, depth: 0.06 }, '1:00');
    this.countBoard = new PixelText({ centre: [5.4, 15.9, -H + 0.08], right: [1, 0, 0], up: [0, 1, 0], pixel: 0.2, color: this.countColor, depth: 0.06 }, '7 LEFT');

    // The others spread out over the top floor, away from you and each other.
    const spots: [number, number][] = [[SPAWN[0], SPAWN[2]]];
    for (const p of CAST) {
      let x = 0, z = 0;
      for (let tries = 0; tries < 80; tries++) {
        x = rand(-9, 9);
        z = rand(-9, 9);
        if (spots.every(([sx, sz]) => Math.hypot(sx - x, sz - z) > 4)) break;
      }
      spots.push([x, z]);
      const c = new Contestant(p.look, [x, TOPS[0], z], Math.atan2(x, z));
      const label: WorldLabel = { pos: [x, TOPS[0] + 2.15, z], text: p.look.number, size: 0.3, color: '#ffffff' };
      this.labelList.push(label);
      this.runners.push({
        c, p, label, layer: 0, y: TOPS[0], vy: 0, air: 'ground', fellFrom: -1, heading: Math.atan2(-z, -x), plan: 0, goal: null, goalT: 0,
        panicT: 0, idleT: 0, gapRoll: null, out: 'no', outT: 0, seed: Math.random() * 100,
      });
    }
  }

  // --- Update ---------------------------------------------------------------------------------------

  update(dt: number) {
    const { player, hud } = this.ctx;
    const death = this.death;
    if (death && this.status === 'playing') {
      death.t += dt;
      if (death.t > DEATH_SCREEN_DELAY) {
        this.status = 'lost';
        hud.show(death.big, `${death.small}\nPress R to try again.`);
        hud.tips([
          ['Hint', "Keep moving, but don't waste tiles: every step you take is floor you won't have later. Jump gaps. The layers below are your second and third chances."],
          ['Controls', 'WASD move · Space jump · Shift sprint'],
        ]);
      }
    }
    this.time += dt;
    this.phaseT += dt;
    this.arrival.update(dt);
    if (this.exit) {
      this.exit.update(dt, player);
      if (this.exit.entered && this.status === 'playing') this.status = 'exited';
    }
    for (const f of this.floors) f.update(dt);

    switch (this.phase) {
      case 'arrive':
        if (this.arrival.done) this.setPhase('ready');
        break;
      case 'ready':
        if (this.phaseT >= COUNTDOWN) this.setPhase('round');
        break;
      case 'round':
        this.roundT += dt;
        this.checkWin();
        break;
      case 'won':
        this.keepExitReachable();
        break;
    }

    this.updatePlayer();
    for (const r of this.runners) this.updateRunner(r, dt);
    this.updateEffects(dt);
    this.updateBoards();
  }

  private setPhase(p: Phase) {
    this.phase = p;
    this.phaseT = 0;
  }

  private get playerAlive() {
    const { player } = this.ctx;
    return !this.death && player.mode === 'control';
  }

  /** The highest floor at or below the player's feet, or -1 below the lot. */
  private floorBelow(y: number) {
    for (let i = 0; i < TOPS.length; i++) if (y >= TOPS[i] - 0.3) return i;
    return -1;
  }

  private updatePlayer() {
    const { player, camera } = this.ctx;
    if (!this.playerAlive || player.inPortal) return;
    const p = player.pos;
    // Standing on tiles eats them (once the round is on).
    if (this.phase === 'round' && player.onGround) {
      for (let i = 0; i < TOPS.length; i++) {
        if (Math.abs(p[1] - TOPS[i]) < 0.35) this.floors[i].touch(p[0], p[2], PLAYER_FOOT);
      }
    }
    // Into the goo.
    if (p[1] < GOO_TOP + 0.05) {
      this.splash([p[0], GOO_TOP, p[2]], 1.3);
      player.kill([0, 0.5, 0], { violence: 0 });
      camera.addShake(0.4);
      const others = this.runners.filter((r) => r.out === 'no').length;
      const oldTimer = this.runners.find((r) => r.p.look.old);
      this.death = {
        t: 0,
        big: 'DISSOLVED',
        small: others === CAST.length && oldTimer?.out === 'no'
          ? 'First one out. Old 001 is still up there. He has a walking frame.'
          : pick([
            'You were eliminated. By gravity.',
            'Three floors, and you used all of them.',
            'The goo thanks you for your contribution.',
            'You have been eliminated. Please do not drink the goo on your way out.',
            'Hex-A-Gone? More like Hex-A-Goner.',
          ]),
      };
    }
  }

  private checkWin() {
    const { player } = this.ctx;
    if (!this.playerAlive || player.inPortal) return;
    const left = this.runners.filter((r) => r.out === 'no').length;
    const timeUp = this.roundT >= ROUND_TIME;
    if (left > 0 && !timeUp) return;
    // Still on (or over) a floor: falling into the goo when the clock stops doesn't count.
    const layer = this.floorBelow(player.pos[1]);
    if (layer < 0) return;
    this.setPhase('won');
    for (const f of this.floors) f.freeze();
    for (const r of this.runners) {
      if (r.out !== 'no') continue;
      r.c.vel = [0, 0, 0];
    }
    this.openExitOn(layer);
    this.ctx.hud.show(
      left === 0 ? 'LAST ONE STANDING' : 'QUALIFIED!',
      left === 0 ? 'Six test subjects went in. One of them is still dry. Congratulations, it is you.' : pick([
        'Everyone still standing qualifies. Participation trophies are in the goo.',
        'Time! You survived by the simple method of never, ever stopping.',
      ]),
      4,
    );
  }

  /** The floor you're on grows back, and the exit opens in the east wall beside it. */
  private openExitOn(layer: number) {
    const { player } = this.ctx;
    this.exitLayer = layer;
    this.floors[layer].regrowFrom(player.pos[0], player.pos[2], 12);
    this.exit = new ExitPortal(0, TOPS[layer]);
    this.exit.openNow();
  }

  /** If the player ends up on another floor after the win (they fell through), move the exit there. */
  private keepExitReachable() {
    const { player } = this.ctx;
    if (!this.playerAlive || !player.onGround || player.inPortal) return;
    const layer = this.floorBelow(player.pos[1]);
    if (layer >= 0 && layer !== this.exitLayer) this.openExitOn(layer);
  }

  /** No one's body is where this tile would pop back in. */
  private clearOf(floor: HexFloor, tile: HexTile) {
    const inSlab = (x: number, y: number, z: number) =>
      Math.hypot(x - tile.x, z - tile.z) < TILE_R + 0.4 && y > floor.top - TILE_T - 1.9 && y < floor.top - 0.05;
    const p = this.ctx.player.pos;
    if (inSlab(p[0], p[1], p[2])) return false;
    return this.runners.every((r) => r.out !== 'no' || !inSlab(r.c.pos[0], r.y, r.c.pos[2]));
  }

  // --- The others -------------------------------------------------------------------------------------

  private updateRunner(r: Runner, dt: number) {
    const c = r.c;
    if (r.out !== 'no') {
      // Sinking into the goo, arms up.
      r.outT += dt;
      r.y = GOO_TOP - 0.2 - r.outT * 0.9;
      if (r.outT > 2.6) r.out = 'gone';
      c.pos[1] = r.y;
      c.update(dt);
      return;
    }
    if (r.air === 'ground') {
      const floor = this.floors[r.layer];
      if (!floor.support(c.pos[0], c.pos[2], FOOT)) {
        if (import.meta.env.DEV) {
          const t = floor.tileAt(c.pos[0], c.pos[2]);
          this.fallLog.push(`${r.p.look.number} L${r.layer} t${this.roundT.toFixed(1)} ${t ? t.state + ' ' + t.t.toFixed(2) : 'none'} v${Math.hypot(c.vel[0], c.vel[2]).toFixed(1)} idle${r.idleT.toFixed(1)} gap${r.gapRoll}`);
        }
        this.startFall(r);
      } else {
        if (this.phase === 'round') floor.touch(c.pos[0], c.pos[2], FOOT);
        if (this.phase === 'round') this.think(r, dt);
        else if (this.phase === 'won') this.celebrate(r);
        else c.vel = [0, 0, 0];
      }
    }
    if (r.air !== 'ground') this.fly(r, dt);
    if (r.out !== 'no') return;
    c.update(dt);
    const lim = H - 0.45;
    if (Math.abs(c.pos[0]) > lim || Math.abs(c.pos[2]) > lim) {
      // Ran into a wall: turn round (and think again).
      if (Math.abs(c.pos[0]) > lim) c.vel[0] = -c.vel[0];
      if (Math.abs(c.pos[2]) > lim) c.vel[2] = -c.vel[2];
      r.heading = Math.atan2(c.vel[2], c.vel[0]);
      r.plan = 0.05;
      c.pos[0] = clamp(c.pos[0], -lim, lim);
      c.pos[2] = clamp(c.pos[2], -lim, lim);
    }
    // Don't walk through the player.
    const p = this.ctx.player.pos;
    const dx = c.pos[0] - p[0], dz = c.pos[2] - p[2];
    const d = Math.hypot(dx, dz);
    if (d < 0.6 && d > 1e-3 && Math.abs(r.y - p[1]) < 1.5) {
      c.pos[0] = p[0] + (dx / d) * 0.6;
      c.pos[2] = p[2] + (dz / d) * 0.6;
    }
    c.pos[1] = r.y;
    r.label.pos = [c.pos[0], r.y + 2.15, c.pos[2]];
  }

  private celebrate(r: Runner) {
    r.c.vel = [0, 0, 0];
    if (r.c.action !== 'cheer') {
      r.c.action = 'cheer';
      r.c.actionT = 0;
    }
  }

  private startFall(r: Runner) {
    r.air = 'fall';
    r.vy = 0;
    r.fellFrom = r.layer;
    r.c.frozen = false;
    r.c.action = 'wobble';
    r.c.actionT = 0;
    r.idleT = 0;
  }

  private jump(r: Runner) {
    r.air = 'jump';
    r.vy = NPC_JUMP * r.p.power;
    r.fellFrom = -1;
    r.c.frozen = true;
  }

  /** In the air: jumping or falling, landing on whatever floor is there when they get to it. */
  private fly(r: Runner, dt: number) {
    const c = r.c;
    const y0 = r.y;
    r.vy -= NPC_GRAVITY * dt;
    r.y += r.vy * dt;
    if (r.air === 'fall') {
      const k = Math.exp(-dt * 2.5);
      c.vel = [c.vel[0] * k, 0, c.vel[2] * k];
    }
    if (r.vy < 0) {
      for (let i = 0; i < TOPS.length; i++) {
        const top = TOPS[i];
        if (i === r.fellFrom || y0 < top || r.y >= top) continue;
        if (this.floors[i].support(c.pos[0], c.pos[2], FOOT)) {
          r.y = top;
          r.vy = 0;
          r.layer = i;
          r.air = 'ground';
          r.fellFrom = -1;
          c.frozen = false;
          c.action = 'none';
          r.plan = 0;
          r.gapRoll = null;
          return;
        }
      }
    }
    if (r.y < GOO_TOP) this.eliminate(r);
  }

  private eliminate(r: Runner) {
    const c = r.c;
    r.out = 'sinking';
    r.outT = 0;
    c.vel = [0, 0, 0];
    c.frozen = false;
    c.action = 'cheer';
    c.actionT = 0;
    r.label.text = '';
    if (import.meta.env.DEV) this.fallLog.push(`OUT ${r.p.look.number} t${this.roundT.toFixed(1)}`);
    this.splash([c.pos[0], GOO_TOP, c.pos[2]], 1);
    this.outLabels.push({ pos: [c.pos[0], GOO_TOP + 1.4, c.pos[2]], text: 'OUT!', size: 0.9, color: '#ff4d4d', ttl: 2.5 });
    // The show-offs stop to cheer. Standing still. On a floor that falls away.
    for (const o of this.runners) {
      if (o === r || o.out !== 'no' || o.air !== 'ground' || this.phase !== 'round') continue;
      if (Math.random() < o.p.cheer) {
        o.idleT = rand(0.8, 1.2);
        o.c.action = 'cheer';
        o.c.actionT = 0;
      }
    }
  }

  /** Where to go next: somewhere with floor ahead, preferably toward the most floor. */
  private think(r: Runner, dt: number) {
    const c = r.c, p = r.p;
    const floor = this.floors[r.layer];
    if (r.idleT > 0) {
      r.idleT -= dt;
      c.vel = [0, 0, 0];
      if (r.idleT <= 0) c.action = 'none';
      return;
    }
    r.goalT -= dt;
    if (r.goalT <= 0 || !r.goal) {
      r.goalT = rand(2, 4);
      r.goal = this.pickGoal(floor, c.pos[0], c.pos[2]);
    }
    r.plan -= dt;
    let speed = p.speed;
    if (r.panicT > 0) {
      r.panicT -= dt;
      speed = p.sprint;
      if (r.plan <= 0) {
        r.plan = 0.35;
        r.heading += rand(-1.4, 1.4);
      }
    } else {
      if (Math.random() < p.panic * dt) r.panicT = rand(0.6, 1.3);
      if (r.plan <= 0) {
        r.plan = rand(0.12, 0.25);
        r.heading = this.chooseHeading(r, floor);
      }
    }
    const dx = Math.cos(r.heading), dz = Math.sin(r.heading);
    const x = c.pos[0], z = c.pos[2];
    // A gap right ahead (the next tile along): jump it, if they notice in time and there's
    // somewhere to land.
    const here = floor.tileAt(x, z);
    let ahead = here;
    for (let d = 0.45; d < 1.6 && ahead === here; d += 0.3) ahead = floor.tileAt(x + dx * d, z + dz * d);
    const aheadOk = !!ahead && (ahead.state === 'solid' || (ahead.state === 'armed' && ahead.t < 0.15));
    const reach = speed * ((2 * NPC_JUMP * p.power) / NPC_GRAVITY);
    const landing = floor.tileAt(x + dx * reach, z + dz * reach);
    const landingOk = floor.fresh(landing);
    if (!aheadOk) {
      if (r.gapRoll === null) r.gapRoll = Math.random() < p.jump;
      if (r.gapRoll && landingOk) return this.jumpAt(r, dx, dz, speed);
      if (r.gapRoll) r.plan = 0; // nowhere to land that way: think again
    } else {
      r.gapRoll = null;
      // Hop now and then to save floor (the good ones do).
      if (landingOk && Math.random() < p.hop * dt) return this.jumpAt(r, dx, dz, speed);
    }
    // Their own tile is about to go and there's nothing fresh near: a desperate leap.
    if (here && here.state === 'armed' && here.t > ARM_TIME * 0.8 && p.jump > 0 && !floor.fresh(ahead)) {
      return this.jumpAt(r, dx, dz, speed);
    }
    c.vel = [dx * speed, 0, dz * speed];
  }

  private jumpAt(r: Runner, dx: number, dz: number, speed: number) {
    r.c.vel = [dx * speed, 0, dz * speed];
    this.jump(r);
  }

  /** A far-off patch of intact floor, chosen from a few random tiles by how much floor surrounds them. */
  private pickGoal(floor: HexFloor, x: number, z: number): [number, number] | null {
    let best: HexTile | null = null, bestScore = -Infinity;
    const tiles = floor.tiles;
    for (let k = 0; k < 14; k++) {
      const t = tiles[Math.floor(Math.random() * tiles.length)];
      if (t.state !== 'solid') continue;
      let score = 0;
      for (let a = 0; a < 6; a++) {
        const ang = (a / 6) * Math.PI * 2;
        if (floor.fresh(floor.tileAt(t.x + Math.cos(ang) * 1.9, t.z + Math.sin(ang) * 1.9))) score += 1;
        if (floor.fresh(floor.tileAt(t.x + Math.cos(ang) * 3.7, t.z + Math.sin(ang) * 3.7))) score += 0.6;
      }
      score -= Math.hypot(t.x - x, t.z - z) * 0.05;
      if (Math.abs(t.x) > H - 1.5 || Math.abs(t.z) > H - 1.5) score -= 2;
      if (score > bestScore) {
        bestScore = score;
        best = t;
      }
    }
    return best ? [best.x, best.z] : null;
  }

  private chooseHeading(r: Runner, floor: HexFloor) {
    const c = r.c, p = r.p;
    const x = c.pos[0], z = c.pos[2];
    const N = 16;
    let best = r.heading, bestScore = -Infinity;
    const goalAngle = r.goal ? Math.atan2(r.goal[1] - z, r.goal[0] - x) : 0;
    const slot = Math.floor(this.time * 1.5);
    for (let k = 0; k < N; k++) {
      const h = (k / N) * Math.PI * 2;
      const dx = Math.cos(h), dz = Math.sin(h);
      let s = 0;
      for (let i = 1; i <= 5; i++) {
        const d = i * 0.85, w = 1.8 - i * 0.28;
        const px = x + dx * d, pz = z + dz * d;
        if (Math.abs(px) > H - 0.4 || Math.abs(pz) > H - 0.4) {
          s -= 2.5 * w;
          break;
        }
        const t = floor.tileAt(px, pz);
        if (t && t.state === 'solid') s += w;
        else if (t && t.state === 'armed') s += i === 1 ? 0.2 * w : -0.3 * w;
        else s -= 0.9 * w;
      }
      s += 1.1 * Math.cos(h - r.heading);
      if (r.goal) s += 0.9 * Math.cos(h - goalAngle);
      // Keep away from the others on the same floor.
      for (const o of this.runners) {
        if (o === r || o.out !== 'no' || o.layer !== r.layer || o.air !== 'ground') continue;
        const ox = o.c.pos[0] - x, oz = o.c.pos[2] - z;
        const od = Math.hypot(ox, oz);
        if (od < 3 && od > 1e-3) s -= (0.8 * (3 - od) / 3) * Math.max(0, (ox * dx + oz * dz) / od);
      }
      s += (hash(k * 13.1 + r.seed + slot * 7.7) - 0.5) * 2 * p.noise;
      if (s > bestScore) {
        bestScore = s;
        best = h;
      }
    }
    return best;
  }

  // --- Effects and boards -----------------------------------------------------------------------------

  private splash(pos: Vec3, size: number) {
    this.splashes.push({ pos, t: 0, size });
  }

  private updateEffects(dt: number) {
    for (const s of this.splashes) s.t += dt;
    this.splashes = this.splashes.filter((s) => s.t < 1.6);
    if (Math.random() < dt * 8) this.bubbles.push({ pos: [rand(-H + 0.5, H - 0.5), GOO_TOP, rand(-H + 0.5, H - 0.5)], age: 0 });
    for (const b of this.bubbles) b.age += dt;
    this.bubbles = this.bubbles.filter((b) => b.age < 1.2);
    for (const l of this.outLabels) {
      l.ttl -= dt;
      l.pos = [l.pos[0], l.pos[1] + dt * 0.8, l.pos[2]];
    }
    this.outLabels = this.outLabels.filter((l) => l.ttl > 0);
  }

  private updateBoards() {
    let text: string;
    let color = LED;
    if (this.phase === 'arrive') text = '1:00';
    else if (this.phase === 'ready') {
      const n = Math.ceil(COUNTDOWN - this.phaseT);
      text = `${n}`;
      color = LED_RED;
    } else if (this.phase === 'round') {
      if (this.roundT < 0.8) {
        text = 'GO!';
        color = LED_GREEN;
      } else {
        const left = Math.max(0, Math.ceil(ROUND_TIME - this.roundT));
        text = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
        if (left <= 10) color = Math.floor(this.roundT * 4) % 2 ? LED_RED : LED;
      }
    } else {
      text = Math.floor(this.phaseT * 2) % 2 ? 'WIN!' : `${Math.floor(Math.max(0, ROUND_TIME - this.roundT) / 60)}:${String(Math.max(0, Math.ceil(ROUND_TIME - this.roundT)) % 60).padStart(2, '0')}`;
      color = LED_GREEN;
    }
    for (let i = 0; i < 3; i++) this.boardColor[i] = color[i];
    if (text !== this.shown) {
      this.shown = text;
      this.board.setText(text);
    }
    const left = this.runners.filter((r) => r.out === 'no').length + (this.death ? 0 : 1);
    this.countBoard.setText(`${left} LEFT`);
  }

  // --- Camera -------------------------------------------------------------------------------------------

  /**
   * The usual over-the-shoulder view, kept between the floors: never above the underside of the
   * floor overhead (where there are tiles), never below the floor you're on, never in the goo.
   */
  private followShot(): CameraShot {
    const { camera, player } = this.ctx;
    const cp = Math.cos(camera.pitch), sp = Math.sin(camera.pitch);
    const fwd: Vec3 = [-Math.sin(camera.yaw) * cp, sp, -Math.cos(camera.yaw) * cp];
    const right: Vec3 = [Math.cos(camera.yaw), 0, -Math.sin(camera.yaw)];
    const feet = player.pos;
    const shoulder = add(add(feet, [0, 1.65, 0]), scale(right, 0.6));
    const pos = sub(shoulder, scale(fwd, 3.2));
    const lim = H - 0.3;
    const cx = clamp(pos[0], -lim, lim), cz = clamp(pos[2], -lim, lim);
    const pushed = Math.hypot(pos[0] - cx, pos[2] - cz);
    pos[0] = cx;
    pos[2] = cz;
    pos[1] += pushed * 0.8;
    // The floor overhead (its underside must be above the feet) and the floor underfoot.
    for (let i = TOPS.length - 1; i >= 0; i--) {
      const under = TOPS[i] - TILE_T;
      if (under > feet[1] + 0.2 && this.tilesNear(this.floors[i], pos[0], pos[2])) {
        pos[1] = Math.min(pos[1], under - 0.35);
        break;
      }
    }
    const below = this.floorBelow(feet[1] + 0.2);
    if (below >= 0 && this.tilesNear(this.floors[below], pos[0], pos[2])) pos[1] = Math.max(pos[1], TOPS[below] + 0.35);
    pos[1] = Math.max(pos[1], GOO_TOP + 0.8);
    return { pos, target: add(shoulder, scale(fwd, 10)), sharpness: 18 };
  }

  private tilesNear(floor: HexFloor, x: number, z: number) {
    if (HexFloor.solid(floor.tileAt(x, z))) return true;
    for (let a = 0; a < 6; a++) {
      const ang = (a / 6) * Math.PI * 2;
      if (HexFloor.solid(floor.tileAt(x + Math.cos(ang) * 0.8, z + Math.sin(ang) * 0.8))) return true;
    }
    return false;
  }

  cameraShot(): CameraShot | null {
    return this.arrival.cameraShot() ?? this.followShot();
  }

  // --- Drawing ------------------------------------------------------------------------------------------

  draw(out: DrawItem[]) {
    this.arrival.draw(out);
    this.exit?.draw(out);
    for (const s of this.statics) out.push(s);
    for (const f of this.floors) f.draw(out);
    for (const r of this.runners) if (r.out !== 'gone') r.c.draw(out);

    const start = out.length;
    this.board.draw(out);
    this.countBoard.draw(out);
    for (let i = start; i < out.length; i++) {
      out[i].pattern = Pattern.emissive;
      out[i].shadow = false;
    }

    for (const b of this.bubbles) {
      const r = 0.08 + b.age * 0.14;
      out.push({ mesh: 'sphere', model: mul(translation([b.pos[0], b.pos[1] + b.age * 0.05, b.pos[2]]), scaling([r, r * 0.6, r])), color: GOO_GLOW, pattern: Pattern.emissive, shadow: false });
    }
    for (const s of this.splashes) this.drawSplash(out, s);
  }

  /** A goo splash: a ring spreading out and a crown of droplets thrown up. */
  private drawSplash(out: DrawItem[], s: Splash) {
    const t = s.t, k = s.size;
    const ring = (0.4 + t * 2.4) * k;
    const fade = Math.max(0, 1 - t / 1.2);
    if (fade > 0) {
      out.push({ mesh: 'tube', model: mul(translation([s.pos[0], GOO_TOP + 0.02, s.pos[2]]), scaling([ring, 0.05, ring])), color: [GOO_GLOW[0] * fade, GOO_GLOW[1] * fade, GOO_GLOW[2] * fade], pattern: Pattern.emissive, shadow: false });
    }
    for (let i = 0; i < 14; i++) {
      const a = i * 2.39996 + s.pos[0];
      const up = (5 + (i % 4) * 1.6) * k, out_ = (1.2 + (i % 3) * 0.7) * k;
      const y = GOO_TOP + up * t - 11 * t * t;
      if (y < GOO_TOP - 0.1) continue;
      const r = (0.13 + (i % 3) * 0.05) * k;
      out.push({ mesh: 'sphere', model: mul(translation([s.pos[0] + Math.cos(a) * out_ * t, y, s.pos[2] + Math.sin(a) * out_ * t]), scaling([r, r * 1.3, r])), color: GOO_GLOW, pattern: Pattern.emissive, shadow: false });
    }
  }

  labels(): WorldLabel[] {
    const list = this.labelList.slice();
    for (const l of this.outLabels) list.push(l);
    return list;
  }

  trackedTargets(): TrackedTarget[] {
    const exit = this.exit?.target();
    return exit ? [exit] : [];
  }

  environment() {
    return this.env;
  }

  obstacles() {
    return [];
  }
}

function hash(n: number) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}
