import { noise, note, sfx, tone, Tune } from '../../engine/audio';
import { add, clamp, lerp, mul, normalize, rotationX, rotationY, rotationZ, scale, scaling, segment, sub, translation, type Mat4, type Vec3 } from '../../engine/math';
import { Pattern, type DrawItem, type Environment } from '../../engine/renderer';
import { drawBody, poseFrames, standingRoot, type Pose } from '../../game/body';
import { CHAMBER_HALF } from '../../game/chamber';
import type { Circle } from '../../game/player';
import { Giant } from '../../entities/giant';
import { Mallet, MALLET_HEAD_R } from '../../entities/mallet';
import { drawDazedStars, Mole, MOLE_HEIGHT, MOLE_LOOKS, MOLE_RADIUS, STAR_COLOR } from '../../entities/mole';
import { drawStar } from '../../entities/pinball';
import { ExitPortal, PortalArrival } from '../../entities/portal';
import { type CameraShot, type Level, type LevelContext, type LevelStatus, type TrackedTarget, type WorldLabel } from '../level';
import { Cabinet, DECK_T, DECK_TOP, HOLE_COLS, HOLE_R, HOLES, RIM_H, UNDER } from './cabinet';
import { Scoreboard } from './scoreboard';

/*
 * Whack-a-Mole, and you're the mole. The floor boots up into the top of a giant arcade cabinet
 * (a raised deck with a grid of holes), the hole under you opens and you drop into the burrow
 * below, with five other moles. Timmy (the giant) is behind the south wall with a huge rubber
 * mallet. Space under a hole pops you up out of it (hold it to stay up); E or a click grabs a
 * carrot lying by the hole; let go of Space to duck. The mallet goes for whatever popped up most
 * recently (you or a mole) after a short reaction, travels over, winds up (a red ring round the
 * hole, the pad under it flashes red) and BONKs: anything sticking out is flattened. Five carrots
 * and the machine TILTs, Timmy throws a tantrum and the exit opens in the burrow's east wall.
 */

const H = CHAMBER_HALF;
/** The hole you land on and drop through: (-2.5, 0). */
const SPAWN_HOLE = 1 * HOLE_COLS + 1;
/** When the plain-looking floor boots up into the arcade (level time). */
const BOOT_AT = 2.0;
const CARROTS_NEEDED = 5;
const CARROTS_ON_DECK = 2;
const ROUND_TIME = 40;
/** From landing in the burrow: Timmy is up (the mallet is live), then GO. */
const MALLET_LIVE_AT = 2.6;
const GO_AT = 3.8;
const BREAK_TIME = 3.2;
/** Feet height when popped up: waist at the deck, chest and head out (player; moles are shorter). */
const UP_FEET = DECK_TOP - 0.95;
const MOLE_UP_FEET = DECK_TOP - 0.8;
const RISE_TIME = 0.2;
const SINK_TIME = 0.17;
/** How close to under a hole (m, horizontally) Space pops you up. */
const POP_RANGE = 0.95;
/** Fully up this long by a carrot and you grab it anyway; the grab takes GRAB_TIME. */
const AUTO_GRAB = 0.6;
const GRAB_TIME = 0.16;
/** A head whose top is above this gets hit. */
const HIT_LINE = DECK_TOP + 0.03;
const MOLE_COUNT = 4;
const MOLE_SPEED = 2.4;
const DEATH_SCREEN_DELAY = 2.6;
/** How long you lie flattened on the hole before slipping down it. */
const PANCAKE_SHOW = 1.5;
/** Carrot geometry: its top (leaf end) this far from the hole centre, and its length. */
const CARROT_IN = 1.18;
const CARROT_LEN = 1.15;
const CARROT_R = 0.17;

/** The mallet's pace, from calm (heat 0) to frantic (heat 1): [calm, frantic]. */
const REACTION = [0.4, 0.1];
/** Up longer than this and you're his target, however many moles pop up after you. */
const PATIENCE = [2.0, 1.0];
const TRAVEL_SPEED = [11, 22];
const WINDUP = [0.6, 0.26];
const SMASH = [0.12, 0.08];
const RECOVER = [0.5, 0.28];

const ORANGE = [0.95, 0.28, 0.02];
const LEAF = [0.22, 0.62, 0.14];
const PAD_IDLE = [0.18, 0.26, 0.5];

const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const ease = (k: number) => k * k * (3 - 2 * k);

type Phase = 'intro' | 'drop' | 'ready' | 'play' | 'break' | 'won';
type MoleState = 'idle' | 'walk' | 'wait' | 'rise' | 'up' | 'sink' | 'bonked' | 'fall' | 'dazed';

interface MoleNpc {
  m: Mole;
  state: MoleState;
  t: number;
  dur: number;
  hole: number;
  /** Walking: the corners of the path still to go, and the leg being walked. */
  path: Vec3[];
  legFrom: Vec3;
  legDone: number;
  since: number;
  ducker: boolean;
  blocked: number;
  label: WorldLabel;
  labelT: number;
  circle: Circle;
  /** Seconds left of cheering (paws in the air) for the new guy's carrot. */
  cheer: number;
}

interface Carrot {
  hole: number;
  angle: number;
  age: number;
  hop: number;
}

interface Pop {
  hole: number;
  state: 'rise' | 'up' | 'sink';
  t: number;
  from: Vec3;
  since: number;
  upTime: number;
  /** A carrot on its way into the hand (t counts up to GRAB_TIME), then held. */
  grab: { carrot: Carrot; t: number; from: Vec3 } | null;
  holding: boolean;
  grabQueued: boolean;
  /** The mallet was already coming for this hole when they popped up, or still down on it. */
  intoRing: boolean;
  intoMallet: boolean;
  /** The camera's yaw and pitch in the burrow, to go back to. */
  view: [number, number];
}

interface Death {
  t: number;
  big: string;
  small: string;
}

interface Particle {
  pos: Vec3;
  vel: Vec3;
  age: number;
  life: number;
  kind: 'dust' | 'star';
  spin: number;
}

export class MolesLevel implements Level {
  readonly number: number;
  readonly title = 'Whack-a-Mole';
  status: LevelStatus = 'playing';
  private arrival: PortalArrival;
  private exit = new ExitPortal(0, -0.15);
  private cabinet: Cabinet;
  private board = new Scoreboard();
  private giant = new Giant();
  private mallet = new Mallet();
  /** Level time, and time since landing in the burrow. */
  private t = 0;
  private g = 0;
  private phase: Phase = 'intro';
  private round = 1;
  private roundT = ROUND_TIME;
  private breakT = 0;
  private wonT = 0;
  /** Time since Timmy started sinking away in a sulk (after the win). */
  private sulkT = 0;
  private score = 0;
  private collected = 0;
  private carrots: Carrot[] = [];
  private carrotRespawn = -1;
  /** Carrots in the burrow's pile by the exit (they go there once you're back down). */
  private stash = 0;
  private moles: MoleNpc[] = [];
  /** Who is using each hole's pad: a mole's index, 'player', or nobody. */
  private holeUser: (number | 'player' | null)[] = HOLES.map(() => null);
  private pop: Pop | null = null;
  private drop: { t: number; from: Vec3; hole: number; slide: number } | null = null;
  private dropWait = 0;
  private ms = {
    state: 'away' as 'away' | 'idle' | 'travel' | 'windup' | 'smash' | 'impact' | 'recover' | 'rest',
    t: 0,
    dur: 0,
    hole: -1,
    bored: 0,
    boredLimit: 2.5,
    /** Slams left in Timmy's tantrum (after the win). */
    tantrum: 0,
    /** What the swing hit (for Timmy's reaction). */
    hitMole: false,
    /** The carrot hole he's hovering over while nothing's up, and for how much longer. */
    campHole: -1,
    camp: 0,
  };
  private death: Death | null = null;
  private pancake: { feet: Vec3; facing: number; t: number } | null = null;
  private particles: Particle[] = [];
  private under = 0;
  private timmyLabel: WorldLabel = { pos: [0, 0, 0], text: '', size: 3, color: '#ffd166' };
  private timmyT = 0;
  private counterLabel: WorldLabel = { pos: [0, 0, 0], text: '', size: 0.16, color: '#ffb347' };
  private signs: WorldLabel[] = [
    { pos: [-H + 0.2, 1.9, 4], text: 'HOME SWEET HOLE', size: 0.3, color: '#ffe3a8' },
    { pos: [-H + 0.2, 1.55, 4], text: 'no mallets past this point', size: 0.13, color: '#e8c89a' },
    { pos: [H - 0.2, 2.15, -6.5], text: 'WANTED', size: 0.3, color: '#5a2a10' },
    { pos: [H - 0.2, 1.8, -6.5], text: 'TIMMY', size: 0.26, color: '#8a1a10' },
    { pos: [H - 0.2, 1.52, -6.5], text: 'for crimes against moles', size: 0.09, color: '#5a2a10' },
  ];
  private labelList: WorldLabel[] = [];
  /** A message flashed on the board for a moment (WHACK!, MISS!). */
  private flash = { text: '', t: 0 };
  private obstacleList: Circle[] = [];
  private lifts: number[] = HOLES.map(() => 0);
  private glows: number[][] = HOLES.map(() => [...PAD_IDLE]);
  private env: Environment = {
    sunDir: [0.12, 1, 0.25],
    sunColor: [1.9, 1.8, 1.62],
    skyColor: [0.2, 0.3, 0.5],
    groundColor: [0.22, 0.2, 0.18],
    fogColor: [0.72, 0.8, 0.9],
    fogDensity: 0.003,
    pointLight: { pos: [0, 2.2, 0], color: [1.3, 0.85, 0.45], range: 11 },
  };
  private tune = new Tune([
    ['C5', 0.5], ['E5', 0.5], ['G5', 0.5], ['E5', 0.5], ['A5', 0.5], ['G5', 0.5], ['E5', 1],
    ['F5', 0.5], ['A5', 0.5], ['C6', 0.5], ['A5', 0.5], ['G5', 1.5], [null, 0.5],
    ['E5', 0.5], ['G5', 0.5], ['C6', 0.5], ['B5', 0.5], ['A5', 0.5], ['F5', 0.5], ['D5', 1],
    ['G5', 0.5], ['F5', 0.5], ['E5', 0.5], ['D5', 0.5], ['C5', 1.5], [null, 0.5],
  ], 168, { wave: 'square', vol: 0.045, bass: true });

  constructor(private ctx: LevelContext) {
    this.number = ctx.number;
    const { hud, physics } = ctx;
    hud.setLevel(`The Chamber · Level ${this.number}`);
    hud.show(`LEVEL ${this.number}`, '', 2.5);
    hud.hint('');
    const spawn = HOLES[SPAWN_HOLE];
    this.arrival = new PortalArrival(ctx, [spawn[0], DECK_TOP, spawn[2]], { minElevationDeg: 86 });
    this.cabinet = new Cabinet(physics);
    this.giant.root = [0, -80, 27];
    this.giant.leanTarget = this.giant.lean = 0.3;
    this.giant.rightCurl = 1.2;
    // Timmy starts out of sight below the south wall, mallet and all.
    this.mallet.aim = [2, DECK_TOP, 15];
    this.mallet.from = normalize([-2, 0, -9]);
    this.mallet.swing = 0.8;
    this.mallet.lift = 4 + this.giant.root[1];
    this.giant.update(0, this.mallet.grip());
    const params = new URLSearchParams(location.search);
    this.collected = Math.min(CARROTS_NEEDED - 1, Math.max(0, Number(params.get('moleCarrots')) || 0));
    this.stash = this.collected;

    // The other moles stand about on pads in the burrow.
    const starts = [0, 3, 6, 8, 11, 2, 9];
    for (let i = 0; i < MOLE_COUNT; i++) {
      const m = new Mole(MOLE_LOOKS[i % MOLE_LOOKS.length]);
      const hole = starts[i];
      m.pos = [HOLES[hole][0], 0, HOLES[hole][2]];
      m.yaw = Math.random() * Math.PI * 2;
      m.time = Math.random() * 10;
      this.holeUser[hole] = i;
      const npc: MoleNpc = {
        m, state: 'idle', t: 0, dur: GO_AT + rand(0.2, 2.2), hole, path: [], legFrom: [...m.pos], legDone: 0, since: 0,
        ducker: false, blocked: 0, label: { pos: [0, 0, 0], text: '', size: 0.26, color: '#ffe2b8' }, labelT: 0,
        circle: { x: m.pos[0], z: m.pos[2], r: MOLE_RADIUS }, cheer: 0,
      };
      this.moles.push(npc);
      this.obstacleList.push(npc.circle);
    }
  }

  // --- Difficulty -----------------------------------------------------------------------------------

  /** 0 (calm) to 1 (frantic): rises with carrots taken, rounds played and Timmy's score. */
  private heat() {
    return clamp(this.collected * 0.17 + (this.round - 1) * 0.2 + this.score / 5000, 0, 1);
  }

  private tune01(range: number[]) {
    return lerp(range[0], range[1], this.heat());
  }

  // --- Update ---------------------------------------------------------------------------------------

  update(dt: number) {
    const { player, hud } = this.ctx;
    this.t += dt;
    const death = this.death;
    if (death && this.status === 'playing') {
      death.t += dt;
      if (death.t > DEATH_SCREEN_DELAY) {
        this.status = 'lost';
        hud.show(death.big, `${death.small}\nPress R to try again.`);
        hud.tips([
          ['Hint', 'Pop up where the mallet isn’t (a red ring on a hole, or a red light round the pad under it, means it’s coming), grab a carrot, duck. The other moles are decoys: pop up as he winds up to whack one. Don’t hang about up there.'],
          ['Controls', 'WASD move · Space (hold) pop up · E or click grab · let go of Space to duck'],
        ]);
      }
    }
    this.arrival.update(dt);
    this.exit.update(dt, player);
    if (this.exit.entered && this.status === 'playing') this.status = 'exited';
    this.cabinet.update(dt);
    this.giant.time += dt;

    this.updatePhase(dt);
    this.updatePlayer(dt);
    this.updateMoles(dt);
    this.updateMallet(dt);
    this.updateCarrots(dt);
    this.updateEffects(dt);
    this.updatePads();
    this.updateEnvironment(dt);
  }

  private updatePhase(dt: number) {
    const board = this.board;
    // The floor boots up while you're still picking yourself up, then drops you in.
    if (this.phase === 'intro') {
      const boot = this.t - BOOT_AT;
      if (boot >= 0 && boot - dt < 0) {
        // Power on: a clunk and a rising whirr.
        tone(70, 0.3, { to: 45, wave: 'square', vol: 0.15 });
        noise(0.9, { freq: 200, to: 2500, type: 'bandpass', q: 2, vol: 0.15 });
      }
      for (let b = 0; b < this.cabinet.bandCount; b++) {
        if (boot >= b * 0.13 && !this.cabinet.isBooted(b)) {
          this.cabinet.boot(b);
          tone(260 + b * 70, 0.08, { wave: 'square', vol: 0.07 });
          if (b === this.cabinet.bandCount - 1) {
            this.jingle(['C5', 'G5', 'E5', 'C6'], 0.07);
            for (let k = 0; k < CARROTS_ON_DECK; k++) this.spawnCarrot();
          }
        }
      }
      board.appear = clamp((boot - 0.1) / 0.45, 0, 1);
      // A moment to take it all in, then the floor gives way.
      if (this.arrival.done && this.cabinet.fullyBooted) {
        this.dropWait += dt;
        if (this.dropWait > 0.7) this.startDrop();
      }
    }
    if (this.t > BOOT_AT + 0.6) board.on = Math.min(1, board.on + dt * 1.6);
    if (this.phase === 'drop') this.updateDrop(dt);
    if (this.phase === 'intro' || this.phase === 'drop') {
      board.setMessage('INSERT COIN');
      board.blink = true;
      return;
    }

    this.g += dt;
    const g = this.g;
    // Timmy rises over the south wall, and at the end sinks away in a sulk.
    const rise = clamp((g - 0.3) / 2.2, 0, 1);
    if (this.phase === 'won' && this.ms.state === 'away') this.sulkT += dt;
    const sulk = clamp(this.sulkT / 3, 0, 1);
    this.giant.root[1] = lerp(-80, 0, 1 - (1 - rise) * (1 - rise)) - 80 * sulk * sulk;
    this.giant.headShake = this.phase === 'won' && this.wonT > 1.2 && this.sulkT === 0 ? 1 : 0;
    this.timmyLabel.pos = add(this.giant.headCenter(), [0, 14, 0]);
    this.timmyT -= dt;
    if (this.timmyT <= 0) this.timmyLabel.text = '';

    board.setScore(this.score);
    if (this.phase === 'ready') {
      board.setTime(ROUND_TIME);
      if (g >= 1.0 && g - dt < 1.0) this.moleSay(this.nearestMole(), 'Psst. New guy.', 1.6);
      if (g >= 2.4 && g - dt < 2.4) {
        this.moleSay(this.nearestMole(), 'The carrots are up top.', 1.8);
        sfx.laugh();
        this.timmySay('WHACK-A-MOLE!!', 2);
      }
      if (g >= 2.7 && g - dt < 2.7) {
        this.coin();
        board.setMessage('READY?');
        board.blink = false;
      }
      if (g >= 3.5 && g - dt < 3.5) {
        const other = this.moles.find((n, i) => i !== this.moles.indexOf(this.nearestMole()) && n.state === 'idle');
        if (other) this.moleSay(other, 'So is the mallet.', 1.8);
      }
      if (g >= GO_AT) {
        this.phase = 'play';
        this.roundT = ROUND_TIME;
        board.setMessage('GO!');
        this.jingle(['C5', 'E5', 'G5', 'C6'], 0.08);
      }
    } else if (this.phase === 'play') {
      this.roundT -= dt;
      board.setTime(this.roundT);
      this.tune.bpm = 168 + this.heat() * 40;
      if (!this.death) this.tune.start();
      else this.tune.stop();
      this.flash.t -= dt;
      let msg = this.flash.t > 0 ? this.flash.text : this.roundT < 5.5 ? 'HURRY UP!' : Math.floor(this.t / 3.5) % 3 === 2 ? 'HI-SCORE: TIMMY' : 'WHACK-A-MOLE!';
      if (this.roundT > ROUND_TIME - 1.5) msg = 'GO!';
      if (this.death) msg = 'BONUS 1000!';
      board.setMessage(msg);
      board.blink = this.death !== null || this.roundT < 5.5;
      if (this.roundT <= 0) {
        this.phase = 'break';
        this.breakT = 0;
        this.tune.stop();
        board.setMessage('GAME OVER');
        board.blink = false;
        this.jingle(['G5', 'E5', 'C5', 'G4'], 0.16, 'triangle');
        this.timmySay(pick(['AWW!', 'NOT FAIR!']), 1.5);
      }
    } else if (this.phase === 'break') {
      this.breakT += dt;
      board.setTime(0);
      if (this.breakT >= 1.0 && this.breakT - dt < 1.0) {
        board.setMessage('INSERT COIN');
        board.blink = true;
        this.timmySay(this.round === 1 ? 'MOM! MORE QUARTERS!' : pick(['ONE MORE!', 'MOM!! QUARTERS!', 'LAST ONE! PROMISE!']), 1.8);
      }
      if (this.breakT >= BREAK_TIME - 0.8 && this.breakT - dt < BREAK_TIME - 0.8) {
        this.coin();
        board.setMessage(`ROUND ${this.round + 1}`);
        board.blink = false;
      }
      if (this.breakT >= BREAK_TIME) {
        this.round++;
        this.phase = 'play';
        this.roundT = ROUND_TIME;
        board.setMessage('GO!');
        this.jingle(['C5', 'E5', 'G5', 'C6'], 0.07);
      }
    } else if (this.phase === 'won') {
      this.wonT += dt;
      board.blink = true;
      board.setMessage(this.wonT < 3 ? 'TILT' : Math.floor(this.wonT) % 2 ? 'TILT' : 'MOLE ESCAPED');
      if (this.wonT >= 1.0 && this.wonT - dt < 1.0) {
        this.exit.openNow();
        this.timmySay('MOOOM! THE MOLE CHEATED!', 2.6);
      }
      if (this.wonT >= 2.2 && this.wonT - dt < 2.2) this.ms.tantrum = 6;
      if (this.sulkT > 0 && this.sulkT - dt <= 0) this.timmySay("I'M TELLING!", 2.5);
    }
  }

  /** The hole under you opens: hang there a moment (it's a cartoon), then drop into the burrow. */
  private startDrop() {
    const { player } = this.ctx;
    this.phase = 'drop';
    this.cabinet.openLids();
    noise(0.35, { freq: 1500, to: 300, type: 'bandpass', q: 1.5, vol: 0.3 });
    tone(90, 0.25, { to: 50, wave: 'square', vol: 0.12 });
    const hole = this.nearestHole(player.pos, 99);
    // If they've wandered off it, the hole sucks them back over (it's that kind of hole).
    const dist = Math.hypot(player.pos[0] - HOLES[hole][0], player.pos[2] - HOLES[hole][2]);
    this.drop = { t: 0, from: [...player.pos], hole, slide: 0.2 + dist * 0.08 };
    if (dist > 1) noise(0.3 + dist * 0.08, { freq: 600, to: 2400, type: 'bandpass', q: 3, vol: 0.2 });
    player.mode = 'swinging';
    player.vel = [0, 0, 0];
    player.cancelJump();
  }

  private updateDrop(dt: number) {
    const { player, camera } = this.ctx;
    const d = this.drop;
    if (!d) return;
    d.t += dt;
    const h = HOLES[d.hole];
    const HANG = d.slide + 0.3;
    const slide = ease(clamp(d.t / d.slide, 0, 1));
    const fall = Math.max(0, d.t - HANG);
    const y = Math.max(0, d.from[1] - 0.5 * 22 * fall * fall);
    player.pos = [lerp(d.from[0], h[0], slide), y, lerp(d.from[2], h[2], slide)];
    player.facing = camera.yaw;
    const t = this.t;
    player.poseOverride = d.t < HANG
      ? { lean: 0.05, headPitch: -0.6, shoulderL: 0.3, shoulderR: 0.3, armOut: 0.5, elbowL: 0.4, elbowR: 0.4, hipL: 0, hipR: 0, kneeL: -0.05, kneeR: -0.05 }
      : {
        lean: 0.1, headPitch: 0.4, shoulderL: 2.7 + Math.sin(t * 18) * 0.3, shoulderR: 2.7 + Math.cos(t * 17) * 0.3, armOut: 0.5,
        elbowL: 0.3, elbowR: 0.3, hipL: 0.5 + Math.sin(t * 14) * 0.4, hipR: 0.1 - Math.sin(t * 14) * 0.4, kneeL: -0.9, kneeR: -0.4,
      };
    if (fall > 0 && fall - dt <= 0) tone(1300, 0.55, { to: 220, wave: 'sine', vol: 0.16 });
    if (y <= 0) {
      player.pos = [h[0], 0, h[2]];
      player.poseOverride = null;
      player.resume([0, -9, 0]);
      player.knock([rand(-1.5, 1.5), 1, rand(-1.5, 1.5)], 0.6);
      sfx.thud(0.7);
      camera.addShake(0.4);
      this.drop = null;
      this.phase = 'ready';
      this.g = 0;
    }
  }

  // --- The player: popping up, grabbing, ducking ---------------------------------------------------

  private updatePlayer(dt: number) {
    const { player, input, camera } = this.ctx;
    const canPop = this.phase === 'ready' || this.phase === 'play' || this.phase === 'break' || this.phase === 'won';
    if (!this.pop && canPop && !this.death && player.mode === 'control' && !player.inPortal && input.wasPressed('Space') &&
        player.pos[1] < 0.35 && !player.gettingUp && player.stun <= 0) {
      const h = this.nearestHole(player.pos, POP_RANGE);
      if (h >= 0 && (this.holeUser[h] === null || this.holeUser[h] === 'player')) this.startPop(h);
    }
    const pop = this.pop;
    if (!pop || this.death) return;
    const hc = HOLES[pop.hole];
    pop.t += dt;
    const holdingSpace = input.isDown('Space');
    const wantGrab = input.wasPressed('KeyE') || input.mousePressed;
    if (wantGrab) pop.grabQueued = true;
    let y = 0;
    if (pop.state === 'rise') {
      const k = clamp(pop.t / RISE_TIME, 0, 1);
      const up = 1 - (1 - k) * (1 - k);
      y = lerp(pop.from[1], UP_FEET, up);
      const kx = ease(clamp(pop.t / (RISE_TIME * 0.7), 0, 1));
      player.pos = [lerp(pop.from[0], hc[0], kx), y, lerp(pop.from[2], hc[2], kx)];
      if (k >= 1) {
        pop.state = 'up';
        pop.t = 0;
      }
    } else if (pop.state === 'up') {
      pop.upTime += dt;
      player.pos = [hc[0], UP_FEET + Math.sin(this.t * 6) * 0.015, hc[2]];
      const carrot = this.carrots.find((c) => c.hole === pop.hole);
      if (carrot && !pop.grab && (pop.grabQueued || pop.upTime >= AUTO_GRAB)) this.startGrab(carrot);
      // Duck when Space is let go (but finish a grab first: it's quick).
      if (!holdingSpace && (!pop.grab || pop.grab.t >= GRAB_TIME)) {
        pop.state = 'sink';
        pop.t = 0;
        tone(750, 0.16, { to: 210, wave: 'sine', vol: 0.16 });
        // Back down to the view you had in the burrow.
        camera.yaw = pop.view[0];
        camera.pitch = pop.view[1];
      }
    } else {
      const k = clamp(pop.t / SINK_TIME, 0, 1);
      y = UP_FEET * (1 - (1 - (1 - k) * (1 - k)));
      player.pos = [hc[0], y, hc[2]];
      if (k >= 1) this.endPop();
    }
    if (!this.pop) return;
    if (pop.grab) pop.grab.t += dt;
    // Face where you look; turn to the carrot to grab it.
    if (pop.grab && pop.grab.t < GRAB_TIME) {
      const cp = this.carrotTop(pop.grab.carrot);
      player.facing = Math.atan2(-(cp[0] - hc[0]), -(cp[2] - hc[2]));
    } else {
      player.facing = camera.yaw;
    }
    player.poseOverride = this.popPose(pop);
  }

  private startPop(h: number) {
    const { player, camera } = this.ctx;
    player.mode = 'swinging';
    player.vel = [0, 0, 0];
    player.cancelJump();
    this.holeUser[h] = 'player';
    const committed = this.ms.hole === h && (this.ms.state === 'travel' || this.ms.state === 'windup' || this.ms.state === 'smash');
    this.pop = {
      hole: h, state: 'rise', t: 0, from: [player.pos[0], 0, player.pos[2]], since: this.t, upTime: 0,
      grab: null, holding: false, grabQueued: false, intoRing: committed, intoMallet: false, view: [camera.yaw, camera.pitch],
    };
    // Up top, you face Timmy: the view swings round to the south (the burrow's view comes back when you duck).
    camera.yaw = Math.PI;
    camera.pitch = -0.2;
    tone(240, 0.12, { to: 720, wave: 'sine', vol: 0.25 });
    tone(110, 0.25, { to: 160, wave: 'triangle', vol: 0.14, at: 0.02 });
    noise(0.06, { freq: 3000, to: 800, vol: 0.15 });
  }

  private endPop() {
    const { player } = this.ctx;
    const pop = this.pop!;
    const hc = HOLES[pop.hole];
    player.pos = [hc[0], 0, hc[2]];
    player.poseOverride = null;
    player.resume([0, 0, 0]);
    this.holeUser[pop.hole] = null;
    if (pop.holding) {
      this.stash++;
      noise(0.08, { freq: 900, to: 300, vol: 0.2 });
    }
    this.pop = null;
  }

  private startGrab(carrot: Carrot) {
    const pop = this.pop!;
    pop.grab = { carrot, t: 0, from: this.carrotTop(carrot) };
    pop.holding = true;
    pop.grabQueued = false;
    this.carrots.splice(this.carrots.indexOf(carrot), 1);
    this.collected++;
    this.crunch();
    // The moles down below are impressed.
    for (const n of this.moles) n.cheer = rand(1.0, 1.8);
    const fan = this.moles.find((n) => n.m.pos[1] < 0.5 && n.state !== 'dazed');
    if (fan && this.collected < CARROTS_NEEDED) this.moleSay(fan, pick(['Nice one!', 'Share it!', 'Legend.', 'Mole of the year!', 'Do another!']), 1.4);
    const { hud } = this.ctx;
    const quips = [
      'Eh... what’s up, doc?',
      'Crunchy. Nutritious. Stolen.',
      'Timmy is starting to suspect something.',
      'One more and it’s a balanced diet.',
    ];
    if (this.collected >= CARROTS_NEEDED) {
      hud.show('TILT!', 'The machine has detected an unauthorised mole.', 2.4);
      this.win();
    } else {
      if (!this.death) this.timmySay(this.collected === 1 ? 'HEY! MY CARROT!' : pick(['THIEF!', 'MOM! A MOLE TOOK A CARROT!', 'HEY!!', 'GIVE IT BACK!']), 1.8);
      hud.show(`${this.collected} / ${CARROTS_NEEDED}`, quips[Math.min(quips.length - 1, this.collected - 1)], 1.4);
      if (this.collected + this.carrots.length < CARROTS_NEEDED) this.carrotRespawn = 1.1;
    }
  }

  private win() {
    this.phase = 'won';
    this.wonT = 0;
    this.tune.stop();
    this.cabinet.tilt = true;
    this.board.tilt = true;
    // Timmy freezes in disbelief (a swing already coming down still lands).
    const ms = this.ms;
    if (ms.state === 'travel' || ms.state === 'windup') {
      ms.state = 'idle';
      ms.t = 0;
      ms.hole = -1;
    }
    this.timmySay('WHAT?!', 1);
    tone(90, 0.9, { wave: 'sawtooth', vol: 0.18 });
    tone(94, 0.9, { wave: 'sawtooth', vol: 0.18 });
    this.jingle(['C5', 'E5', 'G5', 'C6', 'G5', 'C6'], 0.1);
  }

  /** The pose popped up: paws up by the chin like a meerkat, looking where you look; reaching for / holding up a carrot. */
  private popPose(pop: Pop): Pose {
    const { camera } = this.ctx;
    const t = this.t;
    const pitch = camera.pitch;
    const grabK = pop.grab ? clamp(pop.grab.t / GRAB_TIME, 0, 1) : 0;
    const reach = pop.grab ? (grabK < 1 ? Math.sin(grabK * Math.PI) : 0) : 0;
    const hold = pop.holding && grabK >= 1 ? 1 : 0;
    const bob = Math.sin(t * 5) * 0.06;
    return {
      lean: clamp(-pitch * 0.3, -0.35, 0.12) - reach * 0.6,
      headPitch: clamp(pitch * 0.7, -0.5, 0.5),
      shoulderL: 1.05 + bob,
      shoulderR: hold ? 2.85 : lerp(1.05 - bob, 1.35, reach),
      armOut: 0.28,
      elbowL: 1.9,
      elbowR: hold ? 0.25 : lerp(1.9, 0.1, reach),
      hipL: 0.05, hipR: -0.05, kneeL: -0.1, kneeR: -0.1,
    };
  }

  /** The mallet came down on your hole with your head out of it. */
  private whacked() {
    const { player, camera } = this.ctx;
    const pop = this.pop!;
    const hc = HOLES[pop.hole];
    const upFor = pop.upTime;
    const holding = pop.holding;
    const into = pop.intoRing;
    const intoMallet = pop.intoMallet;
    this.pop = null;
    this.holeUser[pop.hole] = null;
    player.poseOverride = null;
    player.hide();
    player.pos = [hc[0], DECK_TOP - 0.28, hc[2]];
    this.pancake = { feet: [hc[0], DECK_TOP - 0.28, hc[2]], facing: player.facing, t: 0 };
    camera.addShake(1.1);
    sfx.oof(1);
    this.score += 1000;
    this.timmySay(pick(['GOLDEN MOLE!!', 'MOM! I GOT THE BIG ONE!', '1000 POINTS!!']), 2.2);
    sfx.laugh(0.4);
    this.tune.stop();
    let small: string;
    if (intoMallet) small = 'You popped up into a mallet. It was still there. It was very much still there.';
    else if (into) small = 'You popped up under a falling mallet. Bold. Wrong, but bold.';
    else if (holding) small = 'So close. The carrot survived. You did not.';
    else if (upFor > 2.2) small = 'Staying up is not a strategy. It’s a target.';
    else small = pick([
      'Timmy scored 1000 points. You scored a concussion.',
      'You were supposed to be the mole. You were the nail.',
      'Eh... what’s up, doc? The mallet. The mallet was up.',
      'Pop goes the weasel. Bonk goes the mole.',
    ]);
    this.death = { t: 0, big: pick(['WHACKED', 'BONK!', 'FLATTENED']), small };
  }

  // --- The other moles ------------------------------------------------------------------------------

  private updateMoles(dt: number) {
    const { player } = this.ctx;
    const live = this.phase === 'play' || this.phase === 'break' || this.phase === 'won' || this.phase === 'ready';
    for (let i = 0; i < this.moles.length; i++) {
      const n = this.moles[i], m = n.m;
      m.time += dt;
      n.t += dt;
      n.labelT -= dt;
      if (n.labelT <= 0) n.label.text = '';
      m.flash = Math.max(0, m.flash - dt * 3);
      m.walking = 0;
      m.armsUp = Math.max(0, m.armsUp - dt * 3);
      n.cheer -= dt;
      if (n.cheer > 0 && m.pos[1] < 0.5 && n.state !== 'dazed') {
        m.armsUp = 1;
        m.wiggle = Math.sin(m.time * 14) * 0.08;
      }
      m.wiggle *= Math.exp(-dt * 6);
      const hc = HOLES[n.hole];
      switch (n.state) {
        case 'idle': {
          // Before the game: loiter on a pad, looking at the new guy once he's down here.
          if (player.pos[1] < 1 && this.phase !== 'intro' && this.phase !== 'drop') {
            m.yaw = turnTo(m.yaw, Math.atan2(-(player.pos[0] - m.pos[0]), -(player.pos[2] - m.pos[2])), dt * 3);
          }
          if (live && this.g >= n.dur) this.moleWait(n, rand(0.1, 0.9));
          break;
        }
        case 'walk':
          this.moleWalk(n, i, dt);
          break;
        case 'wait': {
          // Anticipation: a little crouch just before it pops.
          m.squash = n.dur - n.t < 0.25 ? 0.12 * (1 - (n.dur - n.t) / 0.25) : 0;
          m.yaw = turnTo(m.yaw, Math.sin(m.time * 0.7 + i) * 2, dt * 2);
          if (n.t >= n.dur && this.phase !== 'ready') {
            const playerNear = Math.hypot(player.pos[0] - hc[0], player.pos[2] - hc[2]) < 1.0 && player.pos[1] < 1;
            if (playerNear || this.pop?.hole === n.hole) this.moleGoSomewhere(n, i);
            else {
              n.state = 'rise';
              n.t = 0;
              n.since = this.t;
              n.ducker = Math.random() < 0.2;
              m.squash = 0;
              const d = Math.hypot(player.pos[0] - hc[0], player.pos[2] - hc[2]);
              const vol = clamp(1 - d / 22, 0.15, 1);
              tone(300 + i * 25, 0.1, { to: 800, wave: 'sine', vol: 0.12 * vol });
            }
          }
          break;
        }
        case 'rise': {
          const k = clamp(n.t / 0.22, 0, 1);
          m.pos = [hc[0], MOLE_UP_FEET * (1 - (1 - k) * (1 - k)), hc[2]];
          if (k >= 1) {
            n.state = 'up';
            n.t = 0;
            n.dur = rand(1.5, 3.2);
            if (Math.random() < 0.25) this.moleSay(n, pick(['NYAH!', 'Missed me!', 'Yoo-hoo!', 'Over here!', 'Can’t touch this']), 1.2);
          }
          break;
        }
        case 'up': {
          m.pos = [hc[0], MOLE_UP_FEET + Math.sin(m.time * 7) * 0.02, hc[2]];
          m.armsUp = Math.max(m.armsUp, 0.55 + 0.45 * Math.sin(m.time * 3));
          m.wiggle = Math.sin(m.time * 9) * 0.1;
          m.yaw += dt * Math.sin(m.time * 1.3 + i) * 1.5;
          // Some of them see it coming and duck.
          const coming = this.ms.hole === n.hole && this.ms.state === 'windup' && this.ms.t > this.ms.dur * 0.4;
          if (n.t >= n.dur || (n.ducker && coming)) {
            n.state = 'sink';
            n.t = 0;
          }
          break;
        }
        case 'sink': {
          const k = clamp(n.t / 0.18, 0, 1);
          m.pos = [hc[0], MOLE_UP_FEET * (1 - k * (2 - k)), hc[2]];
          if (k >= 1) {
            if (n.ducker && this.ms.hole === n.hole && (this.ms.state === 'windup' || this.ms.state === 'smash')) this.moleSay(n, pick(['Missed me!', 'Too slow!', 'NYAH NYAH!']), 1.3);
            this.moleGoSomewhere(n, i, rand(0.2, 0.9));
          }
          break;
        }
        case 'bonked': {
          m.pos = [hc[0], DECK_TOP - 0.2, hc[2]];
          m.squash = 1;
          m.dazed = 3;
          if (n.t >= 0.55) {
            n.state = 'fall';
            n.t = 0;
            tone(900, 0.3, { to: 300, wave: 'sine', vol: 0.06 });
          }
          break;
        }
        case 'fall': {
          const k = clamp(n.t / 0.3, 0, 1);
          m.pos = [hc[0], (DECK_TOP - 0.2) * (1 - k * k), hc[2]];
          if (k >= 1) {
            n.state = 'dazed';
            n.t = 0;
            n.dur = rand(2.2, 3.0);
          }
          break;
        }
        case 'dazed': {
          m.pos = [hc[0], 0, hc[2]];
          // Boing back into shape (overshooting), then sway about seeing stars.
          m.squash = Math.cos(n.t * 13) * Math.exp(-n.t * 3.5);
          m.dazed = n.dur - n.t;
          if (n.t >= n.dur) {
            m.squash = 0;
            m.dazed = 0;
            this.moleGoSomewhere(n, i);
          }
          break;
        }
      }
      n.circle.x = m.pos[0];
      n.circle.z = m.pos[2];
      n.label.pos = add(m.top(), [0, 0.45, 0]);
    }
  }

  private moleWait(n: MoleNpc, dur: number) {
    n.state = 'wait';
    n.t = 0;
    n.dur = dur;
  }

  /** Picks a free hole (not yours, not right by you), reserves it and sets off along the grid lines. */
  private moleGoSomewhere(n: MoleNpc, i: number, delay = 0) {
    const { player } = this.ctx;
    const here = n.hole;
    const col = here % HOLE_COLS, row = Math.floor(here / HOLE_COLS);
    const options: number[] = [];
    const weights: number[] = [];
    for (let h = 0; h < HOLES.length; h++) {
      if (h === here || this.holeUser[h] !== null) continue;
      if (Math.hypot(player.pos[0] - HOLES[h][0], player.pos[2] - HOLES[h][2]) < 1.6) continue;
      const steps = Math.abs((h % HOLE_COLS) - col) + Math.abs(Math.floor(h / HOLE_COLS) - row);
      options.push(h);
      weights.push(1 / (steps * steps));
    }
    if (this.holeUser[here] === i) this.holeUser[here] = null;
    if (!options.length) {
      // Nowhere to go: stay put a moment.
      this.holeUser[here] = i;
      this.moleWait(n, 1);
      n.dur = 1;
      return;
    }
    let r = Math.random() * weights.reduce((a, b) => a + b, 0);
    let target = options[0];
    for (let k = 0; k < options.length; k++) {
      r -= weights[k];
      if (r <= 0) {
        target = options[k];
        break;
      }
    }
    this.holeUser[target] = i;
    n.hole = target;
    const to = HOLES[target];
    const from = n.m.pos;
    n.path = [];
    if (Math.abs(from[0] - to[0]) > 0.05) n.path.push([to[0], 0, from[2]]);
    n.path.push([to[0], 0, to[2]]);
    n.legFrom = [from[0], 0, from[2]];
    n.legDone = 0;
    n.state = 'walk';
    n.t = -delay;
    n.blocked = 0;
    n.m.pos = [from[0], 0, from[2]];
  }

  private moleWalk(n: MoleNpc, i: number, dt: number) {
    const { player } = this.ctx;
    const m = n.m;
    if (n.t < 0) return;
    const to = n.path[0];
    const leg = sub(to, n.legFrom);
    const len = Math.hypot(leg[0], leg[2]);
    const dir: Vec3 = len > 1e-3 ? [leg[0] / len, 0, leg[2] / len] : [0, 0, -1];
    // Keep right, so moles going opposite ways pass each other.
    const right: Vec3 = [-dir[2], 0, dir[0]];
    // Wait for the player to get out of the way (for a bit; then just shove past).
    const toP = sub(player.pos, m.pos);
    const ahead = toP[0] * dir[0] + toP[2] * dir[2];
    if (player.mode === 'control' && player.pos[1] < 1 && ahead > 0 && Math.hypot(toP[0], toP[2]) < 1.05 && n.blocked < 1.6) {
      if (n.blocked === 0 && Math.random() < 0.5) this.moleSay(n, pick(['’Scuse me.', 'Coming through!', 'Mind the tail.']), 1.2);
      n.blocked += dt;
      return;
    }
    n.legDone = Math.min(len, n.legDone + MOLE_SPEED * dt);
    const s = n.legDone;
    const off = 0.42 * clamp(s / 0.8, 0, 1) * clamp((len - s) / 0.8, 0, 1);
    m.pos = [n.legFrom[0] + dir[0] * s + right[0] * off, 0, n.legFrom[2] + dir[2] * s + right[2] * off];
    m.yaw = turnTo(m.yaw, Math.atan2(-dir[0], -dir[2]), dt * 10);
    m.walk += dt * 11;
    m.walking = 1;
    if (s >= len - 1e-3) {
      n.legFrom = [...to];
      n.legDone = 0;
      n.path.shift();
      if (!n.path.length) {
        m.pos = [...to];
        // They get jumpier as Timmy warms up: longer and longer before they dare pop up.
        this.moleWait(n, rand(0.5, 2.2) * (1 + this.heat() * 1.5));
      }
    }
    void i;
  }

  private moleSay(n: MoleNpc | undefined, text: string, seconds: number) {
    if (!n) return;
    n.label.text = text;
    n.labelT = seconds;
  }

  private nearestMole(): MoleNpc {
    const p = this.ctx.player.pos;
    let best = this.moles[0], bd = Infinity;
    for (const n of this.moles) {
      const d = Math.hypot(n.m.pos[0] - p[0], n.m.pos[2] - p[2]);
      if (d < bd) {
        bd = d;
        best = n;
      }
    }
    return best;
  }

  // --- Timmy and his mallet -------------------------------------------------------------------------

  /**
   * What Timmy goes for: the newest thing sticking out of a hole (you or a mole), unless you've
   * been up so long he can't help noticing you.
   */
  private newestTarget(): { hole: number; since: number } | null {
    const pop = this.pop;
    const up = pop && !this.death && (pop.state === 'rise' || pop.state === 'up');
    if (up && this.t - pop.since > this.tune01(PATIENCE)) return { hole: pop.hole, since: pop.since };
    // Once he's noticed carrots going missing, anyone popping up by one is the prime suspect.
    if (up && this.collected > 0 && this.carrots.some((c) => c.hole === pop.hole)) return { hole: pop.hole, since: pop.since };
    let best: { hole: number; since: number } | null = null;
    for (const n of this.moles) {
      if ((n.state === 'rise' || n.state === 'up') && (!best || n.since > best.since)) best = { hole: n.hole, since: n.since };
    }
    if (up && (!best || pop.since >= best.since)) best = { hole: pop.hole, since: pop.since };
    return best;
  }

  private commit(hole: number) {
    const ms = this.ms;
    // Uh-oh: a rising whistle when it's you he's going for.
    if (this.pop && this.pop.hole === hole && !this.death) tone(500, 0.35, { to: 1300, wave: 'sine', vol: 0.09 });
    ms.state = 'travel';
    ms.t = 0;
    ms.hole = hole;
    ms.bored = 0;
    ms.boredLimit = rand(1.6, 3.2);
  }

  private updateMallet(dt: number) {
    const ms = this.ms, mal = this.mallet;
    ms.t += dt;
    const mallAlive = (this.phase === 'ready' && this.g >= MALLET_LIVE_AT) || this.phase === 'play' || this.phase === 'won' || this.phase === 'break';
    const k = (rate: number) => 1 - Math.exp(-dt * rate);
    const aimTo = (p: Vec3, speed: number) => {
      const d = sub(p, mal.aim);
      const dist = Math.hypot(d[0], d[2]);
      const step = Math.min(dist, speed * dt);
      if (dist > 1e-4) mal.aim = [mal.aim[0] + (d[0] / dist) * step, DECK_TOP, mal.aim[2] + (d[2] / dist) * step];
      return dist - step;
    };
    const wander: Vec3 = [Math.sin(this.t * 0.45) * 4, DECK_TOP, 1 + Math.cos(this.t * 0.31) * 3.5];
    mal.squash = Math.max(0, mal.squash - dt * 5);

    switch (ms.state) {
      case 'away': {
        // Held up behind the south wall while Timmy rises (or sinks away in a sulk at the end).
        aimTo([2, DECK_TOP, 15], 10);
        mal.swing += (0.8 - mal.swing) * k(4);
        mal.lift += (4 + this.giant.root[1] - mal.lift) * k(8);
        if (mallAlive && this.giant.root[1] > -1 && this.phase !== 'won') {
          ms.state = 'idle';
          ms.t = 0;
        }
        break;
      }
      case 'idle': {
        const best = this.phase === 'break' ? null : this.newestTarget();
        // (Higher near the south wall, so his hand clears it.)
        const high = 0.9 + clamp((mal.aim[2] - 6.5) / 2, 0, 1) * 3.1;
        mal.lift += (high + Math.sin(this.t * 2.1) * 0.25 - mal.lift) * k(3);
        mal.swing += (0.55 + Math.sin(this.t * 1.7) * 0.08 - mal.swing) * k(4);
        if (this.phase === 'break') {
          if (ms.t > 0.3) {
            ms.state = 'rest';
            ms.t = 0;
          }
          aimTo(wander, 4);
          break;
        }
        if (ms.tantrum > 0) {
          const options = HOLES.map((_, h) => h).filter((h) => h !== this.pop?.hole || ms.tantrum < 3);
          this.commit(pick(options));
          ms.tantrum--;
          break;
        }
        if (this.phase === 'won') {
          // Stunned, then (after the tantrum) off to sulk.
          aimTo(wander, 3);
          if (this.wonT > 6.2) {
            ms.state = 'away';
            ms.t = 0;
          }
          break;
        }
        if (best) {
          ms.bored = 0;
          aimTo(HOLES[best.hole], this.tune01(TRAVEL_SPEED) * 0.3);
          if (this.t - best.since >= this.tune01(REACTION) && ms.t > 0.05) this.commit(best.hole);
        } else {
          // Nothing up: he hovers over the carrots, which is where the moles keep turning up.
          ms.camp -= dt;
          const carrotHoles = this.carrots.map((c) => c.hole);
          if (ms.camp <= 0 || !carrotHoles.includes(ms.campHole)) {
            ms.camp = rand(2.5, 4.5);
            ms.campHole = carrotHoles.length ? pick(carrotHoles) : -1;
          }
          if (ms.campHole >= 0) {
            const hc = HOLES[ms.campHole];
            aimTo([hc[0] + Math.sin(this.t * 1.3) * 0.6, DECK_TOP, hc[2] + Math.cos(this.t * 1.1) * 0.6], 6);
          } else aimTo(wander, 3);
          ms.bored += dt;
          if (ms.bored > ms.boredLimit && this.phase !== 'ready') {
            // Bored: slam a hole anyway (often one with a carrot by it).
            const withCarrot = this.carrots.map((c) => c.hole);
            this.commit(withCarrot.length && Math.random() < 0.45 ? pick(withCarrot) : Math.floor(Math.random() * HOLES.length));
          }
        }
        break;
      }
      case 'travel': {
        // On his way to a mole he'll change his mind for a carrot thief (not once he's winding up).
        const pop = this.pop;
        if (pop && !this.death && ms.tantrum <= 0 && pop.hole !== ms.hole && (pop.state === 'rise' || pop.state === 'up') &&
            this.collected > 0 && this.carrots.some((c) => c.hole === pop.hole) && this.t - pop.since >= this.tune01(REACTION)) {
          this.commit(pop.hole);
          this.timmySay(pick(['HEY!', 'THERE YOU ARE!', 'CARROT THIEF!']), 1.2);
        }
        const fast = ms.tantrum > 0 || this.phase === 'won' ? 22 : this.tune01(TRAVEL_SPEED);
        const left = aimTo(HOLES[ms.hole], fast);
        mal.lift += (1.0 - mal.lift) * k(6);
        mal.swing += (0.6 - mal.swing) * k(6);
        if (left < 0.05) {
          ms.state = 'windup';
          ms.t = 0;
          ms.dur = this.phase === 'won' ? 0.35 : this.tune01(WINDUP);
          tone(150, ms.dur, { to: 330, wave: 'sawtooth', vol: 0.03, attack: 0.1 });
          noise(ms.dur, { freq: 200, to: 900, type: 'bandpass', q: 2, vol: 0.08 });
        }
        break;
      }
      case 'windup': {
        const u = clamp(ms.t / ms.dur, 0, 1);
        const e = ease(u);
        mal.aim = [...HOLES[ms.hole]];
        mal.swing = lerp(mal.swing, lerp(0.6, 1.05, e), k(20));
        mal.lift = lerp(mal.lift, lerp(1.0, 1.6, e), k(20));
        this.giant.lean += dt * 0.02;
        if (u >= 1) {
          ms.state = 'smash';
          ms.t = 0;
          ms.dur = this.tune01(SMASH);
          noise(0.14, { freq: 350, to: 2200, type: 'bandpass', q: 1.2, vol: 0.35 });
        }
        break;
      }
      case 'smash': {
        const u = clamp(ms.t / ms.dur, 0, 1);
        mal.swing = lerp(1.05, 0, u * u);
        mal.lift = lerp(1.6, 0, u * u);
        if (u >= 1) {
          ms.state = 'impact';
          ms.t = 0;
          ms.dur = 0.14;
          mal.swing = 0;
          mal.lift = 0;
          mal.squash = 1;
          this.impact(ms.hole);
        }
        break;
      }
      case 'impact': {
        mal.swing = 0;
        mal.lift = 0;
        // Pressing down on the pancake a moment longer, if it was you.
        if (ms.t >= ms.dur + (this.pancake && this.pancake.t < 1 ? 0.45 : 0)) {
          ms.state = 'recover';
          ms.t = 0;
          ms.dur = this.tune01(RECOVER);
        }
        break;
      }
      case 'recover': {
        const u = ease(clamp(ms.t / ms.dur, 0, 1));
        mal.swing = lerp(0, 0.55, u);
        mal.lift = lerp(0, 0.9, u);
        if (u >= 1) {
          // Got you: he holds it up out of the way to admire his work.
          ms.state = this.death ? 'rest' : 'idle';
          ms.t = 0;
          ms.hole = -1;
        }
        break;
      }
      case 'rest': {
        // Held up out of the way (by the south wall) while he looks for a coin, or gloats.
        aimTo([1, DECK_TOP, 8.5], 8);
        mal.swing += (0.75 - mal.swing) * k(3);
        mal.lift += (3.5 - mal.lift) * k(3);
        if (this.phase !== 'break' && !this.death) {
          ms.state = 'idle';
          ms.t = 0;
        }
        break;
      }
    }
    // A popped-up player rising into a mallet that's still down on their hole.
    const pop = this.pop;
    if (pop && !this.death && pop.hole === ms.hole && (ms.state === 'impact' || (ms.state === 'recover' && ms.t < 0.12)) &&
        this.ctx.player.pos[1] + 1.8 > HIT_LINE) {
      pop.intoMallet = true;
      this.whacked();
    }

    // The handle comes in from Timmy's side; he watches what he's aiming at.
    const want = normalize([mal.aim[0] - 4, 0, mal.aim[2] - 24]);
    mal.from = normalize([mal.from[0] + (want[0] - mal.from[0]) * k(5), 0, mal.from[2] + (want[2] - mal.from[2]) * k(5)]);
    this.giant.lookTarget = ms.state === 'away' ? [0, 0, 0] : mal.aim;
    this.giant.update(dt, mal.grip());
  }

  /** BONK: whatever sticks out of hole `h` is flattened. */
  private impact(h: number) {
    const { player, camera } = this.ctx;
    const hc = HOLES[h];
    const dist = Math.hypot(player.pos[0] - hc[0], player.pos[2] - hc[2]);
    camera.addShake(clamp(1 - dist * 0.07, 0.25, 0.9));
    const vol = clamp(1.1 - dist / 25, 0.35, 1);
    tone(700, 0.09, { to: 160, wave: 'sine', vol: 0.5 * vol });
    tone(170, 0.45, { to: 55, wave: 'triangle', vol: 0.45 * vol });
    noise(0.18, { freq: 900, to: 120, vol: 0.55 * vol });
    tone(95, 0.35, { to: 190, wave: 'sine', vol: 0.18 * vol, at: 0.06 });
    // Dust.
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2 + Math.random() * 0.3;
      this.particles.push({ pos: [hc[0] + Math.cos(a) * 1.2, DECK_TOP + 0.15, hc[2] + Math.sin(a) * 1.2], vel: [Math.cos(a) * rand(2, 4), rand(0.3, 1.5), Math.sin(a) * rand(2, 4)], age: 0, life: 0.6, kind: 'dust', spin: 0 });
    }
    // Carrots by the hole jump.
    for (const c of this.carrots) if (c.hole === h) c.hop = 0.45;
    let hit = false;
    for (let i = 0; i < this.moles.length; i++) {
      const n = this.moles[i];
      if (n.hole !== h || !(n.state === 'rise' || n.state === 'up' || n.state === 'sink')) continue;
      if (n.m.pos[1] + MOLE_HEIGHT < HIT_LINE) continue;
      hit = true;
      n.state = 'bonked';
      n.t = 0;
      n.m.flash = 1;
      n.m.wiggle = 0;
      n.m.armsUp = 0;
      this.score += 100;
      this.moleSay(n, pick(['OW!', 'My spine!', 'Ooh... birdies...', 'Not again...', 'Mommy?', 'I felt that.']), 1.6);
      tone(1500, 0.1, { to: 2600, wave: 'square', vol: 0.05 });
      tone(2200, 0.14, { to: 1300, wave: 'square', vol: 0.05, at: 0.1 });
      this.burstStars(add(hc, [0, 0.4, 0]));
    }
    const pop = this.pop;
    if (pop && !this.death && pop.hole === h && player.pos[1] + 1.8 > HIT_LINE) {
      this.whacked();
      this.burstStars(add(hc, [0, 0.4, 0]));
      hit = true;
    }
    this.ms.hitMole = hit;
    if (!this.death) this.flash = hit ? { text: pick(['WHACK!', 'BONK!', 'GOT ONE!']), t: 0.9 } : { text: 'MISS!', t: 0.7 };
    if (!this.death) {
      if (hit) {
        if (Math.random() < 0.6) this.timmySay(pick(['GOT ONE!', 'HEHEHE', 'BONK!', 'TAKE THAT!', '100 POINTS!']), 1.2);
        if (Math.random() < 0.35) sfx.laugh(0.1);
      } else if (this.phase !== 'won' && Math.random() < 0.45) {
        this.timmySay(pick(['AWW!', 'NO FAIR!', 'STAY STILL!', 'HEY!', 'WHERE’D IT GO?']), 1.2);
      }
    }
  }

  private burstStars(p: Vec3) {
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * Math.PI * 2;
      this.particles.push({ pos: [...p], vel: [Math.cos(a) * 3.2, rand(3, 5), Math.sin(a) * 3.2], age: 0, life: 0.8, kind: 'star', spin: rand(-8, 8) });
    }
  }

  private timmySay(text: string, seconds: number) {
    this.timmyLabel.text = text;
    this.timmyT = seconds;
  }

  // --- Carrots ------------------------------------------------------------------------------------

  private spawnCarrot() {
    const pop = this.pop;
    const taken = new Set(this.carrots.map((c) => c.hole));
    const steps = (a: number, b: number) => Math.abs((a % HOLE_COLS) - (b % HOLE_COLS)) + Math.abs(Math.floor(a / HOLE_COLS) - Math.floor(b / HOLE_COLS));
    // Spread out, and the first ones not right by where you land (no grabbing one before Timmy's even up).
    const options = HOLES.map((_, h) => h).filter((h) => !taken.has(h) && h !== pop?.hole &&
      (this.phase !== 'intro' || steps(h, SPAWN_HOLE) > 1) && this.carrots.every((c) => steps(c.hole, h) > 1));
    const pool = options.length ? options : HOLES.map((_, h) => h).filter((h) => !taken.has(h) && h !== pop?.hole);
    const hole = pick(pool);
    // Point it away from the nearest wall (so it's easy to see from the middle).
    const hc = HOLES[hole];
    const base = Math.atan2(hc[2] === 0 ? (Math.random() < 0.5 ? 1 : -1) : Math.sign(hc[2]) * 0.3, hc[0] === 0 ? 1 : Math.sign(hc[0]));
    this.carrots.push({ hole, angle: base + rand(-0.9, 0.9), age: 0, hop: 0 });
    tone(520, 0.08, { to: 900, wave: 'sine', vol: 0.08 });
  }

  private updateCarrots(dt: number) {
    for (const c of this.carrots) {
      c.age += dt;
      c.hop = Math.max(0, c.hop - dt);
    }
    if (this.carrotRespawn > 0) {
      this.carrotRespawn -= dt;
      if (this.carrotRespawn <= 0 && this.collected + this.carrots.length < CARROTS_NEEDED) this.spawnCarrot();
    }
  }

  /** Where a carrot's leafy top is. */
  private carrotTop(c: Carrot): Vec3 {
    const hc = HOLES[c.hole];
    const hop = c.hop > 0 ? Math.sin((c.hop / 0.45) * Math.PI) * 0.5 : 0;
    return [hc[0] + Math.cos(c.angle) * CARROT_IN, DECK_TOP + RIM_H + CARROT_R + hop, hc[2] + Math.sin(c.angle) * CARROT_IN];
  }

  private crunch() {
    for (let k = 0; k < 3; k++) noise(0.05, { freq: 3500, type: 'bandpass', q: 1.5, vol: 0.4, at: k * 0.08 });
    tone(note('C6'), 0.1, { wave: 'square', vol: 0.06, at: 0.24 });
    tone(note('G6'), 0.22, { wave: 'square', vol: 0.06, at: 0.32 });
  }

  private coin() {
    tone(note('B5'), 0.08, { wave: 'square', vol: 0.1 });
    tone(note('E6'), 0.45, { wave: 'square', vol: 0.1, at: 0.08 });
  }

  private jingle(notes: string[], step: number, wave: OscillatorType = 'square') {
    notes.forEach((n, i) => tone(note(n), i === notes.length - 1 ? step * 4 : step * 1.2, { wave, vol: 0.09, at: i * step }));
  }

  // --- Effects, pads, lighting ----------------------------------------------------------------------

  private updateEffects(dt: number) {
    for (const p of this.particles) {
      p.age += dt;
      p.vel[1] -= (p.kind === 'star' ? 12 : 2) * dt;
      p.pos = add(p.pos, scale(p.vel, dt));
      if (p.kind === 'dust') p.vel = scale(p.vel, Math.exp(-dt * 4));
    }
    this.particles = this.particles.filter((p) => p.age < p.life);
    const pc = this.pancake;
    if (pc) {
      pc.t += dt;
      // After a moment on show, the pancake slips down the hole (slide whistle).
      if (pc.t > PANCAKE_SHOW && pc.t - dt <= PANCAKE_SHOW) tone(1100, 0.6, { to: 160, wave: 'sine', vol: 0.15 });
    }
    // The on-screen carrot count, pinned near the top of the view once you've got one.
    this.counterLabel.text = this.collected > 0 && !this.death && this.phase !== 'won' ? `CARROTS ${this.collected}/${CARROTS_NEEDED}` : '';
  }

  private updatePads() {
    const ms = this.ms;
    const flash = ms.state === 'windup' || ms.state === 'smash' ? Math.sin(this.t * 40) > 0 : Math.sin(this.t * 20) > -0.2;
    for (let h = 0; h < HOLES.length; h++) {
      const user = this.holeUser[h];
      let lift = 0;
      if (user === 'player' && this.pop) lift = Math.max(0, this.ctx.player.pos[1]);
      else if (typeof user === 'number') {
        const n = this.moles[user];
        if (n.hole === h && (n.state === 'rise' || n.state === 'up' || n.state === 'sink')) lift = Math.max(0, n.m.pos[1]);
      }
      this.lifts[h] = lift;
      const g = this.glows[h];
      const targeted = ms.hole === h && (ms.state === 'travel' || ms.state === 'windup' || ms.state === 'smash' || ms.state === 'impact');
      if (targeted) {
        const on = flash ? 1 : 0.15;
        g[0] = 3.2 * on; g[1] = 0.22 * on; g[2] = 0.12 * on;
      } else if (this.carrots.some((c) => c.hole === h)) {
        const p = 0.7 + 0.3 * Math.sin(this.t * 5);
        g[0] = 2.8 * p; g[1] = 0.75 * p; g[2] = 0.05 * p;
      } else {
        g[0] = PAD_IDLE[0]; g[1] = PAD_IDLE[1]; g[2] = PAD_IDLE[2];
      }
    }
  }

  private updateEnvironment(dt: number) {
    const { camera, player } = this.ctx;
    const below = camera.pos[1] < DECK_TOP - DECK_T / 2 ? 1 : 0;
    this.under += (below - this.under) * (1 - Math.exp(-dt * 8));
    const u = this.under;
    const e = this.env;
    const mix = (out: number[], a: number[], b: number[]) => {
      for (let i = 0; i < 3; i++) out[i] = a[i] + (b[i] - a[i]) * u;
    };
    mix(e.skyColor as number[], [0.2, 0.3, 0.5], [0.13, 0.11, 0.095]);
    mix(e.groundColor as number[], [0.22, 0.2, 0.18], [0.15, 0.115, 0.085]);
    mix(e.fogColor as number[], [0.72, 0.8, 0.9], [0.06, 0.045, 0.035]);
    e.fogDensity = lerp(0.003, 0.02, u);
    const pl = e.pointLight!;
    pl.pos[0] = clamp(player.pos[0], -H + 1, H - 1);
    pl.pos[1] = 2.15;
    pl.pos[2] = clamp(player.pos[2], -H + 1, H - 1);
  }

  // --- Queries ------------------------------------------------------------------------------------

  /** The hole nearest `p` horizontally, if within `range` (else -1). */
  private nearestHole(p: Vec3, range: number) {
    let best = -1, bd = range;
    for (let h = 0; h < HOLES.length; h++) {
      const d = Math.hypot(HOLES[h][0] - p[0], HOLES[h][2] - p[2]);
      if (d < bd) {
        bd = d;
        best = h;
      }
    }
    return best;
  }

  // --- Camera -------------------------------------------------------------------------------------

  cameraShot(): CameraShot | null {
    const arrival = this.arrival.cameraShot();
    if (arrival) return arrival;
    const { camera, player } = this.ctx;
    const pc = this.pancake;
    if (pc) {
      // Looking down at the pancake (and then down the hole after it).
      // From the north (the mallet comes and goes on the south side), looking down at it.
      const hole: Vec3 = [pc.feet[0], DECK_TOP, pc.feet[2]];
      const side = hole[0] > 0 ? -1 : 1;
      const pos: Vec3 = [hole[0] + side * 0.9, DECK_TOP + 3.0, Math.max(-H + 0.5, hole[2] - 3.1)];
      return { pos, target: add(hole, [0, -0.1, 0.5]), sharpness: 3 };
    }
    const cp = Math.cos(camera.pitch), sp = Math.sin(camera.pitch);
    const fwd: Vec3 = [-Math.sin(camera.yaw) * cp, sp, -Math.cos(camera.yaw) * cp];
    const right: Vec3 = [Math.cos(camera.yaw), 0, -Math.sin(camera.yaw)];
    const feet = player.pos;
    const pop = this.pop;
    const wantUp = this.phase === 'intro' || (this.drop !== null && this.drop.t < this.drop.slide + 0.36) || (pop !== null && pop.state !== 'sink');
    // Popped up: further back and higher, so the hole, the mallet and Timmy all fit in the view.
    const popped = pop !== null && pop.state !== 'sink';
    const shoulder = add(add(feet, [0, popped ? 3.4 : 1.65, 0]), scale(right, popped ? 0.2 : 0.6));
    const pos = sub(shoulder, scale(fwd, popped ? 7.2 : 3.2));
    const lim = H - 0.3;
    const cx = clamp(pos[0], -lim, lim), cz = clamp(pos[2], -lim, lim);
    const pushed = Math.hypot(pos[0] - cx, pos[2] - cz);
    pos[0] = cx;
    pos[2] = cz;
    pos[1] += pushed * 0.8;
    // Up on the deck (arriving, or popped up), or down in the burrow.
    if (wantUp) pos[1] = Math.max(pos[1], DECK_TOP + 0.55);
    else pos[1] = clamp(pos[1], 0.35, UNDER - 0.22);
    // Changing sides (popping up, ducking, dropping in): cut straight to the other side of the deck.
    const camAbove = camera.pos[1] > DECK_TOP - DECK_T / 2;
    return { pos, target: add(shoulder, scale(fwd, 10)), sharpness: wantUp !== camAbove ? 1e4 : 18 };
  }

  // --- Drawing ------------------------------------------------------------------------------------

  draw(out: DrawItem[], time: number) {
    this.arrival.draw(out);
    this.exit.draw(out);
    this.cabinet.draw(out, time);
    this.cabinet.drawPads(out, this.lifts, this.glows);
    this.board.draw(out, time);

    // Timmy (no shadow: he's outside, really), and his mallet (which does cast one).
    const first = out.length;
    this.giant.draw(out);
    for (let i = first; i < out.length; i++) out[i].shadow = false;
    this.mallet.draw(out);
    this.drawTargeting(out);

    for (const n of this.moles) n.m.draw(out);
    for (const c of this.carrots) this.drawCarrot(out, this.carrotFrame(c), c.age < 0.3 ? ease(c.age / 0.3) : 1);
    this.drawHeldCarrot(out);
    this.drawStash(out);
    this.drawPancake(out);

    for (const p of this.particles) {
      const a = 1 - p.age / p.life;
      if (p.kind === 'dust') {
        const r = 0.18 + p.age * 0.7;
        out.push({ mesh: 'sphere', model: mul(translation(p.pos), scaling([r, r * 0.7, r])), color: [0.85, 0.82, 0.78], opacity: 0.55 * a, shadow: false });
      } else {
        drawStar(out, mul(translation(p.pos), rotationY(p.age * p.spin), rotationX(Math.PI / 2)), 0.16, STAR_COLOR, 0.03, { pattern: Pattern.emissive });
      }
    }
  }

  /** The red ring round the hole the mallet is going for (on the deck and under it), and the head's shadow. */
  private drawTargeting(out: DrawItem[]) {
    const ms = this.ms;
    const targeted = ms.hole >= 0 && (ms.state === 'travel' || ms.state === 'windup' || ms.state === 'smash');
    if (targeted) {
      const hc = HOLES[ms.hole];
      const fast = ms.state !== 'travel';
      const pulse = 0.55 + 0.45 * Math.sin(this.t * (fast ? 30 : 12));
      const c = [3.0 * pulse + 0.4, 0.15, 0.1];
      out.push({ mesh: 'tube', model: mul(translation([hc[0], DECK_TOP + RIM_H + 0.015, hc[2]]), scaling([1.78, 0.03, 1.78])), color: c, pattern: Pattern.emissive, shadow: false });
      out.push({ mesh: 'tube', model: mul(translation([hc[0], UNDER - 0.02, hc[2]]), scaling([1.05, 0.03, 1.05])), color: c, pattern: Pattern.emissive, shadow: false });
    }
  }

  /** A carrot's frame: origin at its leafy top, +x along it to the tip (tilted down onto the deck). */
  private carrotFrame(c: Carrot): Mat4 {
    const top = this.carrotTop(c);
    const tilt = Math.atan2(RIM_H + CARROT_R - 0.04, CARROT_LEN);
    const wob = c.hop > 0 ? Math.sin(c.hop * 30) * 0.2 : 0;
    return mul(translation(top), rotationY(-c.angle), rotationZ(-tilt + wob));
  }

  /** Draws a giant carrot in `f` (origin at the top, +x to the tip), scaled by `s`. */
  private drawCarrot(out: DrawItem[], f: Mat4, s: number, glow = 0) {
    const first = out.length;
    const m = mul(f, scaling([s, s, s]));
    out.push({ mesh: 'cone', model: mul(m, translation([CARROT_LEN / 2, 0, 0]), rotationZ(-Math.PI / 2), scaling([CARROT_R, CARROT_LEN, CARROT_R])), color: ORANGE, spec: 0.3 });
    out.push({ mesh: 'sphere', model: mul(m, scaling([0.05, CARROT_R * 0.98, CARROT_R * 0.98])), color: ORANGE, spec: 0.3 });
    for (const x of [0.28, 0.55, 0.8]) {
      const r = CARROT_R * (1 - x / CARROT_LEN) * 1.04;
      out.push({ mesh: 'cylinder', model: mul(m, translation([x, 0, 0]), rotationZ(Math.PI / 2), scaling([r, 0.025, r])), color: [0.8, 0.3, 0.03] });
    }
    // Leaves, drooping over the rim into the hole (you can see them from below).
    for (const [z, droop] of [[-0.08, 0.3], [0, 0.42], [0.08, 0.34], [0.03, 0.2]] as [number, number][]) {
      const a: Vec3 = [-0.02, 0.04, z * 0.5];
      const b: Vec3 = [-0.3, 0.14, z * 1.6];
      const c: Vec3 = [-0.55, 0.14 - droop, z * 2.2];
      out.push({ mesh: 'cylinder', model: mul(m, segment(a, b, 0.03)), color: LEAF });
      out.push({ mesh: 'cylinder', model: mul(m, segment(b, c, 0.025)), color: LEAF });
      out.push({ mesh: 'sphere', model: mul(m, translation(c), scaling([0.09, 0.03, 0.06])), color: [0.18, 0.55, 0.12] });
    }
    if (glow > 0) for (let i = first; i < out.length; i++) out[i].highlight = glow;
  }

  private drawHeldCarrot(out: DrawItem[]) {
    const pop = this.pop;
    if (!pop?.grab) return;
    const g = pop.grab;
    const frames = this.ctx.player.partFrames();
    const f = frames.foreArmR;
    const hand: Vec3 = [f[12] - f[4] * 0.2, f[13] - f[5] * 0.2, f[14] - f[6] * 0.2];
    const k = clamp(g.t / GRAB_TIME, 0, 1);
    if (k < 1) {
      const p: Vec3 = [lerp(g.from[0], hand[0], k), lerp(g.from[1], hand[1], k) + Math.sin(k * Math.PI) * 0.4, lerp(g.from[2], hand[2], k)];
      this.drawCarrot(out, mul(translation(p), rotationY(-g.carrot.angle), rotationZ(-k * 1.2)), 1);
    } else {
      // Held up high, leaves in the fist, like a trophy.
      this.drawCarrot(out, mul(translation(hand), rotationY(-this.ctx.player.facing - Math.PI / 2), rotationZ(Math.PI / 2 - 0.25)), 0.8);
    }
  }

  /** Carrots you've got down to the burrow, in a heap by the exit. */
  private drawStash(out: DrawItem[]) {
    for (let i = 0; i < this.stash; i++) {
      const a = i * 2.1;
      const p: Vec3 = [10.2 + Math.cos(a) * 0.35, 0.18 + Math.floor(i / 3) * 0.3, -2.6 + Math.sin(a) * 0.45];
      this.drawCarrot(out, mul(translation(p), rotationY(a * 1.7), rotationZ(0.1)), 0.8);
    }
  }

  /**
   * You, flattened: a person-shaped pancake lying spread-eagled over the hole with stars going
   * round, which then tips up and slips down the hole like a letter into a letterbox.
   */
  private drawPancake(out: DrawItem[]) {
    const pc = this.pancake;
    if (!pc) return;
    const t = pc.t;
    const tip = clamp((t - PANCAKE_SHOW) / 0.25, 0, 1);
    const fall = Math.max(0, t - PANCAKE_SHOW - 0.25);
    const y = lerp(DECK_TOP + RIM_H + 0.05, DECK_TOP - 0.35, ease(tip)) - 7 * fall * fall;
    if (y < DECK_TOP - 3.5) return;
    const first = out.length;
    const pose: Pose = { lean: 0, headPitch: 0, shoulderL: 0.15, shoulderR: 0.15, armOut: 1.35, elbowL: 0.05, elbowR: 0.05, hipL: 0.15, hipR: -0.15, kneeL: 0, kneeR: 0 };
    drawBody(out, poseFrames(translation([0, -0.98, 0]), pose));
    // Lying face up (head away from the camera, which looks on from the north), squashed thin.
    const centre: Vec3 = [pc.feet[0], y, pc.feet[2]];
    const w = mul(translation(centre), rotationX((Math.PI / 2) * (1 - tip)), scaling([1.25, 1.15, 0.22]));
    for (let i = first; i < out.length; i++) out[i].model = mul(w, out[i].model);
    if (tip < 1) {
      const head: Vec3 = [centre[0], centre[1] + 0.25, centre[2] + 0.85 * (1 - tip)];
      drawDazedStars(out, head, 0.55, this.t, 0.22);
    }
  }

  // --- Level interface bits -----------------------------------------------------------------------

  labels(): WorldLabel[] {
    const list = this.labelList;
    list.length = 0;
    if (this.timmyLabel.text) list.push(this.timmyLabel);
    for (const n of this.moles) if (n.label.text) list.push(n.label);
    if (this.under > 0.5) for (const s of this.signs) list.push(s);
    if (this.counterLabel.text) {
      // Pinned just under the top of the view.
      const { camera } = this.ctx;
      const cp = Math.cos(camera.pitch), sp = Math.sin(camera.pitch);
      const fwd: Vec3 = [-Math.sin(camera.yaw) * cp, sp, -Math.cos(camera.yaw) * cp];
      const up: Vec3 = [Math.sin(camera.yaw) * sp, cp, Math.cos(camera.yaw) * sp];
      this.counterLabel.pos = add(add(camera.pos, scale(fwd, 3)), scale(up, 1.2));
      list.push(this.counterLabel);
    }
    return list;
  }

  trackedTargets(): TrackedTarget[] {
    const list: TrackedTarget[] = [];
    const exit = this.exit.target();
    if (exit) list.push(exit);
    // Popped up: flag the mallet when it's coming for anyone.
    const ms = this.ms;
    if (this.pop && this.pop.state !== 'sink' && !this.death && ms.hole >= 0 && (ms.state === 'travel' || ms.state === 'windup' || ms.state === 'smash')) {
      list.push({ pos: this.mallet.headCentre(), radius: MALLET_HEAD_R * 1.2 });
    }
    return list;
  }

  environment() {
    return this.env;
  }

  obstacles() {
    return this.obstacleList;
  }
}

/** Turns angle `a` toward `b` by at most `step` radians. */
function turnTo(a: number, b: number, step: number) {
  const d = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + clamp(d, -step, step);
}

