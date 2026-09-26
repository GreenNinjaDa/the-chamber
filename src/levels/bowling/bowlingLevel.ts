import { basis, clamp, easeInOut, fromQuat, mul, quatMul, rotationY, scaling, translation, type Quat, type Vec3 } from '../../engine/math';
import { RAPIER, type Body } from '../../engine/physics';
import { Pattern, type DrawItem } from '../../engine/renderer';
import { BALL_COLORS, drawBowlingBall, PIN_BELLY, PIN_HEIGHT, pinSpots, spawnPin, uprightness } from '../../entities/bowling';
import { ExitPortal, PortalArrival } from '../../entities/portal';
import { DEFAULT_ENV, type CameraShot, type Level, type LevelContext, type LevelStatus, type TrackedTarget, type WorldLabel } from '../level';
import {
  addLaneColliders, buildLaneDraws, GUTTER_W, GUTTER_Y, HALF, HATCH_H, HATCH_HALF, HEAD_PIN_Z, LANE_HALF, PIT_EDGE, PIT_Y,
  scoreboardDraws, STEEL, TUNNEL_END,
} from './lane';

/*
 * Bowling. The chamber is a bowling lane and you arrive on the pin deck, among ten pins your
 * size: you're the eleventh pin. A launcher behind a hatch in the south wall fires huge balls
 * down the lane at you (straight, then a late hook, then two at once, then one the size of a
 * house), and after each ball the pinsetter sweeps the deck into the pit and lowers fresh pins
 * onto their spots. Survive four frames and the exit opens, with one last ball for the road.
 */

// --- Balls ---------------------------------------------------------------------------------------
const BALL_R = 1.25;
/** Where a ball waits in the launcher tunnel before it's fired, and where it appears. */
const LOAD_Z = 13.5;
const BACK_Z = TUNNEL_END - BALL_R - 0.05;
/** The furthest a lane ball's centre goes from the middle: its edge stays on the lane. */
const LANE_LIMIT = LANE_HALF - BALL_R;
const GUTTER_X = HALF - GUTTER_W / 2;
const GRAVITY = 20;
/** Balls kill anything whose middle comes within their radius plus this. */
const HIT_MARGIN = 0.32;

type Kind = 'straight' | 'hook' | 'split' | 'giant' | 'final';
/** The frames, in order; after the last, 'final' balls keep coming until you leave. */
const FRAMES: Kind[] = ['straight', 'hook', 'split', 'giant'];

interface Aim {
  /** Forward speed (m/s, toward the pins). */
  speed: number;
  /** Lateral steering (m/s²) and top lateral speed (m/s) once it hooks. */
  accel: number;
  maxLat: number;
}

const AIMS: Record<Exclude<Kind, 'giant'> | 'gutter', Aim> = {
  straight: { speed: 11, accel: 0, maxLat: 0 },
  hook: { speed: 12.5, accel: 16, maxLat: 8 },
  split: { speed: 10.5, accel: 14, maxLat: 6 },
  final: { speed: 12, accel: 9, maxLat: 5 },
  gutter: { speed: 11, accel: 0, maxLat: 0 },
};
/** A hook rolls straight down a line this far to the side of you, and starts curving this far out. */
const HOOK_OFFSET = 4;
const HOOK_LEAD = 11;
/** The two split balls close in on you from this far either side down to this. */
const SPLIT_FROM = 3.8;
const SPLIT_TO = 1.95;
const SPLIT_CATCH_UP = 1.3;

interface Ball {
  body: Body;
  r: number;
  pos: Vec3;
  vx: number;
  vy: number;
  vz: number;
  aim: Aim;
  kind: Kind | 'gutter';
  /** For split balls: which side of you it keeps to (-1 west, 1 east). */
  side: number;
  /** z where it was fired, and the player's z then (for how far along it is). */
  fromZ: number;
  toZ: number;
  /** The straight line it rolls along before (or without) steering. */
  lineX: number;
  /** 0 on the lane, else which gutter it's in. */
  gutter: number;
  state: 'loaded' | 'rolling' | 'falling';
}

// --- The giant ball ---------------------------------------------------------------------------------
const GIANT_R = 6;
const GIANT_START_Z = HALF - GIANT_R - 0.3;
const GIANT_MAX_X = HALF - GIANT_R - 0.2;
const GIANT_DROP_FROM = 42;
const GIANT_GRAVITY = 16;
const GIANT_SPEED = 7.5;
const GIANT_ACCEL = 3.5;
const DEFLATE_TIME = 2.4;

// --- Launcher -----------------------------------------------------------------------------------
const DOOR_TIME = 0.7;
/** From the hatch starting to open to the first ball being fired, and to the second (split). */
const FIRE_AT = 1.9;
const SECOND_AT = 0.32;

// --- Sweep and pinsetter --------------------------------------------------------------------------
const SWEEP_START = HEAD_PIN_Z + 1.9;
const SWEEP_END = -HALF + 0.9;
const SWEEP_LIFT = 8.4;
/**
 * The bar: low and thin, and quick, so it's under you only briefly: jumping when it's about a
 * metre away clears it (a window of about 0.3 s).
 */
const SWEEP_HEIGHT = 0.55;
const SWEEP_DEPTH = 0.25;
const SWEEP_DROP_TIME = 1.1;
const SWEEP_HOLD = 0.6;
const SWEEP_SPEED = 4.0;
const SWEEP_RAISE_TIME = 0.7;
const SWEEP_RETURN_SPEED = 9;
/** New pins come down from this high (their bases) over RACK_TIME. */
const RACK_TOP = 10.4;
const RACK_TIME = 2.4;
/** After the last ball of a frame: when the verdict goes up, and when the sweep starts. */
const SCORE_AT = 1.0;
const SWEEP_AT = 2.0;
const HEAD_BOTTOM = 10.4;
const HEAD_TOP = 12.3;

const SPAWN: Vec3 = [0, 0, HEAD_PIN_Z - 1.85];
/** The exit: halfway down the east gutter, toward the launcher, so the run to it meets the last ball. */
const EXIT_Z = 1.5;
const INTRO_TIME = 3.4;
const DEATH_SCREEN_DELAY = 1.6;

const YELLOW = '#ffd166';
const RED = '#ff4a3a';
const CYAN = '#8fd3ff';

type DeathKind = 'ball' | 'cannon' | 'gutter' | 'giant' | 'sweep' | 'pinned' | 'pit';

const DEATHS: Record<DeathKind, { big: string; small: string[]; hint: string; board: string }> = {
  ball: {
    big: 'STRIKE!',
    small: ['You were the eleventh pin.', 'The Dude does not abide.', 'Mark it zero, Dude.', 'Personal best. For the ball.'],
    hint: "Get out of the ball's way: it's aimed at where you are when it's fired, and hooks toward you on the way. The gutters are safe from balls down the lane.",
    board: 'STRIKE!',
  },
  cannon: {
    big: 'STRIKE!',
    small: ['You stood in front of a bowling cannon. Bold. Wrong, but bold.', 'Point blank. The ball did not even have to try.'],
    hint: 'The hatch in the south wall is where the balls come from. Stand well back from it, then dodge.',
    board: 'STRIKE!',
  },
  gutter: {
    big: 'GUTTER BALL',
    small: ['The gutter was safe. Right up until the ball got there too.', 'You found the gutter. So did the ball.'],
    hint: "Whoever is in a gutter when the ball is fired gets a gutter ball. Get in after it's fired, or jump out when you see one coming.",
    board: 'GUTTER BALL',
  },
  giant: {
    big: 'STRIKE!',
    small: ['That ball had its own weather.', 'Some balls are too big to dodge. On the lane, anyway.', 'Obviously you\'re not a golfer.'],
    hint: 'The huge one is too big to dodge on the lane. Hide in a gutter: it passes right over.',
    board: 'STRIKE!',
  },
  sweep: {
    big: 'CLEARED',
    small: ['You were cleared from the lane.', 'The pinsetter does not care what you identify as.'],
    hint: 'After every ball a bar sweeps the pin deck into the pit. Jump it (Space) just before it reaches you, or stay behind it.',
    board: 'CLEARED',
  },
  pinned: {
    big: 'PINNED',
    small: ['A pin was lowered onto its spot. You were on its spot.', 'Congratulations: you have been set.'],
    hint: "When fresh pins come down, don't stand on a pin spot (the dark dots on the deck). Watch for their shadows.",
    board: 'PINNED',
  },
  pit: {
    big: 'CLEARED',
    small: ['You went into the pit of your own accord. The pinsetter thanks you for your help.'],
    hint: 'The pit at the end of the lane is for pins and balls. Stay on the lane.',
    board: 'CLEARED',
  },
};

const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

export class BowlingLevel implements Level {
  readonly number = 6;
  readonly title = 'Bowling';
  readonly chamber = { none: true };
  status: LevelStatus = 'playing';

  private arrival: PortalArrival;
  private exit = new ExitPortal(EXIT_Z, GUTTER_Y);
  private staticDraws: DrawItem[];

  private phase: 'arrive' | 'intro' | 'hatch' | 'roll' | 'settle' | 'sweep' | 'rack' | 'pause' | 'giantDrop' | 'giantRoll' | 'giantGone' = 'arrive';
  private phaseT = 0;
  private frame = 0;
  private t = 0;

  private balls: Ball[] = [];
  private fired = 0;
  private gutterBallThisFrame = false;
  private giant: { body: Body | null; pos: Vec3; vx: number; vy: number; vz: number; rot: Quat; spin: Quat; wander: Vec3; wanderT: number; deflateT: number } | null = null;

  /** Every pin in the level, and the rack currently standing (or last stood) on the spots. */
  private pins: Body[] = [];
  private rack: Body[] = [];
  private readonly spots = pinSpots(HEAD_PIN_Z);
  private rackT = -1;

  private door: RAPIER.Collider;
  private doorOpen = 0;
  private pusher = { z: BACK_Z + 2, yaw: 0, lunge: -1 };

  private sweepRb: RAPIER.RigidBody;
  private sweep = { state: 'idle' as 'idle' | 'down' | 'hold' | 'push' | 'raise' | 'back', t: 0, z: SWEEP_START, lift: SWEEP_LIFT };

  private strikes = 0;
  private marks: string[] = ['', '', '', '', ''];
  private flash = 0;
  private readonly labelList: WorldLabel[];
  private readonly reaction: WorldLabel = { pos: [0, 5.55, -11.8], text: '', size: 1, color: YELLOW };
  private readonly southReaction: WorldLabel = { pos: [0, 6.75, 11.8], text: '', size: 0.7, color: YELLOW };
  private readonly southSub: WorldLabel = { pos: [0, 5.75, 11.8], text: '', size: 0.34, color: CYAN };
  private readonly markLabels: WorldLabel[];
  private reactionColor = YELLOW;

  private death: { kind: DeathKind; t: number } | null = null;

  constructor(private ctx: LevelContext) {
    const { physics, hud, camera } = ctx;
    hud.setLevel(`The Chamber · Level ${this.number}`);
    hud.show(`LEVEL ${this.number}`, '', 2.5);
    hud.hint('');
    camera.confine = false;
    camera.bounds = { min: [-HALF + 0.3, PIT_Y + 0.6, -HALF + 0.3], max: [HALF - 0.3, 40, HALF - 0.3] };
    // A pin's-eye view: looking down the lane at the launcher.
    camera.yaw = Math.PI;

    addLaneColliders(physics);
    this.staticDraws = [
      ...buildLaneDraws(),
      ...scoreboardDraws([0, 6.9, -HALF], 15, 4.4, 1),
      ...scoreboardDraws([0, 6.3, HALF], 9, 2.5, -1),
      ...this.gantryDraws(),
    ];

    this.door = physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(HATCH_HALF, HATCH_H / 2, 0.15).setTranslation(0, HATCH_H / 2, HALF + 0.2),
    );

    // The sweep bar: a plate across the lane and a lower one in each gutter, so it's the same
    // height to jump from either.
    this.sweepRb = physics.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicVelocityBased().setTranslation(0, SWEEP_LIFT, SWEEP_START));
    const hy = SWEEP_HEIGHT / 2, hz = SWEEP_DEPTH / 2;
    physics.world.createCollider(RAPIER.ColliderDesc.cuboid(LANE_HALF, hy, hz).setTranslation(0, 0.03 + hy, 0), this.sweepRb);
    for (const s of [-1, 1]) {
      physics.world.createCollider(RAPIER.ColliderDesc.cuboid(GUTTER_W / 2, hy, hz).setTranslation(s * GUTTER_X, GUTTER_Y + 0.03 + hy, 0), this.sweepRb);
    }

    for (const spot of this.spots) this.rack.push(this.addPin(spot));

    // The scoreboard.
    const frameX = (i: number) => (i - 2) * 2.6;
    this.markLabels = this.marks.map((_, i) => ({ pos: [frameX(i), 7.1, -11.8] as Vec3, text: '', size: 0.72, color: '#ffffff' }));
    this.labelList = [
      { pos: [0, 8.55, -11.8], text: 'LANE 11 · BOWLER: THE MACHINE · PIN 11: YOU', size: 0.36, color: CYAN },
      ...this.marks.map((_, i) => ({ pos: [frameX(i), 7.85, -11.8] as Vec3, text: `${i + 1}`, size: 0.3, color: '#7f95b8' })),
      ...this.markLabels,
      this.reaction,
      this.southReaction,
      this.southSub,
      { pos: [0, 4.3, 11.85], text: 'APERTURE-ADJACENT BOWLING ENRICHMENT DEVICE', size: 0.24 },
      { pos: [0, 3.82, 11.85], text: 'Please remain pin-shaped.', size: 0.2, color: '#d8d8d8' },
    ];
    for (let i = 0; i < 5; i++) {
      this.staticDraws.push({
        mesh: 'box', model: mul(translation([frameX(i), 7.4, -HALF + 0.13]), scaling([2.1, 1.55, 0.04])), color: [0.04, 0.055, 0.12], spec: 0.05,
      });
    }

    this.arrival = new PortalArrival(ctx, SPAWN, { minElevationDeg: 70 });
  }

  private gantryDraws(): DrawItem[] {
    const out: DrawItem[] = [];
    const box = (c: Vec3, s: Vec3, color = STEEL, glow = false) => out.push({
      mesh: 'box', model: mul(translation(c), scaling(s)), color, spec: 0.5, pattern: glow ? Pattern.emissive : undefined, shadow: glow ? false : undefined,
    });
    const zMid = HEAD_PIN_Z - 2.1;
    // Beams across the wall tops carrying the pinsetter head over the deck, and rails for the sweep.
    for (const z of [zMid - 1.4, zMid + 1.4]) box([0, 10.2, z], [HALF * 2 + 1, 0.4, 0.35]);
    box([0, (HEAD_BOTTOM + HEAD_TOP) / 2, zMid], [7, HEAD_TOP - HEAD_BOTTOM, 5.6], [0.14, 0.15, 0.17]);
    box([0, HEAD_BOTTOM + 0.35, zMid + 2.81], [6.6, 0.25, 0.04], [2.6, 0.6, 0.15], true);
    for (const s of [-1, 1]) box([s * (HALF + 0.25), 10.15, (SWEEP_START + SWEEP_END) / 2], [0.5, 0.3, SWEEP_START - SWEEP_END + 1.5]);
    return out;
  }

  private addPin(spot: Vec3): Body {
    const body = spawnPin(this.ctx.physics, spot);
    this.pins.push(body);
    return body;
  }

  // --- Update -----------------------------------------------------------------------------------

  update(dt: number) {
    this.t += dt;
    this.phaseT += dt;
    this.flash = Math.max(0, this.flash - dt);
    const { player } = this.ctx;
    this.arrival.update(dt);
    this.exit.update(dt, player);
    if (this.exit.entered && this.status === 'playing') this.status = 'exited';

    this.keepCameraAboveFloor();
    this.runPhase(dt);
    this.updateBalls(dt);
    this.updateGiant(dt);
    this.updateSweep(dt);
    this.updateRack(dt);
    this.updateLauncher(dt);
    this.cleanUpPins();
    this.checkPit();

    const death = this.death;
    if (death && this.status === 'playing') {
      death.t += dt;
      // Swept away: wait to see them go over the edge.
      const pelvis = player.body?.position('pelvis');
      const waiting = death.kind === 'sweep' && death.t < 4.5 && pelvis !== undefined && pelvis[1] > -1.5;
      if (!waiting && death.t > DEATH_SCREEN_DELAY) {
        const d = DEATHS[death.kind];
        this.status = 'lost';
        this.ctx.hud.show(d.big, `${pick(d.small)}\nPress R to try again.`);
        this.ctx.hud.tips([
          ['Hint', d.hint],
          ['Controls', 'WASD move · Shift sprint · Space jump'],
        ]);
      }
    }
  }

  /** The floor is at three heights (lane, gutters, pit): keep the camera above whichever it's over. */
  private keepCameraAboveFloor() {
    const { camera } = this.ctx;
    const b = camera.bounds;
    if (!b) return;
    const [x, , z] = camera.pos;
    b.min[1] = z < PIT_EDGE - 0.3 ? PIT_Y + 0.5 : Math.abs(x) > LANE_HALF + 0.3 ? GUTTER_Y + 0.35 : 0.35;
  }

  private setPhase(phase: BowlingLevel['phase']) {
    this.phase = phase;
    this.phaseT = 0;
  }

  private runPhase(dt: number) {
    const t = this.phaseT;
    const alive = !this.death;
    switch (this.phase) {
      case 'arrive':
        if (this.arrival.done) {
          this.setPhase('intro');
          this.say('PIN COUNT: 11?', YELLOW, 'PLEASE HOLD');
        }
        break;
      case 'intro':
        if (t > 1.7 && t - dt <= 1.7) this.say('RECOUNTING...', YELLOW, 'PLEASE HOLD');
        if (t > INTRO_TIME) this.startFrame();
        break;
      case 'hatch': {
        const kind = this.kind();
        if (this.fired === 0 && t >= FIRE_AT) this.fire(this.balls[0], kind === 'split' ? -1 : 0);
        if (kind === 'split' && this.fired === 1 && t >= FIRE_AT + SECOND_AT) this.fire(this.balls[1], 1);
        if (this.fired >= this.balls.length && this.fired > 0) this.setPhase('roll');
        break;
      }
      case 'roll':
        if (this.balls.length === 0) {
          if (this.kind() === 'final') {
            this.setPhase('pause');
          } else {
            this.setPhase('settle');
          }
        }
        break;
      case 'settle':
        if (t > SCORE_AT && t - dt <= SCORE_AT && alive) this.scoreFrame();
        if (t > SWEEP_AT && alive) {
          this.setPhase('sweep');
          this.sweep.state = 'down';
          this.sweep.t = 0;
        }
        break;
      case 'sweep':
        if (this.sweep.state === 'idle' && alive) {
          this.setPhase('rack');
          this.startRack();
        }
        break;
      case 'rack':
        if (this.rackT < 0 && t > 0.6 && alive) {
          this.setPhase('pause');
        }
        break;
      case 'pause':
        if (t > (this.frame >= FRAMES.length ? 1.2 : 0.6) && alive) {
          this.frame++;
          this.startFrame();
        }
        break;
      case 'giantDrop':
      case 'giantRoll':
        break;
      case 'giantGone':
        // One for the road: the exit opens as it's fired.
        if (t > 1.3 && alive) {
          this.frame++;
          this.startFrame();
        }
        break;
    }
  }

  private kind(): Kind {
    return this.frame < FRAMES.length ? FRAMES[this.frame] : 'final';
  }

  private startFrame() {
    const kind = this.kind();
    this.fired = 0;
    this.gutterBallThisFrame = false;
    const sub = kind === 'final' ? 'LAST CALL' : `FRAME ${this.frame + 1}`;
    if (kind === 'giant') {
      this.say('EXTRA LARGE', YELLOW, sub);
      this.dropGiant();
      this.setPhase('giantDrop');
      return;
    }
    const pre: Record<string, string> = {
      straight: 'HOLD STILL',
      hook: 'NICE AND STRAIGHT. PROMISE.',
      split: 'DOUBLES NIGHT',
      final: this.frame === FRAMES.length ? 'ONE FOR THE ROAD' : pick(['ANOTHER ROUND', 'NO REFUNDS', 'STILL HERE?', 'CLOSING TIME']),
    };
    this.say(pre[kind], YELLOW, sub);
    const colors = kind === 'split' ? [BALL_COLORS.blue, BALL_COLORS.green] : [kind === 'straight' ? BALL_COLORS.purple : kind === 'hook' ? BALL_COLORS.red : BALL_COLORS.black];
    this.balls = colors.map((c, i) => this.makeBall(c, i));
    this.setPhase('hatch');
  }

  // --- Balls ------------------------------------------------------------------------------------

  private makeBall(color: number[], index: number): Ball {
    const r = BALL_R;
    const pos: Vec3 = [0, r, BACK_Z + index * 0.01];
    const body = this.ctx.physics.addBall(pos, r, {
      mass: 400, grabbable: false, model: (out, m) => drawBowlingBall(out, m, r, color),
    });
    body.rb.setBodyType(RAPIER.RigidBodyType.KinematicVelocityBased, true);
    return {
      body, r, pos, vx: 0, vy: 0, vz: 0, aim: AIMS.straight, kind: 'straight', side: 0, fromZ: LOAD_Z, toZ: 0, lineX: 0, gutter: 0,
      state: 'loaded',
    };
  }

  /** Fires a loaded ball at the player, working out what kind of throw it is from where they are. */
  private fire(ball: Ball, side: number) {
    const { player, camera } = this.ctx;
    this.fired++;
    const kind = this.kind();
    const px = player.pos[0];
    const pz = Math.min(player.pos[2], ball.pos[2] - 4);
    const inGutter = Math.abs(px) > LANE_HALF && player.mode === 'control';
    ball.side = side;
    ball.fromZ = ball.pos[2];
    ball.toZ = pz;
    ball.state = 'rolling';
    camera.addShake(0.25);
    this.pusher.lunge = 0;
    if (kind === 'final' && !this.exit.open && !this.death) {
      this.exit.openNow();
      this.say('GAME OVER', YELLOW, 'PLEASE RETURN YOUR SHOES');
    }
    if (inGutter && (kind !== 'split' || side === Math.sign(px))) {
      // A gutter ball: straight across into your gutter, dropping in well before it gets to you.
      ball.kind = 'gutter';
      ball.aim = AIMS.gutter;
      const g = Math.sign(px);
      const dropAt = Math.max(pz + 3, Math.min(ball.pos[2] - 4, 6));
      ball.lineX = g * (LANE_HALF + 0.4);
      ball.vx = (ball.lineX - ball.pos[0]) / ((ball.pos[2] - dropAt) / ball.aim.speed);
      ball.vz = -ball.aim.speed;
      this.gutterBallThisFrame = true;
      this.pusher.yaw = Math.atan2(ball.vx, -ball.vz);
      return;
    }
    if (inGutter && kind === 'split') {
      // The other half of a split while you hide in a gutter: the other gutter. It's a 7-10 split.
      ball.kind = 'gutter';
      ball.aim = AIMS.gutter;
      ball.lineX = side * (LANE_HALF + 0.4);
      ball.vx = (ball.lineX - ball.pos[0]) / ((ball.pos[2] - 6) / ball.aim.speed);
      ball.vz = -ball.aim.speed;
      this.pusher.yaw = Math.atan2(ball.vx, -ball.vz);
      return;
    }
    ball.kind = kind;
    ball.aim = AIMS[kind as keyof typeof AIMS];
    // The second of a split leaves a moment later, but faster: they get to you together.
    if (kind === 'split' && this.fired > 1) ball.aim = { ...ball.aim, speed: ball.aim.speed * SPLIT_CATCH_UP };
    let target = clamp(px, -LANE_LIMIT, LANE_LIMIT);
    if (kind === 'hook') {
      // Down a line off to one side (the middle side, so it curves outward at you).
      const s = px > 0 ? -1 : 1;
      target = clamp(px + s * HOOK_OFFSET, -LANE_LIMIT, LANE_LIMIT);
    } else if (kind === 'split') {
      target = clamp(px + side * SPLIT_FROM, -LANE_LIMIT, LANE_LIMIT);
    }
    ball.lineX = target;
    const time = Math.max(0.4, (ball.pos[2] - pz) / ball.aim.speed);
    ball.vx = clamp((target - ball.pos[0]) / time, -ball.aim.speed * 0.6, ball.aim.speed * 0.6);
    ball.vz = -ball.aim.speed;
    this.pusher.yaw = Math.atan2(ball.vx, -ball.vz);
  }

  private updateBalls(dt: number) {
    const { player } = this.ctx;
    for (let i = this.balls.length - 1; i >= 0; i--) {
      const b = this.balls[i];
      const p = b.pos;
      if (b.state === 'loaded') {
        // Roll forward to the mouth of the tunnel once the ball in front is out of the way.
        const blocked = this.balls.some((o) => o !== b && o.pos[2] < p[2] && o.pos[2] > p[2] - 2 * b.r - 0.2);
        if (!blocked && p[2] > LOAD_Z) {
          b.vz = -Math.min(4, (p[2] - LOAD_Z) * 4 + 0.5);
          p[2] = Math.max(LOAD_Z, p[2] + b.vz * dt);
        } else {
          b.vz = 0;
        }
        b.vx = 0;
      } else if (b.state === 'rolling') {
        this.steer(b, dt);
        p[0] += b.vx * dt;
        p[2] += b.vz * dt;
        if (b.gutter === 0 && b.kind !== 'gutter') {
          if (Math.abs(p[0]) > LANE_LIMIT) {
            p[0] = clamp(p[0], -LANE_LIMIT, LANE_LIMIT);
            b.vx = 0;
          }
        } else if (b.gutter === 0 && Math.abs(p[0]) > LANE_HALF) {
          b.gutter = Math.sign(p[0]);
        }
        if (b.gutter !== 0) {
          // In the gutter: settle into the channel.
          const k = 1 - Math.exp(-dt * 10);
          b.vx = 0;
          p[0] += (b.gutter * GUTTER_X - p[0]) * k;
          p[1] += (GUTTER_Y + b.r - p[1]) * k;
        }
        if (p[2] < PIT_EDGE) {
          b.state = 'falling';
          b.vy = 0;
        }
      } else if (b.state === 'falling') {
        b.vy -= GRAVITY * dt;
        p[1] += b.vy * dt;
        p[2] = Math.max(-HALF + b.r, p[2] + b.vz * dt);
        if (p[2] <= -HALF + b.r) b.vz = 0;
        if (p[1] < PIT_Y + b.r) {
          this.ctx.physics.remove(b.body);
          this.balls.splice(i, 1);
          continue;
        }
      }
      this.servo(b.body, p, dt, b.vx, b.vz, b.r);
      if (b.state === 'rolling' || b.state === 'falling') this.checkBallHit(p, b.r, [b.vx, b.vy, b.vz], b.kind === 'gutter' ? 'gutter' : player.pos[2] > 9 ? 'cannon' : 'ball', 20);
    }
  }

  /** Lateral steering: hooks and splits curve toward (or around) the player as they come. */
  private steer(b: Ball, dt: number) {
    const { player } = this.ctx;
    if (b.aim.accel <= 0 || b.gutter !== 0) return;
    const p = b.pos;
    const px = clamp(player.pos[0], -LANE_LIMIT, LANE_LIMIT);
    let target: number;
    if (b.kind === 'hook') {
      if (p[2] > player.pos[2] + HOOK_LEAD) return;
      target = px;
    } else if (b.kind === 'split') {
      const along = clamp((b.fromZ - p[2]) / Math.max(1, b.fromZ - b.toZ), 0, 1);
      target = clamp(player.pos[0] + b.side * (SPLIT_FROM + (SPLIT_TO - SPLIT_FROM) * along), -LANE_LIMIT, LANE_LIMIT);
    } else {
      target = px;
    }
    if (p[2] < player.pos[2] - 2) return; // past you: it doesn't come back
    const ax = clamp((target - p[0]) * 6 - b.vx * 2.2, -b.aim.accel, b.aim.accel);
    b.vx = clamp(b.vx + ax * dt, -b.aim.maxLat, b.aim.maxLat);
  }

  /** Drives a kinematic body toward `pos` over the coming frame, rolling it along its velocity. */
  private servo(body: Body, pos: Vec3, dt: number, vx: number, vz: number, r: number) {
    const t = body.rb.translation();
    const inv = 1 / Math.max(dt, 1e-4);
    body.rb.setLinvel({ x: (pos[0] - t.x) * inv, y: (pos[1] - t.y) * inv, z: (pos[2] - t.z) * inv }, true);
    body.rb.setAngvel({ x: vz / r, y: 0, z: -vx / r }, true);
  }

  /** Kills the player if a ball of radius `r` centred at `c` touches them. */
  private checkBallHit(c: Vec3, r: number, v: Vec3, kind: DeathKind, violence: number) {
    const { player, camera } = this.ctx;
    if (this.death || player.mode !== 'control' || player.inPortal) return;
    const p = player.pos;
    const y = clamp(c[1], p[1] + 0.35, p[1] + 1.5);
    const dx = p[0] - c[0], dy = y - c[1], dz = p[2] - c[2];
    const d = Math.hypot(dx, dy, dz);
    if (d > r + HIT_MARGIN) return;
    const flat = Math.hypot(dx, dz) || 1;
    const away: Vec3 = [dx / flat, 0, dz / flat];
    const launch: Vec3 = [v[0] * 1.15 + away[0] * 4, 6 + Math.abs(v[2]) * 0.25, v[2] * 1.15 + away[2] * 4];
    const contact: Vec3 = [c[0] + (dx / d) * r, c[1] + (dy / d) * r, c[2] + (dz / d) * r];
    player.kill(launch, { violence, origin: contact });
    camera.addShake(0.8);
    this.die(kind);
  }

  // --- The giant ball ------------------------------------------------------------------------------

  private dropGiant() {
    const x = clamp(this.ctx.player.pos[0], -GIANT_MAX_X, GIANT_MAX_X);
    const pos: Vec3 = [x, GIANT_DROP_FROM, GIANT_START_Z];
    const body = this.ctx.physics.addBall(pos, GIANT_R, {
      mass: 5000, grabbable: false, model: (out, m) => drawBowlingBall(out, m, GIANT_R, BALL_COLORS.black),
    });
    body.rb.setBodyType(RAPIER.RigidBodyType.KinematicVelocityBased, true);
    this.giant = { body, pos, vx: 0, vy: 0, vz: 0, rot: { x: 0, y: 0, z: 0, w: 1 }, spin: { x: 0, y: 0, z: 0, w: 1 }, wander: [0, 0, 0], wanderT: 0, deflateT: 0 };
  }

  private updateGiant(dt: number) {
    const g = this.giant;
    if (!g) return;
    const { player, camera, physics } = this.ctx;
    const p = g.pos;
    if (!g.body) {
      // Deflating, like a let-go balloon: zipping about and shrinking to nothing.
      g.deflateT += dt;
      if (g.deflateT > DEFLATE_TIME) {
        this.giant = null;
        return;
      }
      g.wanderT -= dt;
      if (g.wanderT <= 0) {
        g.wanderT = 0.15 + Math.random() * 0.15;
        g.wander = [(Math.random() - 0.5) * 30, 6 + Math.random() * 12, (Math.random() - 0.3) * 24];
        const a = (Math.random() - 0.5) * 0.5;
        g.spin = { x: Math.sin(a) * 0.7, y: Math.sin(a) * 0.5, z: Math.sin(a) * 0.5, w: Math.cos(a) };
      }
      p[0] += g.wander[0] * dt;
      p[1] += g.wander[1] * dt;
      p[2] += g.wander[2] * dt;
      g.rot = quatMul(g.spin, g.rot);
      return;
    }
    if (this.phase === 'giantDrop') {
      g.vy -= GIANT_GRAVITY * dt;
      p[1] = Math.max(GIANT_R, p[1] + g.vy * dt);
      if (p[1] <= GIANT_R) {
        g.vy = 0;
        camera.addShake(1.5);
        this.say('BIG LEBOWSKI', YELLOW, `FRAME ${this.frame + 1}`);
        // The whole lane jumps: pins wobble, some fall over.
        for (const pin of this.pins) {
          const s = 1.2 + Math.random() * 1.6;
          pin.rb.applyImpulse({ x: (Math.random() - 0.5) * s * 20, y: s * 25, z: (Math.random() - 0.5) * s * 20 }, true);
        }
        this.setPhase('giantRoll');
      }
    } else if (this.phase === 'giantRoll') {
      g.vz = Math.max(-GIANT_SPEED, g.vz - GIANT_ACCEL * dt);
      const target = clamp(player.pos[0], -GIANT_MAX_X, GIANT_MAX_X);
      const ax = clamp((target - p[0]) * 1.5 - g.vx * 1.3, -3, 3);
      g.vx = clamp(g.vx + ax * dt, -3.2, 3.2);
      p[0] = clamp(p[0] + g.vx * dt, -GIANT_MAX_X, GIANT_MAX_X);
      p[2] += g.vz * dt;
      if (p[2] <= -HALF + GIANT_R) {
        // Hits the back wall. It's not going in the pit, so it goes pop instead.
        p[2] = -HALF + GIANT_R;
        camera.addShake(1.3);
        const q = g.body!.rb.rotation();
        g.rot = { x: q.x, y: q.y, z: q.z, w: q.w };
        physics.remove(g.body!);
        g.body = null;
        g.wanderT = 0;
        g.vy = 0;
        if (!this.death) {
          this.say('THE DUDE ABIDES', YELLOW, 'FRAME 4');
          this.marks[this.frame] = 'X';
        }
        this.setPhase('giantGone');
        return;
      }
    }
    if (g.body) {
      this.servo(g.body, p, dt, g.vx, g.vz, GIANT_R);
      this.checkBallHit(p, GIANT_R, [g.vx, g.vy, g.vz], 'giant', 34);
    }
  }

  private giantRadius(): number {
    if (!this.giant) return 0;
    if (this.giant.body) return GIANT_R;
    const k = clamp(this.giant.deflateT / DEFLATE_TIME, 0, 1);
    return GIANT_R * Math.max(0.02, (1 - k) * (1 - k) * 0.9 + 0.1 * (1 - k));
  }

  // --- Launcher -----------------------------------------------------------------------------------

  private updateLauncher(dt: number) {
    const open = this.phase === 'hatch' || (this.phase === 'roll' && this.phaseT < 1.1);
    this.doorOpen = clamp(this.doorOpen + (open ? dt : -dt) / DOOR_TIME, 0, 1);
    this.door.setTranslation({ x: 0, y: HATCH_H / 2 + easeInOut(this.doorOpen) * (HATCH_H + 0.2), z: HALF + 0.2 });
    // The pusher sits behind whichever ball is next; firing lunges it forward.
    const pu = this.pusher;
    const waiting = this.balls.find((b) => b.state === 'loaded');
    let rest = waiting ? waiting.pos[2] + waiting.r + 0.2 : TUNNEL_END - 0.35;
    if (!waiting && this.phase === 'hatch') rest = BACK_Z + BALL_R + 0.2;
    if (pu.lunge >= 0) {
      pu.lunge += dt;
      const k = pu.lunge < 0.08 ? pu.lunge / 0.08 : Math.max(0, 1 - (pu.lunge - 0.08) / 0.5);
      pu.z = rest + (HALF + 0.9 - rest) * k;
      if (pu.lunge > 0.6) pu.lunge = -1;
    } else {
      pu.z += (rest - pu.z) * (1 - Math.exp(-dt * 6));
      if (waiting) pu.yaw *= Math.exp(-dt * 3);
    }
  }

  // --- Sweep and pinsetter ----------------------------------------------------------------------

  private updateSweep(dt: number) {
    const s = this.sweep;
    s.t += dt;
    switch (s.state) {
      case 'down':
        s.lift = SWEEP_LIFT * (1 - easeInOut(clamp(s.t / SWEEP_DROP_TIME, 0, 1)));
        if (s.t >= SWEEP_DROP_TIME) this.sweepState('hold');
        break;
      case 'hold':
        if (s.t >= SWEEP_HOLD) this.sweepState('push');
        break;
      case 'push':
        s.z = Math.max(SWEEP_END, s.z - SWEEP_SPEED * dt);
        if (s.z <= SWEEP_END) this.sweepState('raise');
        break;
      case 'raise':
        s.lift = SWEEP_LIFT * easeInOut(clamp(s.t / SWEEP_RAISE_TIME, 0, 1));
        if (s.t >= SWEEP_RAISE_TIME) this.sweepState('back');
        break;
      case 'back':
        s.z = Math.min(SWEEP_START, s.z + SWEEP_RETURN_SPEED * dt);
        if (s.z >= SWEEP_START) this.sweepState('idle');
        break;
    }
    const t = this.sweepRb.translation();
    const inv = 1 / Math.max(dt, 1e-4);
    this.sweepRb.setLinvel({ x: -t.x * inv, y: (s.lift - t.y) * inv, z: (s.z - t.z) * inv }, true);
    this.checkSweepHit();
  }

  private sweepState(state: BowlingLevel['sweep']['state']) {
    this.sweep.state = state;
    this.sweep.t = 0;
  }

  /** The bar lands on you, or catches your feet as it sweeps. */
  private checkSweepHit() {
    const s = this.sweep;
    const { player, camera } = this.ctx;
    if (this.death || player.mode !== 'control' || player.inPortal) return;
    if (s.state !== 'down' && s.state !== 'push') return;
    const p = player.pos;
    const onLane = Math.abs(p[0]) < LANE_HALF + 0.15;
    const bottom = s.lift + (onLane ? 0.03 : GUTTER_Y + 0.03);
    const top = bottom + SWEEP_HEIGHT;
    const ahead = s.z - p[2]; // > 0: the player is north of the bar, where it's going
    const reach = SWEEP_DEPTH / 2 + 0.37;
    let hit = false;
    if (s.state === 'down') hit = Math.abs(ahead) < reach && bottom < p[1] + 1.8 && top > p[1] + 0.1;
    else hit = ahead > -0.15 && ahead < reach && p[1] < top - 0.15;
    if (!hit) return;
    player.kill([0, 1.5, -3.5], { violence: 0 });
    camera.addShake(0.5);
    this.die('sweep');
  }

  private startRack() {
    this.rack = this.spots.map((spot) => {
      const pin = this.addPin([spot[0], RACK_TOP, spot[2]]);
      pin.rb.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
      return pin;
    });
    this.rackT = 0;
  }

  private rackBase(): number {
    return RACK_TOP * (1 - easeInOut(clamp(this.rackT / RACK_TIME, 0, 1)));
  }

  private updateRack(dt: number) {
    if (this.rackT < 0) return;
    this.rackT += dt;
    const base = this.rackBase();
    for (let i = 0; i < this.rack.length; i++) {
      const s = this.spots[i];
      this.rack[i].rb.setNextKinematicTranslation({ x: s[0], y: base + PIN_BELLY, z: s[2] });
    }
    // A pin coming down on your head.
    const { player, camera } = this.ctx;
    if (!this.death && player.mode === 'control' && !player.inPortal) {
      const p = player.pos;
      for (const s of this.spots) {
        if (Math.hypot(p[0] - s[0], p[2] - s[2]) > 0.55) continue;
        if (base > p[1] + 1.9 || base < p[1] + 1.0) continue;
        player.kill([0, -7, 0], { violence: 0 });
        camera.addShake(0.6);
        this.die('pinned');
        break;
      }
    }
    if (this.rackT >= RACK_TIME) {
      for (let i = 0; i < this.rack.length; i++) {
        const rb = this.rack[i].rb;
        const s = this.spots[i];
        rb.setTranslation({ x: s[0], y: PIN_BELLY + 0.01, z: s[2] }, true);
        rb.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
        rb.setLinvel({ x: 0, y: 0, z: 0 }, true);
        rb.setAngvel({ x: 0, y: 0, z: 0 }, true);
      }
      this.rackT = -1;
    }
  }

  /** Pins that fell in the pit (or flew out of the chamber) are gone. */
  private cleanUpPins() {
    const physics = this.ctx.physics;
    for (let i = this.pins.length - 1; i >= 0; i--) {
      const t = this.pins[i].rb.translation();
      if (t.y < PIT_Y + 1.5 || t.y < -2 && t.z > PIT_EDGE || Math.abs(t.x) > HALF + 3 || Math.abs(t.z) > HALF + 3) {
        physics.remove(this.pins[i]);
        this.pins.splice(i, 1);
      }
    }
  }

  private checkPit() {
    const { player } = this.ctx;
    if (this.death || player.mode !== 'control' || player.inPortal) return;
    if (player.pos[2] < PIT_EDGE && player.pos[1] < -1.2) {
      player.kill([0, -2, -1], { violence: 0 });
      this.die('pit');
    }
  }

  private die(kind: DeathKind) {
    this.ctx.hud.hide();
    this.death = { kind, t: 0 };
    this.say(DEATHS[kind].board, kind === 'ball' || kind === 'cannon' || kind === 'giant' ? RED : YELLOW, 'PIN 11: DOWN');
    if (this.frame < this.marks.length) this.marks[this.frame] = 'X';
  }

  // --- Scoreboard -------------------------------------------------------------------------------

  private say(text: string, color: string, sub: string) {
    this.reaction.text = text;
    this.southReaction.text = text;
    this.southSub.text = sub;
    this.reactionColor = color;
    this.reaction.size = Math.min(1.05, 15 / Math.max(1, text.length));
    this.southReaction.size = Math.min(0.7, 9.5 / Math.max(1, text.length));
    this.flash = 1.5;
  }

  /** Counts the pins down and puts a sarcastic verdict on the board. */
  private scoreFrame() {
    const down = this.rack.map((pin, i) => {
      if (!this.pins.includes(pin)) return true;
      const t = pin.rb.translation();
      const s = this.spots[i];
      return uprightness(pin) < 0.8 || Math.hypot(t.x - s[0], t.z - s[2]) > 0.7;
    });
    const n = down.filter(Boolean).length;
    const sub = `FRAME ${this.frame + 1}`;
    this.marks[this.frame] = n === 10 ? 'X' : n === 0 ? '-' : `${n}`;
    if (n === 10) {
      this.strikes++;
      this.say(this.strikes >= 3 ? 'TURKEY!' : pick(['STRIKE!', 'STRIKE! (NOT YOU)']), YELLOW, sub);
      return;
    }
    this.strikes = 0;
    const standing = down.map((d, i) => (d ? 0 : i + 1)).filter(Boolean);
    if (standing.length === 2 && standing[0] === 7 && standing[1] === 10) this.say('7-10 SPLIT', YELLOW, sub);
    else if (this.gutterBallThisFrame && n < 5) this.say('GUTTER BALL', YELLOW, sub);
    else if (n === 0) this.say('MARK IT ZERO', YELLOW, sub);
    else if (n === 9) this.say('SPARE ME', YELLOW, sub);
    else this.say(pick([`${n} PINS. MEH.`, `${n}. RUDE.`, 'SO CLOSE', 'NICE TRY']), YELLOW, sub);
  }

  labels(): WorldLabel[] {
    for (let i = 0; i < this.marks.length; i++) this.markLabels[i].text = this.marks[i];
    const blink = this.flash > 0 && Math.floor(this.flash * 7) % 2 === 0;
    const color = blink ? '#ffffff' : this.reactionColor;
    this.reaction.color = color;
    this.southReaction.color = color;
    // Labels draw over everything: don't show the south board through the giant ball.
    const hide = !!this.giant?.body;
    this.southReaction.size = hide ? 0 : Math.min(0.7, 9.5 / Math.max(1, this.southReaction.text.length));
    this.southSub.size = hide ? 0 : 0.34;
    return this.labelList;
  }

  // --- Drawing ----------------------------------------------------------------------------------

  draw(out: DrawItem[], time: number) {
    for (const d of this.staticDraws) out.push(d);
    this.arrival.draw(out);
    this.exit.draw(out);
    this.drawLauncher(out, time);
    this.drawSweep(out);
    this.drawRackStrings(out);
    const g = this.giant;
    if (g && !g.body) {
      drawBowlingBall(out, fromQuat(g.rot, g.pos), this.giantRadius(), BALL_COLORS.black);
    }
  }

  private drawLauncher(out: DrawItem[], time: number) {
    // The hatch door slides up into the wall.
    const lift = easeInOut(this.doorOpen) * (HATCH_H + 0.2);
    out.push({
      mesh: 'box', model: mul(translation([0, HATCH_H / 2 + lift, HALF + 0.2]), scaling([HATCH_HALF * 2, HATCH_H, 0.3])),
      color: [0.86, 0.87, 0.88], pattern: Pattern.panels, param: 2, spec: 0.15,
    });
    // The pusher: a padded plate on a piston, aimed where the last ball went.
    const pu = this.pusher;
    const m = mul(translation([0, BALL_R, pu.z]), rotationY(pu.yaw));
    out.push({ mesh: 'cylinder', model: mul(m, basis([1.05, 0, 0], [0, 0, 0.3], [0, -1.05, 0], [0, 0, 0])), color: [0.75, 0.12, 0.08], spec: 0.4 });
    out.push({ mesh: 'cylinder', model: mul(m, basis([0.18, 0, 0], [0, 0, 3], [0, -0.18, 0], [0, 0, 1.6])), color: [0.6, 0.62, 0.65], spec: 0.8 });
    // Warning lamps either side of the hatch, blinking while it's busy.
    const busy = this.doorOpen > 0.01;
    const on = busy && Math.floor(time * 4) % 2 === 0;
    for (const s of [-1, 1]) {
      out.push({ mesh: 'cylinder', model: mul(translation([s * 2.45, 3.25, HALF - 0.05]), basis([0.26, 0, 0], [0, 0, 0.12], [0, -0.26, 0], [0, 0, 0])), color: STEEL, spec: 0.5 });
      out.push({
        mesh: 'sphere', model: mul(translation([s * 2.45, 3.25, HALF - 0.13]), scaling([0.19, 0.19, 0.12])),
        color: on ? [6, 2.8, 0.2] : [0.35, 0.18, 0.03], pattern: Pattern.emissive, shadow: false,
      });
    }
  }

  private drawSweep(out: DrawItem[]) {
    const t = this.sweepRb.translation();
    const y = t.y, z = t.z;
    // Hazard-striped plates: across the lane, and lower in each gutter, joined at the lane's edges.
    const seg = 1.2;
    const n = Math.round((LANE_HALF * 2) / seg);
    const w = (LANE_HALF * 2) / n;
    for (let i = 0; i < n; i++) {
      const x = -LANE_HALF + (i + 0.5) * w;
      out.push({
        mesh: 'box', model: mul(translation([x, y + 0.03 + SWEEP_HEIGHT / 2, z]), scaling([w, SWEEP_HEIGHT, SWEEP_DEPTH])),
        color: i % 2 ? [0.06, 0.06, 0.06] : [0.95, 0.72, 0.05], spec: 0.4,
      });
    }
    for (const side of [-1, 1]) {
      out.push({
        mesh: 'box', model: mul(translation([side * GUTTER_X, y + GUTTER_Y + 0.03 + SWEEP_HEIGHT / 2, z]), scaling([GUTTER_W, SWEEP_HEIGHT, SWEEP_DEPTH])),
        color: [0.95, 0.72, 0.05], spec: 0.4,
      });
      out.push({
        mesh: 'box', model: mul(translation([side * LANE_HALF, y + (GUTTER_Y + SWEEP_HEIGHT) / 2 + 0.03, z]), scaling([0.12, SWEEP_HEIGHT - GUTTER_Y, SWEEP_DEPTH + 0.02])),
        color: STEEL, spec: 0.5,
      });
      // Arms up to the rails on the wall tops.
      const armBottom = y + GUTTER_Y + SWEEP_HEIGHT;
      const armTop = 10.3;
      if (armTop > armBottom) {
        out.push({
          mesh: 'box', model: mul(translation([side * (HALF - 0.12), (armBottom + armTop) / 2, z]), scaling([0.14, armTop - armBottom, 0.14])),
          color: STEEL, spec: 0.5,
        });
      }
    }
  }

  private drawRackStrings(out: DrawItem[]) {
    if (this.rackT < 0) return;
    const base = this.rackBase();
    for (const s of this.spots) {
      const bottom = base + PIN_HEIGHT - 0.02;
      if (bottom >= HEAD_BOTTOM) continue;
      out.push({
        mesh: 'box', model: mul(translation([s[0], (bottom + HEAD_BOTTOM) / 2, s[2]]), scaling([0.025, HEAD_BOTTOM - bottom, 0.025])),
        color: [0.9, 0.9, 0.85], shadow: false,
      });
    }
  }

  trackedTargets(): TrackedTarget[] {
    const out: TrackedTarget[] = [];
    const exit = this.exit.target();
    if (exit) out.push(exit);
    if (this.death) return out;
    if (this.phase === 'hatch' && this.doorOpen > 0.3) out.push({ pos: [0, BALL_R, HALF + 0.6], radius: BALL_R + 0.2 });
    for (const b of this.balls) {
      if (b.state === 'rolling') out.push({ pos: [...b.pos] as Vec3, radius: b.r });
    }
    const g = this.giant;
    if (g?.body) out.push({ pos: [...g.pos] as Vec3, radius: GIANT_R });
    return out;
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

