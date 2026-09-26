import { noise, note, sfx, tone } from '../../engine/audio';
import { clamp, easeInOut, mul, normalize, rotationX, scaling, sub, translation, type Vec3 } from '../../engine/math';
import type { RAPIER } from '../../engine/physics';
import { Pattern, type DrawItem } from '../../engine/renderer';
import { drawBody, PART_NAMES, poseFrames, standingRoot, type BodyColors, type PartName, type PhysBody, type Pose } from '../../game/body';
import { CHAMBER_HALF } from '../../game/chamber';
import { PixelText } from '../../entities/pixelText';
import { ExitPortal, PortalArrival } from '../../entities/portal';
import { Confetti, Crowd, RunningTrack } from '../../entities/stadium';
import { DEFAULT_ENV, type CameraShot, type Level, type LevelContext, type LevelStatus, type TrackedTarget, type WorldLabel } from '../level';

/*
 * QWOP Olympics. After the arrival the chamber turns into a stadium: a running track across it
 * from west to east, bleachers full of fans along the north wall, a starter with a pistol, and a
 * scoreboard that has quietly crossed out 100 METRES in favour of 20. Then WASD stops working. The
 * only controls are Q W O P: Q and W swing the thighs, O and P bend the knees, and the body is a
 * physics puppet (Player.startPuppet) that has to be walked, shuffled or dragged across the line.
 * Head or chest on the ground: YOU FELL. 90 seconds and the crowd goes home. Cross the line: NEW
 * WORLD RECORD, confetti, legs back, and the exit.
 */

const START_X = -10;
const FINISH_X = 10;
const LANE_Z = 0;
const LANES = 6;
const LANE_W = 1.22;
/** The player's lane is the 4th: lanes run from the infield (north) toward the camera. */
const FIRST_LANE_Z = LANE_Z - 3 * LANE_W;
const TRACK_NORTH = FIRST_LANE_Z - LANE_W / 2;
const TRACK_SOUTH = FIRST_LANE_Z + LANE_W * (LANES - 0.5);
const SPAWN: Vec3 = [-6, 0, 7];
/** `?qwopQuick` skips the portal and the stadium's big reveal (for testing the running). */
const QUICK = new URLSearchParams(location.search).has('qwopQuick');
const TIME_LIMIT = 90;
const DEATH_SCREEN_DELAY = 1.8;
/** The tape across the finish, and the posts holding it. */
const TAPE_Y = 1.2;

/**
 * The feel of it (the level copies this into `tune`, which play-test bots can poke at).
 * thighFwd / thighBack / kneeBend / kneeStraight: how far the keys push the hips and knees (rad),
 * hipRate / kneeRate: how fast (rad/s); strength: the puppet's muscle (PhysBody.strength).
 * balanceK / balanceC / balanceMax: the helping hand, a torque on the chest toward a slight
 * forward lean (`lean`, rad): N·m per rad, N·m·s per rad, and at most this much. Enough to stand
 * still and to forgive a wobble, not a real mistake.
 */
const TUNING = {
  thighFwd: 1.2,
  thighBack: 0.8,
  kneeBend: 2.0,
  kneeStraight: 0.03,
  hipRate: 3,
  kneeRate: 5,
  strength: 3,
  balanceK: 1500,
  balanceC: 150,
  balanceMax: 600,
  lean: 0.12,
};
const LEAN = TUNING.lean;

/** Standing on the line. */
const SET_POSE: Pose = {
  lean: -LEAN, headPitch: 0, shoulderL: 0.1, shoulderR: -0.1, armOut: 0.08, elbowL: 0.4, elbowR: 0.4,
  hipL: 0.2, hipR: -0.2, kneeL: -0.08, kneeR: -0.12,
};

const STARTER: BodyColors = { suit: [0.62, 0.08, 0.1], pants: [0.92, 0.92, 0.9], skin: [0.85, 0.66, 0.52], hair: [0.72, 0.72, 0.74], pack: null, boot: [0.08, 0.08, 0.08] };
const STARTER_POS: Vec3 = [START_X - 1.3, 0, TRACK_NORTH - 0.3];

/** The other finalists, already out of it. */
const DNF: { colors: BodyColors; at: Vec3; how: 'plank' | 'splits' | 'bug' }[] = [
  { colors: { suit: [0.95, 0.8, 0.1], pants: [0.1, 0.5, 0.2], skin: [0.55, 0.38, 0.28], hair: [0.05, 0.04, 0.03], pack: null, boot: [0.9, 0.9, 0.9] }, at: [-6.2, 0, LANE_Z - LANE_W], how: 'plank' },
  { colors: { suit: [0.95, 0.95, 0.97], pants: [0.15, 0.3, 0.75], skin: [0.95, 0.78, 0.66], hair: [0.8, 0.6, 0.2], pack: null, boot: [0.15, 0.3, 0.75] }, at: [-8.3, 0, LANE_Z - 2 * LANE_W], how: 'splits' },
  { colors: { suit: [0.85, 0.12, 0.12], pants: [0.95, 0.95, 0.95], skin: [0.8, 0.58, 0.45], hair: [0.1, 0.07, 0.04], pack: null, boot: [0.1, 0.1, 0.1] }, at: [-2.6, 0, LANE_Z - 3 * LANE_W], how: 'bug' },
];

const AMBER = [1.6, 0.95, 0.25];
const LED_WHITE = [1.3, 1.3, 1.2];
const LED_RED = [1.8, 0.15, 0.1];
const LED_GREEN = [0.4, 1.6, 0.5];
const BOARD_Z = -CHAMBER_HALF + 0.2;

const FALL_JOKES = [
  'Legs: two. Knees: two. Idea how to use them: none.',
  'The crowd has seen toddlers with better form.',
  'Somewhere, an Olympic coach just felt a disturbance in the force.',
  'Gravity: 1. You: 0.',
  'The track is not a bed.',
  "It's Q W O P, not Q W O OW.",
  'Your legs have filed for divorce.',
  'Bold of you to try it without knees.',
];
const FALL_TIPS: [string, string][] = [
  ['Hint', 'Alternate Q and W to swing your thighs and tap O / P to bend your knees. Shuffling on your knees is a valid strategy. Nobody said it had to look good.'],
  ['Controls', 'Q / W thighs · O / P calves'],
];

/** Chants from the stands, by what you're up to. */
const CHANTS = {
  any: ['QWOP! QWOP!', 'USE YOUR LEGS!', 'BELIEVE!', 'LEFT! NO, OTHER LEFT!', "IT'S ONLY 20 METRES!", 'MY NAN RUNS FASTER', 'GO ON!', 'WE LOVE YOU!'],
  kneeling: ['IS HE PROPOSING?', 'KNEES ARE NOT FEET!', 'SCUTTLE! SCUTTLE!', 'HE KNELT. RESPECT.'],
  splits: ['OOF. THE SPLITS.', 'MY GROIN HURTS WATCHING', 'BENDY!'],
  backwards: ['WRONG WAY!', 'OTHER WAY!', 'THE FINISH IS OVER THERE!'],
  moving: ["HE'S MOVING!", 'GO GO GO!', 'LOOK AT HIM GO!', 'POETRY IN MOTION. BAD POETRY.'],
  stuck: ['DO SOMETHING!', 'IS HE STUCK?', 'I PAID FOR THIS', 'BORING!'],
  done: ['WORLD RECORD!', 'LEGEND!', 'WE BELIEVED!', 'I CRIED', 'HISTORY!'],
  leaving: ["I'M OFF", "TRAFFIC'S GONNA BE BAD", 'NIGHT ALL', 'SAME TIME NEXT YEAR'],
};

/** Best distance this session, for "personal best / worst" (survives restarts, not reloads). */
let personalBest: number | null = null;

const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

type Phase = 'arrive' | 'build' | 'marks' | 'set' | 'run' | 'finished' | 'fell' | 'timeout';

/** Lean of a body part about z (radians, + toward +x), in a side-on puppet. */
function tiltOf(rb: RAPIER.RigidBody) {
  const r = rb.rotation();
  const ux = 2 * (r.x * r.y - r.w * r.z);
  const uy = 1 - 2 * (r.x * r.x + r.z * r.z);
  return Math.atan2(ux, uy);
}

export class QwopLevel implements Level {
  readonly number: number;
  readonly title = 'QWOP Olympics';
  status: LevelStatus = 'playing';
  private arrival: PortalArrival;
  private exit = new ExitPortal(LANE_Z);
  private phase: Phase = 'arrive';
  /** Seconds in the current phase. */
  private t = 0;
  private runTime = 0;
  private camX = START_X;
  private crowd = new Crowd();
  private track = new RunningTrack({ lanes: LANES, laneWidth: LANE_W, firstLaneZ: FIRST_LANE_Z, from: -CHAMBER_HALF, to: CHAMBER_HALF, startX: START_X + 0.25, finishX: FINISH_X });
  private confetti = new Confetti();
  private death: { t: number; big: string; small: string; tips: [string, string][] } | null = null;
  /** Furthest the pelvis has got (m past the start), for milestones and the death screen. */
  private best = 0;
  private milestone = 0;
  private tapeBroken = -1;
  private bang = -1;
  private falseStart = false;
  private gasp = 0;
  private cheer = 0;
  private chantT = 3;
  private stuckT = 0;
  private murmurT = 0;
  private lastX = START_X;
  private speed = 0;
  // Scoreboard: 100 METRES (struck out), 20 METRES, WE BELIEVE IN YOU, and a status line.
  private rowOld = new PixelText({ centre: [0, 8.95, BOARD_Z], right: [1, 0, 0], up: [0, 1, 0], pixel: 0.13, color: AMBER, depth: 0.04, pattern: Pattern.emissive }, '100 METRES');
  private rowNew = new PixelText({ centre: [0, 7.85, BOARD_Z], right: [1, 0, 0], up: [0, 1, 0], pixel: 0.15, color: LED_GREEN, depth: 0.04, pattern: Pattern.emissive }, '20 METRES');
  private rowBelieve = new PixelText({ centre: [0, 6.8, BOARD_Z], right: [1, 0, 0], up: [0, 1, 0], pixel: 0.085, color: LED_WHITE, depth: 0.04, pattern: Pattern.emissive }, 'WE BELIEVE IN YOU');
  private rowStatus = new PixelText({ centre: [0, 5.85, BOARD_Z], right: [1, 0, 0], up: [0, 1, 0], pixel: 0.11, color: AMBER, depth: 0.04, pattern: Pattern.emissive }, '');
  private strike = 0;
  private chimed = false;
  private boardOn = 0;
  private signs: PixelText[] = [];
  private noteLabel: WorldLabel = { pos: [0, 5.05, BOARD_Z + 0.2], text: '', size: 0.34, color: '#ffe9a8' };
  private noteT = 0;
  private metresLabel: WorldLabel = { pos: [0, 0, 0], text: '', size: 0.34, color: '#ffffff' };
  private dnfLabels: WorldLabel[] = DNF.map((d) => ({ pos: [d.at[0] + (d.how === 'bug' ? -0.6 : 0.6), 1.1, d.at[2]], text: 'DNF', size: 0.3, color: '#ff8a80' }));
  private labelList: WorldLabel[] = [];
  /** The feel of it (see TUNING); play-test bots can change it. */
  readonly tune = { ...TUNING };
  private staticItems: DrawItem[] = [];
  private boardItems: DrawItem[] = [];

  constructor(private ctx: LevelContext) {
    this.number = ctx.number;
    const { hud, physics } = ctx;
    hud.setLevel(`The Chamber · Level ${this.number}`);
    hud.show(`LEVEL ${this.number}`, '', 2.5);
    hud.hint('');
    this.arrival = new PortalArrival(ctx, SPAWN);
    this.crowd.addColliders(physics);
    this.track.unroll = 0;
    physics.substepHooks.push((h) => this.balance(h));

    // Painted boards by the track: START, the 5 m marks, FINISH (facing the side-on camera).
    const board = (x: number, text: string, pixel: number, width: number) => {
      const z = TRACK_NORTH - 0.55;
      this.staticItems.push(
        { mesh: 'box', model: mul(translation([x, 1.05, z]), scaling([width, 0.62, 0.06])), color: [0.95, 0.95, 0.93], spec: 0.3 },
        { mesh: 'box', model: mul(translation([x - width * 0.4, 0.4, z - 0.02]), scaling([0.07, 0.8, 0.07])), color: [0.3, 0.3, 0.32] },
        { mesh: 'box', model: mul(translation([x + width * 0.4, 0.4, z - 0.02]), scaling([0.07, 0.8, 0.07])), color: [0.3, 0.3, 0.32] },
      );
      this.signs.push(new PixelText({ centre: [x, 1.05, z + 0.03], right: [1, 0, 0], up: [0, 1, 0], pixel, color: [0.12, 0.12, 0.15], depth: 0.02 }, text));
    };
    board(START_X, 'START', 0.07, 2.4);
    for (const m of [5, 10, 15]) board(START_X + m, `${m}M`, 0.07, 1.4);
    board(FINISH_X, 'FINISH', 0.07, 2.8);
    // Posts for the finish tape.
    for (const z of [TRACK_NORTH - 0.2, TRACK_SOUTH + 0.2]) {
      this.staticItems.push({ mesh: 'cylinder', model: mul(translation([FINISH_X, TAPE_Y / 2 + 0.05, z]), scaling([0.05, TAPE_Y + 0.1, 0.05])), color: [0.9, 0.9, 0.92], spec: 0.6 });
    }
    // The scoreboard's frame on the north wall.
    this.boardItems.push(
      { mesh: 'box', model: mul(translation([0, 7.35, -CHAMBER_HALF + 0.08]), scaling([15.4, 4.9, 0.16])), color: [0.05, 0.05, 0.06], spec: 0.4 },
      { mesh: 'box', model: mul(translation([0, 9.85, -CHAMBER_HALF + 0.1]), scaling([15.6, 0.12, 0.2])), color: [0.85, 0.7, 0.2], spec: 0.8 },
      { mesh: 'box', model: mul(translation([0, 4.85, -CHAMBER_HALF + 0.1]), scaling([15.6, 0.12, 0.2])), color: [0.85, 0.7, 0.2], spec: 0.8 },
    );
    for (const p of [this.rowOld, this.rowNew, this.rowBelieve, this.rowStatus, ...this.signs]) p.reveal = 0;
  }

  // --- Update ---------------------------------------------------------------------------------

  update(dt: number) {
    const { player, hud } = this.ctx;
    this.t += dt;
    const death = this.death;
    if (death && this.status === 'playing') {
      death.t += dt;
      if (death.t > DEATH_SCREEN_DELAY) {
        this.status = 'lost';
        hud.show(death.big, `${death.small}\nPress R to try again.`);
        hud.tips(death.tips);
      }
    }
    if (!QUICK) this.arrival.update(dt);
    this.exit.update(dt, player);
    if (this.exit.entered && this.status === 'playing') this.status = 'exited';
    this.crowd.update(dt);
    this.confetti.update(dt);
    if (this.tapeBroken >= 0) this.tapeBroken += dt;
    this.noteT -= dt;
    if (this.noteT <= 0) this.noteLabel.text = '';

    switch (this.phase) {
      case 'arrive':
        // ?qwopQuick: straight onto the line (for testing).
        if (QUICK) this.onYourMarks();
        else if (this.arrival.done && player.mode === 'control' && !player.gettingUp) this.enter('build');
        break;
      case 'build':
        this.updateBuild();
        break;
      case 'marks':
      case 'set':
        this.updateStart(dt);
        break;
      case 'run':
        this.updateRun(dt);
        break;
      case 'finished':
        if (player.mode === 'puppet' && this.t > 1.3) {
          player.stopPuppet();
          this.ctx.camera.yaw = -Math.PI / 2;
          this.ctx.camera.pitch = -0.15;
        }
        if (this.t > 2 && Math.random() < dt * 0.6) this.crowd.shout(pick(CHANTS.done));
        break;
      case 'fell':
        this.crowd.mood = this.t < 1.2 ? 'gasp' : 'idle';
        this.crowd.excitement = 0.15;
        break;
      case 'timeout':
        this.crowd.leave = clamp(this.t / 4, 0, 1);
        if (this.t > 0.6 && player.mode === 'puppet') {
          // Your legs have also gone home.
          player.kill([0.5, 0, 0]);
          sfx.thud(0.4);
        }
        if (this.t < 3 && Math.random() < dt * 1.5) this.crowd.shout(pick(CHANTS.leaving), 1.2);
        break;
    }

    if (player.body && (player.mode === 'puppet' || player.mode === 'ragdoll')) {
      const x = player.body.position('pelvis')[0];
      this.camX += (clamp(x, START_X + 0.5, FINISH_X - 0.5) - this.camX) * Math.min(1, dt * 3);
    }
    this.updateCrowdSound(dt);
    this.updateLabels();
  }

  private enter(phase: Phase) {
    this.phase = phase;
    this.t = 0;
  }

  private note(text: string, seconds = 3) {
    this.noteLabel.text = text;
    this.noteT = seconds;
  }

  /** The stadium rises out of the floor, and the scoreboard makes an announcement. */
  private updateBuild() {
    const t = this.t;
    this.crowd.rise = easeInOut(clamp(t / 1.6, 0, 1));
    this.track.unroll = easeInOut(clamp((t - 0.2) / 1.3, 0, 1));
    this.boardOn = clamp((t - 0.6) / 0.5, 0, 1);
    this.rowOld.reveal = clamp((t - 0.8) / 0.5, 0, 1);
    for (const s of this.signs) s.reveal = this.track.unroll;
    if (!this.chimed) {
      this.chimed = true;
      // Stadium chimes.
      tone(note('E5'), 0.6, { wave: 'sine', vol: 0.18 });
      tone(note('C5'), 0.9, { wave: 'sine', vol: 0.18, at: 0.4 });
      noise(1.6, { freq: 200, to: 60, vol: 0.25 }); // the rumble of bleachers
    }
    if (t > 2.0) {
      if (this.strike === 0) noise(0.25, { freq: 2500, to: 800, type: 'bandpass', q: 2, vol: 0.2 });
      this.strike = clamp((t - 2.0) / 0.35, 0, 1);
    }
    if (t > 2.6 && this.rowNew.reveal < 1) {
      if (this.rowNew.reveal === 0) {
        tone(note('G5'), 0.12, { wave: 'square', vol: 0.08 });
        this.note('(WE RAN OUT OF CHAMBER)', 2.5);
      }
      this.rowNew.reveal = clamp((t - 2.6) / 0.4, 0, 1);
    }
    if (t > 3.4) this.rowBelieve.reveal = clamp((t - 3.4) / 0.5, 0, 1);
    if (t > 4.6) this.onYourMarks();
  }

  /** WASD stops working: onto the line, and into the puppet. */
  private onYourMarks() {
    const { player } = this.ctx;
    this.enter('marks');
    this.rowNew.reveal = this.rowBelieve.reveal = this.rowOld.reveal = this.boardOn = 1;
    this.crowd.rise = this.track.unroll = 1;
    for (const s of this.signs) s.reveal = 1;
    player.pos = [START_X, 0, LANE_Z];
    player.facing = -Math.PI / 2;
    player.startPuppet(SET_POSE);
    player.puppetStrength = this.tune.strength;
    this.camX = START_X;
    this.rowStatus.setText('ON YOUR MARKS');
    this.rowStatus.reveal = 1;
    tone(660, 0.2, { wave: 'sine', vol: 0.15 });
    noise(0.3, { freq: 600, to: 300, type: 'bandpass', q: 1, vol: 0.12 }); // a puff of chalk
    this.crowd.mood = 'idle';
    this.crowd.excitement = 0.2;
  }

  private updateStart(dt: number) {
    const { input } = this.ctx;
    this.holdPose(dt);
    if (!this.falseStart && ['KeyQ', 'KeyW', 'KeyO', 'KeyP'].some((k) => input.wasPressed(k))) {
      this.falseStart = true;
      this.note("FALSE START. WE'LL ALLOW IT. NOBODY ELSE IS STANDING.", 3.5);
    }
    this.wasdJoke();
    if (this.phase === 'marks' && this.t > 1.5) {
      this.enter('set');
      this.rowStatus.setText('GET SET');
      tone(660, 0.2, { wave: 'sine', vol: 0.15 });
      this.crowd.excitement = 0.05; // a hush
    }
    if (this.phase === 'set' && this.t > 1.3) {
      this.enter('run');
      this.bang = 0;
      this.runTime = 0;
      this.rowStatus.setText('GO!');
      sfx.shot();
      noise(0.8, { freq: 900, to: 200, vol: 0.2, at: 0.08 }); // echo round the stadium
      this.crowd.mood = 'cheer';
      this.crowd.excitement = 0.8;
      this.cheer = 1.2;
      this.cheerSound(0.5);
    }
  }

  private wasdJoke() {
    const { input } = this.ctx;
    if (['KeyA', 'KeyS', 'KeyD'].some((k) => input.wasPressed(k))) {
      this.note(pick(['A, S AND D HAVE BEEN DISQUALIFIED.', 'WASD IS NOT AN OLYMPIC SPORT.', 'THIS IS A Q W O P EVENT.']), 2.5);
    }
  }

  private updateRun(dt: number) {
    const { player } = this.ctx;
    const body = player.body;
    if (player.mode !== 'puppet' || !body) return;
    this.runTime += dt;
    if (this.bang >= 0) this.bang += dt;
    this.drive(dt);
    this.wasdJoke();

    const pelvis = body.position('pelvis');
    const dist = pelvis[0] - START_X;
    this.best = Math.max(this.best, dist);
    this.speed += ((pelvis[0] - this.lastX) / Math.max(dt, 1e-3) - this.speed) * Math.min(1, dt * 2);
    this.lastX = pelvis[0];
    if (this.runTime > 0.9 || this.rowStatus.value !== 'GO!') this.rowStatus.setText(this.clock());

    // Milestones: the crowd goes up every 5 m.
    if (this.best >= this.milestone + 5 && this.milestone + 5 < FINISH_X - START_X) {
      this.milestone += 5;
      this.cheer = 1.6;
      this.crowd.shout(`${this.milestone} METRES!`, 2);
      this.cheerSound(0.35);
    }

    // Wobbling: the stands gasp.
    const tilt = tiltOf(body.parts.chest);
    if (Math.abs(tilt - LEAN) > 0.65 && this.gasp <= 0) {
      this.gasp = 1.2;
      this.gaspSound();
      if (Math.random() < 0.5) this.crowd.shout(pick(['WHOA!', 'OOOH!', 'CAREFUL!']), 1.2);
    }
    this.gasp -= dt;
    this.cheer -= dt;
    this.crowd.mood = this.gasp > 0 ? 'gasp' : this.cheer > 0 ? 'cheer' : 'idle';
    this.crowd.excitement = clamp(0.25 + this.speed * 0.5, 0.15, 1);

    // Something to shout about.
    this.chantT -= dt;
    this.stuckT = Math.abs(this.speed) < 0.08 ? this.stuckT + dt : 0;
    if (this.chantT <= 0) {
      this.chantT = 2.5 + Math.random() * 2.5;
      const hips = tiltOf(body.parts.pelvis);
      const spread = Math.abs(tiltOf(body.parts.thighL) - tiltOf(body.parts.thighR));
      const list = pelvis[1] < 0.6 && Math.abs(hips) < 0.8 ? CHANTS.kneeling
        : spread > 2.2 ? CHANTS.splits
        : this.speed < -0.25 || dist < -0.4 ? CHANTS.backwards
        : this.stuckT > 3 ? CHANTS.stuck
        : this.speed > 0.4 ? CHANTS.moving
        : CHANTS.any;
      this.crowd.shout(pick(list));
    }

    if (pelvis[0] >= FINISH_X) return this.finish();
    if (this.touchingGround(body, 'head') || this.touchingGround(body, 'chest')) return this.fall(dist);
    if (this.runTime >= TIME_LIMIT) return this.timeout(dist);
  }

  /** Q W O P: the keys push the hip and knee targets along at a rate; let go and they stay put. */
  private drive(dt: number) {
    const { player, input } = this.ctx;
    const q = input.isDown('KeyQ'), w = input.isDown('KeyW'), o = input.isDown('KeyO'), p = input.isDown('KeyP');
    const pose = player.puppetPose;
    const hs = (q ? 1 : 0) - (w ? 1 : 0), ks = (o ? 1 : 0) - (p ? 1 : 0);
    const u = this.tune;
    pose.hipL = clamp(pose.hipL + hs * u.hipRate * dt, -u.thighBack, u.thighFwd);
    pose.hipR = clamp(pose.hipR - hs * u.hipRate * dt, -u.thighBack, u.thighFwd);
    pose.kneeL = clamp(pose.kneeL - ks * u.kneeRate * dt, -u.kneeBend, -u.kneeStraight);
    pose.kneeR = clamp(pose.kneeR + ks * u.kneeRate * dt, -u.kneeBend, -u.kneeStraight);
    this.holdPose(dt);
  }

  /** The arms swing against the legs (and the pistol-shot flinch). */
  private holdPose(_dt: number) {
    const { player } = this.ctx;
    const pose = player.puppetPose;
    player.puppetStrength = this.tune.strength;
    pose.shoulderL = -pose.hipL * 0.7;
    pose.shoulderR = -pose.hipR * 0.7;
    pose.elbowL = pose.elbowR = 0.5;
    pose.lean = -this.tune.lean;
    pose.headPitch = 0.05;
  }

  /** A little help staying upright: a torque on the chest toward a slight forward lean. */
  private balance(h: number) {
    const { player } = this.ctx;
    const body = player.body;
    if (player.mode !== 'puppet' || !body) return;
    const chest = body.parts.chest;
    const tilt = tiltOf(chest);
    const w = chest.angvel().z; // + turns +x toward +y: leaning back
    // A torque toward the lean; tilting forward is negative about z.
    const u = this.tune;
    const tau = clamp(-u.balanceK * (tilt - u.lean) + u.balanceC * w, -u.balanceMax, u.balanceMax);
    chest.applyTorqueImpulse({ x: 0, y: 0, z: -tau * h }, true);
  }

  /** True if the part is resting on (or hitting) anything that isn't the body itself. */
  private touchingGround(body: PhysBody, part: PartName) {
    const collider = body.colliders[PART_NAMES.indexOf(part)];
    const world = this.ctx.physics.world;
    let touching = false;
    world.contactPairsWith(collider, (other) => {
      if (touching || body.owns(other)) return;
      world.contactPair(collider, other, (m) => {
        for (let i = 0; i < m.numContacts(); i++) if (m.contactDist(i) < 0.02) touching = true;
      });
    });
    return touching;
  }

  private clock() {
    const left = Math.max(0, TIME_LIMIT - this.runTime);
    return `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}.${Math.floor((left * 10) % 10)}`;
  }

  // --- Endings ----------------------------------------------------------------------------------

  private finish() {
    const { hud } = this.ctx;
    this.enter('finished');
    this.tapeBroken = 0;
    const time = this.runTime.toFixed(1);
    this.rowStatus.setText(`${time} S`);
    this.rowBelieve.setText('NEW WORLD RECORD');
    this.confetti.burst([FINISH_X + 0.5, 3.5, LANE_Z], 3);
    this.crowd.mood = 'cheer';
    this.crowd.excitement = 1;
    this.cheer = 99;
    this.cheerSound(1);
    noise(0.15, { freq: 3500, type: 'highpass', vol: 0.3 }); // snap goes the tape
    ['G4', 'C5', 'E5', 'G5', 'E5', 'G5', 'C6'].forEach((n, i) =>
      tone(note(n), i === 6 ? 0.9 : 0.16, { wave: 'square', vol: 0.1, at: 0.3 + i * 0.15 + (i > 3 ? 0.1 : 0) }));
    hud.show('NEW WORLD RECORD', `20 metres in ${time} seconds. The 100 m record is 9.58, but that was a much bigger chamber.`, 4.5);
    this.note('LEGS RETURNED TO THEIR OWNER. PLEASE EXIT TO THE EAST.', 6);
    this.exit.openNow();
    personalBest = Math.max(personalBest ?? 0, FINISH_X - START_X);
  }

  private fall(dist: number) {
    const { player, camera } = this.ctx;
    this.enter('fell');
    player.kill([0, 0, 0]);
    camera.addShake(0.25);
    sfx.thud(0.5);
    this.awwSound();
    this.rowStatus.setText('OUCH');
    const d = Math.max(0, dist);
    const verdict = personalBest === null ? 'A PERSONAL BEST. ALSO A PERSONAL WORST.'
      : d > personalBest + 0.05 ? 'A PERSONAL BEST!'
      : d < personalBest - 0.05 ? 'A PERSONAL WORST.'
      : 'EXACTLY AS FAR AS LAST TIME. CONSISTENT.';
    personalBest = Math.max(personalBest ?? 0, d);
    const metres = dist < -0.3 ? `${(-dist).toFixed(1)} METRES BACKWARDS. BOLD.` : `${d.toFixed(1)} METRES. ${verdict}`;
    this.crowd.shout(pick(['OHHH!', 'NOOO!', 'MEDIC!', 'HE DIED', 'ENCORE!']), 2);
    this.death = { t: 0, big: 'YOU FELL', small: `${metres}\n${pick(FALL_JOKES)}`, tips: FALL_TIPS };
  }

  private timeout(dist: number) {
    this.enter('timeout');
    this.rowStatus.setText('CLOSED');
    this.rowBelieve.setText('WE STOPPED BELIEVING');
    this.crowd.mood = 'stare';
    this.crowd.excitement = 0;
    tone(note('C5'), 0.5, { wave: 'sine', vol: 0.16 });
    tone(note('E4'), 0.9, { wave: 'sine', vol: 0.16, at: 0.4 });
    this.note('THE STADIUM IS NOW CLOSED. PLEASE LEAVE BY THE NEAREST EXIT. NOT THAT ONE.', 4);
    const d = Math.max(0, dist);
    personalBest = Math.max(personalBest ?? 0, d);
    this.death = {
      t: -2.5, big: 'THE CROWD WENT HOME',
      small: `${TIME_LIMIT} seconds and ${d.toFixed(1)} metres. Even the starter has gone for a sandwich.`, tips: FALL_TIPS,
    };
  }

  // --- Sound ------------------------------------------------------------------------------------

  private updateCrowdSound(dt: number) {
    if (this.crowd.rise < 0.5 || this.crowd.leave >= 1) return;
    this.murmurT -= dt;
    if (this.murmurT > 0) return;
    this.murmurT = 0.45;
    const loud = (0.03 + 0.05 * this.crowd.excitement) * (1 - this.crowd.leave);
    noise(1.0, { freq: 500 + Math.random() * 300, type: 'bandpass', q: 0.8, vol: loud });
  }

  private cheerSound(size: number) {
    noise(1.2 + size * 1.5, { freq: 1400, to: 900, type: 'bandpass', q: 0.5, vol: 0.12 + size * 0.2 });
    for (let i = 0; i < 2 + size * 4; i++) {
      tone(2300 + Math.random() * 700, 0.25, { to: 2900 + Math.random() * 500, wave: 'sine', vol: 0.035, at: Math.random() * 0.8 });
    }
  }

  private gaspSound() {
    noise(0.7, { freq: 700, to: 350, type: 'bandpass', q: 1.5, vol: 0.14 });
    tone(290, 0.7, { to: 230, wave: 'sine', vol: 0.05 });
  }

  private awwSound() {
    tone(330, 1.3, { to: 210, wave: 'triangle', vol: 0.08, attack: 0.1 });
    tone(262, 1.3, { to: 165, wave: 'triangle', vol: 0.07, attack: 0.1 });
    noise(1.3, { freq: 600, to: 250, type: 'bandpass', q: 1.2, vol: 0.14 });
  }

  // --- Labels -----------------------------------------------------------------------------------

  private updateLabels() {
    const { camera, player } = this.ctx;
    const list = this.labelList;
    list.length = 0;
    for (const l of this.crowd.labels) list.push(l);
    if (this.noteLabel.text) list.push(this.noteLabel);
    if (this.phase !== 'arrive' && this.phase !== 'build') for (const l of this.dnfLabels) list.push(l);
    // QWOP's distance readout, pinned near the top of the side-on view.
    const running = this.phase === 'run' || this.phase === 'fell' || this.phase === 'timeout' || this.phase === 'marks' || this.phase === 'set';
    if (running && player.body) {
      const fwd = normalize(sub(camera.target, camera.pos));
      const d = player.body.position('pelvis')[0] - START_X;
      this.metresLabel.pos = [camera.pos[0] + fwd[0] * 5 - 4.2, camera.pos[1] + fwd[1] * 5 + 2.45, camera.pos[2] + fwd[2] * 5];
      this.metresLabel.text = `${(Math.abs(d) < 0.05 ? 0 : d).toFixed(1)} metres`;
      list.push(this.metresLabel);
    }
  }

  labels(): WorldLabel[] {
    return this.labelList;
  }

  // --- Drawing ----------------------------------------------------------------------------------

  draw(out: DrawItem[], time: number) {
    this.arrival.draw(out);
    this.exit.draw(out);
    this.track.draw(out);
    this.crowd.draw(out);
    if (this.phase === 'arrive') return;
    for (const it of this.staticItems) out.push(it);
    if (this.boardOn > 0) for (const it of this.boardItems) out.push(it);
    for (const p of [this.rowOld, this.rowNew, this.rowBelieve, this.rowStatus, ...this.signs]) {
      const start = out.length;
      p.draw(out);
      for (let i = start; i < out.length; i++) out[i].shadow = false;
    }
    if (this.strike > 0) {
      // A red line through 100 METRES.
      const w = 7.8 * this.strike;
      out.push({ mesh: 'box', model: mul(translation([-3.9 + w / 2, 8.95, BOARD_Z + 0.08]), scaling([w, 0.16, 0.05])), color: LED_RED, pattern: Pattern.emissive, shadow: false });
    }
    this.drawTape(out);
    this.drawStarter(out, time);
    this.drawDnf(out);
    this.confetti.draw(out);
  }

  private drawTape(out: DrawItem[]) {
    const len = TRACK_SOUTH - TRACK_NORTH + 0.4;
    const color = [0.98, 0.95, 0.3];
    if (this.tapeBroken < 0) {
      out.push({ mesh: 'box', model: mul(translation([FINISH_X, TAPE_Y, (TRACK_NORTH + TRACK_SOUTH) / 2]), scaling([0.03, 0.06, len])), color, shadow: false });
      return;
    }
    // Snapped: each half droops from its post.
    const droop = Math.min(1.35, this.tapeBroken * 4) + Math.sin(this.tapeBroken * 6) * 0.08 * Math.exp(-this.tapeBroken);
    const half = len / 2;
    for (const side of [-1, 1]) {
      const postZ = side < 0 ? TRACK_NORTH - 0.2 : TRACK_SOUTH + 0.2;
      const a = droop * side;
      const cz = postZ - side * Math.cos(droop) * half / 2;
      const cy = TAPE_Y - Math.sin(droop) * half / 2;
      out.push({ mesh: 'box', model: mul(translation([FINISH_X + 0.1, cy, cz]), rotationX(a), scaling([0.03, 0.06, half])), color, shadow: false });
    }
  }

  private drawStarter(out: DrawItem[], time: number) {
    const armed = this.phase === 'set' || (this.bang >= 0 && this.bang < 1.2);
    const facepalm = this.phase === 'fell' && this.t > 0.5;
    const happy = this.phase === 'finished';
    const gone = this.phase === 'timeout' && this.t > 2;
    if (gone) return;
    const pose: Pose = {
      lean: 0, headPitch: facepalm ? 0.35 : 0, shoulderL: 0.05, shoulderR: 0.05, armOut: 0.12, elbowL: 0.2, elbowR: 0.2,
      hipL: 0, hipR: 0, kneeL: -0.05, kneeR: -0.05,
    };
    if (armed) {
      pose.shoulderR = Math.PI - 0.15;
      pose.elbowR = 0.1;
      pose.armOut = 0.15;
    }
    if (facepalm) {
      pose.shoulderL = 2.3;
      pose.elbowL = 2.3;
    }
    if (happy) {
      pose.shoulderL = pose.shoulderR = 2.7 + Math.sin(time * 9) * 0.3;
      pose.armOut = 0.5;
    }
    // Stands just off the track by the start, facing the camera.
    const frames = poseFrames(standingRoot(STARTER_POS, Math.PI), pose);
    drawBody(out, frames, 1.05, STARTER);
    // The pistol, and its smoke.
    out.push({ mesh: 'box', model: mul(frames.foreArmR, translation([0, -0.2, -0.06]), scaling([0.05, 0.08, 0.2])), color: [0.12, 0.12, 0.13], spec: 0.8 });
    if (this.bang >= 0 && this.bang < 1.5) {
      const tip = frames.foreArmR;
      const k = this.bang / 1.5;
      out.push({
        mesh: 'sphere', model: mul(translation([tip[12], tip[13] + 0.35 + k * 0.8, tip[14]]), scaling([0.12 + k * 0.4, 0.12 + k * 0.4, 0.12 + k * 0.4])),
        color: [0.85, 0.85, 0.85], opacity: 1 - k, shadow: false,
      });
    }
  }

  private drawDnf(out: DrawItem[]) {
    for (const d of DNF) {
      let root, pose: Pose;
      if (d.how === 'plank') {
        // Face down, arms out in front, like a very committed dive.
        root = mul(standingRoot([d.at[0], 0.17, d.at[2]], -Math.PI / 2), rotationX(-Math.PI / 2 + 0.06));
        pose = { lean: 0, headPitch: -0.3, shoulderL: 2.9, shoulderR: 2.7, armOut: 0.3, elbowL: 0.1, elbowR: 0.2, hipL: 0, hipR: 0.1, kneeL: -0.2, kneeR: -0.5 };
      } else if (d.how === 'splits') {
        root = standingRoot(d.at, -Math.PI / 2);
        pose = { crouch: 0.8, lean: 0.1, headPitch: 0.2, shoulderL: 0.4, shoulderR: 0.4, armOut: 1.2, elbowL: 0.3, elbowR: 0.3, hipL: 1.52, hipR: -1.52, kneeL: -0.02, kneeR: -0.02 };
      } else {
        // On his back with his legs in the air, like a dead beetle.
        root = mul(standingRoot([d.at[0], 0.16, d.at[2]], -Math.PI / 2), rotationX(Math.PI / 2));
        pose = { lean: 0.1, headPitch: 0.3, shoulderL: 1.4, shoulderR: 1.6, armOut: 0.2, elbowL: 0.6, elbowR: 0.4, hipL: 1.3, hipR: 1.1, kneeL: -1.6, kneeR: -1.9 };
      }
      drawBody(out, poseFrames(root, pose), 1, d.colors);
    }
  }

  // --- Level plumbing ---------------------------------------------------------------------------

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
    const shot = QUICK ? null : this.arrival.cameraShot();
    if (shot) return shot;
    switch (this.phase) {
      case 'build':
        // Taking in the stadium.
        return { pos: [0, 4.2, 10.5], target: [0, 3, -8], sharpness: 2.5 };
      case 'marks':
      case 'set':
      case 'run':
      case 'fell':
      case 'timeout': {
        // Side on, like the original, following the runner.
        const x = this.camX + 0.7;
        return { pos: [x, 1.55, LANE_Z + 5], target: [x, 1.0, LANE_Z], sharpness: this.phase === 'marks' && this.t < 0.1 ? 60 : 5 };
      }
      case 'finished':
        if (this.ctx.player.mode === 'puppet') return { pos: [this.camX + 0.7, 1.55, LANE_Z + 5], target: [this.camX + 0.7, 1.0, LANE_Z], sharpness: 5 };
        return null;
      default:
        return null;
    }
  }
}
