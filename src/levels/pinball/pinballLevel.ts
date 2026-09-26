import { Drone, tone, Tune } from '../../engine/audio';
import { add, clamp, mul, normalize, rotationX, rotationZ, scale, scaling, sub, translation, type Vec3 } from '../../engine/math';
import { RAPIER, type Body } from '../../engine/physics';
import { Pattern, type DrawItem, type Environment } from '../../engine/renderer';
import { CHAMBER_HALF } from '../../game/chamber';
import { PLAYER_RADIUS } from '../../game/player';
import {
  CHROME, DotMatrix, drawChevron, drawPlunger, drawStar, DropTarget, Flipper, pinSfx, PopBumper, segmentOn, Slingshot,
  spawnSteelBall, STEEL_BALL_RADIUS, TableFrame, triangleModel,
} from '../../entities/pinball';
import { PixelText } from '../../entities/pixelText';
import { ExitPortal, PortalArrival } from '../../entities/portal';
import { DEFAULT_ENV, type CameraShot, type Level, type LevelContext, type LevelStatus, type TrackedTarget, type WorldLabel } from '../level';

/*
 * Pinball. You are the ball. The chamber is a pinball table: the floor slopes down toward two big
 * flippers and the drain, pop bumpers and slingshots kick you about, and big steel balls roll round
 * with you. The portal drops you into the shooter lane, the plunger fires you onto the table, and
 * knocking down the four drop targets (E, X, I, T) lights the exit up in the top-right corner. Fall
 * down the drain (or an outlane) and it's game over. Every jump nudges the table: hop about too
 * much and it TILTs, and the flippers go dead.
 */

const H = CHAMBER_HALF;
// --- The table ----------------------------------------------------------------------------------------
const SLOPE = (10 * Math.PI) / 180;
/** The low (south) edge of the playfield, past the flippers: beyond it is the drain pit. */
const DRAIN_Z = 9.9;
const BASE_Y = 2.0;
const TABLE = new TableFrame(SLOPE, BASE_Y, DRAIN_Z);
/** The middle of the flipper area (the shooter lane takes the east edge). */
const CX = -1.075;
/** The shooter lane: a wall at LANE_WALL_X from the south wall up to LANE_TOP_Z, the lane east of it. */
const LANE_WALL_X = 10;
const LANE_X = (LANE_WALL_X + 0.15 + H) / 2;
const LANE_TOP_Z = -1;
const LANE_WALL_H = 2.2;
/** The plunger's tip at rest, and its housing against the south wall. */
const PLUNGER_Z = 10.3;
const HOUSING_Z = 11.3;
/** Top corners: quarter-circle guides. */
const ARC_R = 3.5;
const ARC_C = 8.5;

// --- Movement on the slope ------------------------------------------------------------------------------
/** Downhill drift added to the player (m/s): on the ground, and while airborne. */
const DRIFT_GROUND = 2.0;
const DRIFT_AIR = 3.0;
/** While scrambling back up after a knock: slower than the body can catch up (player.ts GETUP_SPEED is 1.6 m/s). */
const DRIFT_GETUP = 0.9;
/** Walking / sprinting speed and acceleration on the polished playfield (player.speedScale). */
const PLAYFIELD_GRIP = 0.88;

// --- Flippers --------------------------------------------------------------------------------------------------
const FLIPPER_X = 4.6;
const FLIPPER_Z = 7.6;
const FLIP_REST = (-30 * Math.PI) / 180;
const FLIP_UP = (28 * Math.PI) / 180;
/** How long a flipper stays up after an automatic flip, and the pause before it can flip again. */
const FLIP_HOLD = 0.28;
const FLIP_COOLDOWN = 0.22;
/** A flipper hitting the player: launch speed at the pivot and at the tip (m/s), and upward kick. */
const FLIP_LAUNCH_MIN = 8;
const FLIP_LAUNCH_MAX = 16;
const FLIP_LAUNCH_UP = 4.5;

// --- Kickers --------------------------------------------------------------------------------------------------
const BUMPER_R = 1.0;
const BUMPER_KICK_PLAYER = 8.5;
const BUMPER_KICK_BALL = 9.5;
const SLING_KICK_PLAYER = 8;
const SLING_KICK_BALL = 10;

// --- Steel balls ----------------------------------------------------------------------------------------------
const BALL_R = STEEL_BALL_RADIUS;
const MAX_BALLS = 4;
const MAX_BALL_SPEED = 17;
/** Plunger launch speed for balls, and the player's scripted flight speed. */
const BALL_LAUNCH = 16.5;
const FLIGHT_SPEED = 19;
/** A ball hitting the player this fast (m/s, toward them) knocks them over; this fast kills. */
const BALL_KNOCK_SPEED = 2.5;
const BALL_KILL_SPEED = 14;
/** Balls moving faster than this get a streak behind them (they can kill). */
const BALL_STREAK_SPEED = 11;

// --- Tilt -------------------------------------------------------------------------------------------------------
/** Each jump adds 1; it drains at NUDGE_DECAY per second. DANGER at the first level, TILT at the second. */
const NUDGE_DECAY = 0.4;
const NUDGE_DANGER = 4.5;
const NUDGE_TILT = 6.5;
const TILT_TIME = 6;

// --- Layout (world x, z on the table) ----------------------------------------------------------------------
type P2 = [number, number];
const mirror = (p: P2): P2 => [2 * CX - p[0], p[1]];
/** Outlane dividers: from a post at the top down to the flipper's pivot. */
const RAIL_TOP: P2 = [-10.25, 3.0];
const RAIL_BOTTOM: P2 = [-6.2, 7.3];
/** The left slingshot (the right one is its mirror image): rubber face from top to inner. */
const SLING_TOP: P2 = [-8.43, 0.6];
const SLING_OUTER: P2 = [-8.43, 2.38];
const SLING_INNER: P2 = [-5.55, 5.44];
const BUMPERS: { p: P2; color: number[]; bell: number }[] = [
  { p: [CX - 3, -6.6], color: [1.6, 0.18, 0.12], bell: 0 },
  { p: [CX + 3, -6.6], color: [1.5, 1.1, 0.1], bell: 1 },
  { p: [CX, -3.4], color: [0.2, 0.55, 1.7], bell: 2 },
];
const TARGETS: { p: P2; yaw: number; letter: string }[] = [
  { p: [7.8, -1.2], yaw: (-65 * Math.PI) / 180, letter: 'E' },
  { p: [CX - 5.2, -10.2], yaw: (20 * Math.PI) / 180, letter: 'X' },
  { p: [-9.95, -1.2], yaw: (65 * Math.PI) / 180, letter: 'I' },
  { p: [CX, -10.2], yaw: 0, letter: 'T' },
];
const TARGET_COLORS = [[0.95, 0.75, 0.1], [0.95, 0.35, 0.08], [0.95, 0.12, 0.3], [0.2, 0.75, 0.95]];
const LETTER_LIT = [[2.4, 1.8, 0.2], [2.4, 0.8, 0.12], [2.4, 0.3, 0.7], [0.4, 1.6, 2.4]];
const EXIT_Z = -5.6;

const SPAWN: Vec3 = [LANE_X, TABLE.y(6.0), 6.0];
const DEATH_SCREEN_DELAY = 1.8;

// --- Lighting ------------------------------------------------------------------------------------------------
/** An arcade at night: the room lights down, the table lit by its own lamps. */
const ARCADE_ENV: Environment = {
  sunDir: [0.25, 1, 0.45],
  sunColor: [0.95, 0.85, 1.1],
  skyColor: [0.1, 0.07, 0.2],
  groundColor: [0.12, 0.06, 0.16],
  fogColor: [0.06, 0.03, 0.11],
  fogDensity: 0.004,
};

const YELLOW = '#ffd166';
const PINK = '#ff5ec8';
const CYAN = '#7fe3ff';

type DeathKind = 'drain' | 'outlane' | 'tilt' | 'ball';

const DEATHS: Record<DeathKind, { big: string; small: string[]; hint: string }> = {
  drain: {
    big: 'DRAINED',
    small: [
      'Straight down the middle. The flippers did not even twitch.',
      'The steel balls have ball save. You do not.',
      'You were the ball. Balls drain. That is the whole game.',
    ],
    hint: "The table slopes toward the flippers: keep walking uphill (sprint with Shift). Anything that ends up between the flippers drains. Hit the E, X, I and T targets to light the exit.",
  },
  outlane: {
    big: 'OUTLANE',
    small: ['Down the side, past the flippers. Pinball\'s cruellest lane.', 'The outlane. Nobody saves an outlane.'],
    hint: 'The lanes along the far left and right walls go straight to the drain. Stay away from the sides near the bottom, or let the slingshots bat you back in.',
  },
  tilt: {
    big: 'TILT',
    small: ['You shook the machine. The flippers went on strike.', 'Nudging is an art. You were more of a jackhammer.'],
    hint: "Every jump nudges the table. Hop about too much and it TILTs: the flippers go dead for a few seconds. Save your jumps for when you need them.",
  },
  ball: {
    big: 'STEEL BALL RUN',
    small: ['110 kg of chrome at full speed. The ball is fine.', 'Hit by a ball bearing the size of a beach ball. It did not say sorry.'],
    hint: "Balls fresh off a flipper are going fast enough to flatten you. Don't hang about in front of the flippers when there's a ball on them.",
  },
};

const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
const rand = (a: number, b: number) => a + Math.random() * (b - a);

interface Ball {
  body: Body;
  state: 'play' | 'drained';
  t: number;
  /** Seconds before it can hit the player again. */
  hitCooldown: number;
  /** Seconds it has sat still (for the ball search). */
  still: number;
  /** Per bumper / sling: seconds before it can kick this ball again. */
  kickCooldown: number[];
  prevVel: Vec3;
}

interface Flight {
  pts: Vec3[];
  seg: number;
  along: number;
}

interface Popup {
  label: WorldLabel;
  t: number;
}

export class PinballLevel implements Level {
  readonly number: number;
  readonly title = 'Pinball';
  status: LevelStatus = 'playing';
  private arrival: PortalArrival;
  private exit = new ExitPortal(EXIT_Z, TABLE.y(EXIT_Z));
  private t = 0;
  private phase: 'arrive' | 'boot' | 'ready' | 'play' = 'arrive';
  private phaseT = 0;
  /** How lit the table is (0 off, 1 on); the room dims as it comes up. */
  private power = 0;
  private env: Environment = { ...DEFAULT_ENV };

  private flippers: Flipper[];
  private flipperHold = [0, 0];
  private flipperCool = [0, 0];
  private twitchT = rand(3, 6);
  private bumpers: PopBumper[] = [];
  private slings: Slingshot[] = [];
  private targets: DropTarget[] = [];
  private balls: Ball[] = [];
  private ballQueue = 0;
  private ballQueueT = 0;
  private ballsLaunched = 0;

  private plunger = { pull: 0, state: 'idle' as 'idle' | 'pull' | 'fire', t: 0, loaded: 0, withPlayer: false, collider: null as RAPIER.Collider | null };
  private flight: Flight | null = null;
  private plunges = 0;
  private lastPlungeT = -10;

  private playerCool = { bumper: [0, 0, 0], sling: [0, 0], flipper: 0 };
  private wasOnGround = true;
  private nudge = 0;
  private dangerShown = false;
  private tiltT = 0;
  private tilts = 0;

  private score = 0;
  private shownScore = -1;
  private dmd: DotMatrix;
  private msg: { text: string; t: number; dur: number; flash: boolean } | null = null;
  private scheduled: { at: number; text: string; dur: number; flash: boolean }[] = [];
  private wrongTargetT = -10;
  private exitLamps: PixelText[] = [];
  private exitLampColors: number[][] = [];
  private inserts: PixelText[] = [];
  private insertColors: number[][] = [];
  private chevronColors: number[][][] = [];
  private bulbColors: number[][] = [];
  /** The table's general illumination bulbs (shared by every bulb, dimmed with the power). */
  private giColor = [0, 0, 0];
  private staticDraws: DrawItem[] = [];
  private labelList: WorldLabel[];
  private popups: Popup[] = [];

  private hum = new Drone(60, { wave: 'sawtooth', vol: 0.012 });
  private rumble = new Drone(42, { wave: 'triangle', vol: 0.0001, wobble: 4 });
  private music = new Tune(
    [
      ['C3', 0.5], ['C4', 0.5], ['G3', 0.5], ['C4', 0.5], ['Eb3', 0.5], ['F3', 0.5], ['G3', 1],
      ['Bb2', 0.5], ['Bb3', 0.5], ['F3', 0.5], ['Bb3', 0.5], ['D3', 0.5], ['Eb3', 0.5], ['F3', 1],
      ['Ab2', 0.5], ['Ab3', 0.5], ['Eb3', 0.5], ['Ab3', 0.5], ['G2', 0.5], ['G3', 0.5], ['D3', 0.5], ['G3', 0.5],
      ['C3', 0.5], ['Eb3', 0.5], ['G3', 0.5], ['Bb3', 0.5], ['C4', 1], [null, 1],
    ],
    150,
    { wave: 'square', vol: 0.028 },
  );

  private death: { kind: DeathKind; t: number; at: Vec3 } | null = null;
  private won = false;

  constructor(private ctx: LevelContext) {
    this.number = ctx.number;
    const { physics, hud } = ctx;
    hud.setLevel(`The Chamber · Level ${this.number}`);
    hud.show(`LEVEL ${this.number}`, '', 2.5);
    hud.hint('');
    // Dropped straight down into the shooter lane.
    this.arrival = new PortalArrival(ctx, SPAWN, { minElevationDeg: 86 });
    // The playfield is polished to a shine: a little slippery underfoot.
    ctx.player.speedScale = PLAYFIELD_GRIP;

    this.buildTable();

    this.flippers = [
      new Flipper(physics, TABLE, CX - FLIPPER_X, FLIPPER_Z, FLIP_REST, FLIP_UP),
      new Flipper(physics, TABLE, CX + FLIPPER_X, FLIPPER_Z, Math.PI - FLIP_REST, Math.PI - FLIP_UP),
    ];
    physics.substepHooks.push((h) => {
      for (const f of this.flippers) f.step(h);
    });
    physics.postStepHooks.push(() => this.kickBalls());

    for (const b of BUMPERS) this.bumpers.push(new PopBumper(physics, TABLE, b.p[0], b.p[1], BUMPER_R, b.color));
    this.slings.push(new Slingshot(physics, TABLE, SLING_TOP, SLING_OUTER, SLING_INNER, [1.8, 0.35, 0.1]));
    this.slings.push(new Slingshot(physics, TABLE, mirror(SLING_TOP), mirror(SLING_OUTER), mirror(SLING_INNER), [1.8, 0.35, 0.1]));
    TARGETS.forEach((t, i) => this.targets.push(new DropTarget(physics, TABLE, t.p[0], t.p[1], t.yaw, t.letter, TARGET_COLORS[i])));

    // The plunger's tip: a block across the bottom of the shooter lane.
    this.plunger.collider = TABLE.addBox(physics, LANE_X, PLUNGER_Z + 0.25, [H - LANE_WALL_X - 0.15, 1.3, 0.5]);

    // The backglass: a dot-matrix display on the north wall, with EXIT lamps above it.
    const wallZ = -H + 0.12;
    this.dmd = new DotMatrix([0, 7.35, wallZ + 0.1], [1, 0, 0], [0, 1, 0], 15.5, 2.5, [
      { offset: 0.45, pixel: 0.2 },
      { offset: -0.78, pixel: 0.13 },
    ]);
    this.dmd.setLine(0, 'INSERT COIN');
    this.dmd.setLine(1, '');
    TARGETS.forEach((t, i) => {
      const color = [0.25, 0.04, 0.04];
      this.exitLampColors.push(color);
      this.exitLamps.push(new PixelText({ centre: [-1.8 + i * 1.2, 9.25, wallZ + 0.1], right: [1, 0, 0], up: [0, 1, 0], pixel: 0.15, color, depth: 0.04, pattern: Pattern.emissive }, t.letter));
    });
    // A lamp insert on the playfield in front of each target (its letter, lying flat), and chevrons pointing at it.
    TARGETS.forEach((t) => {
      const facing = TABLE.dir(Math.sin(t.yaw), Math.cos(t.yaw));
      const at = (d: number) => TABLE.point(t.p[0] + Math.sin(t.yaw) * d, t.p[1] + Math.cos(t.yaw) * d * TABLE.cos, 0.012);
      const up = scale(facing, -1);
      const right = crossV(up, TABLE.normal);
      const color = [0.2, 0.03, 0.02];
      this.insertColors.push(color);
      this.inserts.push(new PixelText({ centre: at(1.6), right, up, pixel: 0.16, color, depth: 0.02, pattern: Pattern.emissive }, t.letter));
      this.chevronColors.push([[0, 0, 0], [0, 0, 0], [0, 0, 0]]);
    });

    this.labelList = [
      { pos: [-7.2, 9.3, wallZ + 0.3], text: 'SPACE CADAVER', size: 0.62, color: PINK },
      { pos: [7.2, 9.3, wallZ + 0.3], text: '1 PLAYER · 25¢', size: 0.5, color: CYAN },
      { pos: [0, TABLE.y(DRAIN_Z) + 0.9, DRAIN_Z + 1.0], text: 'DRAIN', size: 0.5, color: '#ff4a3a' },
    ];
  }

  // --- Building the table ---------------------------------------------------------------------------------

  private buildTable() {
    const { physics } = this.ctx;
    const d = this.staticDraws;
    const t = TABLE;

    // The playfield: one slab from the north wall down to the drain, and the shooter lane's floor past it.
    const slab = (x0: number, x1: number, z0: number, z1: number, color: number[], spec: number) => {
      const len = (z1 - z0) / t.cos;
      const thick = 2.6;
      const f = t.frame((x0 + x1) / 2, (z0 + z1) / 2);
      physics.addStaticBox(t.point((x0 + x1) / 2, (z0 + z1) / 2, -thick / 2), [x1 - x0, thick, len], t.quat());
      d.push({ mesh: 'box', model: mul(f, translation([0, -thick / 2, 0]), scaling([x1 - x0, thick, len])), color, spec });
    };
    slab(-H, H, -H - 0.4, DRAIN_Z, [0.035, 0.05, 0.19], 0.9);
    slab(LANE_WALL_X - 0.15, H, DRAIN_Z, H + 0.4, [0.05, 0.05, 0.1], 0.5);

    // Walls on the table: a box between two points, `h` tall.
    const wall = (a: P2, b: P2, h: number, thick: number, color: number[], extra: Partial<DrawItem> = {}, lift = 0) => {
      const dx = b[0] - a[0], dz = (b[1] - a[1]) / t.cos;
      const len = Math.hypot(dx, dz);
      const yaw = Math.atan2(-dz, dx);
      const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
      t.addBox(physics, mx, mz, [len + thick, h, thick], yaw, lift);
      d.push({ mesh: 'box', model: mul(t.frame(mx, mz, yaw, lift), translation([0, h / 2, 0]), scaling([len + thick, h, thick])), color, spec: 0.6, ...extra });
    };
    const post = (p: P2, h: number, r = 0.26) => {
      physics.world.createCollider(RAPIER.ColliderDesc.cylinder(h / 2, r).setTranslation(...t.point(p[0], p[1], h / 2)).setRotation(t.quat()));
      d.push({ mesh: 'cylinder', model: mul(t.frame(p[0], p[1]), translation([0, h / 2, 0]), scaling([r, h, r])), color: CHROME, spec: 1.6 });
      d.push({ mesh: 'cylinder', model: mul(t.frame(p[0], p[1]), translation([0, h + 0.03, 0]), scaling([r * 0.8, 0.06, r * 0.8])), color: [1.8, 0.5, 0.1], pattern: Pattern.emissive, shadow: false });
    };
    const RAIL = [0.85, 0.12, 0.1];

    // Outlane dividers, down to each flipper's pivot, with a post at the top.
    for (const m of [false, true]) {
      const a = m ? mirror(RAIL_TOP) : RAIL_TOP, b = m ? mirror(RAIL_BOTTOM) : RAIL_BOTTOM;
      wall(a, b, 1.0, 0.3, RAIL);
      d.push({ mesh: 'cylinder', model: segmentOn(t, a, b, 1.02, 0.1), color: CHROME, spec: 1.6 });
      post(a, 1.1);
    }

    // The shooter lane's wall: clear plastic with a chrome rail on top, down into the pit too.
    const laneA: P2 = [LANE_WALL_X, H], laneB: P2 = [LANE_WALL_X, LANE_TOP_Z];
    wall(laneA, laneB, LANE_WALL_H + 2.6, 0.3, [0.55, 0.75, 0.95], { opacity: 0.35, spec: 1.5 }, -2.6);
    d.push({ mesh: 'cylinder', model: segmentOn(t, laneA, laneB, LANE_WALL_H + 0.05, 0.12), color: CHROME, spec: 1.6 });
    post(laneB, LANE_WALL_H + 0.1, 0.22);

    // The top corners: quarter-circle guides (the NE one turns the plunged ball west), filled in behind.
    for (const sx of [1, -1]) {
      const c: P2 = [sx * ARC_C, -ARC_C];
      const corner: P2 = [sx * H, -H];
      const n = 9;
      for (let i = 0; i < n; i++) {
        const a0 = -(i / n) * (Math.PI / 2), a1 = -((i + 1) / n) * (Math.PI / 2);
        const p0: P2 = [c[0] + sx * Math.cos(a0) * ARC_R, c[1] + Math.sin(a0) * ARC_R];
        const p1: P2 = [c[0] + sx * Math.cos(a1) * ARC_R, c[1] + Math.sin(a1) * ARC_R];
        wall(p0, p1, 1.6, 0.35, [0.92, 0.9, 0.86]);
        const loc = (p: P2): P2 => [p[0], p[1] / t.cos];
        d.push({ mesh: 'wedge', model: triangleModel(t.frame(0, 0), loc(corner), loc(p0), loc(p1), 0, 1.55), color: [0.1, 0.03, 0.18], spec: 0.4 });
        d.push({ mesh: 'cylinder', model: segmentOn(t, p0, p1, 1.62, 0.1), color: CHROME, spec: 1.6 });
      }
    }

    // Chrome rails along the side walls, and a dark apron face over the drain.
    for (const x of [-H + 0.08, H - 0.08]) {
      d.push({ mesh: 'cylinder', model: segmentOn(t, [x, -H], [x, x > 0 ? H : DRAIN_Z], 1.1, 0.09), color: CHROME, spec: 1.6 });
    }
    // (a plate just outside the slab's end face, which is square to the slope)
    d.push({ mesh: 'box', model: mul(t.frame((LANE_WALL_X - 0.15 - H) / 2, DRAIN_Z), translation([0, -1.3, 0.03]), scaling([LANE_WALL_X - 0.15 + H, 2.6, 0.04])), color: [0.14, 0.02, 0.04], spec: 0.3 });
    for (let i = 0; i < 10; i++) {
      // Hazard chevrons down the face of the drain, pointing into it.
      const x = -H + 1.1 + i * 2.1;
      d.push({ mesh: 'box', model: mul(t.frame(x, DRAIN_Z), translation([0, -0.35, 0.06]), rotationZ(-0.6), scaling([0.9, 0.18, 0.02])), color: [0.95, 0.7, 0.05], spec: 0.3 });
      d.push({ mesh: 'box', model: mul(t.frame(x + 0.6, DRAIN_Z), translation([0, -0.35, 0.06]), rotationZ(0.6), scaling([0.9, 0.18, 0.02])), color: [0.95, 0.7, 0.05], spec: 0.3 });
    }
    // The pit floor: dark, with a sullen red glow.
    d.push({ mesh: 'box', model: mul(translation([(LANE_WALL_X - 0.15 - H) / 2, 0.02, (DRAIN_Z + H) / 2]), scaling([LANE_WALL_X - 0.15 + H, 0.03, H - DRAIN_Z])), color: [0.25, 0.02, 0.02], pattern: Pattern.emissive, shadow: false });

    this.buildArt();
  }

  /** Printed playfield art: a sunburst behind the bumpers, stars, lane-light inserts. */
  private buildArt() {
    const d = this.staticDraws;
    const t = TABLE;
    const loc = (p: P2): P2 => [p[0], p[1] / t.cos];
    const f0 = t.frame(0, 0, 0, 0.004);
    // Sunburst rays fanning up the table from just above the flippers.
    const origin: P2 = [CX, 6.5];
    const rays = 11;
    for (let i = 0; i < rays; i++) {
      const a0 = Math.PI * (0.08 + (0.84 * i) / rays), a1 = Math.PI * (0.08 + (0.84 * (i + 0.5)) / rays);
      const R = 17;
      const p1: P2 = [origin[0] - Math.cos(a0) * R, origin[1] - Math.sin(a0) * R];
      const p2: P2 = [origin[0] - Math.cos(a1) * R, origin[1] - Math.sin(a1) * R];
      const clampP = (p: P2): P2 => [clamp(p[0], -H, LANE_WALL_X - 0.2), clamp(p[1], -H, DRAIN_Z)];
      d.push({ mesh: 'wedge', model: triangleModel(f0, loc(origin), loc(clampP(p1)), loc(clampP(p2)), 0, 0.006), color: i % 2 ? [0.13, 0.03, 0.26] : [0.02, 0.12, 0.3], spec: 0.9, shadow: false });
    }
    // Stars.
    const stars: [number, number, number, number[]][] = [
      [-7, -5, 0.6, [0.95, 0.8, 0.15]], [5.5, -6, 0.5, [0.95, 0.3, 0.6]], [-3.5, 1.5, 0.45, [0.3, 0.85, 0.95]],
      [2.5, 0.5, 0.55, [0.95, 0.8, 0.15]], [-9.5, -8, 0.35, [0.95, 0.95, 0.95]], [7.5, -9.5, 0.3, [0.95, 0.95, 0.95]],
      [-5, -1.5, 0.3, [0.95, 0.45, 0.1]], [6.2, -2.8, 0.35, [0.3, 0.85, 0.95]], [CX, 3.2, 0.8, [0.95, 0.8, 0.15]],
      [-9.2, 6.5, 0.3, [0.95, 0.3, 0.6]], [7.1, 6.5, 0.3, [0.95, 0.3, 0.6]], [-2.5, -9.5, 0.4, [0.3, 0.85, 0.95]],
    ];
    for (const [x, z, r, c] of stars) drawStar(d, t.frame(x, z, 0, 0.01), r, c, 0.012, { spec: 0.6 });
    // A white outline round the centre star.
    d.push({ mesh: 'tube', model: mul(t.frame(CX, 3.2, 0, 0.008), scaling([1.25, 0.012, 1.25])), color: [0.9, 0.9, 0.95], spec: 0.5, shadow: false });

    // Cabinet side art along the side walls: a dark band with speed stripes, and a row of
    // general-illumination bulbs along the bottom.
    const band = 2.4;
    const STRIPES = [[0.9, 0.15, 0.6], [0.95, 0.75, 0.1], [0.1, 0.7, 0.9]];
    for (const [x, z0, z1] of [[-H + 0.02, -H, DRAIN_Z], [H - 0.02, -H, H]] as const) {
      const zc = (z0 + z1) / 2, len = (z1 - z0) / t.cos;
      const f = t.frame(x, zc);
      d.push({ mesh: 'box', model: mul(f, translation([0, band / 2 - 0.2, 0]), scaling([0.04, band + 0.4, len])), color: [0.07, 0.02, 0.13], spec: 0.5 });
      d.push({ mesh: 'box', model: mul(f, translation([0, band, 0]), scaling([0.09, 0.08, len])), color: CHROME, spec: 1.4 });
      const side = x < 0 ? 1 : -1;
      for (let z = z0 + 1.2; z < z1 - 1; z += 3.6) {
        STRIPES.forEach((c, k) => {
          const fs = t.frame(x + side * 0.02, z + k * 0.6);
          d.push({ mesh: 'box', model: mul(fs, translation([0, band / 2, 0]), rotationX(0.65), scaling([0.02, band / Math.cos(0.65) - 0.2, 0.3])), color: c, spec: 0.4, shadow: false });
        });
      }
      for (let z = z0 + 0.8; z < z1 - 0.3; z += 1.6) {
        d.push({ mesh: 'sphere', model: mul(t.frame(x + side * 0.14, z, 0, 0.3), scaling([0.1, 0.1, 0.1])), color: this.giColor, pattern: Pattern.emissive, shadow: false });
      }
    }
  }

  // --- Update ---------------------------------------------------------------------------------------------------

  update(dt: number) {
    const { player, hud } = this.ctx;
    this.t += dt;
    this.phaseT += dt;
    const alive = !this.death && this.status === 'playing';

    // Death screen.
    const death = this.death;
    if (death && this.status === 'playing') {
      death.t += dt;
      if (death.t > DEATH_SCREEN_DELAY) {
        this.status = 'lost';
        const info = DEATHS[death.kind];
        hud.show(info.big, `${pick(info.small)}\nGAME OVER. INSERT COIN.  ·  SCORE ${this.score.toLocaleString('en-US')}\nPress R to try again.`);
        hud.tips([
          ['Hint', info.hint],
          ['Controls', 'WASD move · Shift sprint · Space jump (nudge)'],
        ]);
      }
    }

    // Sound: the machine hums once it's on, plays its tune while you play, and the balls rumble.
    if (alive && this.power > 0.5) {
      this.hum.start();
      this.music.start();
    } else {
      this.hum.stop();
      this.music.stop();
    }
    this.updateRumble();

    this.arrival.update(dt);
    this.updatePhase(dt);
    this.exit.update(dt, player);
    if (this.exit.entered && this.status === 'playing') this.status = 'exited';

    // Timers.
    this.tiltT = Math.max(0, this.tiltT - dt);
    this.nudge = Math.max(0, this.nudge - NUDGE_DECAY * dt);
    if (this.nudge < NUDGE_DANGER - 1.5) this.dangerShown = false;
    for (const k of ['bumper', 'sling'] as const) this.playerCool[k] = this.playerCool[k].map((c) => Math.max(0, c - dt));
    this.playerCool.flipper = Math.max(0, this.playerCool.flipper - dt);
    for (const b of this.bumpers) b.update(dt);
    for (const s of this.slings) s.update(dt);
    for (const tg of this.targets) tg.update(dt);

    this.updateFlippers(dt);
    this.updatePlunger(dt);
    this.updateFlight(dt);
    this.updateBalls(dt);

    // The slope: standing still slides you down toward the flippers.
    const controlling = player.mode === 'control' && !player.inPortal && alive && this.arrival.done;
    if (controlling && player.stun <= 0) {
      const onTable = player.pos[2] < DRAIN_Z + 2.5 && player.pos[1] > 0.5;
      const drift = !onTable ? 0 : player.gettingUp ? DRIFT_GETUP : player.onGround ? DRIFT_GROUND : DRIFT_AIR;
      player.platformVel = TABLE.dir(0, drift);
      player.platformVel[1] = 0;
    } else {
      player.platformVel = [0, 0, 0];
    }

    if (controlling) {
      this.detectNudge();
      this.touchBumpers();
      this.touchSlings();
      this.touchTargets();
      this.touchFlippers();
      this.checkDrain();
    }
    this.wasOnGround = player.onGround;

    this.updateLights(dt);
    this.updateDisplay(dt);
    for (const p of this.popups) {
      p.t += dt;
      p.label.pos[1] += dt * 0.9;
    }
    this.popups = this.popups.filter((p) => p.t < 1.1);
  }

  private setPhase(p: PinballLevel['phase']) {
    this.phase = p;
    this.phaseT = 0;
  }

  private updatePhase(dt: number) {
    switch (this.phase) {
      case 'arrive':
        this.power = 0.12 + 0.08 * Math.sin(this.t * 3);
        if (this.arrival.done) {
          this.setPhase('boot');
          pinSfx.coin();
          this.showMsg('PLAYER 1', 1.4, false);
        }
        break;
      case 'boot':
        if (this.phaseT > 0.6 && this.phaseT - dt <= 0.6) pinSfx.boot();
        this.power = clamp((this.phaseT - 0.6) / 1.0, 0.12, 1);
        if (this.phaseT > 1.9) {
          this.setPhase('ready');
          this.showMsg('BALL 1', 2.5, false);
        }
        break;
      case 'ready':
        // Waiting for the plunger. If the player walks up the lane instead, start without them.
        if (this.phaseT > 7) this.startPlay();
        break;
      case 'play':
        if (this.ballQueue > 0) {
          this.ballQueueT -= dt;
          if (this.ballQueueT <= 0) {
            this.ballQueue--;
            this.ballQueueT = 2.4;
            this.addBall();
          }
        }
        break;
    }
    // The room lights go down as the table comes up; the table's own lamps light it (dimmer on a TILT).
    const m = this.phase === 'arrive' ? 0 : clamp(this.power, 0, 1);
    const mix = (a: Vec3, b: Vec3): Vec3 => [a[0] + (b[0] - a[0]) * m, a[1] + (b[1] - a[1]) * m, a[2] + (b[2] - a[2]) * m];
    this.env.sunDir = mix(DEFAULT_ENV.sunDir, ARCADE_ENV.sunDir);
    this.env.sunColor = mix(DEFAULT_ENV.sunColor, ARCADE_ENV.sunColor);
    this.env.skyColor = mix(DEFAULT_ENV.skyColor, ARCADE_ENV.skyColor);
    this.env.groundColor = mix(DEFAULT_ENV.groundColor, ARCADE_ENV.groundColor);
    this.env.fogColor = mix(DEFAULT_ENV.fogColor, ARCADE_ENV.fogColor);
    this.env.fogDensity = DEFAULT_ENV.fogDensity + (ARCADE_ENV.fogDensity - DEFAULT_ENV.fogDensity) * m;
    const gi = m * (this.tiltT > 0 ? 0.3 : 1);
    this.env.pointLight = gi > 0.01 ? { pos: [CX, 9.5, -1], color: [1.5 * gi, 1.2 * gi, 0.95 * gi], range: 30 } : undefined;
  }

  /** The first ball joins in once the player is on the table. */
  private startPlay() {
    if (this.phase === 'play') return;
    this.setPhase('play');
    this.ballQueue = 1;
    this.ballQueueT = 2.2;
  }

  // --- Flippers ----------------------------------------------------------------------------------------------------

  private updateFlippers(dt: number) {
    const tilted = this.tiltT > 0;
    const { player } = this.ctx;
    this.twitchT -= dt;
    this.flippers.forEach((f, i) => {
      this.flipperCool[i] = Math.max(0, this.flipperCool[i] - dt);
      if (this.flipperHold[i] > 0) {
        this.flipperHold[i] -= dt;
        if (this.flipperHold[i] <= 0) {
          f.holding = false;
          this.flipperCool[i] = FLIP_COOLDOWN;
        }
      }
      if (tilted) {
        f.holding = false;
        this.flipperHold[i] = 0;
        return;
      }
      if (this.power < 0.9 || f.holding || this.flipperCool[i] > 0) return;
      // Anything on (or just above) the flipper toward its tip makes it flip.
      let want = false;
      if (player.mode === 'control' && !this.death) want = this.onFlipper(f, player.pos[0], player.pos[2], PLAYER_RADIUS, player.pos[1] - TABLE.y(player.pos[2]));
      for (const b of this.balls) {
        if (want) break;
        if (b.state !== 'play') continue;
        const p = b.body.rb.translation();
        want = this.onFlipper(f, p.x, p.z, BALL_R, p.y - BALL_R - TABLE.y(p.z));
      }
      // Now and then a flipper twitches by itself, as if someone's fidgeting with the button.
      if (!want && this.twitchT <= 0 && Math.random() < 0.5) {
        want = true;
        this.twitchT = rand(3, 7);
      }
      if (want) {
        f.holding = true;
        this.flipperHold[i] = FLIP_HOLD;
        pinSfx.flipper();
      }
    });
    if (this.twitchT <= 0) this.twitchT = rand(3, 7);
  }

  /** Whether something at world (x, z) of radius r (its bottom `above` the table) is on the flipper, out toward its tip. */
  private onFlipper(f: Flipper, x: number, z: number, r: number, above: number) {
    if (above > 1.6) return false;
    const { s, e } = f.relative(x, z);
    // e < 0 is over the bar itself (standing on it); behind it (e < -2 radius) doesn't count.
    return s > f.length * 0.2 && s < f.length + 0.35 && e < r + 1.0 && e > -2 * f.radiusAt(s) - 0.1;
  }

  /** A flipper swinging up through the player bats them up the table. */
  private touchFlippers() {
    const { player, camera } = this.ctx;
    if (this.playerCool.flipper > 0 || player.stunImmunity > 0) return;
    const above = player.pos[1] - TABLE.y(player.pos[2]);
    if (above > 1.1) return;
    for (const f of this.flippers) {
      if (f.rate <= 0) continue;
      const { s, e } = f.relative(player.pos[0], player.pos[2]);
      if (s < -0.4 || s > f.length + 0.45 || e > PLAYER_RADIUS + 0.2 || e < -2 * f.radiusAt(s) - 0.1) continue;
      const k = clamp(s / f.length, 0, 1);
      const speed = FLIP_LAUNCH_MIN + (FLIP_LAUNCH_MAX - FLIP_LAUNCH_MIN) * k;
      const [sx, sz] = f.sweep();
      const dir = TABLE.dir(sx, sz);
      const v = add(scale(dir, speed), [0, FLIP_LAUNCH_UP, 0]);
      player.knock(v, 1.0);
      camera.addShake(0.35);
      this.playerCool.flipper = 0.6;
      this.addScore(5000, add(player.pos, [0, 2, 0]));
      if (Math.random() < 0.5) this.showMsg(pick(['NICE SAVE', 'FLIPPED!', 'WHEEE', 'BACK IN PLAY']), 1.4);
      tone(300, 0.25, { to: 900, wave: 'triangle', vol: 0.12 });
      return;
    }
  }

  // --- Kickers -----------------------------------------------------------------------------------------------------

  private touchBumpers() {
    if (this.tiltT > 0) return;
    const { player, camera } = this.ctx;
    const pelvis = player.body?.position('pelvis') ?? player.pos;
    this.bumpers.forEach((b, i) => {
      if (this.playerCool.bumper[i] > 0) return;
      const probe = (p: Vec3) => {
        const d = Math.hypot(p[0] - b.x, (p[2] - b.z) / TABLE.cos);
        const above = p[1] - TABLE.y(p[2]);
        return above < 1.7 && d < BUMPER_R + PLAYER_RADIUS + 0.12 ? d : Infinity;
      };
      const d = Math.min(probe(player.pos), probe(pelvis));
      if (d === Infinity) return;
      let dx = player.pos[0] - b.x, dz = (player.pos[2] - b.z) / TABLE.cos;
      const l = Math.hypot(dx, dz) || 1;
      dx /= l;
      dz /= l;
      player.knock(add(scale(TABLE.dir(dx, dz), BUMPER_KICK_PLAYER), [0, 3, 0]), 0.5);
      camera.addShake(0.25);
      b.kick();
      pinSfx.bumper(BUMPERS[i].bell);
      this.playerCool.bumper[i] = 0.45;
      this.addScore(1000, add(b.centre, [0, 2.2, 0]));
    });
  }

  private touchSlings() {
    if (this.tiltT > 0) return;
    const { player, camera } = this.ctx;
    this.slings.forEach((s, i) => {
      if (this.playerCool.sling[i] > 0) return;
      const above = player.pos[1] - TABLE.y(player.pos[2]);
      if (above > 1.3) return;
      if (s.faceDistance(player.pos[0], player.pos[2]) > PLAYER_RADIUS + 0.2) return;
      player.knock(add(scale(TABLE.dir(s.normal[0], s.normal[1]), SLING_KICK_PLAYER), [0, 3, 0]), 0.5);
      camera.addShake(0.2);
      s.kick();
      pinSfx.sling();
      this.playerCool.sling[i] = 0.45;
      this.addScore(500, add(player.pos, [0, 2, 0]));
    });
  }

  /** Balls touching a bumper or a slingshot get kicked (every physics step). */
  private kickBalls() {
    if (this.tiltT > 0) return;
    for (const b of this.balls) {
      if (b.state !== 'play') continue;
      const rb = b.body.rb;
      const p = rb.translation();
      const v = rb.linvel();
      this.bumpers.forEach((bu, i) => {
        if (b.kickCooldown[i] > this.t) return;
        let dx = p.x - bu.x, dz = (p.z - bu.z) / TABLE.cos;
        const d = Math.hypot(dx, dz);
        if (d > BUMPER_R + BALL_R + 0.06 || p.y - BALL_R - TABLE.y(p.z) > 1.2) return;
        dx /= d;
        dz /= d;
        const dir = TABLE.dir(dx, dz);
        const radial = v.x * dir[0] + v.y * dir[1] + v.z * dir[2];
        const dv = BUMPER_KICK_BALL - radial;
        rb.setLinvel({ x: v.x + dir[0] * dv, y: v.y + dir[1] * dv, z: v.z + dir[2] * dv }, true);
        b.kickCooldown[i] = this.t + 0.15;
        bu.kick();
        pinSfx.bumper(BUMPERS[i].bell);
        this.addScore(100);
      });
      this.slings.forEach((s, i) => {
        const k = 3 + i;
        if (b.kickCooldown[k] > this.t) return;
        if (s.faceDistance(p.x, p.z) > BALL_R + 0.18 || p.y - BALL_R - TABLE.y(p.z) > 0.8) return;
        const dir = TABLE.dir(s.normal[0], s.normal[1]);
        const into = v.x * dir[0] + v.y * dir[1] + v.z * dir[2];
        const dv = SLING_KICK_BALL - into;
        rb.setLinvel({ x: v.x + dir[0] * dv, y: v.y + dir[1] * dv, z: v.z + dir[2] * dv }, true);
        b.kickCooldown[k] = this.t + 0.2;
        s.kick();
        pinSfx.sling();
        this.addScore(50);
      });
    }
  }

  // --- Targets -------------------------------------------------------------------------------------------------------

  private touchTargets() {
    const { player } = this.ctx;
    const body = player.body;
    const probes: Vec3[] = [add(player.pos, [0, 0.5, 0]), add(player.pos, [0, 1.2, 0])];
    if (body) probes.push(body.position('chest'), body.position('pelvis'));
    this.targets.forEach((tg, i) => {
      if (tg.down) return;
      if (!probes.some((p) => tg.touches(p, 0.42))) return;
      // They only drop in order: you have to spell it.
      if (i !== this.nextTarget()) {
        if (this.t - this.wrongTargetT > 2.5) {
          this.wrongTargetT = this.t;
          tone(110, 0.18, { wave: 'square', vol: 0.12 });
          this.showMsg(pick(['IN ORDER', 'SPELL IT', 'NOPE']), 1.1);
          this.later(1.1, `NEXT: ${TARGETS[this.nextTarget()].letter}`, 1.4, false);
        }
        return;
      }
      tg.drop();
      pinSfx.target(i);
      const down = this.targets.filter((x) => x.down).length;
      this.addScore(25000, TABLE.point(tg.x, tg.z, 2.2));
      if (this.t - this.lastPlungeT < 2.5) {
        this.showMsg('SKILL SHOT!', 2);
        this.addScore(500000);
        pinSfx.knocker();
      } else if (down < 4) {
        this.showMsg(`${this.progress()}`, 1.6);
      }
      if (down === 1) {
        // Your reward: another ball. Hooray.
        this.ballQueue += 1;
        this.ballQueueT = 1.0;
        this.later(1.7, 'EXTRA BALL', 2.2);
        pinSfx.knocker();
      }
      if (down === 2) {
        // Half the word lights multiball. Congratulations.
        this.ballQueue += 1;
        this.ballQueueT = 1.2;
        this.showMsg('MULTIBALL!', 3);
        pinSfx.multiball();
      }
      if (down === 4) this.jackpot();
    });
  }

  private progress() {
    return this.targets.map((t) => (t.down ? t.letter : '-')).join(' ');
  }

  /** Index of the target that counts next (they go in order), or -1 once they're all down. */
  private nextTarget() {
    return this.targets.findIndex((t) => !t.down);
  }

  private jackpot() {
    this.won = true;
    this.exit.openNow();
    this.addScore(1000000);
    this.showMsg('JACKPOT!', 2.5);
    pinSfx.jackpot();
    pinSfx.knocker();
    this.ctx.camera.addShake(0.3);
    // And one more ball, for the road.
    this.ballQueue += 1;
    this.ballQueueT = 2.8;
    this.later(2.6, 'EXIT LIT', 3);
  }

  /** Queues a display message `delay` seconds from now. */
  private later(delay: number, text: string, dur: number, flash = true) {
    this.scheduled.push({ at: this.t + delay, text, dur, flash });
  }

  // --- Tilt -----------------------------------------------------------------------------------------------------------

  private detectNudge() {
    const { player } = this.ctx;
    if (!(this.wasOnGround && !player.onGround && player.vel[1] > 5)) return;
    this.nudge += 1;
    if (this.tiltT > 0) return;
    if (this.nudge >= NUDGE_TILT) {
      this.tiltT = TILT_TIME;
      this.tilts++;
      this.nudge = 0;
      this.showMsg('TILT', TILT_TIME, true);
      pinSfx.tilt();
      this.ctx.camera.addShake(0.5);
    } else if (this.nudge >= NUDGE_DANGER && !this.dangerShown) {
      this.dangerShown = true;
      this.showMsg('DANGER', 2);
      pinSfx.danger();
    }
  }

  // --- The drain ------------------------------------------------------------------------------------------------------

  private checkDrain() {
    const { player } = this.ctx;
    const p = player.pos;
    if (p[2] < DRAIN_Z + 0.05 || p[1] > TABLE.y(DRAIN_Z) - 0.8 || p[0] > LANE_WALL_X) return;
    const outlane = Math.abs(p[0] - CX) > FLIPPER_X + 1.2;
    this.die(this.tiltT > 0 ? 'tilt' : outlane ? 'outlane' : 'drain');
    player.kill([0, -1, 1.5], { violence: 0 });
    pinSfx.drain();
    this.showMsg(this.tiltT > 0 ? 'TILT' : 'DRAINED', 3);
  }

  private die(kind: DeathKind) {
    if (this.death) return;
    this.death = { kind, t: 0, at: [...this.ctx.player.pos] };
    this.ctx.hud.hide();
    this.scheduled.length = 0;
    this.later(1.4, 'GAME OVER', 60);
  }

  // --- The plunger and the flight up the lane ---------------------------------------------------------------------

  /** Whether (x, z) is on the plunger's tip, at the bottom of the lane. */
  private onPlunger(x: number, z: number, above: number) {
    return x > LANE_WALL_X + 0.15 && z > PLUNGER_Z - 1.9 && z < HOUSING_Z && above < 0.9;
  }

  private updatePlunger(dt: number) {
    const pl = this.plunger;
    const { player } = this.ctx;
    const armed = this.phase === 'ready' || this.phase === 'play';
    const playerOn = armed && player.mode === 'control' && !this.death && !player.inPortal &&
      this.onPlunger(player.pos[0], player.pos[2], player.pos[1] - TABLE.y(player.pos[2]));
    const ballsOn = this.balls.filter((b) => {
      if (b.state !== 'play') return false;
      const p = b.body.rb.translation();
      return this.onPlunger(p.x, p.z, p.y - BALL_R - TABLE.y(p.z));
    });
    pl.t += dt;
    switch (pl.state) {
      case 'idle':
        pl.pull = Math.max(0, pl.pull - dt * 6);
        if (armed && (playerOn || ballsOn.length)) {
          pl.loaded += dt;
          if (pl.loaded > (playerOn ? 0.5 : 0.3)) {
            pl.state = 'pull';
            pl.withPlayer = playerOn;
            pl.t = 0;
            pinSfx.plungerPull();
          }
        } else pl.loaded = 0;
        break;
      case 'pull':
        pl.pull = Math.min(1, pl.t / 0.9);
        if (pl.t > 1.05) {
          pl.state = 'fire';
          pl.t = 0;
          pl.loaded = 0;
          pinSfx.plungerFire();
          // The player goes first; a ball sharing the tip waits for the next pull.
          if (playerOn) this.launchPlayer();
          else {
            // Every ball queued up the lane goes together, or the first would just ram the rest.
            const s = BALL_LAUNCH * rand(0.95, 1.03);
            const v = scale(TABLE.upSlope, s);
            for (const b of this.balls) {
              if (b.state !== 'play') continue;
              const p = b.body.rb.translation();
              if (p.x < LANE_WALL_X + 0.15 || p.z < LANE_TOP_Z + 1 || p.y - BALL_R - TABLE.y(p.z) > 1.2) continue;
              // Already rolling (spinning to match), so it doesn't lose half its speed skidding.
              b.body.rb.setLinvel({ x: v[0], y: v[1], z: v[2] }, true);
              b.body.rb.setAngvel({ x: -s / BALL_R, y: 0, z: 0 }, true);
              b.body.rb.wakeUp();
            }
          }
        }
        break;
      case 'fire':
        pl.pull = Math.max(0, 1 - pl.t / 0.06);
        if (pl.t > 0.5) pl.state = 'idle';
        break;
    }
    pl.collider?.setTranslation(v3(TABLE.point(LANE_X, PLUNGER_Z + 0.25 + pl.pull * 0.9, 0.65)));
  }

  /** Fires the player up the shooter lane, round the top-right corner and out onto the table. */
  private launchPlayer() {
    const { player, camera } = this.ctx;
    const pts: Vec3[] = [add(player.pos, [0, 0.9, 0])];
    const lift = 1.05;
    pts.push(TABLE.point(LANE_X, Math.min(player.pos[2] - 1.5, 8.0), lift));
    pts.push(TABLE.point(LANE_X, -ARC_C, lift));
    const r = ARC_R - 0.9;
    for (let i = 1; i <= 8; i++) {
      const a = -(i / 8) * (Math.PI / 2);
      pts.push(TABLE.point(ARC_C + Math.cos(a) * r, -ARC_C + Math.sin(a) * r, lift + 0.4 * Math.sin((i / 8) * Math.PI)));
    }
    pts.push(TABLE.point(6.4, -H + 0.95, lift));
    this.flight = { pts, seg: 0, along: 0 };
    player.mode = 'flying';
    player.pos = [...pts[0]];
    player.flightDir = normalize(sub(pts[1], pts[0]));
    camera.addShake(0.4);
    this.plunges++;
    this.lastPlungeT = this.t + 1.6;
    if (this.plunges > 1) this.showMsg(pick(['SHOOT AGAIN', 'EXTRA BALL?', 'REPLAY']), 1.8);
    if (this.phase === 'ready') this.startPlay();
  }

  private updateFlight(dt: number) {
    const f = this.flight;
    const { player } = this.ctx;
    if (!f) return;
    if (player.mode !== 'flying') {
      this.flight = null;
      return;
    }
    let step = FLIGHT_SPEED * dt;
    while (step > 0 && f.seg < f.pts.length - 1) {
      const a = f.pts[f.seg], b = f.pts[f.seg + 1];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      const left = len - f.along;
      if (step < left) {
        f.along += step;
        step = 0;
      } else {
        step -= left;
        f.seg++;
        f.along = 0;
      }
    }
    if (f.seg >= f.pts.length - 1) {
      // Out onto the table, tumbling down into the bumpers.
      const end = f.pts[f.pts.length - 1];
      const v: Vec3 = [-rand(4, 7.5), 1.5, rand(3, 6)];
      this.flight = null;
      player.emerge(end, Math.PI / 2, v, 0.7);
      this.lastPlungeT = this.t;
      return;
    }
    const a = f.pts[f.seg], b = f.pts[f.seg + 1];
    const dir = normalize(sub(b, a));
    player.pos = add(a, scale(dir, f.along));
    player.flightDir = dir;
  }

  // --- Steel balls --------------------------------------------------------------------------------------------------

  /** A new ball rolls into the shooter lane (the plunger does the rest). */
  private addBall() {
    const live = this.balls.length;
    if (live >= MAX_BALLS) return;
    const body = spawnSteelBall(this.ctx.physics, TABLE.point(LANE_X, 6.5, BALL_R + 0.05));
    this.balls.push({ body, state: 'play', t: 0, hitCooldown: 0, still: 0, kickCooldown: [0, 0, 0, 0, 0], prevVel: [0, 0, 0] });
    this.ballsLaunched++;
  }

  private updateBalls(dt: number) {
    const { player, camera } = this.ctx;
    for (const b of this.balls) {
      const rb = b.body.rb;
      b.t += dt;
      b.hitCooldown = Math.max(0, b.hitCooldown - dt);
      const p = rb.translation();
      const v = rb.linvel();
      if (b.state === 'drained') {
        if (b.t > 1.4) {
          // Ball save: back into the shooter lane.
          b.state = 'play';
          b.t = 0;
          const at = TABLE.point(LANE_X, 5.5, BALL_R + 0.05);
          rb.setTranslation(v3(at), true);
          rb.setLinvel({ x: 0, y: 0, z: 0 }, true);
          rb.setAngvel({ x: 0, y: 0, z: 0 }, true);
          if (!this.death) this.showMsg('BALL SAVED', 1.6);
        }
        continue;
      }
      // Down the drain.
      if (p.z > DRAIN_Z + 0.2 && p.y < TABLE.y(DRAIN_Z) - 0.6 && p.x < LANE_WALL_X) {
        b.state = 'drained';
        b.t = 0;
        pinSfx.drain();
        continue;
      }
      // Lost somehow (flung out of the table): straight back to the lane.
      if (p.y < -2 || p.y > 20 || Math.abs(p.x) > H + 1 || Math.abs(p.z) > H + 1) {
        b.state = 'drained';
        b.t = 1.4;
        continue;
      }
      // Speed limit, and clacks when it hits something hard.
      const speed = Math.hypot(v.x, v.y, v.z);
      if (speed > MAX_BALL_SPEED) {
        const k = MAX_BALL_SPEED / speed;
        rb.setLinvel({ x: v.x * k, y: v.y * k, z: v.z * k }, true);
      }
      const jolt = Math.hypot(v.x - b.prevVel[0], v.y - b.prevVel[1], v.z - b.prevVel[2]);
      if (jolt > 3.5) pinSfx.clack(Math.min(0.45, jolt * 0.04));
      b.prevVel = [v.x, v.y, v.z];
      // Ball search: a ball sitting still anywhere but the plunger gets a kick, like a real machine
      // firing every solenoid to shake a stuck ball loose.
      const onPlunger = p.x > LANE_WALL_X + 0.15 && p.z > PLUNGER_Z - 2.5;
      b.still = speed < 0.35 && !onPlunger ? b.still + dt : 0;
      if (b.still > 3) {
        b.still = 0;
        const kick = add(TABLE.dir(rand(-4, 4), rand(1, 3)), [0, 3.5, 0]);
        rb.setLinvel({ x: kick[0], y: kick[1], z: kick[2] }, true);
        for (const bu of this.bumpers) bu.kick();
        for (const s of this.slings) s.kick();
        for (let i = 0; i < 4; i++) tone(90, 0.06, { wave: 'square', vol: 0.12, at: i * 0.09 });
        if (!this.death && !this.msg) this.showMsg('BALL SEARCH', 1.5);
      }

      // Hitting the player.
      if (player.mode !== 'control' || player.inPortal || this.death || b.hitCooldown > 0) continue;
      const feet = player.pos;
      const cy = clamp(p.y, feet[1] + 0.35, feet[1] + 1.45);
      const nx = feet[0] - p.x, ny = cy - p.y, nz = feet[2] - p.z;
      const dist = Math.hypot(nx, ny, nz);
      if (dist > BALL_R + 0.42 || dist < 1e-4) continue;
      const n: Vec3 = [nx / dist, ny / dist, nz / dist];
      const approach = (v.x - player.vel[0]) * n[0] + (v.y - player.vel[1]) * n[1] + (v.z - player.vel[2]) * n[2];
      if (approach >= BALL_KILL_SPEED) {
        const ball: Vec3 = [p.x, p.y, p.z];
        player.kill([v.x * 0.7, 4 + Math.abs(v.y) * 0.3, v.z * 0.7], { violence: 26, origin: ball });
        camera.addShake(1);
        pinSfx.knocker();
        this.die('ball');
        this.showMsg('STEEL BALL RUN', 4);
        rb.setLinvel({ x: v.x * 0.6, y: v.y * 0.6, z: v.z * 0.6 }, true);
        continue;
      }
      if (approach >= BALL_KNOCK_SPEED) {
        const push = Math.max(5, approach * 0.85);
        const flat = normalize([n[0], 0, n[2]]);
        player.knock(add(scale(flat, push), [0, 2.5, 0]), 0.5 + approach * 0.07);
        camera.addShake(0.3);
        pinSfx.clack(0.4);
        b.hitCooldown = 0.6;
        // The ball's heavier: it only loses a little.
        const lose = approach * 0.3;
        rb.setLinvel({ x: v.x - n[0] * lose, y: v.y - n[1] * lose, z: v.z - n[2] * lose }, true);
        if (Math.random() < 0.4) this.showMsg(pick(['BALL CONTACT', 'CLONK', 'OOF']), 1.1);
        continue;
      }
      // Leaning on you: nudged aside.
      const over = BALL_R + 0.42 - dist;
      if (player.stun <= 0) {
        const flat = normalize([n[0], 0, n[2]]);
        player.pos[0] += flat[0] * over;
        player.pos[2] += flat[2] * over;
        player.syncCollider();
      }
    }
  }

  private updateRumble() {
    if (this.death || this.status !== 'playing') {
      this.rumble.stop();
      return;
    }
    let total = 0;
    for (const b of this.balls) {
      if (b.state !== 'play') continue;
      const v = b.body.rb.linvel();
      total += Math.hypot(v.x, v.y, v.z);
    }
    if (total > 0.5) this.rumble.start();
    this.rumble.setVolume(Math.min(0.12, total * 0.006));
  }

  // --- Score and the display -------------------------------------------------------------------------------------------

  private addScore(n: number, at?: Vec3) {
    if (this.death) return;
    this.score += n;
    if (at) {
      const text = n >= 1000000 ? `${n / 1000000}M` : n >= 1000 ? `${n / 1000}K` : `${n}`;
      this.popups.push({ label: { pos: [...at], text: `+${text}`, size: 0.45, color: YELLOW }, t: 0 });
    }
  }

  private showMsg(text: string, dur = 2, flash = true) {
    this.msg = { text, t: 0, dur, flash };
  }

  private updateDisplay(dt: number) {
    for (let i = this.scheduled.length - 1; i >= 0; i--) {
      const s = this.scheduled[i];
      if (this.t < s.at) continue;
      this.scheduled.splice(i, 1);
      this.showMsg(s.text, s.dur, s.flash);
    }
    const m = this.msg;
    let line0 = this.phase === 'arrive' ? 'INSERT COIN' : this.won ? 'EXIT LIT' : 'BALL 1';
    const next = this.nextTarget();
    if (this.phase === 'play' && !this.won && next >= 0) {
      // Between messages the display cycles through its prompts, like any machine in play.
      const cycle = next > 0 ? ['BALL 1', this.progress(), `SHOOT ${TARGETS[next].letter}`] : ['BALL 1', `SHOOT ${TARGETS[next].letter}`];
      line0 = cycle[Math.floor(this.t / 2.5) % cycle.length];
    }
    let show0 = this.phase !== 'arrive' || Math.floor(this.t * 1.6) % 2 === 0;
    if (m) {
      m.t += dt;
      if (m.t > m.dur) this.msg = null;
      else {
        line0 = m.text;
        show0 = !m.flash || Math.floor(m.t * 6) % 2 === 0 || m.t > 1.2;
      }
    }
    if (this.dmd.line(0) !== line0) this.dmd.setLine(0, line0);
    this.dmd.visible[0] = show0;
    if (this.phase !== 'arrive' && this.shownScore !== this.score) {
      this.shownScore = this.score;
      this.dmd.setLine(1, this.score.toLocaleString('en-US'));
    }
  }

  private updateLights(dt: number) {
    void dt;
    const pw = this.tiltT > 0 ? 0 : clamp(this.power, 0, 1);
    const blink = Math.floor(this.t * 4) % 2 === 0;
    // The EXIT lamps on the backglass: lit per target, all flashing once they're all down.
    this.targets.forEach((tg, i) => {
      const c = this.exitLampColors[i];
      const lit = tg.down && (!this.won || blink || this.tiltT > 0);
      const src = lit ? LETTER_LIT[i] : [0.22, 0.04, 0.04];
      for (let k = 0; k < 3; k++) c[k] = src[k] * (this.tiltT > 0 ? 0.3 : 1);
      // The playfield insert in front of it: lit once it's down, blinking if it's the one to hit next.
      const next = i === this.nextTarget() && this.phase === 'play';
      const ic = this.insertColors[i];
      const on = tg.down || (next && blink) ? LETTER_LIT[i] : [0.3, 0.06, 0.04];
      for (let k = 0; k < 3; k++) ic[k] = on[k] * (0.15 + 0.85 * pw);
      // Chevrons chase toward the next target only.
      const cc = this.chevronColors[i];
      const phase = Math.floor(this.t * 5) % 4;
      cc.forEach((col, j) => {
        const bright = next && (phase === 2 - j || phase === 3) ? 1 : 0;
        const base = next ? 0.15 : 0.04;
        for (let k = 0; k < 3; k++) col[k] = (base + bright * 1.6) * LETTER_LIT[i][k] * 0.6 * pw + 0.02;
      });
    });
    // The general illumination: warm, with the odd flicker.
    const gi = (0.08 + 0.92 * pw) * (Math.random() < 0.02 ? 0.7 : 1);
    this.giColor[0] = 2.0 * gi;
    this.giColor[1] = 1.45 * gi;
    this.giColor[2] = 0.7 * gi;
    // Chasing bulbs round the backglass.
    const n = 24;
    if (!this.bulbColors.length) for (let i = 0; i < n * 2; i++) this.bulbColors.push([0, 0, 0]);
    for (let i = 0; i < n * 2; i++) {
      const on = (i + Math.floor(this.t * 8)) % 3 === 0;
      const c = this.bulbColors[i];
      const v = (on ? 2.2 : 0.35) * (0.1 + 0.9 * pw);
      c[0] = v;
      c[1] = v * 0.75;
      c[2] = v * 0.3;
    }
  }

  // --- Drawing ------------------------------------------------------------------------------------------------------

  draw(out: DrawItem[], time: number) {
    this.arrival.draw(out);
    this.exit.draw(out);
    for (const s of this.staticDraws) out.push(s);
    const pw = this.tiltT > 0 ? 0 : clamp(this.power, 0, 1);
    for (const f of this.flippers) f.draw(out, pw);
    for (const b of this.bumpers) b.draw(out, time, pw);
    for (const s of this.slings) s.draw(out, pw);
    for (const tg of this.targets) tg.draw(out);
    for (const ins of this.inserts) ins.draw(out);
    TARGETS.forEach((t, i) => {
      this.chevronColors[i].forEach((c, j) => {
        const dist = 2.9 + j * 0.8;
        const x = t.p[0] + Math.sin(t.yaw) * dist, z = t.p[1] + Math.cos(t.yaw) * dist * TABLE.cos;
        // Pointing back at the target.
        drawChevron(out, mul(TABLE.frame(x, z, t.yaw + Math.PI / 2, 0.012)), 0.9, c, { pattern: Pattern.emissive });
      });
    });
    // The plunger.
    drawPlunger(out, TABLE.frame(LANE_X, PLUNGER_Z), this.plunger.pull, (HOUSING_Z - PLUNGER_Z) / TABLE.cos);

    // Steel balls: fast ones leave a streak.
    for (const b of this.balls) {
      if (b.state !== 'play') continue;
      const v = b.body.rb.linvel();
      const speed = Math.hypot(v.x, v.y, v.z);
      if (speed < BALL_STREAK_SPEED) continue;
      const p = b.body.rb.translation();
      const k = clamp((speed - BALL_STREAK_SPEED) / 4, 0.2, 1);
      for (let i = 1; i <= 3; i++) {
        const back = (i * 0.09);
        out.push({
          mesh: 'sphere',
          model: mul(translation([p.x - v.x * back, p.y - v.y * back, p.z - v.z * back]), scaling([BALL_R * (1 - i * 0.18), BALL_R * (1 - i * 0.18), BALL_R * (1 - i * 0.18)])),
          color: [1.6 * k, 1.2 * k, 0.6 * k],
          pattern: Pattern.emissive,
          opacity: 0.45 - i * 0.12,
          shadow: false,
        });
      }
    }

    // The backglass.
    const wallZ = -H + 0.05;
    out.push({ mesh: 'box', model: mul(translation([0, 7.95, wallZ]), scaling([22, 3.9, 0.12])), color: [0.05, 0.02, 0.09], spec: 0.8 });
    for (const y of [6.0, 9.9]) out.push({ mesh: 'cylinder', model: mul(translation([0, y, wallZ + 0.08]), rotationZ90, scaling([0.09, 22, 0.09])), color: CHROME, spec: 1.6 });
    this.dmd.draw(out);
    for (const l of this.exitLamps) l.draw(out);
    const n = this.bulbColors.length / 2;
    for (let i = 0; i < this.bulbColors.length; i++) {
      const row = i < n ? 0 : 1;
      const x = -10.6 + ((i % n) + 0.5) * (21.2 / n);
      out.push({ mesh: 'sphere', model: mul(translation([x, row ? 9.7 : 6.2, wallZ + 0.1]), scaling([0.1, 0.1, 0.1])), color: this.bulbColors[i], pattern: Pattern.emissive, shadow: false });
    }
  }

  labels(): WorldLabel[] {
    if (!this.popups.length) return this.labelList;
    return [...this.labelList, ...this.popups.map((p) => p.label)];
  }

  trackedTargets(): TrackedTarget[] {
    const exit = this.exit.target();
    return exit ? [exit] : [];
  }

  environment() {
    return this.env;
  }

  obstacles() {
    return [];
  }

  // --- Camera ------------------------------------------------------------------------------------------------------

  cameraShot(): CameraShot | null {
    return this.arrival.cameraShot() ?? this.drainShot() ?? this.plungerShot() ?? this.followShot();
  }

  /** On the plunger while it pulls back: looking back down the lane at the player (the wall's too close behind). */
  private plungerShot(): CameraShot | null {
    const pl = this.plunger;
    const { player } = this.ctx;
    if (pl.state !== 'pull' || !pl.withPlayer || player.mode !== 'control') return null;
    const target = add(player.pos, [0, 0.8, 0]);
    return { pos: TABLE.point(LANE_X + 0.35, player.pos[2] - 5.2, 3.1), target, sharpness: 5 };
  }

  /** Drained: looking down into the pit from over the flippers. */
  private drainShot(): CameraShot | null {
    const d = this.death;
    if (!d || d.kind === 'ball') return null;
    const p = this.ctx.player.pos;
    return { pos: [clamp(p[0] + 0.6, -H + 1, LANE_WALL_X - 1), 5.6, 9.7], target: [p[0], Math.max(0, p[1] + 0.9), p[2]], sharpness: 2.5 };
  }

  /** The usual over-the-shoulder view, kept above the sloping table. */
  private followShot(): CameraShot {
    const { camera, player } = this.ctx;
    const cp = Math.cos(camera.pitch), sp = Math.sin(camera.pitch);
    const fwd: Vec3 = [-Math.sin(camera.yaw) * cp, sp, -Math.cos(camera.yaw) * cp];
    const right: Vec3 = [Math.cos(camera.yaw), 0, -Math.sin(camera.yaw)];
    const feet: Vec3 = player.mode === 'flying' ? [player.pos[0], player.pos[1] - 0.9, player.pos[2]] : player.pos;
    const shoulder = add(add(feet, [0, 1.65, 0]), scale(right, 0.6));
    const pos = sub(shoulder, scale(fwd, 3.2));
    const lim = H - 0.3;
    const cx = clamp(pos[0], -lim, lim), cz = clamp(pos[2], -lim, lim);
    const pushed = Math.hypot(pos[0] - cx, pos[2] - cz);
    pos[0] = cx;
    pos[2] = cz;
    pos[1] += pushed * 0.8;
    const inPit = pos[2] > DRAIN_Z && pos[0] < LANE_WALL_X;
    const floor = inPit ? 0 : TABLE.y(Math.min(pos[2], DRAIN_Z));
    pos[1] = Math.max(pos[1], floor + 0.45);
    return { pos, target: add(shoulder, scale(fwd, 10)), sharpness: 18 };
  }
}

const rotationZ90 = rotationZ(Math.PI / 2);
const v3 = (v: Vec3) => ({ x: v[0], y: v[1], z: v[2] });
const crossV = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
