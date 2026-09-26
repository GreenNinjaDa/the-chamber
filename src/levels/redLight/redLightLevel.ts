import { clamp, length, mul, normalize, rotationY, scaling, segment, sub, toQuat, translation, type Vec3 } from '../../engine/math';
import { GROUPS_QUERY_WORLD, RAPIER, type Body } from '../../engine/physics';
import { Pattern, type DrawItem, type Environment } from '../../engine/renderer';
import { Contestant, type ContestantLook } from '../../entities/contestant';
import { BareTree, Doll, DOLL_HEAD_Y } from '../../entities/doll';
import { junk, spawnJunk } from '../../entities/junk';
import { ExitPortal, PortalArrival } from '../../entities/portal';
import { CHAMBER_HALF } from '../../game/chamber';
import type { Circle } from '../../game/player';
import { DEFAULT_ENV, type CameraShot, type Level, type LevelContext, type LevelStatus, type TrackedTarget, type WorldLabel } from '../level';

/*
 * Red Light, Green Light. A giant doll stands by the east wall with her back to the room,
 * chanting. While she chants, move; when her head whips round, freeze, or her eyes laser you
 * across the chamber. Cross the red line before the clock on the north wall runs out. Other
 * test subjects in green tracksuits play too, and demonstrate the rules the hard way. Junk
 * blocks her view: moving while hidden is fine.
 */

// --- Tuning -----------------------------------------------------------------------------------
const DOLL_POS: Vec3 = [9.5, 0, -5];
/** Her body faces the east wall (+x). */
const DOLL_YAW = -Math.PI / 2;
const TREE_POS: Vec3 = [10.6, 0, -9.6];
/** The finish line (red tape across the floor) and the start line. */
const FINISH_X = 7;
const START_X = -10.4;
const SPAWN: Vec3 = [-9.5, 0, 0];
const EXIT_Z = 5;
/** The clock on the north wall (s), counting from the first chant. */
const CLOCK = 60;
/** When the first chant starts (s after the level starts), and how long it lasts. */
const CHANT_START = 1.3;
const FIRST_GREEN = 3.2;
/**
 * Moving means going faster than this horizontally (m/s, measured from where the player actually
 * went), or jumping / falling faster than MOVE_VERTICAL, for at least MOVE_TIME in a row.
 */
const MOVE_SPEED = 0.3;
const MOVE_VERTICAL = 1.2;
const MOVE_TIME = 0.05;
/**
 * She has to see this many of your head, chest and pelvis (clear rays from her eyes) to count
 * you as seen. Two lets you hide behind a fridge with your head poking over it (from 6 m up,
 * most cover leaves the head showing), while anything lower than your chest won't do.
 */
const SEEN_PARTS = 2;
/**
 * She only starts looking this long after her head has finished turning. Stopping from a sprint
 * (8.5 m/s) takes about 0.42 s, from a walk 0.35 s, so reacting as her head starts to turn is
 * enough: with her fastest turn a sprinter can take ~0.35 s to react (measured), a walker more.
 * The first two red lights are more generous (extra seconds, per red light).
 */
const GRACE = 0.45;
const EXTRA_GRACE = [0.5, 0.2];
/** How long her head takes to whip round, per red light (the last value repeats). */
const TURN_TIMES = [0.5, 0.45, 0.4, 0.35];
const TURN_BACK = 0.55;
/** Which green light has the fake-out (she starts to turn, then doesn't). */
const FAKE_OUT_GREEN = 3;
const FAKE_OUT_TIME = 0.8;
/** Her slow, smug 360 when you cross the line. */
const SPIN_TIME = 3.5;
const LASER_TIME = 0.35;
const DEATH_SCREEN_DELAY = 1.6;
/** From this red light on, player 001 doesn't bother to stop. She doesn't mind. */
const OLD_MAN_CHEATS_FROM = 4;

// --- The chant ---------------------------------------------------------------------------------
const SYLLABLES = ['MU', 'GUNG', 'HWA', 'KKO', 'CHI', 'PI', 'EOT', 'SSEUM', 'NI', 'DA'];
const WORD_START = [0, 0, 0, 3, 3, 5, 5, 5, 5, 5];
/** What's shown after each syllable: the current word so far. */
const CHANT_TEXT = SYLLABLES.map((_, i) => {
  const word = SYLLABLES.slice(WORD_START[i], i + 1).join('');
  return i === SYLLABLES.length - 1 ? `${word}!` : i === 2 || i === 4 ? `${word}...` : word;
});
/** Relative gaps after each syllable (the last one lands as her head turns). */
const TEMPOS: number[][] = [
  [1, 1, 1.5, 1, 1.5, 1, 1, 1, 1], // steady
  [2.2, 2.2, 2.8, 0.6, 0.8, 0.45, 0.45, 0.4, 0.4], // slow, then gabbled
  [0.6, 0.6, 0.9, 0.6, 2.8, 1.6, 1.4, 1.2, 1.0], // quick, then drawn out
  [1, 1, 3.2, 1, 1, 0.5, 0.5, 0.35, 0.3], // MUGUNGHWAAAA... then in a hurry
  [0.5, 0.5, 0.6, 0.5, 0.6, 0.5, 0.5, 0.45, 0.45], // all in one breath
];

// --- The cast ----------------------------------------------------------------------------------
type Doom = 'runner' | 'wobble' | 'panic' | 'sneeze';

interface CastMember extends ContestantLook {
  z: number;
  speed: number;
  /** Eliminated in this red light (0 = the first), in this way. */
  doom?: { red: number; kind: Doom };
}

const CAST: CastMember[] = [
  { number: '324', z: -7.5, speed: 4.0, hair: [0.1, 0.08, 0.06], doom: { red: 0, kind: 'runner' } },
  { number: '067', z: -4.8, speed: 2.5, hair: [0.09, 0.06, 0.05], skin: [0.86, 0.68, 0.55] },
  { number: '218', z: -2.5, speed: 0.95, hair: [0.06, 0.05, 0.05], doom: { red: 4, kind: 'sneeze' } },
  { number: '101', z: 2.5, speed: 1.6, hair: [0.05, 0.05, 0.05], girth: 1.18, doom: { red: 2, kind: 'wobble' } },
  { number: '212', z: 5, speed: 1.2, hair: [0.32, 0.16, 0.08], skin: [0.9, 0.72, 0.6], doom: { red: 3, kind: 'panic' } },
  { number: '001', z: 7.6, speed: 0.55, hair: [0.86, 0.86, 0.84], skin: [0.8, 0.63, 0.52], old: true },
];

/** When (s after her head finishes turning) each kind of doomed contestant gets lasered. */
const DOOM_AT: Record<Doom, number> = { runner: 0.2, wobble: 1.5, panic: 1.4, sneeze: 1.35 };

/** Where contestants who made it go and stand (clear of the doll and the exit). */
const SPOTS: Vec3[] = [[10.6, 0, 10.2], [9.2, 0, 11], [8.3, 0, 9.6], [10.6, 0, -10.6], [8.9, 0, -10.2], [11, 0, 0.8]];

/** Heavy junk to hide behind: [name, x, z, yaw]. */
const COVER: [string, number, number, number][] = [
  ['fridge', -5.5, -6.3, 0.1],
  ['vending machine', -3.2, 3.8, -0.05],
  ['piano', -0.8, -1.9, Math.PI / 2 + 0.05],
  ['bookcase', 1.8, 7.2, Math.PI / 2],
  ['fridge', 2.6, -7.2, -0.1],
  ['vending machine', 4.2, 1.4, 0.05],
  ['couch', -2.4, 9.2, Math.PI / 2],
  ['crate', 0.8, 3.4, 0.2],
];

// --- Words -------------------------------------------------------------------------------------
const SEEN_LINES = [
  "You moved. She saw. That's the whole game.",
  "Red light means stop. It's right there in the name.",
  'She has one job, and she is very, very good at it.',
  "Statues don't fidget. Be a statue.",
];
const PARTIAL_LINES = [
  'She is seven metres tall. Your hiding spot was not.',
  'Half hidden is still half seen. It was the wrong half.',
];
const CHEAT_LINE = 'Yes, 001 moved too. He has... connections. You do not.';
const TIMEUP_LINES = [
  'The line was right there. So was the clock.',
  'Hiding forever is also a way to lose.',
  'Slow and steady loses the race, it turns out.',
];
const PASS_LINES = [
  'Congratulations. Your prize is another chamber.',
  'You have been promoted to: still alive.',
  'She will remember this. She remembers everything.',
];
const CONTROLS = 'WASD move · Shift sprint';
const SEEN_HINT = "Move only while she faces the wall, and stop the moment her head turns: stopping from a sprint takes a moment. She can't see through fridges.";
const TIMEUP_HINT = 'Cross the red line before the clock on the north wall runs out. Every green light counts.';

const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const smooth = (k: number) => k * k * (3 - 2 * k);
/** A whip: fast out, a touch of overshoot, settle. */
const whip = (k: number) => {
  const c = 1.4, x = k - 1;
  return 1 + (c + 1) * x * x * x + c * x * x;
};

type Phase = 'wait' | 'green' | 'turn' | 'red' | 'turnBack' | 'spin' | 'timeUp';

interface Npc {
  c: Contestant;
  cast: CastMember;
  label: WorldLabel;
  circle: Circle;
  /** Seconds into this green light before they set off / into a red light before they freeze. */
  startDelay: number;
  stopDelay: number;
  crossed: boolean;
  spot: Vec3 | null;
  cheered: boolean;
}

interface Beam {
  target: Vec3;
  t: number;
}

interface Death {
  t: number;
  big: string;
  small: string;
  hint: string;
}

export class RedLightLevel implements Level {
  readonly number: number;
  readonly title = 'Red Light, Green Light';
  status: LevelStatus = 'playing';
  private arrival: PortalArrival;
  private exit = new ExitPortal(EXIT_Z);
  private doll = new Doll(DOLL_POS, DOLL_YAW);
  private tree = new BareTree(TREE_POS);
  /** The finish line (red tape) and the start line (white tape). */
  private tapes: DrawItem[] = [
    { mesh: 'box', model: mul(translation([FINISH_X, 0.006, 0]), scaling([0.3, 0.012, CHAMBER_HALF * 2 - 0.02])), color: [0.85, 0.06, 0.05], shadow: false },
    { mesh: 'box', model: mul(translation([START_X - 0.45, 0.005, 0]), scaling([0.2, 0.01, CHAMBER_HALF * 2 - 0.02])), color: [0.95, 0.95, 0.93], shadow: false },
  ];
  private dollColliders = new Set<number>();
  private cover: { body: Body; r: number }[] = [];
  private npcs: Npc[] = [];
  private t = 0;
  private phase: Phase = 'wait';
  private phaseT = 0;
  private phaseLen = CHANT_START;
  /** Green lights started so far (the current one is cycle - 1), and the current / last red light. */
  private cycle = 0;
  private red = -1;
  private turnFrom = 0;
  private turnTime = 0.5;
  // The chant: time into it (paused during a fake-out), its length, and when each syllable lands.
  private chantT = 0;
  private chantLen = 0;
  private chantAt = new Array<number>(SYLLABLES.length).fill(0);
  private fake = -1; // time into the fake-out, or -1
  private fakeAt = -1; // chant time it starts at, or -1 for none this green
  private beams: Beam[] = [];
  private announceT = 0;
  private redness = 0;
  private cameraTurned = false;
  private crossed = false;
  /** Player movement bookkeeping (actual displacement, not intended velocity). */
  private lastPos: Vec3 = [...SPAWN];
  private moveTime = 0;
  private seenAt: Vec3 = [0, 0, 0];
  /** Player 001 moved during this red light (and got away with it). */
  private oldManMoved = false;
  private oldManExcused = false;
  private timeUpZaps = 0;
  private death: Death | null = null;
  private labelList: WorldLabel[] = [];
  private bubble: WorldLabel = { pos: [DOLL_POS[0], DOLL_HEAD_Y + 1.9, DOLL_POS[2]], text: '', size: 0.75, color: '#ffd23f' };
  private clock: WorldLabel = { pos: [5, 7.4, -CHAMBER_HALF + 0.05], text: '', size: 1.6, color: '#ff3b30' };
  private clockShows = -1;
  private circles: Circle[] = [];
  /** The sun comes from behind the start line, so her face is lit when she turns round. */
  private env: Environment = { ...DEFAULT_ENV, sunDir: [-0.45, 1.0, 0.55], sunColor: [...DEFAULT_ENV.sunColor], skyColor: [...DEFAULT_ENV.skyColor] };

  constructor(private ctx: LevelContext) {
    this.number = ctx.number;
    const { physics, hud } = ctx;
    hud.setLevel(`The Chamber · Level ${this.number}`);
    hud.show(`LEVEL ${this.number}`, '', 2.5);
    hud.hint('');
    this.arrival = new PortalArrival(ctx, SPAWN);

    for (const c of this.doll.addColliders(physics)) this.dollColliders.add(c.handle);
    // The tree's trunk.
    physics.addStaticCylinder([TREE_POS[0], 1.6, TREE_POS[2]], 0.34, 3.2);

    for (const [name, x, z, yaw] of COVER) {
      const def = junk(name);
      const h = def.size[1];
      const rot = toQuat(rotationY(yaw));
      const body = spawnJunk(physics, def, [x, h / 2 + 0.01, z], rot);
      this.cover.push({ body, r: Math.hypot(def.size[0], def.size[2]) / 2 });
      if (name === 'crate') {
        // Two crates stacked: about as tall as you, so just about cover.
        const top = spawnJunk(physics, def, [x + 0.05, h * 1.5 + 0.03, z - 0.04], toQuat(rotationY(yaw + 0.4)));
        this.cover.push({ body: top, r: 0.5 });
      }
    }

    CAST.forEach((cast) => {
      const c = new Contestant(cast, [START_X, 0, cast.z], -Math.PI / 2);
      const npc: Npc = {
        c, cast,
        label: { pos: [0, 0, 0], text: cast.number, size: 0.28, color: '#ffffff' },
        circle: { x: 0, z: 0, r: 0.3 },
        startDelay: 0, stopDelay: 0, crossed: false, spot: null, cheered: false,
      };
      this.npcs.push(npc);
    });
  }

  // --- Game flow -------------------------------------------------------------------------------

  private setPhase(phase: Phase, len = 0) {
    this.phase = phase;
    this.phaseT = 0;
    this.phaseLen = len;
  }

  private startGreen() {
    const n = this.cycle++;
    const len = n === 0 ? FIRST_GREEN : n === 1 ? 3.4 : n === 2 ? 3.0
      : rand(Math.max(1.5, 2.3 - 0.2 * (n - 3)), Math.max(1.9, 3.6 - 0.25 * (n - 3)));
    this.setPhase('green', len);
    this.chantT = 0;
    this.chantLen = len;
    const tempo = n === 0 ? TEMPOS[0] : pick(TEMPOS);
    const total = tempo.reduce((a, b) => a + b, 0);
    let acc = 0;
    for (let i = 0; i < SYLLABLES.length; i++) {
      this.chantAt[i] = (len * acc) / total;
      acc += tempo[i] ?? 0;
    }
    // The fake-out: she stops after "KKOCHI..." and starts to turn round. Then doesn't.
    this.fakeAt = n === FAKE_OUT_GREEN && !this.crossed ? this.chantAt[5] - 0.05 : -1;
    this.fake = -1;
    // (The doomed runner is off like a shot.)
    for (const npc of this.npcs) npc.startDelay = npc.cast.doom?.kind === 'runner' && n === 0 ? 0.15 : rand(0.1, 0.5);
  }

  private startTurn() {
    this.red++;
    this.turnFrom = this.doll.headYaw;
    this.turnTime = TURN_TIMES[Math.min(this.red, TURN_TIMES.length - 1)];
    this.setPhase('turn', this.turnTime);
    this.bubble.text = CHANT_TEXT[SYLLABLES.length - 1];
    this.bubble.color = '#ffd23f';
    this.oldManMoved = false;
    for (const npc of this.npcs) npc.stopDelay = rand(0.05, 0.28);
  }

  private startRed() {
    let len = this.red === 0 ? 3.0 : rand(2.0, 3.5);
    // Leave time for whatever a doomed contestant is about to do.
    for (const npc of this.npcs) {
      const doom = npc.cast.doom;
      if (doom && doom.red === this.red && npc.c.alive && !npc.crossed) len = Math.max(len, DOOM_AT[doom.kind] + 1.1);
    }
    this.setPhase('red', len);
  }

  private startTurnBack() {
    this.turnFrom = this.doll.headYaw;
    this.setPhase('turnBack', TURN_BACK);
  }

  private get grace() {
    return GRACE + (EXTRA_GRACE[this.red] ?? 0);
  }

  private get timeLeft() {
    return Math.max(0, CLOCK - Math.max(0, this.t - CHANT_START));
  }

  update(dt: number) {
    const { player, camera, hud } = this.ctx;
    this.t += dt;
    this.phaseT += dt;
    this.arrival.update(dt);

    const death = this.death;
    if (death && this.status === 'playing') {
      death.t += dt;
      if (death.t > DEATH_SCREEN_DELAY) {
        this.status = 'lost';
        hud.show(death.big, `${death.small}\nPress R to try again.`);
        hud.tips([['Hint', death.hint], ['Controls', CONTROLS]]);
      }
    }

    // Once the portal has spat the player out, face them down the field toward her.
    if (!this.cameraTurned && !this.arrival.cameraShot()) {
      this.cameraTurned = true;
      camera.yaw = -Math.PI / 2;
      camera.pitch = -0.08;
    }

    this.trackPlayerMovement(dt);
    this.updatePhase(dt);
    this.updateNpcs(dt);
    this.checkPlayer();

    // Lasers and announcements fade.
    for (const b of this.beams) b.t += dt;
    while (this.beams.length && this.beams[0].t > LASER_TIME) this.beams.shift();
    if (this.announceT > 0) this.announceT -= dt;

    // The room goes a little red while she's looking.
    const wantRed = this.phase === 'turn' || this.phase === 'red' || this.phase === 'timeUp' ? 1 : 0;
    this.redness += (wantRed - this.redness) * (1 - Math.exp(-dt * 8));
    const m = this.redness * 0.4;
    const sun = DEFAULT_ENV.sunColor, sky = DEFAULT_ENV.skyColor;
    this.env.sunColor[0] = sun[0] + (2.2 - sun[0]) * m;
    this.env.sunColor[1] = sun[1] + (1.15 - sun[1]) * m;
    this.env.sunColor[2] = sun[2] + (1.0 - sun[2]) * m;
    this.env.skyColor[0] = sky[0] + (0.5 - sky[0]) * m;
    this.env.skyColor[1] = sky[1] + (0.16 - sky[1]) * m;
    this.env.skyColor[2] = sky[2] + (0.16 - sky[2]) * m;

    // The clock.
    const left = Math.ceil(this.timeLeft);
    if (left !== this.clockShows) {
      this.clockShows = left;
      this.clock.text = `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`;
    }
    if (this.timeLeft <= 0 && this.phase !== 'timeUp') {
      this.turnFrom = this.doll.headYaw;
      this.setPhase('timeUp', 0);
      this.timeUpZaps = 0;
      this.bubble.text = "TIME'S UP.";
      this.bubble.color = '#ff4d3d';
      this.announceT = 2;
    }

    this.exit.update(dt, player);
    if (this.exit.entered && this.status === 'playing') this.status = 'exited';
  }

  private updatePhase(dt: number) {
    const doll = this.doll;
    const k = this.phaseLen > 0 ? clamp(this.phaseT / this.phaseLen, 0, 1) : 1;
    switch (this.phase) {
      case 'wait':
        doll.headYaw = 0;
        doll.eyeGlow = 0;
        if (this.phaseT >= this.phaseLen) this.startGreen();
        break;
      case 'green': {
        doll.eyeGlow = 0;
        if (this.fakeAt >= 0 && this.fake < 0 && this.chantT >= this.fakeAt) this.fake = 0;
        if (this.fake >= 0 && this.fake < FAKE_OUT_TIME) {
          // Starts to turn... holds... no. Carry on.
          this.fake += dt;
          const f = this.fake;
          const out = f < 0.2 ? smooth(f / 0.2) : f < 0.45 ? 1 : 1 - smooth(clamp((f - 0.45) / 0.35, 0, 1));
          doll.headYaw = out * 1.25;
          doll.eyeGlow = out * 0.45;
          this.phaseT -= dt; // the green light doesn't count down meanwhile
          break;
        }
        doll.headYaw = 0;
        this.chantT += dt;
        let i = 0;
        while (i + 1 < SYLLABLES.length - 1 && this.chantT >= this.chantAt[i + 1]) i++;
        if (this.announceT <= 0) {
          this.bubble.text = CHANT_TEXT[i];
          this.bubble.color = '#ffd23f';
        }
        // Her head rocks from side to side in time with the chant.
        const tilt = i % 2 === 0 ? 0.08 : -0.08;
        doll.headTilt += (tilt - doll.headTilt) * (1 - Math.exp(-dt * 14));
        if (this.chantT >= this.chantLen) this.startTurn();
        break;
      }
      case 'turn':
        doll.headYaw = this.turnFrom + (Math.PI - this.turnFrom) * whip(k);
        doll.headTilt += (0.14 - doll.headTilt) * (1 - Math.exp(-dt * 12));
        doll.eyeGlow = 0.3 + 0.4 * k;
        if (this.phaseT >= this.phaseLen) this.startRed();
        break;
      case 'red':
        doll.headYaw = Math.PI;
        doll.eyeGlow = 0.7 + 0.15 * Math.sin(this.t * 9);
        if (this.announceT <= 0 && this.phaseT > 0.8) this.bubble.text = '';
        if (this.phaseT >= this.phaseLen) this.startTurnBack();
        break;
      case 'turnBack':
        doll.headYaw = this.turnFrom * (1 - smooth(k));
        doll.headTilt *= Math.exp(-dt * 6);
        doll.eyeGlow = 0.7 * (1 - k);
        if (this.phaseT >= this.phaseLen) this.startGreen();
        break;
      case 'spin':
        // Slow, smug, full circle.
        doll.headYaw = this.turnFrom + Math.PI * 2 * smooth(k);
        doll.eyeGlow = 0.6;
        if (this.phaseT >= this.phaseLen) {
          doll.headYaw = this.turnFrom;
          this.startTurnBack();
        }
        break;
      case 'timeUp': {
        const kt = clamp(this.phaseT / 0.35, 0, 1);
        doll.headYaw = this.turnFrom + (Math.PI - this.turnFrom) * whip(kt);
        doll.eyeGlow = 1;
        this.timeUpVolley();
        break;
      }
    }
    doll.update();
    if (this.beams.length) doll.eyeGlow = 1;
  }

  /** Time's up: everyone still short of the line gets lasered, one by one (almost everyone). */
  private timeUpVolley() {
    const { player } = this.ctx;
    const at = 0.5 + this.timeUpZaps * 0.4;
    if (this.phaseT < at) return;
    this.timeUpZaps++;
    if (!this.crossed && player.mode !== 'ragdoll' && !this.death && !player.inPortal && player.mode !== 'hidden') {
      this.zapPlayer("TIME'S UP", pick(TIMEUP_LINES), TIMEUP_HINT);
      return;
    }
    const next = this.npcs.find((n) => n.c.alive && !n.crossed && !n.cast.old);
    if (next) {
      this.zapNpc(next);
      return;
    }
    const old = this.npcs.find((n) => n.c.alive && !n.crossed && n.cast.old);
    if (old && this.timeUpZaps < 20) {
      this.timeUpZaps = 20;
      this.announce('PLAYER 001... IS FINE.');
    }
  }

  // --- The player ------------------------------------------------------------------------------

  private trackPlayerMovement(dt: number) {
    const { player } = this.ctx;
    const p = player.pos;
    const hs = dt > 0 ? Math.hypot(p[0] - this.lastPos[0], p[2] - this.lastPos[2]) / dt : 0;
    const vs = dt > 0 ? Math.abs(p[1] - this.lastPos[1]) / dt : 0;
    const moving = hs > MOVE_SPEED || (!player.onGround && vs > MOVE_VERTICAL);
    this.moveTime = moving ? this.moveTime + dt : 0;
    this.lastPos[0] = p[0];
    this.lastPos[1] = p[1];
    this.lastPos[2] = p[2];
  }

  private checkPlayer() {
    const { player, hud } = this.ctx;
    const playing = player.mode === 'control' && !player.inPortal && !this.death;
    if (!playing || !this.arrival.done) return;
    // Across the line: safe, and the exit opens.
    if (!this.crossed && player.pos[0] > FINISH_X + 0.25) {
      this.crossed = true;
      this.exit.openNow();
      hud.show('PASSED', pick(PASS_LINES), 3);
      if (this.phase !== 'timeUp') {
        this.turnFrom = this.doll.headYaw;
        this.setPhase('spin', SPIN_TIME);
        this.announce('PLAYER 456... PASSED. BARELY.', SPIN_TIME);
      }
      return;
    }
    if (this.crossed || this.phase !== 'red' || this.phaseT < this.grace) return;
    if (this.moveTime < MOVE_TIME) return;
    const seen = this.partsSeen();
    if (seen < SEEN_PARTS) return;
    // Half hidden (behind something too low for a 7 m doll) gets its own line.
    const line = seen < 3 ? pick(PARTIAL_LINES) : this.oldManMoved ? CHEAT_LINE : pick(SEEN_LINES);
    this.zapPlayer('ELIMINATED', line, SEEN_HINT, this.seenAt);
  }

  /**
   * How many of the player's head, chest and pelvis she has a clear line of sight to; `seenAt` is
   * the one to aim for (the chest if she can see it).
   */
  private partsSeen(): number {
    const body = this.ctx.player.body;
    if (!body) return 0;
    let seen = 0;
    for (const part of ['pelvis', 'head', 'chest'] as const) {
      const p = body.position(part);
      if (!this.canSee(p)) continue;
      seen++;
      this.seenAt = p;
    }
    return seen;
  }

  private canSee(target: Vec3): boolean {
    const eye = this.doll.eyeCentre();
    const d = sub(target, eye);
    const dist = length(d);
    if (dist < 0.1) return true;
    const dir: Vec3 = [d[0] / dist, d[1] / dist, d[2] / dist];
    // Only in front of her face.
    const look = this.doll.lookDir();
    if (dir[0] * look[0] + dir[1] * look[1] + dir[2] * look[2] < 0.2) return false;
    const ray = new RAPIER.Ray({ x: eye[0], y: eye[1], z: eye[2] }, { x: dir[0], y: dir[1], z: dir[2] });
    const hit = this.ctx.physics.world.castRay(ray, dist, true, undefined, GROUPS_QUERY_WORLD, undefined, undefined,
      (c) => !this.dollColliders.has(c.handle));
    return !hit || hit.timeOfImpact > dist - 0.2;
  }

  private zapPlayer(big: string, small: string, hint: string, aim?: Vec3) {
    const { player, camera, hud } = this.ctx;
    const chest = player.body?.position('chest') ?? [player.pos[0], player.pos[1] + 1.3, player.pos[2]];
    this.fire(aim ?? chest);
    const away = normalize([chest[0] - DOLL_POS[0], 0, chest[2] - DOLL_POS[2]]);
    player.kill([away[0] * 13, 6, away[2] * 13], { violence: 22, origin: chest });
    camera.addShake(0.8);
    this.announce('PLAYER 456... ELIMINATED.');
    hud.hide();
    this.death = { t: 0, big, small, hint };
  }

  // --- Everyone else ---------------------------------------------------------------------------

  private updateNpcs(dt: number) {
    const redT = this.phase === 'red' ? this.phaseT : -1;
    const faking = this.fake >= 0 && this.fake < FAKE_OUT_TIME;
    const stopped = this.phase !== 'green' || faking;
    const sinceStop = this.phase === 'turn' ? this.phaseT : this.phase === 'red' ? this.turnTime + this.phaseT : faking ? this.fake : 99;
    for (const npc of this.npcs) {
      const c = npc.c;
      c.update(dt);
      if (!c.alive) {
        // Nobody gets flung through a wall.
        c.pos[0] = clamp(c.pos[0], -CHAMBER_HALF + 1, CHAMBER_HALF - 1);
        c.pos[2] = clamp(c.pos[2], -CHAMBER_HALF + 1, CHAMBER_HALF - 1);
        continue;
      }
      if (!npc.crossed && c.pos[0] > FINISH_X + 0.45) {
        npc.crossed = true;
        c.frozen = false;
        npc.spot = SPOTS[this.npcs.filter((n) => n.crossed).length - 1] ?? [9, 0, 10];
      }
      if (npc.crossed) {
        // Made it: stroll over to the side, cheer, then stand and watch.
        const spot = npc.spot!;
        if (Math.hypot(spot[0] - c.pos[0], spot[2] - c.pos[2]) > 0.2) this.steer(npc, spot, 1.8);
        else {
          c.vel[0] = c.vel[2] = 0;
          if (!npc.cheered) {
            npc.cheered = true;
            c.action = 'cheer';
            c.actionT = 0;
          } else if (c.action === 'cheer' && c.actionT > 2.5) c.action = 'none';
          c.facing += Math.atan2(Math.sin(Math.PI / 2 - c.facing), Math.cos(Math.PI / 2 - c.facing)) * Math.min(1, dt * 3);
        }
        continue;
      }
      const doom = npc.cast.doom;
      const doomed = doom && doom.red === this.red && (this.phase === 'turn' || this.phase === 'red');
      if (doomed) {
        this.doomedBehaviour(npc, doom.kind, redT, dt);
        continue;
      }
      // (Whatever a doomed contestant was up to, if their red light got cut short.)
      if (c.action === 'wobble' || c.action === 'sneeze') c.action = 'none';
      const goal: Vec3 = [FINISH_X + 1.1, 0, npc.cast.z];
      if (npc.cast.old && this.red >= OLD_MAN_CHEATS_FROM && this.phase === 'red') {
        // Player 001 just keeps shuffling. She pretends not to notice.
        c.frozen = false;
        this.steer(npc, goal, npc.cast.speed * 0.7);
        if (redT > this.grace && !this.oldManMoved) {
          this.oldManMoved = true;
          // The first time, she makes a point of not minding.
          if (!this.oldManExcused && this.announceT <= 0) {
            this.oldManExcused = true;
            this.announce('PLAYER 001... IS FINE.');
          }
        }
        continue;
      }
      if (stopped) {
        // Freeze (after a moment's reaction), mid-stride.
        if (sinceStop < npc.stopDelay && this.phase !== 'spin' && this.phase !== 'wait') {
          this.steer(npc, goal, npc.cast.speed);
        } else {
          c.vel[0] *= Math.exp(-dt * 25);
          c.vel[2] *= Math.exp(-dt * 25);
          if (Math.hypot(c.vel[0], c.vel[2]) < 0.1) {
            c.vel[0] = c.vel[2] = 0;
            c.frozen = this.phase !== 'wait';
          }
        }
        continue;
      }
      c.frozen = false;
      if (this.phaseT < npc.startDelay) {
        c.vel[0] = c.vel[2] = 0;
        continue;
      }
      this.steer(npc, goal, npc.cast.speed);
    }
  }

  private doomedBehaviour(npc: Npc, kind: Doom, redT: number, dt: number) {
    const c = npc.c;
    const goal: Vec3 = [FINISH_X + 1.1, 0, npc.cast.z];
    const zapAt = DOOM_AT[kind];
    if (kind === 'runner') {
      // Didn't notice. Keeps running.
      c.frozen = false;
      this.steer(npc, goal, npc.cast.speed);
    } else if (redT < 0 || redT < zapAt - (kind === 'wobble' ? 1.2 : kind === 'panic' ? 0.7 : 1.0)) {
      // Freezes like everyone else, for now.
      c.vel[0] *= Math.exp(-dt * 25);
      c.vel[2] *= Math.exp(-dt * 25);
      if (Math.hypot(c.vel[0], c.vel[2]) < 0.1) {
        c.vel[0] = c.vel[2] = 0;
        c.frozen = true;
      }
    } else if (kind === 'wobble') {
      // Loses their balance... and puts a foot down.
      if (c.action !== 'wobble') {
        c.action = 'wobble';
        c.actionT = 0;
        c.frozen = false;
      }
      if (redT > zapAt - 0.3) {
        c.vel[0] = -Math.sin(c.facing) * 1.4;
        c.vel[2] = -Math.cos(c.facing) * 1.4;
      }
    } else if (kind === 'panic') {
      // Loses their nerve and runs for the start line.
      c.frozen = false;
      c.action = 'none';
      this.steer(npc, [START_X, 0, npc.cast.z], 4.5);
    } else if (kind === 'sneeze') {
      if (c.action !== 'sneeze') {
        c.action = 'sneeze';
        c.actionT = 0;
        c.frozen = false;
        npc.label.text = 'AH...';
      }
      if (c.actionT > 0.4 && c.actionT < 0.75) npc.label.text = 'AH... AH...';
      if (c.actionT >= 0.75) {
        npc.label.text = 'ACHOO!';
        if (c.actionT < 0.9) {
          c.vel[0] = -Math.sin(c.facing) * 1.5;
          c.vel[2] = -Math.cos(c.facing) * 1.5;
        } else c.vel[0] = c.vel[2] = 0;
      }
    }
    if (redT >= zapAt) this.zapNpc(npc);
  }

  /** Walks a contestant toward `goal`, around the junk, the doll, each other and the player. */
  private steer(npc: Npc, goal: Vec3, speed: number) {
    const c = npc.c, p = c.pos;
    let dx = goal[0] - p[0], dz = goal[2] - p[2];
    const d = Math.hypot(dx, dz);
    if (d < 0.05) {
      c.vel[0] = c.vel[2] = 0;
      return;
    }
    dx /= d;
    dz /= d;
    let ax = 0, az = 0;
    const avoid = (ox: number, oz: number, r: number) => {
      const rx = p[0] - ox, rz = p[2] - oz;
      const dist = Math.hypot(rx, rz);
      const range = r + 1.1;
      if (dist > range || dist < 1e-3) return;
      // Only mind things ahead (or right on top of us).
      if (rx * dx + rz * dz > 0.3 && dist > r + 0.3) return;
      const w = (range - dist) / 1.1;
      ax += (rx / dist) * w;
      az += (rz / dist) * w;
      // ...and go round them, on whichever side we're already on.
      const side = dx * rz - dz * rx >= 0 ? 1 : -1;
      ax += -dz * side * w * 1.5;
      az += dx * side * w * 1.5;
    };
    for (const cv of this.cover) {
      const t = cv.body.rb.translation();
      avoid(t.x, t.z, cv.r);
    }
    avoid(DOLL_POS[0], DOLL_POS[2], 1.4);
    for (const other of this.npcs) if (other !== npc && other.c.alive) avoid(other.c.pos[0], other.c.pos[2], 0.35);
    const pp = this.ctx.player.pos;
    avoid(pp[0], pp[2], 0.4);
    let vx = dx + ax, vz = dz + az;
    const len = Math.hypot(vx, vz) || 1;
    const s = Math.min(speed, d * 2);
    vx = (vx / len) * s;
    vz = (vz / len) * s;
    // Ease into it rather than snapping.
    c.vel[0] += (vx - c.vel[0]) * 0.25;
    c.vel[2] += (vz - c.vel[2]) * 0.25;
  }

  private zapNpc(npc: Npc) {
    const c = npc.c;
    if (!c.alive) return;
    const chest = c.chest();
    this.fire(chest);
    const away = normalize([chest[0] - DOLL_POS[0], 0, chest[2] - DOLL_POS[2]]);
    // The first one goes out in style.
    const first = npc.cast.doom?.kind === 'runner';
    c.kill(away, first ? 6.5 : rand(3, 5), first ? 6.5 : rand(3, 4.5), first ? 1 : 0, first ? rand(-4, 4) : rand(-1.5, 1.5));
    this.announce(`PLAYER ${npc.cast.number}... ELIMINATED.`);
    const d = Math.hypot(chest[0] - this.ctx.player.pos[0], chest[2] - this.ctx.player.pos[2]);
    this.ctx.camera.addShake(clamp(0.45 - d * 0.03, 0.05, 0.4));
  }

  private fire(target: Vec3) {
    this.beams.push({ target: [...target], t: 0 });
  }

  private announce(text: string, seconds = 1.8) {
    this.bubble.text = text;
    this.bubble.color = '#ff4d3d';
    this.announceT = seconds;
  }

  // --- Drawing ---------------------------------------------------------------------------------

  draw(out: DrawItem[]) {
    this.doll.draw(out);
    this.tree.draw(out);
    for (const tape of this.tapes) out.push(tape);
    for (const npc of this.npcs) npc.c.draw(out);
    for (const b of this.beams) {
      const fade = 1 - b.t / LASER_TIME;
      for (const side of [-1, 1] as const) {
        const eye = this.doll.eye(side);
        const target: Vec3 = [b.target[0] + side * 0.05, b.target[1], b.target[2]];
        // A white-hot core in a red beam in a faint red glow.
        out.push({ mesh: 'cylinder', model: segment(eye, target, 0.018), color: [5, 1.4, 1.0], pattern: Pattern.emissive, shadow: false });
        out.push({ mesh: 'cylinder', model: segment(eye, target, 0.045), color: [4, 0.02, 0.01], pattern: Pattern.emissive, shadow: false });
        out.push({ mesh: 'cylinder', model: segment(eye, target, 0.12), color: [1.4, 0, 0], pattern: Pattern.emissive, shadow: false, opacity: 0.45 * fade });
      }
      const r = 0.2 + b.t * 1.2;
      out.push({ mesh: 'sphere', model: mul(translation(b.target), scaling([r, r, r])), color: [4, 0.12, 0.02], pattern: Pattern.emissive, shadow: false, opacity: fade });
    }
    this.arrival.draw(out);
    this.exit.draw(out);
  }

  labels(): WorldLabel[] {
    const list = this.labelList;
    list.length = 0;
    list.push(this.clock);
    if (this.bubble.text && (this.phase !== 'wait' || this.announceT > 0)) list.push(this.bubble);
    for (const npc of this.npcs) {
      if (!npc.c.alive) continue;
      const p = npc.c.pos;
      npc.label.pos[0] = p[0];
      npc.label.pos[1] = p[1] + 2.15;
      npc.label.pos[2] = p[2];
      if (npc.c.action !== 'sneeze') npc.label.text = npc.cast.number;
      list.push(npc.label);
    }
    return list;
  }

  trackedTargets(): TrackedTarget[] {
    const exit = this.exit.target();
    return exit ? [exit] : [];
  }

  environment() {
    return this.env;
  }

  obstacles() {
    const list = this.circles;
    list.length = 0;
    for (const npc of this.npcs) {
      if (!npc.c.alive) continue;
      npc.circle.x = npc.c.pos[0];
      npc.circle.z = npc.c.pos[2];
      list.push(npc.circle);
    }
    return list;
  }

  cameraShot(): CameraShot | null {
    return this.arrival.cameraShot();
  }
}
