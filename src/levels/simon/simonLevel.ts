import { noise, tone } from '../../engine/audio';
import { add, basis, clamp, mul, scale, scaling, translation, type Vec3 } from '../../engine/math';
import type { Body } from '../../engine/physics';
import { Pattern, type DrawItem } from '../../engine/renderer';
import { CHAMBER_HALF } from '../../game/chamber';
import { junk } from '../../entities/junk';
import { ExitPortal, PortalArrival } from '../../entities/portal';
import { Button } from '../../entities/props';
import { drawTrapdoor } from '../../entities/trapdoor';
import { DEFAULT_ENV, type CameraShot, type Level, type LevelContext, type LevelStatus, type TrackedTarget, type WorldLabel } from '../level';

/*
 * Simon Says. The floor is the 1978 Simon toy (four coloured pads round a hub with a button), and
 * screens on the walls give orders. Do what Simon says, and nothing Simon didn't say: the floor
 * panel under anyone who gets it wrong turns into a catapult. It ends with Simon's memory game
 * (step on the pads in the order they lit up) and an exit you may only use once Simon says so.
 */

type Pad = 0 | 1 | 2 | 3;
const PAD_NAME = ['GREEN', 'RED', 'YELLOW', 'BLUE'];
/** Each pad's tone (Hz), like the 1978 toy's. */
const PAD_TONE = [415, 310, 252, 209];
/** Which way each pad lies from the centre (x, z): as on the toy, with north at the top. */
const PAD_DIR: [number, number][] = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
/** Angle (from +x toward +z) where each quarter-disc pad starts. */
const PAD_START = [Math.PI, Math.PI * 1.5, Math.PI * 0.5, 0];
const PAD_DIM = [[0.06, 0.3, 0.12], [0.45, 0.06, 0.05], [0.52, 0.43, 0.06], [0.05, 0.14, 0.5]];
const PAD_LIT = [[0.35, 2.4, 0.6], [2.6, 0.3, 0.22], [2.5, 2.1, 0.35], [0.4, 0.85, 2.8]];

/** Each pad is a quarter disc this big, its corner this far out from each axis (the dark cross between pads). */
const PAD_R = 8;
const GAP = 0.5;
const HUB_R = 2.4;
const BASE_R = 8.9;
const BASE_TOP = 0.06;
const PAD_TOP = 0.075;
const HUB_TOP = 0.09;
const BASE = [0.12, 0.12, 0.13];
const HUB = [0.07, 0.07, 0.08];

const EXIT_Z = 5;
/** Wall screens: width, height, centre height. */
const SCREEN_W = 8;
const SCREEN_H = 3.6;
const SCREEN_Y = 4.3;
const DEATH_SCREEN_DELAY = 1.8;
/** Horizontal speed (m/s) that counts as moving. */
const MOVING = 1.0;

const GOOD = ['GOOD.', 'ADEQUATE.', 'SIMON IS PLEASED.', 'FINE.', 'CORRECT. SUSPICIOUSLY.', 'OK.', 'NOT BAD. FOR A HUMAN.'];
const SPOTTED = ["SIMON DIDN'T SAY.", "SIMON DIDN'T SAY. WELL SPOTTED.", "HM. YOU'RE GOOD.", "SIMON DIDN'T SAY. SIMON SULKS."];
const TRAP_DEATHS = [
  'Simon was very clear. Well, Simon was very quiet.',
  'Rule one of Simon Says: Simon has to say it.',
  'You would make an excellent soldier. A terrible Simon Says player.',
  'Simon did not say. Simon did, however, fling.',
];

const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

type StepKind = 'say' | 'simon' | 'trap' | 'hold' | 'watch' | 'repeat' | 'leaveTrap' | 'leave';

interface Step {
  kind: StepKind;
  /** The line above the order: 'SIMON SAYS:', nothing, or a trick ('SIMEON SAYS:'). */
  prefix: string;
  text: string;
  /** Time limit (s): to obey a Simon order, or to resist a trap / hold still. */
  time: number;
  /** simon: done it. trap: did it anyway. hold: moved. */
  check?: () => boolean;
  /** Seconds at the start in which a trap / hold doesn't count yet (momentum, reaction). */
  grace?: number;
  /** Shown when it's done (instead of a random GOOD / SPOTTED line). */
  quip?: string;
  /** Go straight on to the next step, without a pause. */
  chain?: boolean;
  /** Death screen for failing this step. */
  fail?: [string, string, string];
  /** Memory game: the pads to light / repeat. */
  seq?: Pad[];
}

interface Death {
  t: number;
  big: string;
  small: string;
  hint: string;
}

interface Screen {
  /** Centre of the screen's face, and the direction it faces (into the room). */
  pos: Vec3;
  normal: Vec3;
  prefix: WorldLabel;
  line: WorldLabel;
  sub: WorldLabel;
}

export class SimonLevel implements Level {
  readonly number: number;
  readonly title = 'Simon Says';
  status: LevelStatus = 'playing';
  private arrival: PortalArrival;
  private exit = new ExitPortal(EXIT_Z);
  private duck: Body;
  private screens: Screen[] = [];
  private allLabels: WorldLabel[] = [];
  private death: Death | null = null;

  private steps: Step[];
  private index = -1;
  private stepT = 0;
  /** Between steps: the quip shows this much longer. */
  private pause = 1;
  private started = false;
  /** The timer bar (fraction left), or -1 for none. */
  private timer = -1;

  // What the player has done since the current step started.
  private jumps = 0;
  private spin = 0;
  private spinCam = 0;
  private spinBody = 0;
  private pressed = false;
  private duckThrown = false;
  /** Looked below the LOOK UP line since the step began. */
  private lookedAway = false;
  private wasOnGround = true;
  private lastYaw = 0;
  private lastFacing = 0;
  private carryingDuck = false;
  /** The pad under the player's feet (null: hub, gaps, or off the disc). */
  private pad: Pad | null = null;
  /** The pad the player was on when the current step began. */
  private startPad: Pad | null = null;
  /** Memory game: how many pads repeated so far, and the last one stepped on. */
  private repeated = 0;
  private lastRepeat: Pad | null = null;

  /** How brightly each pad is lit (0-1). */
  private glow = [0, 0, 0, 0];
  /** The trapdoor catapult that flung the player (world position of its hinge side, its yaw, and age). */
  private catapult: { pos: Vec3; yaw: number; t: number } | null = null;

  constructor(private ctx: LevelContext) {
    this.number = ctx.number;
    const { physics, hud } = ctx;
    hud.setLevel(`The Chamber · Level ${this.number}`);
    hud.show(`LEVEL ${this.number}`, '', 2.5);
    hud.hint('');
    this.arrival = new PortalArrival(ctx, [0, 0, 6]);

    // The toy: a dark disc you stand on, with the pads drawn on top and the button in the middle.
    physics.addStaticCylinder([0, BASE_TOP / 2, 0], BASE_R, BASE_TOP);
    new Button(physics, [0, BASE_TOP, 0], [0.85, 0.85, 0.82], () => (this.pressed = true));
    // A big rubber duck, for later.
    const duckModel = junk('rubber duck').model;
    this.duck = physics.addBox([1.7, BASE_TOP + 0.5, 1.3], [0.85, 0.9, 1.05], {
      mass: 4,
      rotation: { x: 0, y: Math.sin(-0.4), z: 0, w: Math.cos(-0.4) },
      model: (out, m) => duckModel(out, mul(m, translation([0, -0.03, 0]), scaling([2, 2, 2]))),
    });

    // A screen on every wall (the east one off to the side of the exit), so one is always in view.
    const wall = CHAMBER_HALF - 0.16;
    const faces: [Vec3, Vec3][] = [
      [[0, SCREEN_Y, -wall], [0, 0, 1]],
      [[0, SCREEN_Y, wall], [0, 0, -1]],
      [[-wall, SCREEN_Y, 0], [1, 0, 0]],
      [[wall, SCREEN_Y, -4.5], [-1, 0, 0]],
    ];
    for (const [pos, normal] of faces) {
      const at = (y: number): Vec3 => add([pos[0], y, pos[2]], scale(normal, 0.25));
      const screen: Screen = {
        pos,
        normal,
        prefix: { pos: at(SCREEN_Y + 0.95), text: '', size: 0.6, color: '#ffd166' },
        line: { pos: at(SCREEN_Y), text: '', size: 1, color: '#ffffff' },
        sub: { pos: at(SCREEN_Y - 0.95), text: '', size: 0.42, color: '#9adfff' },
      };
      this.screens.push(screen);
      this.allLabels.push(screen.prefix, screen.line, screen.sub);
    }
    this.allLabels.push({ pos: [0, 2.05, 0], text: 'SIMON', size: 0.32, color: '#ffd166' });

    this.steps = this.script();
    // Walking out before Simon says so is not allowed.
    this.exit.refuse = () => {
      if (this.steps[this.index]?.kind === 'leave' && this.pause <= 0) return false;
      const { player, camera } = this.ctx;
      const chest = add(player.pos, [0, 1.3, 0]);
      player.kill([-16, 6, (Math.random() - 0.5) * 4], { violence: 22, origin: add(chest, [0.6, 0, 0]) });
      camera.addShake(0.9);
      this.show('', 'NO.', '');
      this.die("SIMON DIDN'T SAY LEAVE", 'So close. So very, very close.', 'Wait for "SIMON SAYS: LEAVE." Simon is petty like that.');
      return true;
    };
  }

  // --- The script ---------------------------------------------------------------------------------

  private script(): Step[] {
    const { player, camera } = this.ctx;
    const moving = () => Math.hypot(player.vel[0], player.vel[2]) > MOVING || !player.onGround;
    const jumped = () => this.jumps > 0;
    const on = (p: Pad) => () => this.pad === p;
    const simon = (text: string, time: number, check: () => boolean, extra: Partial<Step> = {}): Step =>
      ({ kind: 'simon', prefix: 'SIMON SAYS:', text, time, check, ...extra });
    const trap = (prefix: string, text: string, time: number, check: () => boolean, extra: Partial<Step> = {}): Step =>
      ({ kind: 'trap', prefix, text, time, check, grace: 0.25, ...extra });

    // Pads to go to: never the one you're probably on already.
    const first = Math.floor(Math.random() * 4) as Pad;
    const other = (not: Pad[]) => pick(([0, 1, 2, 3] as Pad[]).filter((p) => !not.includes(p)));
    const second = other([first]);
    const tempting = other([second]);

    const lookUp = simon('LOOK UP.', 5, () => camera.pitch > 0.55);
    const toes = simon('TOUCH YOUR TOES.', 6, () => camera.pitch < -0.95 && Math.hypot(player.vel[0], player.vel[2]) < 0.6, {
      quip: 'FLEXIBLE. FOR A TEST SUBJECT.',
    });
    const button = simon('PRESS THE BUTTON.', 7, () => this.pressed);
    const spin = simon('SPIN AROUND.', 6, () => this.spin > Math.PI * 1.8, { quip: 'WHEEE.' });
    const tricks: Step[] = [
      trap('SIMEON SAYS:', 'JUMP.', 3.5, jumped, { quip: 'SIMEON IS NOT SIMON. WELL READ.' }),
      trap('SIMON SAID:', 'LOOK UP.', 3.5, () => {
        // Only a fresh look up counts: you may still be gazing at the ceiling from the real one.
        if (camera.pitch < 0.45) this.lookedAway = true;
        return this.lookedAway && camera.pitch > 0.55;
      }, { quip: 'PAST TENSE. NICE CATCH.' }),
      trap('', 'PRESS THE BUTTON.', 4, () => this.pressed),
      trap("SIMON'S MUM SAYS:", 'SPIN AROUND.', 4, () => this.spin > Math.PI * 1.5, { quip: "SIMON'S MUM HAS NO AUTHORITY HERE." }),
    ];
    const memory = (n: number): Pad[] => {
      const seq: Pad[] = [];
      for (let i = 0; i < n; i++) seq.push(other(i ? [seq[i - 1]] : []));
      return seq;
    };
    const seq1 = memory(4), seq2 = memory(5);
    const trick = pick(tricks);
    // Whichever of the button / spin wasn't used as the trick.
    const later = trick.text === 'PRESS THE BUTTON.' ? spin : trick.text === 'SPIN AROUND.' ? button : pick([button, spin]);

    return [
      { kind: 'say', prefix: '', text: 'I WANT TO PLAY A GAME.', time: 2.6 },
      simon('JUMP.', 5, jumped),
      simon(`STAND ON ${PAD_NAME[first]}.`, 8, on(first)),
      trap('', 'JUMP.', 3.2, jumped),
      pick([lookUp, toes]),
      trick,
      { kind: 'hold', prefix: 'SIMON SAYS:', text: 'FREEZE.', time: 3.5, check: moving, grace: 0.7, chain: true,
        fail: ['YOU MOVED', 'Simon said freeze. You did the opposite of freezing. You thawed.', 'When Simon says freeze, stand still until Simon says otherwise.'] },
      trap('', 'OK. YOU CAN MOVE NOW.', 3, moving, { grace: 0.2, quip: 'NO YOU CAN\'T. WELL DONE.' }),
      simon('YOU CAN MOVE NOW.', 4, () => Math.hypot(player.vel[0], player.vel[2]) > 2),
      later,
      simon(`STAND ON ${PAD_NAME[second]}.`, 8, on(second)),
      trap('', `STAND ON ${PAD_NAME[tempting]}.`, 3.5, () => this.pad === tempting && this.startPad !== tempting),
      simon('PICK UP THE DUCK.', 9, () => this.carryingDuck, { quip: 'HE LIKES YOU.' }),
      simon('THROW THE DUCK.', 6, () => this.duckThrown, { quip: 'HE LIKED YOU.' }),
      pick([
        simon('DANCE.', 6, () => this.jumps >= 2 || this.spin > Math.PI * 1.5, { quip: 'THAT WAS NOT DANCING. BUT FINE.' }),
        { kind: 'hold', prefix: 'SIMON SAYS:', text: 'HOLD YOUR BREATH.', time: 3, check: () => false, quip: "GOOD. SIMON COULDN'T TELL EITHER WAY." },
      ]),
      simon('JUMP.', 5, jumped, { quip: '', chain: true }),
      trap('', 'AGAIN.', 3, jumped, { grace: 0.6, quip: 'AGAIN? NO. GOOD.' }),
      { kind: 'watch', prefix: 'SIMON SAYS:', text: 'WATCH.', time: 0, seq: seq1 },
      { kind: 'repeat', prefix: 'SIMON SAYS:', text: 'REPEAT.', time: 6 + seq1.length * 2.5, seq: seq1, quip: 'YOUR MEMORY BEATS A GOLDFISH.' },
      { kind: 'watch', prefix: 'SIMON SAYS:', text: 'WATCH. AGAIN.', time: 0, seq: seq2 },
      { kind: 'repeat', prefix: 'SIMON SAYS:', text: 'REPEAT.', time: 6 + seq2.length * 2.5, seq: seq2, quip: '...BARELY.' },
      { kind: 'leaveTrap', prefix: '', text: 'LEAVE.', time: 4.5, quip: 'NOT YET. NOW...' },
      { kind: 'leave', prefix: 'SIMON SAYS:', text: 'LEAVE.', time: 0 },
    ];
  }

  private begin(i: number) {
    const { player, camera } = this.ctx;
    // A throw straight after picking the duck up (during the pause) still counts for THROW.
    const keepThrow = this.steps[i].text === 'THROW THE DUCK.' && this.steps[this.index]?.text === 'PICK UP THE DUCK.';
    this.index = i;
    this.stepT = 0;
    this.jumps = 0;
    this.spin = 0;
    this.spinCam = 0;
    this.spinBody = 0;
    this.pressed = false;
    this.duckThrown = keepThrow && this.duckThrown;
    this.lookedAway = camera.pitch < 0.45;
    this.lastYaw = camera.yaw;
    this.lastFacing = player.facing;
    this.startPad = this.pad;
    const step = this.steps[i];
    this.show(step.prefix, step.text, '');
    if (step.kind === 'repeat') {
      this.repeated = 0;
      this.lastRepeat = null;
      // Already standing on the first colour counts; any other pad you're on doesn't (until you step on it again).
      if (this.pad !== null) {
        if (this.pad === step.seq![0]) this.stepOnPad(this.pad, step);
        else this.lastRepeat = this.pad;
      }
      this.progress(step);
    }
    if (step.kind === 'leaveTrap') this.exit.openNow();
  }

  /** The current step is done: a quip, a moment's pause, then the next. */
  private done(fallback: string[]) {
    const step = this.steps[this.index];
    if (step.chain) {
      this.begin(this.index + 1);
      return;
    }
    this.show('', step.quip ?? pick(fallback), '');
    this.pause = step.quip === '' ? 0.4 : 1.1;
    this.timer = -1;
  }

  private show(prefix: string, line: string, sub: string) {
    for (const s of this.screens) {
      s.prefix.text = prefix;
      s.line.text = line;
      s.sub.text = sub;
      // Shrink long lines to fit the screen.
      s.line.size = Math.min(1, (SCREEN_W - 0.8) / (0.72 * Math.max(1, line.length)));
      s.prefix.size = Math.min(0.6, (SCREEN_W - 0.8) / (0.72 * Math.max(1, prefix.length)));
    }
  }

  private progress(step: Step) {
    const dots = step.seq!.map((_, i) => (i < this.repeated ? '●' : '○')).join(' ');
    for (const s of this.screens) s.sub.text = dots;
  }

  private stepOnPad(pad: Pad, step: Step) {
    const seq = step.seq!;
    if (pad === this.lastRepeat) return; // back onto the one you just did: no harm
    if (pad !== seq[this.repeated]) {
      this.fling('WRONG COLOUR', 'Simon is a toy from 1978. Simon has a better memory than you.',
        'Watch which pads light up, then step on them in the same order. The dark cross and the middle are safe to cross.');
      return;
    }
    this.glow[pad] = 1;
    tone(PAD_TONE[pad], 0.4, { wave: 'triangle', vol: 0.3 });
    this.lastRepeat = pad;
    this.repeated++;
    this.progress(step);
    if (this.repeated >= seq.length) this.done(GOOD);
  }

  // --- Deaths ---------------------------------------------------------------------------------------

  /** The floor panel under the player turns out to be a catapult. */
  private fling(big: string, small: string, hint: string) {
    const { player, camera } = this.ctx;
    if (this.death || player.mode !== 'control') return;
    tone(42, 0.8, { wave: 'sawtooth', vol: 0.3 });
    noise(0.3, { freq: 2000, to: 200, vol: 0.4, at: 0.05 });
    const yaw = Math.random() * Math.PI * 2;
    this.catapult = { pos: [player.pos[0], surfaceY(player.pos[0], player.pos[2]), player.pos[2]], yaw, t: 0 };
    // Up and away over the hinge side.
    player.kill([Math.sin(yaw) * 5, 24, Math.cos(yaw) * 5], { violence: 12 });
    camera.addShake(0.7);
    this.show('', 'GOODBYE.', '');
    this.die(big, small, hint);
  }

  private die(big: string, small: string, hint: string) {
    this.timer = -1;
    this.death = { t: 0, big, small, hint };
  }

  // --- Update -------------------------------------------------------------------------------------

  update(dt: number) {
    const { player, camera, hud } = this.ctx;
    const death = this.death;
    if (death && this.status === 'playing') {
      death.t += dt;
      if (death.t > DEATH_SCREEN_DELAY) {
        this.status = 'lost';
        hud.show(death.big, `${death.small}\nPress R to try again.`);
        hud.tips([
          ['Hint', death.hint],
          ['Controls', 'Space jump · Mouse look · Stand still and look down to touch your toes · E or click press · Hold E or click carry · Press another throw'],
        ]);
      }
    }
    this.arrival.update(dt);
    this.exit.update(dt, player);
    if (this.exit.entered && this.status === 'playing') this.status = 'exited';
    if (this.catapult) this.catapult.t += dt;
    for (let i = 0; i < 4; i++) this.glow[i] = Math.max(0, this.glow[i] - dt * 2.2);

    // Where the player is and what they did this frame.
    const alive = player.mode === 'control' && !this.death;
    this.pad = alive ? padAt(player.pos[0], player.pos[2]) : null;
    // The pad you stand on glows a little (except while Simon shows a sequence).
    const watching = this.steps[this.index]?.kind === 'watch' && this.pause <= 0;
    if (this.pad !== null && alive && !watching) this.glow[this.pad] = Math.max(this.glow[this.pad], 0.3);
    if (alive) {
      if (this.wasOnGround && !player.onGround && player.vel[1] > 2.5) this.jumps++;
      // Net rotation (either way round), by the camera or by the player turning while they run in circles.
      this.spinCam += camera.yaw - this.lastYaw;
      this.spinBody += wrap(player.facing - this.lastFacing);
      this.spin = Math.max(Math.abs(this.spinCam), Math.abs(this.spinBody));
      const carrying = player.carrying === this.duck.collider;
      if (this.carryingDuck && !carrying) {
        const v = this.duck.rb.linvel();
        if (Math.hypot(v.x, v.y, v.z) > 4) this.duckThrown = true;
      }
      this.carryingDuck = carrying;
    }
    this.wasOnGround = player.onGround;
    this.lastYaw = camera.yaw;
    this.lastFacing = player.facing;

    if (!this.arrival.done || this.death || !alive) return;
    if (!this.started) {
      this.started = true;
      this.pause = 1;
    }
    if (this.pause > 0) {
      this.pause -= dt;
      if (this.pause <= 0 && this.index < this.steps.length - 1) this.begin(this.index + 1);
      return;
    }
    const step = this.steps[this.index];
    this.stepT += dt;
    this.timer = step.time > 0 && step.kind !== 'say' && step.kind !== 'watch' ? clamp(1 - this.stepT / step.time, 0, 1) : -1;
    const late = step.time > 0 && this.stepT > step.time;
    switch (step.kind) {
      case 'say':
        if (late) this.done(['']);
        break;
      case 'simon':
        if (step.check!()) this.done(GOOD);
        else if (late) this.fling('TOO SLOW', "Simon said. You didn't.", 'When a line starts with "SIMON SAYS", do it, and quickly.');
        break;
      case 'trap':
        if (this.stepT > (step.grace ?? 0) && step.check!()) {
          this.fling("SIMON DIDN'T SAY", pick(TRAP_DEATHS), 'Only do it if the line starts with exactly "SIMON SAYS". Read the whole thing. Simon is sneaky.');
        } else if (late) this.done(SPOTTED);
        break;
      case 'hold':
        if (this.stepT > (step.grace ?? 0) && step.check!()) this.fling(...step.fail!);
        else if (late) this.done(GOOD);
        break;
      case 'watch': {
        // Light the pads one by one, then move on to repeating them.
        const on = 0.55, off = 0.2, lead = 0.8;
        const k = (this.stepT - lead) / (on + off);
        const i = Math.floor(k);
        if (k >= 0 && i < step.seq!.length && k - i < on / (on + off)) {
          if (this.glow[step.seq![i]] < 0.9) tone(PAD_TONE[step.seq![i]], on, { wave: 'triangle', vol: 0.3 });
          this.glow[step.seq![i]] = 1;
        }
        if (k > step.seq!.length + 0.3) this.begin(this.index + 1);
        break;
      }
      case 'repeat':
        if (this.pad !== null) this.stepOnPad(this.pad, step);
        if (!this.death && this.pause <= 0 && late) {
          this.fling('TOO SLOW', 'Simon waited. Simon does not like waiting.', 'Watch which pads light up, then step on them in the same order, before the bar runs out.');
        }
        break;
      case 'leaveTrap':
        if (late) this.done(['']);
        break;
      case 'leave':
        break;
    }
  }

  // --- Drawing ------------------------------------------------------------------------------------

  draw(out: DrawItem[]) {
    this.arrival.draw(out);
    this.exit.draw(out);

    // The toy.
    out.push({ mesh: 'cylinder', model: mul(translation([0, BASE_TOP / 2, 0]), scaling([BASE_R, BASE_TOP, BASE_R])), color: BASE, spec: 0.35 });
    const padH = PAD_TOP - BASE_TOP + 0.004, padY = (PAD_TOP + BASE_TOP - 0.004) / 2;
    for (let p = 0; p < 4; p++) {
      const g = this.glow[p];
      const [sx, sz] = PAD_DIR[p];
      for (const a of [PAD_START[p], PAD_START[p] + Math.PI / 4]) {
        const x: Vec3 = [Math.cos(a) * PAD_R, 0, Math.sin(a) * PAD_R];
        const z: Vec3 = [-Math.sin(a) * PAD_R, 0, Math.cos(a) * PAD_R];
        out.push({
          mesh: 'wedge',
          model: basis(x, [0, padH, 0], z, [sx * GAP, padY, sz * GAP]),
          color: g > 0.01 ? mix(PAD_DIM[p], PAD_LIT[p], g) : PAD_DIM[p],
          pattern: g > 0.01 ? Pattern.emissive : Pattern.plain,
          spec: 0.5,
        });
      }
    }
    out.push({ mesh: 'cylinder', model: mul(translation([0, HUB_TOP / 2, 0]), scaling([HUB_R, HUB_TOP, HUB_R])), color: HUB, spec: 0.5 });

    // The screens.
    for (const s of this.screens) {
      const [nx, , nz] = s.normal;
      const across: Vec3 = [nz, 0, -nx];
      const frame = basis(scale(across, SCREEN_W + 0.5), [0, SCREEN_H + 0.5, 0], scale(s.normal, 0.3), s.pos);
      out.push({ mesh: 'box', model: frame, color: [0.2, 0.21, 0.23], spec: 0.3 });
      out.push({ mesh: 'box', model: basis(scale(across, SCREEN_W), [0, SCREEN_H, 0], scale(s.normal, 0.32), s.pos), color: [0.015, 0.02, 0.03], spec: 0.8 });
      if (this.timer >= 0) {
        const w = (SCREEN_W - 0.6) * this.timer;
        const left = add(s.pos, scale(across, -(SCREEN_W - 0.6) / 2 + w / 2));
        const color = this.timer > 0.3 ? [1.4, 1.2, 0.4] : [2, 0.3, 0.2];
        out.push({ mesh: 'box', model: basis(scale(across, w), [0, 0.14, 0], scale(s.normal, 0.34), add(left, [0, -SCREEN_H / 2 + 0.3, 0])), color, pattern: Pattern.emissive });
      }
    }

    // The trapdoor that flung the player: a floor plate snapped up on its hinge, over a dark hole.
    const c = this.catapult;
    if (c) drawTrapdoor(out, c.pos, c.yaw, c.t);
  }

  labels(): WorldLabel[] {
    return this.allLabels;
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
    return this.arrival.cameraShot();
  }
}

/** Which pad is at (x, z): each is a quarter disc cornered just off the centre lines, outside the hub. */
function padAt(x: number, z: number): Pad | null {
  if (Math.hypot(x, z) < HUB_R + 0.05) return null;
  for (let p = 0; p < 4; p++) {
    const [sx, sz] = PAD_DIR[p];
    const u = x * sx - GAP, v = z * sz - GAP;
    if (u > 0.05 && v > 0.05 && Math.hypot(u, v) < PAD_R) return p as Pad;
  }
  return null;
}

/** Height of the toy's surface (or the floor) at (x, z). */
function surfaceY(x: number, z: number) {
  const r = Math.hypot(x, z);
  if (r < HUB_R) return HUB_TOP;
  if (padAt(x, z) !== null) return PAD_TOP;
  return r < BASE_R ? BASE_TOP : 0;
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

function mix(a: number[], b: number[], t: number): number[] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
