import { Drone, noise, note, sfx, tone, Tune } from '../../engine/audio';
import { basis, clamp, cross, mul, normalize, quatMul, rotationX, rotationY, rotationZ, scaling, segment, toQuat, translation, type Vec3 } from '../../engine/math';
import { RAPIER, type Body } from '../../engine/physics';
import { Pattern, type DrawItem } from '../../engine/renderer';
import { junk, spawnJunk, type JunkDef } from '../../entities/junk';
import { bigTwo, dimsOf, Katamari } from '../../entities/katamari';
import { King } from '../../entities/king';
import { spawnPlush } from '../../entities/plush';
import { ExitPortal, PortalArrival } from '../../entities/portal';
import { TRINKETS } from '../../entities/trinkets';
import { drawBody, poseFrames, type Pose } from '../../game/body';
import { CHAMBER_HALF } from '../../game/chamber';
import type { Circle } from '../../game/player';
import { DEFAULT_ENV, type CameraShot, type Level, type LevelContext, type LevelStatus, type TrackedTarget, type WorldLabel } from '../level';

/*
 * Katamari. The chamber is a mess of stuff, from pencils to pianos. After the arrival a royal beam
 * drops off a very small prince with a very sticky ball, and the King (an enormous crowned head
 * over the north wall) wants it made into a star: 5 metres, against the clock. The ball rolls up
 * anything up to half its size, growing as it goes, and on his own the prince is too slow: feeding
 * it (carry or throw junk in, or lead it through the big stuff) is how it gets there in time.
 * Trouble is, once it's twice your size you count as stuff too, and the prince stops looking for
 * furniture. 5 m and it floats up into the sky as a star and the exit opens; out of time and the
 * King zaps you; touched once it's big enough: rolled up.
 */

// --- Tunables -------------------------------------------------------------------------------------

const params = new URLSearchParams(location.search);
/** Seconds on the clock (`?katTime=N`). */
const ROUND_TIME = Number(params.get('katTime')) || 90;
/** The goal (m of diameter), and the ball's diameter at the start (`?katSize=D` to start bigger, for testing). */
const GOAL = 5;
const START_DIAMETER = Number(params.get('katSize')) || 0.62;
/** It rolls up things whose biggest extent is at most this share of its diameter. */
const PICK = 0.5;
/** The player counts as this big: the ball can roll them up from PLAYER_SIZE / PICK (3.4 m). */
const PLAYER_SIZE = 1.7;
/** Growth: diameter² grows by GROW × (the thing's two biggest extents multiplied). */
const GROW = 0.8;
/** Things the player carried or threw in grow it this many times as much. */
const FED_BONUS = 2;
/** Top speed (m/s) while gathering: BASE + PER_M × diameter, at most SPEED_MAX (a sprint is 8.5 m/s). */
const SPEED_BASE = 1.6;
const SPEED_PER_M = 0.9;
const SPEED_MAX = 7.0;
/** ...and while hunting you (a walk is 5 m/s). */
const HUNT_BASE = 2.6;
const HUNT_PER_M = 1.15;
/** Every so often (s) the prince stops to admire his ball for a moment (s). */
const DAWDLE_EVERY: [number, number] = [5, 9];
const DAWDLE_FOR = 1.1;
/**
 * Once it can roll you up, the King helps his prince: every DELIVERY_EVERY seconds (up to
 * DELIVERIES) something big it can roll up drops in from the sky: every third one straight into
 * its path, the rest somewhere to lead it to, marked by a beam for DELIVERY_WARN seconds first.
 */
const DELIVERY_EVERY = 6;
const DELIVERIES = 14;
const DELIVERY_WARN = 1.3;
const DELIVERY_ITEMS = ['couch', 'mattress', 'bookcase', 'fridge', 'vending machine', 'bathtub', 'piano', 'filing cabinet', 'washing machine'];
/** Acceleration (m/s²): BASE + PER_M × diameter, at most ACCEL_MAX. */
const ACCEL_BASE = 3.5;
const ACCEL_PER_M = 1.2;
const ACCEL_MAX = 8;
/** Sideways (turning) acceleration is limited to this share of that. */
const TURN_SHARE = 0.6;
/** When hunting it aims where you'll be this far ahead (s). */
const LEAD = 0.35;
/** When it first gets big enough to roll you up, it stops and "notices" you for this long (s) first. */
const NOTICE_TIME = 1.4;
/** Rolled up if your middle comes within this of its surface (m). */
const EAT_REACH = 0.42;
/**
 * Hunting, it still takes a detour of up to SNACK_TIME seconds for anything of at least SNACK_AREA
 * (m²) within SNACK_REACH of its surface, ahead of it.
 */
const SNACK_AREA = 0.4;
const SNACK_REACH = 2.2;
const SNACK_TIME = 1.4;
/** Things too big to roll up are shoved at most this much faster than it's going (m/s), and this fast upward. */
const SHOVE_EXTRA = 0.5;
const SHOVE_UP = 2;
/** A target it can't get to in this long is ignored for a while. */
const GIVE_UP_AFTER = 4;
const IGNORE_FOR = 10;

// --- Timeline (s after the arrival) ------------------------------------------------------------------

const BEAM_AT = 0.4;
const DROP_AT = 0.9;
const BEAM_END = 2.0;
const DISPLAY_AT = 2.6;
const ROLL_AT = 3.6;
const INTRO_SHOT_END = 2.6;
const DEATH_SCREEN_DELAY = 2.8;

const DROP_SPOT: Vec3 = [-9.6, 0, -9.6];
const DROP_HEIGHT = 7;
const WALL_Z = -CHAMBER_HALF + 0.06;

const DISPLAY_BG = [0.07, 0.06, 0.18];
const GOLD = [0.95, 0.72, 0.18];
const BAR_BG = [0.16, 0.14, 0.3];
const BAR_FILL = [2.2, 0.55, 1.4];
const BAR_DANGER = [2.5, 0.12, 0.1];

const LINES_EATEN = [
  'You are now part of a star. Congratulations?',
  'The King would like to thank you for your contribution to astronomy.',
  'Somewhere up there, a constellation is shaped like you. Screaming.',
  'You were the biggest thing in the room. Briefly.',
];

const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
/** A glowing colour that cycles round the rainbow as `h` goes up. */
const rainbow = (h: number) => [1.5 + Math.sin(h) * 1.3, 1.5 + Math.sin(h + 2.1) * 1.3, 1.5 + Math.sin(h + 4.2) * 1.3];
const rand = (a: number, b: number) => a + Math.random() * (b - a);

type Phase = 'arrival' | 'intro' | 'rolling' | 'star' | 'timeout' | 'eaten';

/** A junk definition's full extents. */
const dimsOfDef = (def: JunkDef): Vec3 =>
  def.shape === 'box' ? def.size : def.shape === 'ball' ? [def.size[0] * 2, def.size[0] * 2, def.size[0] * 2] : [def.size[0] * 2, def.size[1], def.size[0] * 2];

/** A royal delivery: a rainbow shaft of light from the sky down onto `spot`, `k` (0-1) strong. */
function drawBeam(out: DrawItem[], time: number, spot: Vec3, k: number) {
  if (k <= 0.01) return;
  const a: Vec3 = [spot[0], 0, spot[2]], b: Vec3 = [spot[0], 60, spot[2]];
  out.push({ mesh: 'cylinder', model: segment(a, b, 0.22 * k), color: [3, 3, 3], pattern: Pattern.emissive, shadow: false });
  out.push({ mesh: 'cylinder', model: segment(a, b, 0.55 * k), color: rainbow(time * 3), pattern: Pattern.emissive, shadow: false, opacity: 0.6 });
  out.push({ mesh: 'cylinder', model: segment(a, b, 1.1 * k), color: rainbow(time * 3 + 2), pattern: Pattern.emissive, shadow: false, opacity: 0.25 });
  out.push({
    mesh: 'cylinder', model: mul(translation([spot[0], 0.01, spot[2]]), scaling([1.6 * k, 0.02, 1.6 * k])),
    color: rainbow(time * 3 + 1), pattern: Pattern.emissive, shadow: false, opacity: 0.5,
  });
}

interface Thing {
  body: Body;
  /** Biggest extent, and the product of the two biggest (for growth). */
  size: number;
  area: number;
  name: string;
}

/** An original, jaunty, slightly royal loop for rolling things up. */
const ROLLING_TUNE: [string | null, number][] = [
  ['C5', 1], ['E5', 0.5], ['G5', 0.5], ['A5', 0.5], ['G5', 0.5], ['E5', 0.5], ['C5', 0.5],
  ['D5', 1], ['F5', 0.5], ['A5', 0.5], ['G5', 0.5], ['F5', 0.5], ['D5', 0.5], ['B4', 0.5],
  ['C5', 0.5], ['E5', 0.5], ['G5', 0.5], ['C6', 0.5], ['B5', 0.5], ['G5', 0.5], ['A5', 0.5], ['F5', 0.5],
  ['G5', 1], ['E5', 1], ['C5', 1], [null, 1],
  ['E5', 1], ['G5', 0.5], ['E5', 0.5], ['F5', 0.5], ['A5', 0.5], ['C6', 0.5], ['A5', 0.5],
  ['G5', 1], ['E5', 0.5], ['C5', 0.5], ['D5', 0.5], ['E5', 0.5], ['F5', 0.5], ['D5', 0.5],
  ['E5', 0.5], ['G5', 0.5], ['C6', 0.5], ['E6', 0.5], ['D6', 0.5], ['B5', 0.5], ['G5', 0.5], ['B5', 0.5],
  ['C6', 1.5], [null, 0.5], ['G5', 0.5], ['E5', 0.5], ['C5', 1],
];

export class KatamariLevel implements Level {
  readonly number: number;
  readonly title = 'Katamari';
  status: LevelStatus = 'playing';
  private arrival: PortalArrival;
  private exit = new ExitPortal(0);
  private kat: Katamari;
  private phase: Phase = 'arrival';
  /** Seconds since the arrival finished (-1 until then), and into the current phase. */
  private t = -1;
  private phaseT = 0;
  private clock = ROUND_TIME;
  private things: Thing[] = [];
  private byBody = new Map<Body, Thing>();
  /** Loose things touching the ball during the last physics steps. */
  private touching = new Set<Body>();
  /** What the prince is heading for, and how he's getting on. */
  private target: Thing | null = null;
  /** While hunting: something big it has spotted right in front of it, and for how much longer it'll try. */
  private snack: Thing | null = null;
  private snackT = 0;
  private targetBest = Infinity;
  private targetSince = 0;
  private ignored = new Map<Thing, number>();
  private rethink = 0;
  private wanderTo: Vec3 = [0, 0, 0];
  private stuckT = 0;
  private dodgeT = 0;
  private dodgeDir: [number, number] = [1, 0];
  private hunting = false;
  private dangerous = false;
  /** Seconds left of the pause when the prince first notices you're bite-sized. */
  private noticeT = 0;
  private alert: WorldLabel = { pos: [0, 0, 0], text: '', size: 1.1, color: '#ff3b2f' };
  private dawdleIn = rand(DAWDLE_EVERY[0], DAWDLE_EVERY[1]);
  private dawdleT = 0;
  /** Royal deliveries: how many so far, the countdown to the next, and the one on its way. */
  private delivered = 0;
  private deliveryIn = 4;
  private delivery: { spot: Vec3; t: number; name: string } | null = null;
  /** One-off moments (lines, sounds, milestones) already done. */
  private said = new Set<string>();
  private lastCarried: Body | null = null;
  private lastCarriedT = 99;
  private stickSoundT = 0;
  private bonkT = 0;
  private tune = new Tune(ROLLING_TUNE, 150, { wave: 'square', vol: 0.07, bass: true });
  private rumble = new Drone(45, { wave: 'sawtooth', vol: 0.09, wobble: 4 });
  /** Rolled up: which way the player sticks out of the ball (in its frame) and their head's direction. */
  private riderDir: Vec3 = [0, 1, 0];
  private riderUp: Vec3 = [1, 0, 0];
  /** The star it becomes: where it ends up in the sky. */
  private starFrom: Vec3 = [0, 0, 0];
  private starPos: Vec3 = [0, 80, -60];
  /** The King himself, looming over the north wall. */
  private royal = new King();
  private time = 0;
  private deathShown = false;
  private zapAt: Vec3 = [0, 0, 0];

  private ballCircle: Circle = { x: 0, z: 0, r: 0 };
  private circles: Circle[] = [];
  private noCircles: Circle[] = [];
  private shot: CameraShot = { pos: [0, 0, 0], target: [0, 0, 0], sharpness: 3 };
  /** Which side of the ball's path the rolled-up camera watches from (0: not chosen yet). */
  private shotSide = 0;
  private targets: TrackedTarget[] = [];
  private ballTarget: TrackedTarget = { pos: [0, 0, 0], radius: 1 };
  private displayItems: DrawItem[] = [];
  private barFill: DrawItem;
  private barTick: DrawItem;
  private title1: WorldLabel = { pos: [0, 9.05, WALL_Z], text: '', size: 0.78, color: '#ffc93c' };
  private title2: WorldLabel = { pos: [0, 8.15, WALL_Z], text: '', size: 0.5, color: '#ffffff' };
  private readout: WorldLabel = { pos: [0, 6.85, WALL_Z], text: '', size: 1.25, color: '#ffffff' };
  private clockLabel: WorldLabel = { pos: [0, 4.75, WALL_Z], text: '', size: 0.75, color: '#9fe7ff' };
  private youLabel: WorldLabel = { pos: [0, 6.0, WALL_Z], text: '', size: 0.28, color: '#ff5a4a' };
  /** The King's words, pinned across the top of the screen while he talks. */
  private kingHead: WorldLabel = { pos: [0, 0, 0], text: '', size: 1, color: '#ffc93c' };
  private kingLine1: WorldLabel = { pos: [0, 0, 0], text: '', size: 1, color: '#ffffff' };
  private kingLine2: WorldLabel = { pos: [0, 0, 0], text: '', size: 1, color: '#ffffff' };
  private kingT = 0;
  private labelList: WorldLabel[] = [
    this.title1, this.title2, this.readout, this.clockLabel, this.youLabel, this.alert, this.kingHead, this.kingLine1, this.kingLine2,
  ];

  constructor(private ctx: LevelContext) {
    this.number = ctx.number;
    const { hud, physics } = ctx;
    hud.setLevel(`The Chamber · Level ${this.number}`);
    hud.show(`LEVEL ${this.number}`, '', 2.5);
    hud.hint('');
    this.arrival = new PortalArrival(ctx, [0, 0, 6]);
    this.spawnStuff();

    // The ball waits up in the sky until the beam brings it down.
    this.kat = new Katamari(physics, [DROP_SPOT[0], DROP_HEIGHT + 30, DROP_SPOT[2]], START_DIAMETER / 2);
    this.kat.body.rb.setEnabled(false);
    this.kat.princeVisible = false;
    this.kat.heading = [Math.SQRT1_2, Math.SQRT1_2]; // out of the corner, toward the middle

    // Whatever touches the ball during a physics step might get rolled up.
    physics.postStepHooks.push(() => this.collectContacts());

    // The display on the north wall: a dark royal panel in a gold frame, with a size bar.
    const panel = (c: Vec3, s: Vec3, color: number[], pattern?: number) =>
      this.displayItems.push({ mesh: 'box', model: mul(translation(c), scaling(s)), color, pattern, spec: 0.2 });
    panel([0, 6.95, -CHAMBER_HALF + 0.03], [13.4, 5.3, 0.06], DISPLAY_BG, Pattern.emissive);
    for (const y of [4.3, 9.6]) panel([0, y, -CHAMBER_HALF + 0.05], [13.6, 0.16, 0.08], GOLD);
    for (const x of [-6.8, 6.8]) panel([x, 6.95, -CHAMBER_HALF + 0.05], [0.16, 5.46, 0.08], GOLD);
    panel([0, 5.8, -CHAMBER_HALF + 0.07], [10.2, 0.42, 0.04], BAR_BG);
    this.barFill = { mesh: 'box', model: mul(translation([0, 5.8, -CHAMBER_HALF + 0.1]), scaling([0.01, 0.3, 0.04])), color: BAR_FILL, pattern: Pattern.emissive, shadow: false };
    const tickX = -5 + 10 * ((PLAYER_SIZE / PICK) / GOAL);
    this.barTick = { mesh: 'box', model: mul(translation([tickX, 5.8, -CHAMBER_HALF + 0.12]), scaling([0.08, 0.6, 0.04])), color: BAR_DANGER, pattern: Pattern.emissive, shadow: false };
    this.youLabel.pos = [tickX, 5.3, WALL_Z];
  }

  // --- Setting up the mess ------------------------------------------------------------------------

  private addThing(body: Body, name: string) {
    const [a, b] = bigTwo(dimsOf(body));
    const thing: Thing = { body, size: a, area: a * b, name };
    this.things.push(thing);
    this.byBody.set(body, thing);
  }

  /** Is there room at (x, z) for something of radius r? Keeps clear of the arrival, the exit and the drop spot. */
  private free(spots: [number, number, number][], x: number, z: number, r: number) {
    if (Math.abs(x) > CHAMBER_HALF - r - 0.1 || Math.abs(z) > CHAMBER_HALF - r - 0.1) return false;
    if (Math.hypot(x, z - 6) < 2.2 + r) return false; // where you land
    if (Math.hypot(x - DROP_SPOT[0], z - DROP_SPOT[2]) < 1.6 + r) return false;
    if (x > CHAMBER_HALF - 2.5 && Math.abs(z) < 2 + r) return false; // in front of the exit
    return spots.every(([sx, sz, sr]) => Math.hypot(sx - x, sz - z) > sr + r + 0.05);
  }

  private spawnStuff() {
    const { physics } = this.ctx;
    const spots: [number, number, number][] = [];
    const q = (yaw: number, tilt = 0) => toQuat(tilt ? mul(rotationY(yaw), rotationZ(tilt)) : rotationY(yaw));
    const standing = (def: JunkDef) => (def.shape === 'box' ? def.size[1] / 2 : def.shape === 'ball' ? def.size[0] : def.size[1] / 2) + 0.02;

    // The big stuff, against the walls (yaw turns each one's front, local -z, toward the room).
    const big: [string, number, number, number][] = [
      ['fridge', -11.5, -3.5, -Math.PI / 2],
      ['vending machine', -11.5, 4, -Math.PI / 2],
      ['bookcase', -3.8, -11.75, Math.PI],
      ['piano', 4.2, -11.6, Math.PI],
      ['couch', 11.4, -7.5, Math.PI / 2],
      ['bathtub', 7.5, 11.5, 0],
      ['washing machine', -7.5, 11.5, 0],
      ['filing cabinet', 11.6, 6.5, Math.PI / 2],
      ['safe', 0.8, -11.6, Math.PI],
      ['oil drum', 11.3, 11.3, 0],
      ['mattress', -4, 9.8, 0.3],
      ['couch', -0.5, 11.45, 0],
      ['bookcase', 8.2, -11.75, Math.PI],
      ['mattress', 5.5, 3.5, 1.2],
    ];
    for (const [name, x, z, yaw] of big) {
      const def = junk(name);
      const [dx, , dz] = def.shape === 'box' ? def.size : [def.size[0] * 2, 0, def.size[0] * 2];
      spots.push([x, z, Math.hypot(dx, dz) / 2]);
      this.addThing(spawnJunk(physics, def, [x, standing(def), z], q(yaw)), name);
    }

    // Medium stuff scattered about: the rest of the junk pile, and three teddies.
    const medium: string[] = [
      'rubber duck', 'garden gnome', 'beach ball', 'traffic cone', 'pillow', 'pillow', 'cardboard box', 'cardboard box',
      'microwave', 'small crate', 'small crate', 'trash can', 'potted plant', 'potted plant', 'tire', 'tire',
      'crate', 'crate', 'CRT TV', 'toilet', 'anvil', 'traffic cone', 'rubber duck',
    ];
    const place = (r: number): [number, number] => {
      for (let tries = 0; tries < 200; tries++) {
        const x = rand(-10.8, 10.8), z = rand(-10.8, 10.8);
        if (this.free(spots, x, z, r)) {
          spots.push([x, z, r]);
          return [x, z];
        }
      }
      return [rand(-8, 8), rand(-8, 8)];
    };
    for (const name of medium) {
      const def = junk(name);
      const [x, z] = place(bigTwo(dimsOfDef(def))[0] * 0.6);
      this.addThing(spawnJunk(physics, def, [x, standing(def), z], q(rand(0, Math.PI * 2))), name);
    }
    const look = { eyeGlow: 0 };
    for (let i = 0; i < 3; i++) {
      const [x, z] = place(0.55);
      this.addThing(spawnPlush(physics, 'teddy', [x, 0.66, z], look, q(rand(0, Math.PI * 2))).body, 'teddy bear');
    }

    // Tiny things in little heaps all over the floor.
    let k = 0;
    for (let heap = 0; heap < 16; heap++) {
      const [hx, hz] = place(0.9);
      const n = 5 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) {
        const def = TRINKETS[k++ % TRINKETS.length];
        const a = rand(0, Math.PI * 2), d = rand(0, 0.8);
        const x = hx + Math.cos(a) * d, z = hz + Math.sin(a) * d;
        // Long thin things lie down; the rest sit as they are, turned any which way.
        const lying = def.shape === 'cylinder' && def.size[1] > def.size[0] * 4;
        const y = (lying ? def.size[0] : standing(def)) + 0.02 + i * 0.03;
        this.addThing(spawnJunk(physics, def, [x, y, z], q(rand(0, Math.PI * 2), lying ? Math.PI / 2 : 0)), def.name);
      }
    }
  }

  // --- The ball ------------------------------------------------------------------------------------

  private collectContacts() {
    if (this.phase !== 'rolling' && this.phase !== 'eaten') return;
    const physics = this.ctx.physics, world = physics.world;
    const ball = this.kat.body.collider;
    const bv = this.kat.body.rb.linvel();
    const cap = Math.hypot(bv.x, bv.z) + SHOVE_EXTRA;
    world.contactPairsWith(ball, (other) => {
      const b = physics.bodyFor(other);
      if (!b || b === this.kat.body) return;
      const thing = this.byBody.get(b);
      if (!thing) return;
      // Too big to roll up: it gets shoved along, but not launched across the room (a flying
      // mattress knocking you over just before it catches you isn't fair).
      if (!this.canPick(thing.size)) {
        const v = b.rb.linvel();
        const hs = Math.hypot(v.x, v.z);
        const k = hs > cap ? cap / hs : 1;
        if (k < 1 || v.y > SHOVE_UP) b.rb.setLinvel({ x: v.x * k, y: Math.min(v.y, SHOVE_UP), z: v.z * k }, true);
      }
      world.contactPair(ball, other, (m) => {
        if (m.numSolverContacts() > 0 || m.numContacts() > 0) this.touching.add(b);
      });
    });
  }

  private canPick(size: number) {
    return size <= PICK * this.kat.diameter;
  }

  /** Grows the ball by a thing of this area (the product of its two biggest extents). */
  private grow(area: number) {
    const d = this.kat.diameter;
    this.kat.setRadius(Math.sqrt(d * d + GROW * area) / 2);
  }

  private absorbTouching() {
    const { player } = this.ctx;
    for (const b of this.touching) {
      const thing = this.byBody.get(b);
      if (!thing) continue;
      if (!this.canPick(thing.size)) {
        // Too big: a bonk (it bounces off, physically).
        const v = this.kat.body.rb.linvel();
        if (this.bonkT <= 0 && Math.hypot(v.x, v.z) > 1.5) {
          this.bonkT = 0.5;
          tone(150, 0.18, { to: 70, wave: 'triangle', vol: 0.25 });
          noise(0.1, { freq: 600, to: 150, vol: 0.2 });
        }
        continue;
      }
      const fed = (b === this.lastCarried && this.lastCarriedT < 3) || (player.carrying !== null && b.collider.handle === player.carrying.handle);
      this.kat.absorb(this.ctx.physics, b);
      this.byBody.delete(b);
      this.things.splice(this.things.indexOf(thing), 1);
      if (this.target === thing) this.target = null;
      // Royal gratitude: things you bring it count for more.
      this.grow(thing.area * (fed ? FED_BONUS : 1));
      this.stickSound(thing.size);
      if (fed && !this.said.has('fed') && this.phase === 'rolling') {
        this.said.add('fed');
        this.king('OH, A VOLUNTEER.', 'The test subject is helping, Prince.|How noble. How... bite-sized.');
      }
    }
    this.touching.clear();
  }

  private stickSound(size: number) {
    if (this.stickSoundT > 0) return;
    this.stickSoundT = 0.05;
    const k = clamp(size / 2, 0, 1);
    tone(700 - 450 * k + Math.random() * 120, 0.09, { to: 1500 - 700 * k, wave: 'sine', vol: 0.18 + 0.12 * k });
    noise(0.07, { freq: 3000 - 2000 * k, to: 500, vol: 0.15 + 0.2 * k });
    if (k > 0.4) tone(90, 0.25, { to: 50, wave: 'sine', vol: 0.3 * k });
  }

  /**
   * The King speaks: a scratchy royal garble, and his words across the top of the screen (a gold
   * heading, then up to two lines split at '|'), out of the way of the ball.
   */
  private king(big: string, small: string, seconds = 3.6) {
    const [a, b] = small.split('|');
    this.kingHead.text = big;
    this.kingLine1.text = a?.trim() ?? '';
    this.kingLine2.text = b?.trim() ?? '';
    this.kingT = seconds;
    for (let i = 0; i < 3; i++) noise(0.12, { freq: 900 + Math.random() * 900, to: 2600 + Math.random() * 1500, type: 'bandpass', q: 5, vol: 0.3, at: i * 0.13 });
    for (let i = 0; i < 5; i++) tone(rand(130, 260), 0.09, { to: rand(90, 200), wave: 'sawtooth', vol: 0.06, at: 0.05 + i * 0.08 });
  }

  /** The King rises behind the north wall when he first speaks, flaps his mouth, watches, weeps, glares. */
  private updateKing(dt: number) {
    const { player } = this.ctx;
    const r = this.royal;
    this.time += dt;
    if (this.phase !== 'arrival' && (this.phase !== 'intro' || this.phaseT >= DISPLAY_AT - 1.2)) r.rise = Math.min(1, r.rise + dt / 1.6);
    r.talk = this.kingT > 0 ? 0.5 + 0.5 * Math.sin(this.time * 17) : Math.max(0, r.talk - dt * 4);
    const watchBall = this.phase === 'eaten' || this.phase === 'intro';
    if (this.phase === 'star' && this.phaseT < 3.5) r.lookAt = this.starPath(this.phaseT);
    else if (watchBall) r.lookAt = this.kat.centre();
    else r.lookAt = [player.pos[0], player.pos[1] + 1.2, player.pos[2]];
    r.tears = this.phase === 'star' ? Math.min(1, this.phaseT / 0.8) : 0;
    r.glow = this.phase === 'timeout' ? clamp((this.phaseT - 2.0) / 0.8, 0, 1) * (this.phaseT > 4.6 ? 0 : 1) : 0;
  }

  /** Puts a label at a fixed place on screen: `up` is the height (fraction of half the screen above the middle), `size` a fraction of its height. */
  private pinToScreen(label: WorldLabel, up: number, size: number) {
    const { camera } = this.ctx;
    const D = 6;
    const p = camera.pos, t = camera.target;
    const f = normalize([t[0] - p[0], t[1] - p[1], t[2] - p[2]]);
    const r = normalize(cross(f, camera.up));
    const u = cross(r, f);
    const half = Math.tan(camera.fov / 2) * D;
    label.pos = [p[0] + f[0] * D + u[0] * half * up, p[1] + f[1] * D + u[1] * half * up, p[2] + f[2] * D + u[2] * half * up];
    label.size = size * 2 * half;
  }

  /** Picks what the prince rolls toward: you, once you're bite-sized; otherwise the best thing to eat. */
  private chooseTarget(dt: number) {
    const { player } = this.ctx;
    const c = this.kat.centre();
    for (const [thing, left] of this.ignored) {
      if (left - dt <= 0) this.ignored.delete(thing);
      else this.ignored.set(thing, left - dt);
    }
    this.hunting = this.phase === 'rolling' && this.dangerous && this.noticeT <= 0 && player.mode === 'control' && !player.inPortal;
    if (this.hunting) {
      this.target = null;
      // Hunting, but anything big and tasty right in front of it gets a quick detour.
      if (this.snack) {
        this.snackT -= dt;
        if (!this.byBody.has(this.snack.body)) this.snack = null;
        else if (this.snackT <= 0) {
          this.ignored.set(this.snack, 4);
          this.snack = null;
        }
      }
      if (!this.snack && (this.rethink -= dt) <= 0) {
        this.rethink = 0.3;
        const h = this.kat.heading, R = this.kat.radius;
        for (const thing of this.things) {
          if (thing.area < SNACK_AREA || !this.canPick(thing.size) || this.ignored.has(thing)) continue;
          const p = thing.body.rb.translation();
          const dx = p.x - c[0], dz = p.z - c[2], dist = Math.hypot(dx, dz);
          if (dist - R < SNACK_REACH && (dx * h[0] + dz * h[1]) > 0.3 * dist) {
            this.snack = thing;
            this.snackT = SNACK_TIME;
            break;
          }
        }
      }
      return;
    }
    this.snack = null;
    this.rethink -= dt;
    if (this.target && this.rethink > 0) return;
    this.rethink = 0.8;
    let best: Thing | null = null, bestScore = 0;
    for (const thing of this.things) {
      if (!this.canPick(thing.size) || this.ignored.has(thing)) continue;
      const p = thing.body.rb.translation();
      if (Math.abs(p.x) > CHAMBER_HALF || Math.abs(p.z) > CHAMBER_HALF || p.y > 6) continue;
      const d = Math.hypot(p.x - c[0], p.z - c[2]);
      const score = (thing.area + 0.02) / Math.pow(d + 1.5, 1.6);
      if (score > bestScore) {
        bestScore = score;
        best = thing;
      }
    }
    if (best !== this.target) {
      this.target = best;
      this.targetBest = Infinity;
      this.targetSince = 0;
    }
    if (!best && Math.hypot(this.wanderTo[0] - c[0], this.wanderTo[2] - c[2]) < 1.5) this.wanderTo = [rand(-8, 8), 0, rand(-8, 8)];
  }

  /** Pushes the ball toward its target: a speed and turning limit that grow with it. */
  private drive(dt: number) {
    const { player } = this.ctx;
    const rb = this.kat.body.rb;
    const c = this.kat.centre();
    const d = this.kat.diameter;
    let goal: Vec3;
    if (this.hunting && this.snack) {
      const p = this.snack.body.rb.translation();
      goal = [p.x, 0, p.z];
    } else if (this.hunting) {
      goal = [player.pos[0] + player.vel[0] * LEAD, 0, player.pos[2] + player.vel[2] * LEAD];
    } else if (this.target) {
      const p = this.target.body.rb.translation();
      goal = [p.x, 0, p.z];
      // Not getting any closer: give up on it for a while.
      const dist = Math.hypot(p.x - c[0], p.z - c[2]);
      this.targetSince += dt;
      if (dist < this.targetBest - 0.4) {
        this.targetBest = dist;
        this.targetSince = 0;
      } else if (this.targetSince > GIVE_UP_AFTER) {
        this.ignored.set(this.target, IGNORE_FOR);
        this.target = null;
      }
    } else {
      goal = this.wanderTo;
    }
    let dx = goal[0] - c[0], dz = goal[2] - c[2];
    const len = Math.hypot(dx, dz);
    if (len > 1e-3) {
      dx /= len;
      dz /= len;
    }
    const v = rb.linvel();
    let speed = Math.min(SPEED_MAX, this.hunting ? HUNT_BASE + HUNT_PER_M * d : SPEED_BASE + SPEED_PER_M * d);
    // Now and then (not while hunting) he stops to admire his work.
    if (!this.hunting && this.phase === 'rolling') {
      if (this.dawdleT > 0) {
        this.dawdleT -= dt;
        speed = 0;
      } else if ((this.dawdleIn -= dt) <= 0) {
        this.dawdleIn = rand(DAWDLE_EVERY[0], DAWDLE_EVERY[1]);
        this.dawdleT = DAWDLE_FOR;
      }
    } else this.dawdleT = 0;
    if (this.noticeT > 0) speed = 0;
    this.kat.cheer = this.dawdleT > 0 ? Math.min(1, this.dawdleT * 4, (DAWDLE_FOR - this.dawdleT) * 6) : 0;
    // Wedged against something big: back off to one side for a moment.
    const hs = Math.hypot(v.x, v.z);
    if (speed === 0) {
      this.stuckT = 0;
    } else if (this.dodgeT > 0) {
      this.dodgeT -= dt;
      dx = this.dodgeDir[0];
      dz = this.dodgeDir[1];
    } else if (hs < 0.35 * speed && len > this.kat.radius + 0.5) {
      this.stuckT += dt;
      if (this.stuckT > 0.9) {
        this.stuckT = 0;
        this.dodgeT = 0.7;
        const side = Math.random() < 0.5 ? 1 : -1;
        const a = Math.atan2(dz, dx) + Math.PI + side * 1.1;
        this.dodgeDir = [Math.cos(a), Math.sin(a)];
      }
    } else this.stuckT = 0;
    const accel = Math.min(ACCEL_MAX, ACCEL_BASE + ACCEL_PER_M * d);
    let ax = dx * speed - v.x, az = dz * speed - v.z;
    // A big ball has momentum: it can speed up or brake harder than it can swerve.
    if (hs > 0.5) {
      const fx = v.x / hs, fz = v.z / hs;
      const along = ax * fx + az * fz;
      const side = -ax * fz + az * fx;
      const sideMax = accel * TURN_SHARE * dt;
      const s = clamp(side, -sideMax, sideMax);
      ax = fx * along - fz * s;
      az = fz * along + fx * s;
    }
    const a = Math.hypot(ax, az), maxA = accel * dt;
    if (a > maxA) {
      ax *= maxA / a;
      az *= maxA / a;
    }
    const m = rb.mass();
    rb.applyImpulse({ x: ax * m, y: 0, z: az * m }, true);
    // Roll without slipping (friction would get there too, but this keeps the spin honest).
    const R = this.kat.radius;
    if (c[1] < R + 0.15) {
      const vx = v.x + ax, vz = v.z + az;
      const w = rb.angvel();
      rb.setAngvel({ x: vz / R, y: w.y * 0.9, z: -vx / R }, true);
    }
    if (hs > 0.3) this.kat.heading = [v.x / hs, v.z / hs];
    else if (len > 1e-3) this.kat.heading = [dx, dz];
  }

  // --- The player -----------------------------------------------------------------------------------

  /** The ball's cross-section where the player is (0 if they're above it). */
  private reachAtPlayer(): number {
    const { player } = this.ctx;
    const c = this.kat.centre(), R = this.kat.radius;
    const lo = player.pos[1], hi = player.pos[1] + 1.8;
    const dy = c[1] < lo ? lo - c[1] : c[1] > hi ? c[1] - hi : 0;
    return dy >= R ? 0 : Math.sqrt(R * R - dy * dy);
  }

  private rollUp() {
    const { player, camera } = this.ctx;
    const c = this.kat.centre();
    const toPlayer = normalize([player.pos[0] - c[0], player.pos[1] + 0.9 - c[1], player.pos[2] - c[2]]);
    this.riderDir = this.kat.toLocalDir(toPlayer);
    // Head up the way it was, as near as the ball's surface allows.
    const upWorld = normalize(cross(cross(toPlayer, [0, 1, 0]), toPlayer));
    this.riderUp = normalize(this.kat.toLocalDir(Math.hypot(...upWorld) > 0.1 ? upWorld : [1, 0, 0]));
    player.hide();
    this.grow(PLAYER_SIZE * 0.5);
    camera.addShake(0.5);
    sfx.oof(1);
    this.stickSound(2);
    tone(note('C4'), 0.3, { to: note('C6'), wave: 'square', vol: 0.15 });
    this.setPhase('eaten');
    this.king('OH, PRINCE.', 'You have rolled up the test subject.|How... crunchy.', 2.6);
  }

  /** The rolled-up player, flailing on the ball's surface. */
  private drawRider(out: DrawItem[], time: number) {
    const f = this.kat.frame();
    const n = this.riderDir, up = this.riderUp;
    const z: Vec3 = [-n[0], -n[1], -n[2]]; // back to the ball
    const y = normalize(cross(z, cross(up, z)));
    const x = cross(y, z);
    const dist = this.kat.radius + 0.1;
    const origin: Vec3 = [n[0] * dist - y[0] * 0.95, n[1] * dist - y[1] * 0.95, n[2] * dist - y[2] * 0.95];
    const root = mul(f, basis(x, y, z, origin));
    const t = time * 1.0;
    const pose: Pose = {
      lean: 0.25, headPitch: -0.3 + Math.sin(t * 7) * 0.2,
      shoulderL: 1.4 + Math.sin(t * 13) * 0.9, shoulderR: 1.4 + Math.cos(t * 12) * 0.9, armOut: 1.2,
      elbowL: 0.5 + Math.sin(t * 9) * 0.4, elbowR: 0.5 + Math.cos(t * 10) * 0.4,
      hipL: 0.5 + Math.sin(t * 14) * 0.6, hipR: 0.5 - Math.sin(t * 14) * 0.6, kneeL: -0.8, kneeR: -0.6,
    };
    drawBody(out, poseFrames(root, pose));
  }

  // --- Flow ------------------------------------------------------------------------------------------

  private setPhase(p: Phase) {
    this.phase = p;
    this.phaseT = 0;
  }

  private die(big: string, small: string, hint: string) {
    const { hud } = this.ctx;
    this.status = 'lost';
    this.kingT = 0;
    this.kingHead.text = this.kingLine1.text = this.kingLine2.text = '';
    hud.show(big, `${small}\nPress R to try again.`);
    hud.tips([
      ['Hint', hint],
      ['Controls', 'WASD move · Shift sprint · Space jump · Hold click carry · Right-click throw'],
    ]);
  }

  update(dt: number) {
    const { player } = this.ctx;
    this.arrival.update(dt);
    if (this.t < 0 && this.arrival.done) {
      this.t = 0;
      this.setPhase('intro');
    }
    if (this.t >= 0) this.t += dt;
    this.phaseT += dt;
    this.stickSoundT -= dt;
    this.bonkT -= dt;
    if (this.kingT > 0 && (this.kingT -= dt) <= 0) this.kingHead.text = this.kingLine1.text = this.kingLine2.text = '';
    this.kat.update(dt);
    this.updateKing(dt);

    // Remember what the player was carrying (things thrown in count as feeding it).
    if (player.carrying) {
      this.lastCarried = this.ctx.physics.bodyFor(player.carrying) ?? null;
      this.lastCarriedT = 0;
    } else this.lastCarriedT += dt;

    switch (this.phase) {
      case 'intro': this.updateIntro(); break;
      case 'rolling': this.updateRolling(dt); break;
      case 'star': this.updateStar(dt); break;
      case 'timeout': this.updateTimeout(); break;
      case 'eaten': this.updateEaten(dt); break;
    }
    if ((this.phase === 'rolling' || this.phase === 'eaten') && this.status === 'playing') this.tune.start();
    else this.tune.stop();
    // A rumble when it's big enough to eat you and bearing down.
    const c = this.kat.centre();
    const gap = Math.hypot(c[0] - player.pos[0], c[2] - player.pos[2]) - this.kat.radius;
    if (this.phase === 'rolling' && this.dangerous && gap < 7 && player.mode === 'control') {
      const v = this.kat.body.rb.linvel();
      this.rumble.setFreq(38 + Math.hypot(v.x, v.z) * 3);
      this.rumble.start();
    } else this.rumble.stop();

    // Keep the player out of the ball (it doesn't push the capsule by itself).
    this.circles = this.noCircles;
    if (this.kat.princeVisible && this.phase !== 'star') {
      const r = this.reachAtPlayer();
      if (r > 0) {
        const c = this.kat.centre();
        this.ballCircle.x = c[0];
        this.ballCircle.z = c[2];
        this.ballCircle.r = r;
        this.circles = [this.ballCircle];
      }
    }

    this.exit.update(dt, player);
    if (this.exit.entered && this.status === 'playing') this.status = 'exited';
  }

  private updateIntro() {
    const t = this.phaseT;
    const rb = this.kat.body.rb;
    if (t >= BEAM_AT && !this.said.has('beam')) {
      this.said.add('beam');
      tone(note('C6'), 0.9, { to: note('C4'), wave: 'sine', vol: 0.18 });
      noise(1.0, { freq: 5000, to: 800, type: 'bandpass', q: 2, vol: 0.18 });
    }
    if (t >= DROP_AT && !this.said.has('drop')) {
      this.said.add('drop');
      rb.setEnabled(true);
      rb.setTranslation({ x: DROP_SPOT[0], y: DROP_HEIGHT, z: DROP_SPOT[2] }, true);
      rb.setLinvel({ x: 0, y: -4, z: 0 }, true);
      this.kat.princeVisible = true;
    }
    // The prince floats down beside his ball.
    if (this.kat.princeVisible) {
      const k = clamp((t - DROP_AT) / 0.9, 0, 1);
      this.kat.princeLift = DROP_HEIGHT * (1 - k) * (1 - k);
      if (k >= 1 && !this.said.has('land')) {
        this.said.add('land');
        sfx.thud(0.3);
      }
    }
    if (t >= DISPLAY_AT && !this.title1.text) {
      this.king('OH, PRINCE.', 'We have found a test chamber absolutely full of things.|Roll them up. All of them.', 4.2);
      this.title1.text = 'MAKE IT 5 METRES.';
      this.title2.text = 'USE ANYTHING. ANYTHING.';
      this.youLabel.text = 'YOU';
      tone(note('G5'), 0.15, { wave: 'square', vol: 0.1 });
      tone(note('C6'), 0.3, { wave: 'square', vol: 0.1, at: 0.15 });
    }
    if (t >= ROLL_AT) this.setPhase('rolling');
    this.updateReadout();
  }

  private updateRolling(dt: number) {
    const { player } = this.ctx;
    this.clock = Math.max(0, this.clock - dt);
    this.chooseTarget(dt);
    this.drive(dt);
    this.absorbTouching();
    const d = this.kat.diameter;

    if (!this.dangerous && d >= PLAYER_SIZE / PICK) {
      this.dangerous = true;
      this.noticeT = NOTICE_TIME;
      this.alert.text = '!';
      this.tune.bpm = 184;
      this.ctx.camera.addShake(0.25);
      // A sting: something is now the right size.
      tone(note('C5'), 0.6, { to: note('C4'), wave: 'sawtooth', vol: 0.16 });
      tone(note('F#4'), 0.6, { to: note('F#3'), wave: 'sawtooth', vol: 0.12, at: 0.05 });
      noise(0.5, { freq: 1500, to: 200, vol: 0.25 });
      this.king('OH, PRINCE.', 'A test subject. How delightful.', 3.4);
    }
    this.milestones(d);
    if (this.dangerous) this.updateDeliveries(dt);
    if (this.noticeT > 0) {
      // The prince has noticed you: a moment's pause (and a '!') before it comes for you.
      const c = this.kat.centre();
      this.alert.pos = [c[0], c[1] + this.kat.radius + 0.9 + Math.sin(this.noticeT * 20) * 0.08, c[2]];
      if ((this.noticeT -= dt) <= 0) this.alert.text = '';
    }

    // Rolled up: you count as stuff now.
    if (this.dangerous && this.noticeT <= 0 && player.mode === 'control' && !player.inPortal) {
      const c = this.kat.centre();
      const reach = this.reachAtPlayer();
      const side = reach > 0 && Math.hypot(player.pos[0] - c[0], player.pos[2] - c[2]) < reach + EAT_REACH;
      // (Or on top of it, somehow.)
      const top = player.pos[1] > c[1] && Math.hypot(player.pos[0] - c[0], player.pos[1] - c[1], player.pos[2] - c[2]) < this.kat.radius + EAT_REACH;
      if (side || top) {
        this.rollUp();
        return;
      }
    }

    if (d >= GOAL) {
      this.launch();
      return;
    }
    if (this.clock <= 0) {
      this.setPhase('timeout');
      this.updateReadout();
      this.kat.body.rb.setLinvel({ x: 0, y: 0, z: 0 }, true);
      this.king('TIME, PRINCE.', 'This is not a star. This is a pebble.', 2.4);
      return;
    }
    this.updateReadout();
  }

  /** Big things dropped in from above while it hunts you, to lead it through. */
  private updateDeliveries(dt: number) {
    const { player, physics } = this.ctx;
    const dl = this.delivery;
    if (dl) {
      dl.t += dt;
      if (dl.t >= DELIVERY_WARN) {
        const def = junk(dl.name);
        const body = spawnJunk(physics, def, [dl.spot[0], 9, dl.spot[2]], toQuat(rotationY(rand(0, Math.PI * 2))));
        body.rb.setLinvel({ x: 0, y: -8, z: 0 }, true);
        this.addThing(body, dl.name);
        this.delivery = null;
        tone(1200, 0.5, { to: 300, wave: 'sine', vol: 0.12 });
        sfx.thud(0.5);
      }
      return;
    }
    if (this.delivered >= DELIVERIES || (this.deliveryIn -= dt) > 0) return;
    const c = this.kat.centre(), R = this.kat.radius;
    const clearOf = (x: number, z: number, fromPlayer: number) => Math.abs(x) < 9.8 && Math.abs(z) < 9.8 &&
      Math.hypot(x - player.pos[0], z - player.pos[2]) > fromPlayer && Math.hypot(x - c[0], z - c[2]) > R + 1.2 &&
      !(x > 7 && Math.abs(z) < 3);
    // Every third one lands between it and you (it will roll straight into it); the rest somewhere to lead it to.
    let spot: Vec3 | null = null;
    let warn = 0;
    if (this.delivered % 3 === 0) {
      // Straight onto its path, where it'll be when this lands (a quick flash, no warning: you're well clear).
      const v = this.kat.body.rb.linvel();
      const dx = player.pos[0] - c[0], dz = player.pos[2] - c[2], dist = Math.hypot(dx, dz);
      const x = c[0] + v.x * 0.9 + (dx / dist) * (R + 1.3), z = c[2] + v.z * 0.9 + (dz / dist) * (R + 1.3);
      if (clearOf(x, z, 3.6) && Math.hypot(x - c[0], z - c[2]) < dist) {
        spot = [x, 0, z];
        warn = DELIVERY_WARN - 0.3;
      }
    }
    // Not where you're running to, either.
    const pv = player.vel, ps = Math.hypot(pv[0], pv[2]);
    for (let tries = 0; !spot && tries < 60; tries++) {
      const x = rand(-9.5, 9.5), z = rand(-9.5, 9.5);
      const rx = x - player.pos[0], rz = z - player.pos[2], dist = Math.hypot(rx, rz);
      const ahead = ps > 1 && (rx * pv[0] + rz * pv[2]) / (dist * ps) > 0.5;
      if (clearOf(x, z, 5.5) && dist < 12 && !ahead) spot = [x, 0, z];
    }
    if (!spot) return;
    // Something it can roll up right away: one of the biggest that fit.
    const edible = DELIVERY_ITEMS.filter((n) => this.canPick(bigTwo(dimsOfDef(junk(n)))[0]));
    if (!edible.length) return;
    this.delivery = { spot, t: warn, name: edible[Math.floor(Math.random() * Math.min(3, edible.length))] };
    this.delivered++;
    this.deliveryIn = DELIVERY_EVERY;
    tone(note('E6'), 0.6, { to: note('E5'), wave: 'sine', vol: 0.14 });
    noise(0.8, { freq: 5000, to: 900, type: 'bandpass', q: 2, vol: 0.14 });
    if (this.delivered === 1) this.king('A ROYAL DELIVERY.', 'Something for the Prince to roll up.|Not you. Well. Also you.', 3.2);
  }

  private milestones(d: number) {
    const once = (key: string, when: boolean, big: string, small: string) => {
      if (!when || this.said.has(key)) return;
      this.said.add(key);
      this.king(big, small);
    };
    once('1m', d >= 1, 'ONE METRE.', 'We have seen bigger sandwiches, Prince.|Keep rolling.');
    once('2m', d >= 2, 'TWO METRES.', 'It is now the size of a small regret.');
    once('2.8m', d >= 2.8 && !this.dangerous, 'NEARLY THREE.', 'Almost as tall as the test subject.|Interesting. No reason.');
    once('4m', d >= 4 && this.dangerous, 'FOUR METRES!', 'We can almost see it from the palace.|More. MORE.');
    once('30s', this.clock <= 30, 'THIRTY SECONDS.', 'We are tapping our royal foot, Prince.');
    once('10s', this.clock <= 10, 'TEN SECONDS.', 'Nine. Eight. We are counting. Royally.');
  }

  private updateReadout() {
    const d = this.kat.diameter;
    if (this.title1.text) {
      this.readout.text = `${Math.min(d, 99).toFixed(2)} m / ${GOAL} m`;
      this.readout.color = this.phase === 'star' ? '#ffc93c' : this.dangerous ? '#ff4a3a' : '#ffffff';
      const s = Math.ceil(this.clock);
      this.clockLabel.text = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      this.clockLabel.color = this.clock <= 10 && this.phase === 'rolling' ? (Math.floor(this.clock * 4) % 2 ? '#ff4a3a' : '#ffffff') : '#9fe7ff';
    }
    const k = clamp((d - 0) / GOAL, 0, 1);
    const w = 10 * k;
    const m = this.barFill.model;
    m[0] = Math.max(0.01, w);
    m[12] = -5 + w / 2;
    this.barFill.color = this.dangerous && this.phase === 'rolling' ? BAR_DANGER : BAR_FILL;
  }

  // --- Endings ---------------------------------------------------------------------------------------

  /** 5 m: it goes up to be a star. */
  private launch() {
    const rb = this.kat.body.rb;
    this.setPhase('star');
    this.starFrom = this.kat.centre();
    this.starPos = [this.starFrom[0] * 0.3, 62, -42];
    rb.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    this.kat.body.collider.setEnabled(false);
    this.kat.followBall = false;
    this.kat.cheer = 1;
    this.updateReadout();
    this.king('WE ARE MOVED TO TEARS', 'by the size of this katamari.|Truly. Look, a royal tear.', 4.2);
    // A triumphant little jingle.
    ['C5', 'E5', 'G5', 'C6', 'E6', 'G6'].forEach((n, i) => tone(note(n), 0.22, { wave: 'square', vol: 0.12, at: 0.9 + i * 0.1 }));
    tone(note('C7'), 1.2, { wave: 'sine', vol: 0.12, at: 1.5 });
    tone(note('E6'), 1.2, { wave: 'triangle', vol: 0.1, at: 1.5 });
  }

  /** Where the rising katamari is at time t of the star phase. */
  private starPath(t: number): Vec3 {
    const a = this.starFrom, b = this.starPos;
    if (t < 0.9) return [a[0], a[1] + 0.6 * Math.sin((t / 0.9) * Math.PI / 2), a[2]];
    const k = clamp((t - 0.9) / 2.6, 0, 1), e = k * k;
    return [a[0] + (b[0] - a[0]) * e, a[1] + 0.6 + (b[1] - a[1] - 0.6) * e, a[2] + (b[2] - a[2]) * e];
  }

  private updateStar(dt: number) {
    const t = this.phaseT;
    const rb = this.kat.body.rb;
    if (t < 3.5) {
      const p = this.starPath(t);
      rb.setTranslation({ x: p[0], y: p[1], z: p[2] }, true);
      const w = 1 + t * 3;
      const q = rb.rotation();
      const spin = toQuat(mul(rotationY(dt * w), rotationX(dt * w * 0.6)));
      rb.setRotation(quatMul(spin, q), true);
    }
    if (t >= 3.5 && !this.said.has('star')) {
      this.said.add('star');
      this.kat.ballVisible = false;
      noise(1.2, { freq: 6000, to: 2000, type: 'highpass', vol: 0.12 });
      tone(note('G6'), 1.5, { wave: 'sine', vol: 0.1 });
      this.king('A STAR IS BORN.', 'The exit is open. The King is weeping.|Leave while he is distracted.', 4.5);
      this.readout.text = 'A STAR IS BORN';
    }
    if (t >= 4.4 && !this.exit.open) this.exit.openNow();
    this.kat.cheer = t < 6 ? 1 : 0.4;
  }

  private updateTimeout() {
    const t = this.phaseT;
    const { player, camera } = this.ctx;
    this.zapAt = [player.pos[0], player.pos[1], player.pos[2]];
    if (t >= 2.2 && !this.said.has('unacceptable')) {
      this.said.add('unacceptable');
      this.king('UNACCEPTABLE.', '', 1.6);
      tone(200, 1.0, { to: 1600, wave: 'sawtooth', vol: 0.1 });
    }
    if (t >= 3.1 && !this.said.has('zap')) {
      this.said.add('zap');
      sfx.zap();
      sfx.explosion(0.45);
      camera.addShake(0.8);
      player.char = 0.75;
      player.kill([rand(-2, 2), 13, rand(-2, 2)], { violence: 24, origin: [player.pos[0], player.pos[1] + 0.2, player.pos[2]] });
    }
    if (t >= 4.8 && !this.deathShown) {
      this.deathShown = true;
      this.die('ROYALLY ZAPPED', 'The King wanted a star. He got a pebble, and a crater.',
        "It won't get to 5 metres on its own in time. Feed it: carry or throw junk into it, and lead it through the big stuff. Once it's twice your size, don't let it touch you.");
    }
  }

  private updateEaten(dt: number) {
    // The prince doesn't even notice. Onward.
    this.chooseTarget(dt);
    this.drive(dt);
    this.absorbTouching();
    if (this.phaseT >= DEATH_SCREEN_DELAY && !this.deathShown) {
      this.deathShown = true;
      this.die('ROLLED UP', pick(LINES_EATEN),
        "Feed it: carry or throw junk into it to make it grow faster. Once it's twice your size (the red line on the board), don't let it touch you: sprint, and lead it through the big stuff.");
    }
  }

  // --- Drawing ----------------------------------------------------------------------------------------

  draw(out: DrawItem[], time: number) {
    this.arrival.draw(out);
    this.exit.draw(out);
    for (const item of this.displayItems) out.push(item);
    if (this.title1.text) {
      out.push(this.barFill);
      out.push(this.barTick);
    }
    if (this.phase === 'intro') {
      const t = this.phaseT;
      if (t >= BEAM_AT && t <= BEAM_END) drawBeam(out, time, DROP_SPOT, Math.min(clamp((t - BEAM_AT) / 0.25, 0, 1), clamp((BEAM_END - t) / 0.4, 0, 1)));
    }
    const dl = this.delivery;
    if (dl) drawBeam(out, time, dl.spot, Math.min(1, dl.t / 0.25) * (0.6 + 0.4 * Math.sin(dl.t * 20)));
    this.kat.draw(out, time);
    this.royal.draw(out, time);
    if (this.phase === 'star' && this.phaseT >= 3.5) this.drawStar(out, time);
    if (this.phase === 'eaten') this.drawRider(out, time);
    if (this.phase === 'timeout' && this.phaseT >= 2.2) this.drawZap(out, time);
  }

  /** The finished star, high in the sky: a bright twinkling point with rays. */
  private drawStar(out: DrawItem[], time: number) {
    const p = this.starPos;
    const tw = 1 + Math.sin(time * 7) * 0.25 + Math.sin(time * 11.3) * 0.15;
    const flash = Math.max(0, 1 - (this.phaseT - 3.5) / 0.6);
    const r = 3.2 * tw + flash * 16;
    out.push({ mesh: 'sphere', model: mul(translation(p), scaling([r, r, r])), color: [3, 2.4, 0.9], pattern: Pattern.emissive, shadow: false });
    out.push({ mesh: 'sphere', model: mul(translation(p), scaling([r * 2.2, r * 2.2, r * 2.2])), color: [1.6, 1.0, 0.25], pattern: Pattern.emissive, shadow: false, opacity: 0.35 });
    // Rays: a long cross and a short one, turning slowly, facing the chamber.
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 4 + time * 0.25;
      const len = (i % 2 ? 9 : 16) * tw;
      out.push({ mesh: 'box', model: mul(translation(p), rotationX(-0.6), rotationZ(a), scaling([len * 2, 0.9, 0.3])), color: [2.4, 1.9, 0.6], pattern: Pattern.emissive, shadow: false, opacity: 0.8 });
    }
  }

  /** The King's displeasure, arriving from above as a rainbow beam on the player. */
  private drawZap(out: DrawItem[], time: number) {
    const t = this.phaseT;
    const fire = t >= 3.1;
    const k = fire ? Math.max(0, 1 - (t - 3.1) / 1.4) : clamp((t - 2.2) / 0.9, 0, 1) * 0.3;
    if (k <= 0) return;
    // From both of the King's eyes to where you stand.
    const p = this.zapAt;
    const a: Vec3 = [p[0], p[1] + 0.9, p[2]];
    for (const side of [-1, 1] as const) {
      const b = this.royal.eye(side);
      out.push({ mesh: 'cylinder', model: segment(a, b, (fire ? 0.35 : 0.06) * Math.max(k, 0.2)), color: [4, 4, 4], pattern: Pattern.emissive, shadow: false });
      out.push({ mesh: 'cylinder', model: segment(a, b, (fire ? 1.1 : 0.22) * Math.max(k, 0.2)), color: rainbow(time * 9 + side), pattern: Pattern.emissive, shadow: false, opacity: 0.45 });
    }
  }

  // --- Level interface ----------------------------------------------------------------------------------

  labels(): WorldLabel[] {
    if (this.kingT > 0) {
      this.pinToScreen(this.kingHead, 0.78, 0.065);
      this.pinToScreen(this.kingLine1, 0.63, 0.036);
      this.pinToScreen(this.kingLine2, 0.54, 0.036);
    }
    return this.labelList;
  }

  trackedTargets(): TrackedTarget[] {
    this.targets.length = 0;
    // Hunting you and getting close: flag it (an arrow at the edge of the screen when it's behind you).
    const { player } = this.ctx;
    if (this.hunting && player.mode === 'control') {
      const c = this.kat.centre();
      if (Math.hypot(c[0] - player.pos[0], c[2] - player.pos[2]) - this.kat.radius < 9) {
        this.ballTarget.pos = c;
        this.ballTarget.radius = this.kat.radius;
        this.targets.push(this.ballTarget);
      }
    }
    const exit = this.exit.target();
    if (exit) this.targets.push(exit);
    return this.targets;
  }

  environment() {
    return DEFAULT_ENV;
  }

  obstacles() {
    return this.circles;
  }

  cameraShot(): CameraShot | null {
    const arrival = this.arrival.cameraShot();
    if (arrival) return arrival;
    const { player } = this.ctx;
    const shot = this.shot;
    if (this.phase === 'intro' && this.phaseT < INTRO_SHOT_END && this.phaseT > BEAM_AT) {
      // Cut over to the royal delivery in the corner.
      // From the side, so the prince (behind his ball, facing out of the corner) is in view.
      shot.pos = [DROP_SPOT[0] + 3.4, 1.5, DROP_SPOT[2] - 0.2];
      shot.target = [DROP_SPOT[0], 0.6 + this.kat.princeLift * 0.6, DROP_SPOT[2] + 0.2];
      shot.sharpness = this.phaseT < BEAM_AT + 0.1 ? 60 : 8;
      return shot;
    }
    if (this.phase === 'eaten') {
      const c = this.kat.centre(), R = this.kat.radius, h = this.kat.heading;
      const lim = CHAMBER_HALF - 0.6;
      // From the side of its path (whichever side has more room), so you can watch yourself go round and round.
      const side = R + 6.5;
      const room = (s: number) => {
        const x = c[0] - h[0] * 2 + h[1] * side * s, z = c[2] - h[1] * 2 - h[0] * side * s;
        return Math.abs(x - clamp(x, -lim, lim)) + Math.abs(z - clamp(z, -lim, lim));
      };
      if (this.shotSide === 0 || room(this.shotSide) > room(-this.shotSide) + 2) this.shotSide = room(1) <= room(-1) ? 1 : -1;
      const s = this.shotSide;
      shot.pos = [clamp(c[0] - h[0] * 2 + h[1] * side * s, -lim, lim), Math.min(12, c[1] + R * 0.5 + 2.2), clamp(c[2] - h[1] * 2 - h[0] * side * s, -lim, lim)];
      shot.target = c;
      shot.sharpness = 2.5;
      return shot;
    }
    if (this.phase === 'star' && this.phaseT < 4.6) {
      const p = this.phaseT < 3.5 ? this.starPath(this.phaseT) : this.starPos;
      const lim = CHAMBER_HALF - 0.6;
      const back = normalize([player.pos[0] - this.starFrom[0], 0, player.pos[2] - this.starFrom[2]]);
      shot.pos = [clamp(player.pos[0] + back[0] * 3, -lim, lim), player.pos[1] + 1.6, clamp(player.pos[2] + back[2] * 3, -lim, lim)];
      shot.target = p;
      shot.sharpness = 3;
      return shot;
    }
    return null;
  }
}
