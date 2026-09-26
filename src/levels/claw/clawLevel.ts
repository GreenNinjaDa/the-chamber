import { Drone, noise, sfx, tone, Tune } from '../../engine/audio';
import {
  add, clamp, distXZ, easeInOut, lerp3, mul, quatSlerp, rotationX, rotationZ, scale, scaling, sub, translation, type Quat, type Vec3,
} from '../../engine/math';
import { RAPIER } from '../../engine/physics';
import { Pattern, type DrawItem, type Environment } from '../../engine/renderer';
import { CHAMBER_HALF, WALL_HEIGHT } from '../../game/chamber';
import { Claw, CLAW_TOP, HUB_BOTTOM, PRONGS_OPEN, PRONGS_SHUT, TIP_DEPTH } from '../../entities/claw';
import { spawnPlush, type Plush, type PlushKind, type PlushLook } from '../../entities/plush';
import { drawPortal, PORTAL_SQUEEZE_TIME, PortalArrival } from '../../entities/portal';
import { type CameraShot, type Level, type LevelContext, type LevelStatus, type TrackedTarget, type WorldLabel } from '../level';

/*
 * The Claw. The chamber is the inside of a claw machine and you are one of the prizes, knee-deep
 * in plush toys (mostly little green three-eyed aliens, who worship the claw). An unseen kid has
 * three credits. Each credit the claw wanders about, settles over something (often an alien,
 * sometimes you), drops, grabs whatever is under it, rises, does the rigged-machine jiggle that
 * shakes most prizes loose, and carries anything left over to the prize chute in the corner. The
 * chute's portal is the only way out, and its walls are too tall to climb.
 *
 * Hold E (or left mouse) near the claw as it comes down to hang on to a prong: it carries you up,
 * shakes you (keep holding), and drops you in the chute. Let go too early and it's a long way
 * down. Stand under it without holding on and it grabs you anyway, then drops you at the jiggle.
 * Out of credits, the lights go out.
 */

// --- Layout -------------------------------------------------------------------------------------
const SPAWN: Vec3 = [-2, 0, 5];
/** The prize chute fills the north-east corner (front right, by the glass): inner edges at x = CHUTE_IN, z = -CHUTE_IN. */
const CHUTE_IN = 9.4;
const CHUTE_T = 0.2;
/** Solid walls this tall, then a clear guard on top: too tall to climb or jump into. */
const CHUTE_H = 1.8;
const GUARD_H = 1.7;
const CHUTE_C: Vec3 = [(CHUTE_IN + CHAMBER_HALF) / 2, 0, -(CHUTE_IN + CHAMBER_HALF) / 2];
const PORTAL_Y = 0.06;
const PORTAL_R = 1.15;
/** The claw's parking spot: over the chute. */
const HOME: [number, number] = [CHUTE_C[0], CHUTE_C[2]];
/** How far out the kid can steer the claw, and the corner it won't go for (the chute). */
const CLAW_LIMIT = 10.2;
const CHUTE_KEEP_OUT = 7.2;

/** Heaps of toys: x, z and how many (the rest are scattered), settled in bins this wide. */
const HEAPS: [number, number, number][] = [
  [-6.8, -6, 8], [0, -6.8, 8], [5.6, -2.2, 8], [-7, 3.2, 8], [4.8, 5.8, 7], [-0.6, 0.2, 6],
];
const HEAP_BIN = 2.3;

// --- The kid -------------------------------------------------------------------------------------
const CREDITS = 3;
/** Seconds after the arrival that the coins go in, and that the first credit starts. */
const COINS_AT = 1.0;
const FIRST_CREDIT_AT = 2.6;
/** Seconds on the clock each credit: the claw drops when it hits zero. */
const CREDIT_TIME = 12;
/** With this much left on the clock, the kid makes up his mind what to go for... */
const DECIDE_AT = 8.5;
/** ...and always leaves at least this long hovering over it before the drop. */
const MIN_HOVER = 3;
/** Chance (per credit) the kid goes for the spot you're standing on rather than a prize. */
const AIM_AT_PLAYER = [0.25, 0.45, 0.6];
/** From the second credit on, the chance the kid changes his mind with SWITCH_AT seconds to go. */
const FICKLE = 0.35;
const SWITCH_AT = 2.6;

// --- The claw's go -------------------------------------------------------------------------------
const DROP_SPEED = 7.5;
const DROP_ACCEL = 30;
const RISE_SPEED = 2.6;
/** The lowest the hub goes: open tips just into the pile. */
const SINK = 0.35;
const BOTTOM_PAUSE = 0.55;
const CLOSE_TIME = 0.6;
const JIGGLE_TIME = 1.5;
/** When in the jiggle the grip goes weak (and prizes slip). */
const SLIP_AT = 0.5;
const RELEASE_TIME = 1.1;
const REST_TIME = 2.2;
/** Things within this far of the claw's axis (m) get grabbed when it closes. */
const GRAB_R = 0.85;
/** Chance a grabbed prize slips at the jiggle: the first one the kid gets usually makes it, to show how it's done. */
const FIRST_SLIP = 0.3;
const SLIP = 0.75;

// --- You -----------------------------------------------------------------------------------------
/** Hands above the feet (arms up), how close they must be to grab the claw, and how far out from the prong you hang. */
const HANDS = 2.05;
const REACH = 0.9;
const HANG_OUT = 0.3;
/** Grabbing on the run swings the claw (share of your speed); kicking your legs (WASD) swings it this hard (m/s²). */
const GRAB_SWING = 0.15;
const PUMP = 2.5;
/** Feet below the hub when the claw grabs you (your head against the hub). */
const GRIPPED = 2.3;
const HEAD_TOP = 1.9;
/** Landing faster than this (m/s) is fatal (about a 4.5 m fall); faster than HARD_LANDING (about 3 m) knocks you down. */
const SPLAT_SPEED = 14;
const HARD_LANDING = 11.5;
/** Wading: each toy crowding your legs takes this much off your speed, down to WADE_MIN. */
const WADE_SLOW = 0.16;
const WADE_MIN = 0.5;
const DEATH_SCREEN_DELAY = 1.6;

// --- Game over -----------------------------------------------------------------------------------
const LIGHTS_OUT_AT = 1.3;
const TURN_AT = 1.8;
const TURN_TIME = 1.4;
const GAME_OVER_SCREEN_AT = 5.2;

// --- Looks ---------------------------------------------------------------------------------------
const ARCADE: Environment = {
  sunDir: [0.18, 1, 0.32],
  sunColor: [1.75, 1.66, 1.72],
  skyColor: [0.2, 0.14, 0.32],
  groundColor: [0.12, 0.08, 0.18],
  fogColor: [0.05, 0.03, 0.09],
  fogDensity: 0.004,
};
const PORTAL_LIGHT = { pos: [CHUTE_C[0], 1.4, CHUTE_C[2]] as Vec3, color: [1.3, 0.45, 2.1] as Vec3, range: 7 };
const BACKDROP = [0.2, 0.12, 0.4];
const CABINET = [0.07, 0.05, 0.11];
/** The cabinet's ceiling, over the gantry. */
const CEILING_Y = 14;
const GLASS = [0.025, 0.04, 0.08];
const FELT = [0.035, 0.03, 0.13];
const TRIM = [0.78, 0.08, 0.45];
const CHUTE_PAINT = [0.96, 0.74, 0.1];
const CHROME = [0.78, 0.8, 0.84];
const BULB_COLORS: Vec3[] = [[3, 2.6, 1.6], [3, 0.9, 1.9], [0.8, 2.6, 3], [3, 2.4, 0.4]];
const ALIEN_TALK = '#b9ff7a';

const HINT = 'Get under the claw before it comes down, and grab hold (hold E or a mouse button): the claw is rigged, it WILL try to drop you. Let go over the chute.';
const CONTROLS = 'WASD move · Space jump · Hold E or a click to hang on';

/** What the prize flap says when you press E on it. */
const FLAP_QUIPS: [string, string][] = [
  ['PRIZES ONLY', 'The flap opens from the inside. You have to be won first.'],
  ['NICE TRY', 'This is the way out. For prizes. Are you a prize? Not yet.'],
  ['STILL NO', 'Pushing it harder does not make you more of a prize.'],
];

type DeathKind = 'dropped' | 'letgo' | 'gameover';
const DEATHS: Record<DeathKind, { big: string; small: string[]; hint: string }> = {
  dropped: {
    big: 'DROPPED',
    small: [
      'The claw giveth, and the claw droppeth.',
      'Everybody knows the claw is rigged. Now you do too.',
      'Chosen, lifted, returned. No refunds.',
    ],
    hint: HINT,
  },
  letgo: {
    big: 'SPLAT',
    small: [
      'You let go. The floor did not.',
      'Plush toys bounce. You are not a plush toy.',
      'That was not the chute. That was not near the chute.',
    ],
    hint: 'Keep holding on (E or a mouse button) all the way: the claw carries you over the chute and opens by itself.',
  },
  gameover: {
    big: 'LEFT IN THE MACHINE',
    small: [
      'The claw has chosen. It did not choose you.',
      'Out of credits. Out of luck. Still in the machine.',
      'The kid spent his whole allowance on an alien. Again.',
    ],
    hint: HINT,
  },
};

type Phase = 'arrive' | 'coins' | 'move' | 'hover' | 'drop' | 'bottom' | 'close' | 'rise' | 'jiggle' | 'carry' | 'release' | 'rest' | 'over';
/** Phases the gantry motor runs in. */
const WHIRRING = new Set<Phase>(['move', 'drop', 'rise', 'carry']);
/** A cheerful arcade loop. [note, beats]. */
const ARCADE_TUNE: [string | null, number][] = [
  ['E5', 0.5], ['G5', 0.5], ['C6', 0.5], ['G5', 0.5], ['A5', 0.5], ['F5', 0.5], ['D5', 1],
  ['F5', 0.5], ['A5', 0.5], ['D6', 0.5], ['A5', 0.5], ['B5', 0.5], ['G5', 0.5], ['E5', 1],
];

interface Prize extends Plush {
  gone: boolean;
}

/** What the prongs have hold of (the player hanging off a prong isn't held: they're holding on). */
type Held =
  | { kind: 'plush'; prize: Prize; from: Vec3; slips: boolean }
  | { kind: 'player'; from: Vec3 };

/** A line of alien chatter floating over one of them. */
interface Chant {
  prize: Prize | null;
  label: WorldLabel;
  start: number;
  end: number;
  /** Height over the toy (staggered, so neighbours don't talk over each other). */
  lift: number;
}

const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
const rand = (a: number, b: number) => a + Math.random() * (b - a);

export class ClawLevel implements Level {
  readonly number: number;
  readonly title = 'The Claw';
  status: LevelStatus = 'playing';
  private arrival: PortalArrival;
  private t = 0;
  private claw: Claw;
  private prizes: Prize[] = [];
  private look: PlushLook = { eyeGlow: 0 };
  private env: Environment = { ...ARCADE, pointLight: { ...PORTAL_LIGHT } };

  // The kid.
  private phase: Phase = 'arrive';
  private motor = new Drone(120, { wave: 'square', vol: 0.03, wobble: 8 });
  private ditty = new Tune(ARCADE_TUNE, 132, { wave: 'square', vol: 0.035 });
  private phaseT = 0;
  private credits = CREDITS;
  private creditNo = 0;
  private clock = 0;
  private target: [number, number] = [...HOME];
  private decided = false;
  private legPause = 0;
  private nudgeIn = 0;
  private coinsIn = false;
  private grabbedPrizes = 0;
  private dropSpeed = 0;
  private closeFrom = PRONGS_OPEN;
  private closeTo = PRONGS_SHUT;
  private held: Held | null = null;
  /** This credit the kid will change his mind at the last moment; he's doing it right now. */
  private fickle = false;
  private hopping = false;
  /** Where the trolley heads to put the load over the chute. */
  private carryTo: [number, number] = [...HOME];
  /** Something slipped at the last jiggle (for the display). */
  private slipped = false;

  // You.
  /** Hanging on to a prong: which one, and the offset easing in from where you grabbed. */
  private hang: { prong: number; offset: Vec3 } | null = null;
  private wasGrounded = true;
  private lastVy = 0;
  /** How you came to be falling: let go yourself, or dropped by the claw. */
  private fall: 'letgo' | 'dropped' = 'letgo';
  private death: { t: number; kind: DeathKind } | null = null;
  private exiting = -1;
  private gameOverT = -1;
  private turning: { prize: Prize; fromPos: Vec3; toPos: Vec3; fromRot: Quat; toRot: Quat }[] = [];

  // Looks.
  private decor: DrawItem[] = [];
  private bulbs: { item: DrawItem; color: Vec3; i: number }[] = [];
  private chants: Chant[] = [];
  private chantCount = 0;
  private labelList: WorldLabel[] = [];
  private signs: WorldLabel[] = [];
  private creditLabel: WorldLabel = { pos: [0, 8.72, -CHAMBER_HALF + 0.2], text: 'CREDITS 0', size: 0.62, color: '#ff5a36' };
  private statusLabel: WorldLabel = { pos: [0, 8.02, -CHAMBER_HALF + 0.2], text: 'INSERT COIN', size: 0.52, color: '#ffc03a' };
  private statusShown = -1;

  constructor(private ctx: LevelContext) {
    this.number = ctx.number;
    const { physics, hud, camera, player } = ctx;
    hud.setLevel(`The Chamber · Level ${this.number}`);
    hud.show(`LEVEL ${this.number}`, '', 2.5);
    hud.hint('');
    this.arrival = new PortalArrival(ctx, SPAWN);
    // Facing the glass, with the chute and the claw off to the right.
    camera.yaw = -0.45;

    this.claw = new Claw(physics, HOME[0], HOME[1]);
    this.buildChute();
    this.buildDecor();
    // The player's body is out of the way (until the portal spits them out) while the pile settles.
    player.body?.setEnabled(false);
    this.spawnPrizes();

    this.signs = [
      { pos: [0, 7.3, CHAMBER_HALF - 0.15], text: 'THE CLAW', size: 1.7, color: '#ffd23f' },
      { pos: [0, 6.25, CHAMBER_HALF - 0.15], text: 'A game of skill. Allegedly.', size: 0.42, color: '#f3dcff' },
      { pos: [-CHAMBER_HALF + 0.15, 4.2, 0], text: 'WIN EVERY TIME!*', size: 1.0, color: '#7cf0ff' },
      { pos: [-CHAMBER_HALF + 0.15, 3.3, 0], text: '*not every time', size: 0.34, color: '#f3dcff' },
      { pos: [CHAMBER_HALF - 0.15, 3.4, 2], text: 'PLEASE DO NOT TAUNT THE CLAW', size: 0.55, color: '#ff9ad5' },
      { pos: [CHUTE_IN - CHUTE_T - 0.05, 4.05, -CHUTE_IN + CHUTE_T + 0.05], text: 'PRIZES', size: 0.5, color: '#ffd23f' },
      { pos: [CHUTE_IN - CHUTE_T - 0.05, CHUTE_H + 0.75, -10.7], text: 'NO CLIMBING', size: 0.24, color: '#ff4040' },
      this.flapLabel,
      this.creditLabel,
      this.statusLabel,
    ];
  }

  // --- Building ----------------------------------------------------------------------------------

  private buildChute() {
    const { physics } = this.ctx;
    const h = CHUTE_H + GUARD_H;
    const I = CHUTE_IN, T = CHUTE_T, E = CHAMBER_HALF;
    // Two walls (the chamber's own make the other two sides), solid all the way up the guard.
    const west: { pos: Vec3; size: Vec3 } = { pos: [I - T / 2, 0, (-E + (-I + T)) / 2], size: [T, 0, E - I + T] };
    const south: { pos: Vec3; size: Vec3 } = { pos: [(I - T + E) / 2, 0, -I + T / 2], size: [E - I + T, 0, T] };
    for (const w of [west, south]) {
      physics.addStaticBox([w.pos[0], h / 2, w.pos[2]], [w.size[0], h, w.size[2]]);
      // Painted lower wall, a chrome rim, and a clear guard above it.
      this.decor.push({ mesh: 'bevelbox', model: mul(translation([w.pos[0], CHUTE_H / 2, w.pos[2]]), scaling([w.size[0], CHUTE_H, w.size[2]])), color: CHUTE_PAINT, spec: 0.4 });
      this.decor.push({ mesh: 'box', model: mul(translation([w.pos[0], CHUTE_H + 0.03, w.pos[2]]), scaling([w.size[0] + 0.04, 0.08, w.size[2] + 0.04])), color: CHROME, spec: 0.9 });
      const g: Vec3 = [w.size[0] > 1 ? w.size[0] : 0.05, GUARD_H, w.size[2] > 1 ? w.size[2] : 0.05];
      this.decor.push({ mesh: 'box', model: mul(translation([w.pos[0], CHUTE_H + GUARD_H / 2, w.pos[2]]), scaling(g)), color: [0.75, 0.88, 1], spec: 1.2, opacity: 0.3, shadow: false });
      this.decor.push({ mesh: 'box', model: mul(translation([w.pos[0], h, w.pos[2]]), scaling([g[0] + 0.03, 0.05, g[2] + 0.03])), color: CHROME, spec: 0.9 });
    }
    // A dark lining inside, so the portal glows out of a pit.
    this.decor.push({ mesh: 'box', model: mul(translation([CHUTE_C[0], 0.02, CHUTE_C[2]]), scaling([E - I, 0.04, E - I])), color: [0.03, 0.02, 0.05], shadow: false });
    // The prize flap at the front. It only opens from the inside, for prizes; E on it gets a lecture.
    const flapPos: Vec3 = [CHUTE_C[0], 0.55, -I + T + 0.04];
    this.decor.push({ mesh: 'box', model: mul(translation([flapPos[0], flapPos[1], flapPos[2] - 0.02]), scaling([1.16, 0.86, 0.04])), color: CHROME, spec: 0.9 });
    const flapCollider = physics.addStaticBox(flapPos, [1.0, 0.7, 0.08]);
    physics.registerUsable(flapCollider, this.flap);
    this.flapItem = { mesh: 'box', model: mul(translation(flapPos), scaling([1.0, 0.7, 0.05])), color: [0.12, 0.12, 0.14], spec: 0.5 };
    this.flapLabel = { pos: [flapPos[0], flapPos[1] + 0.02, flapPos[2] + 0.06], text: 'PUSH', size: 0.2, color: '#ffffff' };
  }

  /** The prize flap's lectures, in order (then round again). */
  private flapUses = 0;
  private flap = {
    highlight: 0,
    use: () => {
      if (this.death || this.status !== 'playing') return;
      const [big, small] = FLAP_QUIPS[this.flapUses++ % FLAP_QUIPS.length];
      this.ctx.hud.show(big, small, 3);
    },
  };
  private flapItem!: DrawItem;
  private flapLabel!: WorldLabel;

  private buildDecor() {
    const E = CHAMBER_HALF;
    const d = this.decor;
    const top = WALL_HEIGHT - 0.7; // backdrops stop under the marquee trim
    // The prize bed: a felt floor.
    d.push({ mesh: 'box', model: mul(translation([0, 0.004, 0]), scaling([E * 2, 0.02, E * 2])), color: FELT, pattern: Pattern.skin, spec: 0.02, shadow: false });
    // The glass front (north): dark glossy glass, a few soft reflections, and the arcade glowing beyond.
    d.push({ mesh: 'box', model: mul(translation([0, top / 2, -E + 0.03]), scaling([E * 2, top, 0.04])), color: GLASS, spec: 1.4, shadow: false });
    for (const [x, w] of [[-6, 0.5], [-4.6, 0.18], [5.5, 0.35], [7.2, 0.14]]) {
      d.push({ mesh: 'box', model: mul(translation([x, top / 2, -E + 0.06]), rotationZ(0.55), scaling([w, top * 1.2, 0.01])), color: [0.07, 0.085, 0.12], pattern: Pattern.emissive, shadow: false });
    }
    const arcade: Vec3[] = [[0.9, 0.2, 0.5], [0.2, 0.6, 0.9], [0.9, 0.7, 0.2], [0.3, 0.9, 0.4], [0.7, 0.3, 0.9]];
    for (let i = 0; i < 14; i++) {
      const r = rand(0.05, 0.2);
      const c = scale(pick(arcade), rand(0.2, 0.4));
      d.push({ mesh: 'sphere', model: mul(translation([rand(-11, 11), rand(0.8, 5.5), -E + 0.07]), scaling([r, r, 0.01])), color: c, pattern: Pattern.emissive, shadow: false });
    }
    // Starry backdrops on the other three walls, with a ringed planet at the back.
    const walls: { pos: Vec3; size: Vec3; n: Vec3 }[] = [
      { pos: [0, top / 2, E - 0.03], size: [E * 2, top, 0.04], n: [0, 0, -1] },
      { pos: [-E + 0.03, top / 2, 0], size: [0.04, top, E * 2], n: [1, 0, 0] },
      { pos: [E - 0.03, top / 2, 0], size: [0.04, top, E * 2], n: [-1, 0, 0] },
    ];
    for (const w of walls) {
      d.push({ mesh: 'box', model: mul(translation(w.pos), scaling(w.size)), color: BACKDROP, pattern: Pattern.panels, param: 2, spec: 0.1, shadow: false });
      for (let i = 0; i < 16; i++) {
        const along = rand(-E + 0.5, E - 0.5), y = rand(1.5, top - 0.3), r = rand(0.04, 0.11);
        const p: Vec3 = w.n[2] !== 0 ? [along, y, w.pos[2] + w.n[2] * 0.03] : [w.pos[0] + w.n[0] * 0.03, y, along];
        d.push({ mesh: 'sphere', model: mul(translation(p), scaling([r, r, r])), color: [2.2, 2.1, 1.7], pattern: Pattern.emissive, shadow: false });
      }
    }
    d.push({ mesh: 'sphere', model: mul(translation([-6.5, 5.6, E - 0.2]), scaling([1.5, 1.5, 0.6])), color: [0.95, 0.55, 0.22], pattern: Pattern.skin, spec: 0.1, shadow: false });
    d.push({ mesh: 'tube', model: mul(translation([-6.5, 5.6, E - 0.2]), rotationZ(0.35), rotationX(1.25), scaling([2.5, 0.05, 2.5])), color: [0.95, 0.85, 0.55], spec: 0.3, shadow: false });
    // The credits display, over the glass.
    d.push({ mesh: 'bevelbox', model: mul(translation([0, 8.35, -E + 0.1]), scaling([6.4, 1.7, 0.12])), color: [0.02, 0.02, 0.03], spec: 0.8, shadow: false });
    d.push({ mesh: 'box', model: mul(translation([0, 8.35, -E + 0.08]), scaling([6.7, 1.95, 0.06])), color: [2.2, 0.35, 0.9], pattern: Pattern.emissive, shadow: false });
    // The cabinet: dark walls up past the gantry, and a ceiling with fluorescent tubes (the "sun").
    // None of it casts shadows, so the light still gets in.
    const lid = CEILING_Y;
    const upper = lid - WALL_HEIGHT;
    for (const [pos, size] of [
      [[0, WALL_HEIGHT + upper / 2, -E - 0.5], [E * 2 + 2, upper, 1]], [[0, WALL_HEIGHT + upper / 2, E + 0.5], [E * 2 + 2, upper, 1]],
      [[-E - 0.5, WALL_HEIGHT + upper / 2, 0], [1, upper, E * 2 + 2]], [[E + 0.5, WALL_HEIGHT + upper / 2, 0], [1, upper, E * 2 + 2]],
    ] as [Vec3, Vec3][]) {
      d.push({ mesh: 'box', model: mul(translation(pos), scaling(size)), color: CABINET, pattern: Pattern.panels, param: 2, spec: 0.2, shadow: false });
    }
    d.push({ mesh: 'box', model: mul(translation([0, lid + 0.25, 0]), scaling([E * 2 + 2, 0.5, E * 2 + 2])), color: CABINET, pattern: Pattern.panels, param: 3, spec: 0.1, shadow: false });
    for (const x of [-8, -2.7, 2.7, 8]) {
      d.push({ mesh: 'box', model: mul(translation([x, lid - 0.05, 0]), scaling([0.5, 0.1, E * 2 - 3])), color: [0.25, 0.25, 0.3], shadow: false });
      d.push({ mesh: 'cylinder', model: mul(translation([x, lid - 0.14, 0]), rotationX(Math.PI / 2), scaling([0.12, E * 2 - 3.4, 0.12])), color: [2.6, 2.55, 2.8], pattern: Pattern.emissive, shadow: false });
    }
    // Marquee trim and chasing bulbs along the top of every wall, and chrome posts in the corners.
    const bandY = WALL_HEIGHT - 0.42;
    for (const [pos, size] of [
      [[0, bandY, -E + 0.08], [E * 2, 0.55, 0.12]], [[0, bandY, E - 0.08], [E * 2, 0.55, 0.12]],
      [[-E + 0.08, bandY, 0], [0.12, 0.55, E * 2]], [[E - 0.08, bandY, 0], [0.12, 0.55, E * 2]],
    ] as [Vec3, Vec3][]) {
      d.push({ mesh: 'box', model: mul(translation(pos), scaling(size)), color: TRIM, spec: 0.5, shadow: false });
    }
    let n = 0;
    for (let k = -E + 0.6; k <= E - 0.5; k += 1.0) {
      for (const p of [[k, bandY, -E + 0.16], [k, bandY, E - 0.16], [-E + 0.16, bandY, k], [E - 0.16, bandY, k]] as Vec3[]) {
        const item: DrawItem = { mesh: 'sphere', model: mul(translation(p), scaling([0.11, 0.11, 0.11])), color: [1, 1, 1], pattern: Pattern.emissive, shadow: false };
        this.bulbs.push({ item, color: BULB_COLORS[n % BULB_COLORS.length], i: n });
        n++;
      }
    }
    for (const x of [-1, 1]) for (const z of [-1, 1]) {
      d.push({ mesh: 'cylinder', model: mul(translation([x * (E - 0.12), WALL_HEIGHT / 2, z * (E - 0.12)]), scaling([0.14, WALL_HEIGHT, 0.14])), color: [0.25, 0.2, 0.3], spec: 0.6 });
    }
  }

  /** The pile: heaps of plush toys, mostly aliens. */
  private spawnPrizes() {
    const bag: PlushKind[] = [];
    const add1 = (k: PlushKind, n: number) => { for (let i = 0; i < n; i++) bag.push(k); };
    add1('alien', 28);
    add1('teddy', 10);
    add1('duck', 6);
    add1('ball', 4);
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    const spots: Vec3[] = [];
    for (const [hx, hz, count] of HEAPS) {
      for (let i = 0; i < count; i++) {
        const a = rand(0, Math.PI * 2), r = rand(0, 0.7);
        spots.push([hx + Math.cos(a) * r, 0.7 + i * 0.8, hz + Math.sin(a) * r]);
      }
    }
    while (spots.length < bag.length) {
      const p: Vec3 = [rand(-10.5, 10.5), 0.7, rand(-10.5, 10.5)];
      if (distXZ(p, SPAWN) < 3.5 || this.nearChute(p[0], p[2])) continue;
      spots.push(p);
    }
    const { physics } = this.ctx;
    bag.forEach((kind, i) => {
      const plush = spawnPlush(physics, kind, spots[i], this.look, randomRotation());
      this.prizes.push({ ...plush, gone: false });
    });

    // Let them settle into heaps before anyone sees them: dropped into bins, which are then
    // taken away so the heaps slump. The chamber's own colliders only go in after the level is
    // built, so stand in temporary ones for those too.
    const E = CHAMBER_HALF;
    const room = [
      physics.addStaticBox([0, -0.5, 0], [E * 2 + 2, 1, E * 2 + 2]),
      physics.addStaticBox([0, 5, -E - 0.5], [E * 2 + 2, 10, 1]),
      physics.addStaticBox([0, 5, E + 0.5], [E * 2 + 2, 10, 1]),
      physics.addStaticBox([-E - 0.5, 5, 0], [1, 10, E * 2 + 2]),
      physics.addStaticBox([E + 0.5, 5, 0], [1, 10, E * 2 + 2]),
    ];
    const bins = HEAPS.flatMap(([x, z]) => {
      const h = HEAP_BIN / 2 + 0.1;
      return [
        physics.addStaticBox([x - h, 3, z], [0.2, 6, HEAP_BIN]),
        physics.addStaticBox([x + h, 3, z], [0.2, 6, HEAP_BIN]),
        physics.addStaticBox([x, 3, z - h], [HEAP_BIN, 6, 0.2]),
        physics.addStaticBox([x, 3, z + h], [HEAP_BIN, 6, 0.2]),
      ];
    });
    // Thick with damping while they settle, so they come to rest in piles (and fall asleep there).
    for (const p of this.prizes) {
      p.body.rb.setAngularDamping(12);
      p.body.rb.setLinearDamping(2);
    }
    for (let i = 0; i < 240; i++) physics.world.step();
    for (const c of bins) physics.world.removeCollider(c, true); // wake anything leaning on them
    for (let i = 0; i < 240; i++) physics.world.step();
    for (const c of room) physics.world.removeCollider(c, false);
    for (const p of this.prizes) {
      p.body.rb.setAngularDamping(p.body.angularDamping);
      p.body.rb.setLinearDamping(0);
    }
  }

  // --- The kid and the claw ------------------------------------------------------------------------

  private setPhase(p: Phase) {
    this.phase = p;
    this.phaseT = 0;
    if (p === 'coins') for (let k = 0; k < 2; k++) {
      tone(1760, 0.1, { wave: 'triangle', vol: 0.15, at: k * 0.4 });
      tone(2637, 0.25, { wave: 'triangle', vol: 0.1, at: k * 0.4 + 0.06 });
    }
    if (p === 'close') {
      sfx.thud(0.35);
      noise(0.15, { freq: 2500, to: 900, type: 'bandpass', q: 3, vol: 0.25 });
    }
    if (p === 'release') noise(0.2, { freq: 3000, to: 1200, type: 'bandpass', q: 4, vol: 0.25 });
  }

  private startCredit() {
    this.credits--;
    this.creditNo++;
    this.clock = CREDIT_TIME;
    this.decided = false;
    this.slipped = false;
    this.fickle = this.creditNo >= 2 && Math.random() < FICKLE;
    this.hopping = false;
    this.legPause = rand(0.2, 0.6);
    this.wander();
    this.setPhase('move');
  }

  /** Somewhere, anywhere: the kid hasn't made up his mind. */
  private wander() {
    for (let tries = 0; tries < 20; tries++) {
      const x = rand(-8.5, 8.5), z = rand(-8.5, 8.5);
      if (Math.abs(x - this.claw.x) + Math.abs(z - this.claw.z) < 4) continue;
      this.target = [x, z];
      return;
    }
    this.target = [0, 0];
  }

  /** The kid picks what to go for: usually an alien, sometimes (more so each credit) wherever you are. */
  private decide() {
    this.decided = true;
    const { player } = this.ctx;
    const aimAtYou = Math.random() < AIM_AT_PLAYER[Math.min(this.creditNo - 1, AIM_AT_PLAYER.length - 1)];
    let spot: [number, number] | null = null;
    if (aimAtYou && player.mode === 'control') {
      const a = rand(0, Math.PI * 2), r = rand(0.3, 1.1);
      spot = [player.pos[0] + Math.cos(a) * r, player.pos[2] + Math.sin(a) * r];
    } else {
      const options = this.prizes.filter((p) => !p.gone && (p.kind === 'alien' || Math.random() < 0.3) && !this.nearChute(p.body.rb.translation().x, p.body.rb.translation().z));
      if (options.length) {
        const t = pick(options).body.rb.translation();
        spot = [t.x + rand(-0.25, 0.25), t.z + rand(-0.25, 0.25)];
      }
    }
    if (!spot) spot = [rand(-8, 8), rand(-8, 8)];
    spot = [clamp(spot[0], -CLAW_LIMIT, CLAW_LIMIT), clamp(spot[1], -CLAW_LIMIT, CLAW_LIMIT)];
    if (this.nearChute(spot[0], spot[1])) spot = [Math.min(spot[0], CHUTE_KEEP_OUT - 0.5), spot[1]];
    // Close enough to get there with time to spare over it.
    const travel = Math.max(Math.abs(spot[0] - this.claw.x), Math.abs(spot[1] - this.claw.z)) / 3.2 + 1;
    const spare = this.clock - MIN_HOVER;
    if (travel > spare) {
      const k = clamp(spare / travel, 0.2, 1);
      spot = [this.claw.x + (spot[0] - this.claw.x) * k, this.claw.z + (spot[1] - this.claw.z) * k];
    }
    this.target = spot;
  }

  private nearChute(x: number, z: number) {
    return x > CHUTE_KEEP_OUT && z < -CHUTE_KEEP_OUT;
  }

  private updateClaw(dt: number) {
    const claw = this.claw;
    const { player, camera } = this.ctx;
    switch (this.phase) {
      case 'arrive':
        if (this.arrival.done) this.setPhase('coins');
        break;
      case 'coins':
        if (!this.coinsIn && this.phaseT > COINS_AT) {
          this.coinsIn = true;
          this.chorus(['Ooooh!', 'Ooooh!', 'A customer!'], 3, null);
        }
        if (this.phaseT > FIRST_CREDIT_AT) this.startCredit();
        break;
      case 'move': {
        this.clock -= dt;
        if (!this.decided && this.clock <= DECIDE_AT) this.decide();
        if (this.legPause > 0) {
          this.legPause -= dt;
          claw.driveTo(claw.x, claw.z, dt);
        } else if (claw.driveTo(this.target[0], this.target[1], dt)) {
          if (this.decided) {
            this.nudgeIn = rand(0.8, 1.5);
            this.setPhase('hover');
          } else {
            this.legPause = rand(0.2, 0.7);
            this.wander();
          }
        }
        if (this.clock <= 0) this.startDrop();
        break;
      }
      case 'hover': {
        this.clock -= dt;
        // Fine-tuning: little nudges while there's time, then dead still for the last couple of seconds.
        this.nudgeIn -= dt;
        if (this.nudgeIn <= 0 && this.clock > 2.2) {
          this.nudgeIn = rand(0.9, 1.6);
          this.target = [
            clamp(this.target[0] + rand(-0.5, 0.5), -CLAW_LIMIT, CLAW_LIMIT),
            clamp(this.target[1] + rand(-0.5, 0.5), -CLAW_LIMIT, CLAW_LIMIT),
          ];
        }
        // Now and then the kid changes his mind at the last moment: a quick hop to one side.
        if (this.fickle && this.clock <= SWITCH_AT) {
          this.fickle = false;
          const a = rand(0, Math.PI * 2), r = rand(2, 3.2);
          this.target = [clamp(this.target[0] + Math.cos(a) * r, -CLAW_LIMIT, CLAW_LIMIT), clamp(this.target[1] + Math.sin(a) * r, -CLAW_LIMIT, CLAW_LIMIT)];
          if (this.nearChute(this.target[0], this.target[1])) this.target[0] = CHUTE_KEEP_OUT - 0.5;
          this.hopping = true;
          this.chorusNear(claw.hub(), ['Ooooh?', 'It moves!', 'Ooooh!'], 3);
        }
        const arrived = claw.driveTo(this.target[0], this.target[1], dt, this.hopping ? 3.2 : 1.5);
        if (arrived) this.hopping = false;
        if (this.clock <= 0) this.startDrop();
        break;
      }
      case 'drop': {
        claw.driveTo(claw.x, claw.z, dt);
        this.dropSpeed = Math.min(DROP_SPEED, this.dropSpeed + DROP_ACCEL * dt);
        claw.y -= this.dropSpeed * dt;
        // Down until the open tips sink into whatever is below, or the hub meets a head.
        const hub = claw.hub();
        const hit = this.ctx.physics.raycast(hub, [0, -1, 0], 20, claw.collider);
        const surface = hit ? hit.point[1] : 0;
        // Tips sink a little into a soft toy, and just touch a hard floor.
        const soft = hit ? this.ctx.physics.bodyFor(hit.collider) !== undefined : false;
        let stop = Math.max(surface + TIP_DEPTH - (soft ? SINK : 0.05), 1.1);
        let bonk = false;
        if (player.mode === 'control' && !player.inPortal && !this.death && distXZ(player.pos, hub) < 0.5) {
          const head = player.pos[1] + HEAD_TOP + HUB_BOTTOM;
          if (head > stop) {
            stop = head;
            bonk = true;
          }
        }
        if (this.hang) stop = claw.y; // it feels the weight and stops
        if (claw.y <= stop) {
          claw.y = stop;
          if (bonk) {
            // Straight on the head: it knocks you silly (and you're right where it grabs).
            const away = sub(player.pos, hub);
            player.knock([away[0] * 2, -2, away[2] * 2], 1.3);
            camera.addShake(0.6);
          } else {
            camera.addShake(0.25);
          }
          this.setPhase('bottom');
        }
        break;
      }
      case 'bottom':
        claw.driveTo(claw.x, claw.z, dt);
        if (this.phaseT >= BOTTOM_PAUSE) this.startClose();
        break;
      case 'close': {
        const k = easeInOut(clamp(this.phaseT / CLOSE_TIME, 0, 1));
        claw.angle = this.closeFrom + (this.closeTo - this.closeFrom) * k;
        if (this.phaseT >= CLOSE_TIME) this.setPhase('rise');
        break;
      }
      case 'rise':
        claw.y = Math.min(CLAW_TOP, claw.y + RISE_SPEED * dt);
        if (claw.y >= CLAW_TOP) {
          this.setPhase('jiggle');
          this.slipped = false;
        }
        break;
      case 'jiggle': {
        // The rigged bit: a shudder, the grip goes weak, and prizes fall out.
        const t = this.phaseT;
        const env = Math.sin(Math.PI * clamp(t / JIGGLE_TIME, 0, 1));
        claw.shake = [Math.sin(t * 43) * 0.14 * env, Math.sin(t * 31) * 0.05 * env, Math.sin(t * 37 + 1) * 0.12 * env];
        const weak = clamp((t - SLIP_AT + 0.25) / 0.25, 0, 1) * clamp((SLIP_AT + 0.6 - t) / 0.3, 0, 1);
        claw.angle = this.closeTo + (Math.min(PRONGS_OPEN, this.closeTo + 0.35) - this.closeTo) * weak;
        if (this.hang) camera.addShake(0.35);
        if (t >= SLIP_AT && this.held) this.slip();
        if (t >= JIGGLE_TIME) {
          claw.shake = [0, 0, 0];
          if (!this.held) {
            this.closeTo = this.hang ? claw.angleFor(0.32) : PRONGS_SHUT;
            claw.angle = this.closeTo;
          }
          const hub = claw.hub();
          this.carryTo = this.hang
            ? [clamp(HOME[0] - (player.pos[0] - hub[0]), -11, 11), clamp(HOME[1] - (player.pos[2] - hub[2]), -11, 11)]
            : [...HOME];
          this.setPhase('carry');
        }
        break;
      }
      case 'carry': {
        // Back to the chute. With someone hanging off a prong, line *them* up over it (their
        // offset from the hub is fixed once the claw is shut; the cable swing comes and goes).
        claw.driveTo(this.carryTo[0], this.carryTo[1], dt, 3.6);
        const near = Math.abs(claw.x - this.carryTo[0]) + Math.abs(claw.z - this.carryTo[1]) < 0.12;
        if (near && Math.abs(claw.vx) + Math.abs(claw.vz) < 0.3 && this.phaseT > 0.5) this.setPhase('release');
        break;
      }
      case 'release': {
        claw.driveTo(claw.x, claw.z, dt);
        const k = easeInOut(clamp(this.phaseT / 0.5, 0, 1));
        claw.angle = this.closeTo + (PRONGS_OPEN - this.closeTo) * k;
        // Whoever's hanging on drops straight away; prizes once the prongs are open a little.
        if (this.hang) this.letGo([0, -0.5, 0]);
        if (this.phaseT >= 0.15) this.letGoOfEverything();
        if (this.phaseT >= RELEASE_TIME) this.setPhase('rest');
        break;
      }
      case 'rest':
        claw.driveTo(HOME[0], HOME[1], dt);
        if (this.phaseT >= REST_TIME && !this.death && this.exiting < 0) {
          if (this.credits > 0) this.startCredit();
          else this.startGameOver();
        }
        break;
      case 'over':
        claw.driveTo(HOME[0], HOME[1], dt);
        break;
    }
  }

  private startDrop() {
    this.clock = 0;
    this.dropSpeed = 0;
    this.setPhase('drop');
    this.chorusNear(this.claw.hub(), ['Ooooh...', 'The claaaw!', 'Ooooooh!', pick(['Reach for the claaaw!', 'It comes!', 'Ooooh...'])], 4);
  }

  /** Picks what the prongs close on: whatever's nearest the middle, you included. */
  private startClose() {
    const claw = this.claw;
    const { player } = this.ctx;
    const hub = claw.hub();
    this.closeFrom = claw.angle;
    this.held = null;
    if (!this.hang) {
      let bestD = GRAB_R;
      let best: Held | null = null;
      if (player.mode === 'control' && !player.inPortal && !this.death) {
        const d = distXZ(player.pos, hub);
        const head = player.pos[1] + HEAD_TOP;
        if (d < bestD && head > claw.y - TIP_DEPTH - 0.3 && player.pos[1] < claw.y) {
          best = { kind: 'player', from: [...player.pos] };
          bestD = d - 0.2;
        }
      }
      for (const prize of this.prizes) {
        if (prize.gone) continue;
        const t = prize.body.rb.translation();
        const d = Math.hypot(t.x - hub[0], t.z - hub[2]);
        if (d < bestD && t.y < claw.y - 0.2 && t.y > claw.y - TIP_DEPTH - prize.radius - 0.2) {
          best = { kind: 'plush', prize, from: [t.x, t.y, t.z], slips: Math.random() < (this.grabbedPrizes === 0 ? FIRST_SLIP : SLIP) };
          bestD = d;
        }
      }
      this.held = best;
    }
    const held = this.held;
    if (held?.kind === 'plush') {
      this.grabbedPrizes++;
      held.prize.body.rb.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
      this.closeTo = claw.angleFor(held.prize.radius * 0.75);
      if (held.prize.kind === 'alien') {
        this.say(held.prize, 'I have been chosen!', 0, 3);
        this.chorusNear(hub, ['Ooooh!', 'He has been chosen!', 'Ooooh!'], 3, held.prize);
      } else {
        this.chorusNear(hub, ['Ooooh!', 'Not the bear...', 'Ooooh!'], 3);
      }
    } else if (held?.kind === 'player') {
      player.mode = 'held';
      player.vel = [0, 0, 0];
      this.closeTo = claw.angleFor(0.3);
      this.chorusNear(hub, ['Ooooh!', 'A stranger!', 'Ooooh...'], 3);
    } else {
      this.closeTo = this.hang ? claw.angleFor(0.32) : PRONGS_SHUT;
      if (this.hang) this.chorusNear(hub, ['Ooooh!', 'A volunteer!', 'Ooooh!'], 3);
    }
    this.setPhase('close');
  }

  /** The jiggle: prizes (usually) and grabbed players (always) slip out. */
  private slip() {
    const held = this.held;
    if (!held) return;
    const { player } = this.ctx;
    const v = this.claw.velocity();
    if (held.kind === 'plush') {
      if (!held.slips) return;
      this.dropPrize(held.prize, add(v, [rand(-1.2, 1.2), rand(-0.5, 0.5), rand(-1.2, 1.2)]));
      this.chorusNear(held.prize.body.rb.translation(), ['Awww...', 'Awww!', 'Nooo...'], 3, held.prize);
    } else {
      player.resume([v[0] + rand(-0.8, 0.8), -0.5, v[2] + rand(-0.8, 0.8)]);
      this.fall = 'dropped';
      this.lastVy = -0.5;
      this.chorusNear(player.pos, ['Awww...', 'Uh oh.', 'Awww!'], 3);
    }
    this.held = null;
    this.slipped = true;
  }

  private dropPrize(prize: Prize, vel: Vec3) {
    const rb = prize.body.rb;
    rb.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    rb.setLinvel({ x: vel[0], y: vel[1], z: vel[2] }, true);
    rb.setAngvel({ x: rand(-4, 4), y: rand(-4, 4), z: rand(-4, 4) }, true);
  }

  /** Over the chute: the prongs open, and whatever's in them (or hanging off them) drops. */
  private letGoOfEverything() {
    const held = this.held;
    if (held?.kind === 'plush') this.dropPrize(held.prize, [0, -1, 0]);
    else if (held?.kind === 'player') {
      this.ctx.player.resume([0, -0.5, 0]);
      this.fall = 'dropped';
    }
    this.held = null;
    if (this.hang) this.letGo([0, -0.5, 0]);
  }

  /** Moves whatever the prongs hold along with the claw. */
  private carryHeld() {
    const held = this.held;
    if (!held) return;
    const claw = this.claw;
    const closing = this.phase === 'close' ? easeInOut(clamp(this.phaseT / CLOSE_TIME, 0, 1)) : 1;
    if (held.kind === 'plush') {
      const p = lerp3(held.from, claw.gripPoint(), closing);
      held.prize.body.rb.setNextKinematicTranslation({ x: p[0], y: p[1], z: p[2] });
    } else {
      const player = this.ctx.player;
      player.pos = lerp3(held.from, sub(claw.hub(), [0, GRIPPED, 0]), closing);
      player.pos[1] = Math.max(player.pos[1], held.from[1]); // not through the floor before it lifts
      player.vel = [0, 0, 0];
    }
  }

  // --- Hanging on -----------------------------------------------------------------------------------

  /** Hold E or a mouse button with your hands near the claw (while it's down) to hang on to a prong. */
  private updateHang(dt: number) {
    const { player, input } = this.ctx;
    const holding = input.actionDown;
    const claw = this.claw;
    if (this.hang) {
      if (!holding || this.death) {
        this.letGo(add(claw.velocity(), [0, -0.3, 0]));
        return;
      }
      // Up top, kick your legs (WASD) to swing the claw about a bit. It doesn't get you anywhere.
      const yaw = this.ctx.camera.yaw;
      const fwd = (input.isDown('KeyW') ? 1 : 0) - (input.isDown('KeyS') ? 1 : 0);
      const side = (input.isDown('KeyD') ? 1 : 0) - (input.isDown('KeyA') ? 1 : 0);
      if ((fwd || side) && claw.y > CLAW_TOP - 3) {
        const k = PUMP * dt;
        claw.nudge([(-Math.sin(yaw) * fwd + Math.cos(yaw) * side) * k, 0, (-Math.cos(yaw) * fwd - Math.sin(yaw) * side) * k]);
      }
      this.placeHanger(dt);
      return;
    }
    if (!holding || player.mode !== 'control' || player.inPortal || this.death || this.gameOverT >= 0) return;
    if (claw.y > CLAW_TOP - 0.3) return;
    const hands = add(player.pos, [0, HANDS, 0]);
    if (claw.distanceTo(hands) > REACH) return;
    const prong = claw.nearestProng(hands);
    this.hang = { prong, offset: sub(player.pos, this.hangSpot(prong)) };
    claw.nudge(scale([player.vel[0], 0, player.vel[2]], GRAB_SWING));
    player.mode = 'swinging';
    player.vel = [0, 0, 0];
    this.fall = 'letgo';
    this.placeHanger(0);
  }

  /** Where your feet go when you hang off prong `i`: hands on its knuckle, body just outside it. */
  private hangSpot(i: number): Vec3 {
    const knuckle = this.claw.prong(i)[1];
    const out = this.claw.prongOut(i);
    return add(add(knuckle, scale(out, HANG_OUT)), [0, -HANDS, 0]);
  }

  private placeHanger(dt: number) {
    const hang = this.hang!;
    const player = this.ctx.player;
    // Ease from where you grabbed on to the proper spot.
    const k = 1 - Math.exp(-dt * 7);
    hang.offset = scale(hang.offset, 1 - k);
    const spot = add(this.hangSpot(hang.prong), hang.offset);
    spot[1] = Math.max(spot[1], 0.02); // standing on the floor until it lifts you
    player.pos = spot;
    player.vel = [0, 0, 0];
    const out = this.claw.prongOut(hang.prong);
    player.facing = Math.atan2(out[0], out[2]);
  }

  private letGo(vel: Vec3) {
    this.hang = null;
    const player = this.ctx.player;
    if (player.mode === 'swinging') {
      player.resume(vel);
      this.lastVy = vel[1];
      this.wasGrounded = false;
    }
  }

  // --- Update ------------------------------------------------------------------------------------

  update(dt: number) {
    const playing = this.status === 'playing' && !this.death;
    if (playing && this.phase !== 'arrive') this.ditty.start();
    else this.ditty.stop();
    if (playing && WHIRRING.has(this.phase)) this.motor.start();
    else this.motor.stop();
    this.t += dt;
    this.phaseT += dt;
    this.arrival.update(dt);

    this.updateClaw(dt);
    this.claw.update(dt);
    this.carryHeld();
    this.updateHang(dt);
    this.checkChute();
    this.checkLanding();
    this.wade(dt);
    this.updateGameOver(dt);
    this.updateLooks();

    if (this.exiting >= 0) {
      this.exiting += dt;
      if (this.exiting >= PORTAL_SQUEEZE_TIME && this.status === 'playing') this.status = 'exited';
    }
    const death = this.death;
    if (death && this.status === 'playing') {
      death.t += dt;
      const wait = death.kind === 'gameover' ? 0 : DEATH_SCREEN_DELAY;
      if (death.t > wait) {
        const d = DEATHS[death.kind];
        this.status = 'lost';
        this.ctx.hud.show(d.big, `${pick(d.small)}\nPress R to try again.`);
        this.ctx.hud.tips([['Hint', d.hint], ['Controls', CONTROLS]]);
      }
    }
  }

  /** Prizes and players that make it into the chute go through the portal at the bottom. */
  private checkChute() {
    const { player, physics } = this.ctx;
    const inside = (x: number, y: number, z: number) => x > CHUTE_IN && z < -CHUTE_IN && y < CHUTE_H + 0.3;
    for (const prize of this.prizes) {
      if (prize.gone || (this.held?.kind === 'plush' && this.held.prize === prize)) continue;
      const t = prize.body.rb.translation();
      if (!inside(t.x, t.y, t.z)) continue;
      prize.gone = true;
      physics.remove(prize.body);
      this.chorusNear(CHUTE_C, prize.kind === 'alien' ? ['Farewell, friend!', 'He goes to a better place.', 'Ooooh...'] : ['Ooooh...', 'Bye, bear.', 'Ooooh!'], 3);
    }
    if (this.exiting < 0 && player.mode === 'control' && !player.inPortal && !this.death && inside(player.pos[0], player.pos[1] + 0.9, player.pos[2])) {
      player.shrinkInto([CHUTE_C[0], PORTAL_Y + 0.2, CHUTE_C[2]], PORTAL_SQUEEZE_TIME);
      this.exiting = 0;
      this.chorusNear(CHUTE_C, ['Ooooh!', 'Farewell, stranger!', 'Ooooh!'], 3);
    }
  }

  /** Hard landings knock you down; falls from the claw's height kill. */
  private checkLanding() {
    const { player, camera } = this.ctx;
    if (player.mode !== 'control' || player.inPortal) {
      this.wasGrounded = true;
      this.lastVy = 0;
      return;
    }
    if (this.arrival.done && !this.death && player.onGround && !this.wasGrounded) {
      const speed = -this.lastVy;
      if (speed > SPLAT_SPEED) {
        player.kill([rand(-1, 1), 2.5, rand(-1, 1)], { violence: 16 + (speed - SPLAT_SPEED) * 1.5, origin: player.pos });
        camera.addShake(0.8);
        this.die(this.fall);
      } else if (speed > HARD_LANDING) {
        player.knock([0, -1, 0], 0.7);
        camera.addShake(0.3);
      }
    }
    this.wasGrounded = player.onGround;
    this.lastVy = player.vel[1];
  }

  /** Every toy crowding your legs slows you down. */
  private wade(dt: number) {
    const { player } = this.ctx;
    if (player.mode !== 'control') return;
    let crowd = 0;
    for (const prize of this.prizes) {
      if (prize.gone) continue;
      const t = prize.body.rb.translation();
      if (t.y > player.pos[1] + 1.3 || t.y < player.pos[1] - 0.3) continue;
      if (Math.hypot(t.x - player.pos[0], t.z - player.pos[2]) < prize.radius + 0.5) crowd++;
    }
    const want = clamp(1 - crowd * WADE_SLOW, WADE_MIN, 1);
    player.speedScale += (want - player.speedScale) * Math.min(1, dt * 6);
  }

  private die(kind: DeathKind) {
    this.ctx.hud.hide();
    this.death = { t: 0, kind };
  }

  // --- Game over -----------------------------------------------------------------------------------

  private startGameOver() {
    this.setPhase('over');
    this.gameOverT = 0;
  }

  private updateGameOver(dt: number) {
    if (this.gameOverT < 0) return;
    const { player, camera } = this.ctx;
    const before = this.gameOverT;
    this.gameOverT += dt;
    const t = this.gameOverT;
    const passed = (at: number) => before < at && t >= at;
    if (passed(LIGHTS_OUT_AT)) {
      // Clunk.
      this.env.sunColor = [0, 0, 0];
      this.env.skyColor = [0.012, 0.01, 0.02];
      this.env.groundColor = [0.008, 0.006, 0.012];
      this.env.fogColor = [0.004, 0.003, 0.008];
      camera.addShake(0.2);
    }
    if (passed(TURN_AT)) {
      // Every alien turns to look at you.
      this.look.eyeGlow = 1;
      for (const prize of this.prizes) {
        if (prize.gone || prize.kind !== 'alien') continue;
        const rb = prize.body.rb;
        const p = rb.translation();
        const yaw = Math.atan2(-(player.pos[0] - p.x), -(player.pos[2] - p.z));
        rb.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
        const r = rb.rotation();
        this.turning.push({
          prize,
          fromPos: [p.x, p.y, p.z],
          toPos: [p.x, Math.max(p.y, 0.56), p.z],
          fromRot: { x: r.x, y: r.y, z: r.z, w: r.w },
          toRot: { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) },
        });
      }
    }
    if (this.turning.length) {
      const k = easeInOut(clamp((t - TURN_AT) / TURN_TIME, 0, 1));
      for (const turn of this.turning) {
        const p = lerp3(turn.fromPos, turn.toPos, k);
        const q = quatSlerp(turn.fromRot, turn.toRot, k);
        turn.prize.body.rb.setNextKinematicTranslation({ x: p[0], y: p[1], z: p[2] });
        turn.prize.body.rb.setNextKinematicRotation(q);
      }
    }
    if (passed(TURN_AT + TURN_TIME + 0.4)) this.chorusNear(player.pos, ['One of us.', 'One of us.', 'One of us!', 'Stay.'], 4);
    if (passed(GAME_OVER_SCREEN_AT) && !this.death && this.exiting < 0) this.die('gameover');
  }

  // --- Looks ---------------------------------------------------------------------------------------

  private updateLooks() {
    // Chasing marquee lights (dark once it's game over and the power's off).
    const lightsOn = this.gameOverT < LIGHTS_OUT_AT;
    const step = Math.floor(this.t * 7);
    const excited = this.phase === 'drop' || this.phase === 'jiggle';
    for (const b of this.bulbs) {
      const lit = lightsOn && (excited ? (step + (b.i >> 2)) % 2 === 0 : ((b.i >> 2) + step) % 3 !== 0);
      const c = b.item.color as number[];
      const k = lit ? 1 : lightsOn ? 0.12 : 0.02;
      c[0] = b.color[0] * k;
      c[1] = b.color[1] * k;
      c[2] = b.color[2] * k;
    }
    this.updateDisplay();
  }

  private updateDisplay() {
    const blink = Math.floor(this.t * 2.5) % 2 === 0;
    let credits: string, status: string;
    if (this.gameOverT >= 0) {
      credits = 'GAME OVER';
      status = blink ? 'INSERT COIN' : '';
    } else if (this.exiting >= 0) {
      credits = `CREDITS ${this.credits}`;
      status = blink ? 'WINNER!' : '';
    } else {
      credits = `CREDITS ${this.coinsIn ? this.credits : 0}`;
      switch (this.phase) {
        case 'arrive':
        case 'coins':
          status = this.coinsIn ? 'READY?' : blink ? 'INSERT COIN' : '';
          break;
        case 'move':
        case 'hover': {
          const secs = Math.max(0, Math.ceil(this.clock));
          if (secs !== this.statusShown) {
            this.statusShown = secs;
            this.statusLabel.text = `TIME ${secs < 10 ? '0' : ''}${secs}`;
          }
          return this.setCredits(credits);
        }
        case 'drop':
        case 'bottom':
        case 'close':
        case 'rise':
          status = 'GOOD LUCK!';
          break;
        case 'jiggle':
          status = this.slipped ? 'SO CLOSE!' : 'HOLD ON...';
          break;
        default:
          status = this.slipped ? 'TRY AGAIN!' : this.credits > 0 ? 'NICE ONE!' : 'LAST TRY...';
      }
    }
    this.statusShown = -1;
    this.statusLabel.text = status;
    this.setCredits(credits);
  }

  private setCredits(text: string) {
    this.creditLabel.text = text;
    this.statusLabel.color = this.gameOverT >= 0 ? '#ff3a3a' : '#ffc03a';
  }

  /** One alien says something. */
  private say(prize: Prize | null, text: string, delay: number, duration: number) {
    // The same alien again takes back its own line; otherwise a free slot, a new one, or the oldest.
    let slot = this.chants.find((c) => c.prize === prize && c.end >= this.t) ?? this.chants.find((c) => c.end < this.t);
    if (!slot) {
      if (this.chants.length < 10) {
        slot = { prize: null, label: { pos: [0, 0, 0], text: '', size: 0.28, color: ALIEN_TALK }, start: 0, end: 0, lift: 0 };
        this.chants.push(slot);
      } else {
        slot = this.chants.reduce((a, b) => (a.end < b.end ? a : b));
      }
    }
    slot.lift = 0.9 + (this.chantCount++ % 3) * 0.22;
    slot.prize = prize;
    slot.label.text = text;
    slot.start = this.t + delay;
    slot.end = this.t + delay + duration;
  }

  /** The aliens nearest `where` chime in, one after another. */
  private chorusNear(where: Vec3 | { x: number; y: number; z: number }, lines: string[], count: number, except?: Prize) {
    const w: Vec3 = Array.isArray(where) ? where : [where.x, where.y, where.z];
    const aliens = this.prizes
      .filter((p) => !p.gone && p.kind === 'alien' && p !== except && (this.held?.kind !== 'plush' || this.held.prize !== p))
      .map((p) => ({ p, d: distXZ(vec(p), w) }))
      .filter((a) => a.d < 9)
      .sort((a, b) => a.d - b.d)
      .slice(0, count);
    aliens.forEach(({ p }, i) => this.say(p, lines[i % lines.length], 0.25 + i * 0.35, 2.4));
  }

  /** A few aliens anywhere in the pile. */
  private chorus(lines: string[], count: number, except: Prize | null) {
    const aliens = this.prizes.filter((p) => !p.gone && p.kind === 'alien' && p !== except);
    for (let i = 0; i < count && aliens.length; i++) {
      const j = Math.floor(Math.random() * aliens.length);
      this.say(aliens.splice(j, 1)[0], lines[i % lines.length], 0.2 + i * 0.4, 2.2);
    }
  }

  labels(): WorldLabel[] {
    const list = this.labelList;
    list.length = 0;
    for (const s of this.signs) list.push(s);
    for (const c of this.chants) {
      if (this.t < c.start || this.t > c.end || !c.prize || c.prize.gone) continue;
      const t = c.prize.body.rb.translation();
      c.label.pos[0] = t.x;
      c.label.pos[1] = t.y + c.lift + Math.sin((this.t - c.start) * 5) * 0.04;
      c.label.pos[2] = t.z;
      list.push(c.label);
    }
    return list;
  }

  draw(out: DrawItem[], time: number) {
    for (const d of this.decor) out.push(d);
    this.flapItem.highlight = this.flap.highlight;
    out.push(this.flapItem);
    for (const b of this.bulbs) out.push(b.item);
    // The chute's portal, glowing up out of the pit.
    drawPortal(out, [CHUTE_C[0], PORTAL_Y, CHUTE_C[2]], [0, 1, 0], PORTAL_R * (1 + Math.sin(time * 3) * 0.02), false);
    this.claw.draw(out);
    this.arrival.draw(out);
    // A soft pool of light on the floor right under the claw while it's out looking for something,
    // so you can tell where it's going to come down.
    if (this.phase === 'move' || this.phase === 'hover' || this.phase === 'drop' || this.phase === 'bottom') {
      const hub = this.claw.hub();
      const intent = this.phase === 'move' ? 0.3 : 0.55;
      out.push({
        mesh: 'cylinder',
        model: mul(translation([hub[0], 0.03, hub[2]]), scaling([1.7, 0.02, 1.7])),
        color: [0.55, 0.5, 0.95],
        pattern: Pattern.blob,
        param: intent,
        shadow: false,
      });
    }
  }

  trackedTargets(): TrackedTarget[] {
    if (this.death || this.gameOverT >= 0) return [];
    return [{ pos: [CHUTE_C[0], PORTAL_Y + 0.3, CHUTE_C[2]], radius: PORTAL_R, color: 'purple' }];
  }

  environment() {
    return this.env;
  }

  obstacles() {
    return [];
  }

  cameraShot(): CameraShot | null {
    return this.arrival.cameraShot();
  }
}

function vec(p: Prize): Vec3 {
  const t = p.body.rb.translation();
  return [t.x, t.y, t.z];
}

/** A random orientation (for toys dropped in a heap). */
function randomRotation(): Quat {
  const u1 = Math.random(), u2 = Math.random() * Math.PI * 2, u3 = Math.random() * Math.PI * 2;
  const a = Math.sqrt(1 - u1), b = Math.sqrt(u1);
  return { x: a * Math.sin(u2), y: a * Math.cos(u2), z: b * Math.sin(u3), w: b * Math.cos(u3) };
}
