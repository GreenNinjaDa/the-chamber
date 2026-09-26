import { noise, sfx, tone } from '../../engine/audio';
import {
  add, basis, clamp, cross, dot, easeInOut, fromQuat, length, lerp, mul, normalize, scale, scaling, segment, sub, toQuat,
  translation, type Mat4, type Vec3,
} from '../../engine/math';
import { GROUPS_QUERY_WORLD, RAPIER, type Body } from '../../engine/physics';
import { Pattern, type DrawItem } from '../../engine/renderer';
import { BIRD_MASS, BIRD_RADIUS, drawBird, drawPigFace, drawStar, PIG_GREEN, Slingshot, type BirdKind } from '../../entities/birds';
import { MATERIALS, spawnBlock, type Block, type Material } from '../../entities/blocks';
import { PixelText } from '../../entities/pixelText';
import { ExitPortal, PortalArrival } from '../../entities/portal';
import { PART_NAMES, PLAYER_COLORS } from '../../game/body';
import { CHAMBER_HALF, WALL_HEIGHT } from '../../game/chamber';
import { DEFAULT_ENV, type CameraShot, type Level, type LevelContext, type LevelStatus, type TrackedTarget, type WorldLabel } from '../level';

/*
 * Angry Birds, and you are the pig. You land inside a fortress of planks, glass, stone and TNT.
 * A giant slingshot rises behind the west wall, the birds line up on top of the wall, and it
 * dawns on you (and on your face: a snout). Six birds get fired over the wall at you, aimed a
 * little better each time: Red, the Blues (split in three), Chuck (zooms at you), Bomb (goes off
 * after landing), Red again (leads you, lobs over cover) and Terence (huge; goes through
 * everything). Hide behind the heavy stuff, move when you see the aim. Everything they break
 * scores them points on the board on the north wall. Survive them all and it's LEVEL FAILED
 * (for the birds), and the exit opens.
 */

// --- Tuning -----------------------------------------------------------------------------------
const SPAWN: Vec3 = [1.2, 0, -0.4];
const EXIT_Z = 5;
/** The slingshot's base, outside the west wall (it faces east, +x). */
const SLING_BASE: Vec3 = [-17, -0.1, 0];
/** The west wall: its middle (x) and top. Birds queue along its top. */
const WALL_X = -CHAMBER_HALF - 0.5;
const WALL_TOP = WALL_HEIGHT;
/** Script times, in seconds after the arrival: the slingshot rises, the birds perch on the wall, the penny drops. */
const RISE_AT = 1.0;
const RISE_TIME = 3.2;
const PERCH_AT = 3.0;
const PERCH_GAP = 0.32;
const REVEAL_AT = 6.2;
const FIRST_SHOT_AT = 8.2;
/** Per shot: hop into the pouch, pull back and aim, hold still (aim locked), then let go. */
const LOAD_TIME = 1.0;
const AIM_TIME = 2.2;
const HOLD_TIME = 0.55;
/** How far the pouch is pulled back (m). */
const PULL = 4.2;
/** Birds fly at this share of normal gravity (floaty, Angry Birds-style), until they hit something. */
const FLIGHT_GRAVITY = 0.5;
const G = 20 * FLIGHT_GRAVITY;
/** A bird is deadly while faster than this (m/s); Terence at any real speed. */
const LETHAL_SPEED = 6;
const TERENCE_LETHAL_SPEED = 2.5;
/** A sudden speed change (m/s in one physics step) that counts as hitting something. */
const BIRD_IMPACT_DV = 2.5;
const BLOCK_EVENT_DV = 1.2;
/** The Blues split this far into their flight, fanning out by this angle (rad). */
const SPLIT_AT = 0.45;
const SPLIT_ANGLE = 0.24;
/** Chuck zooms at you this far into his flight, at this speed (m/s), in a straight line. */
const DASH_AT = 0.52;
const DASH_SPEED = 27;
/** Bomb's fuse after he lands (s). */
const BOMB_FUSE = 2.2;
/** After a shot's birds have all landed, wait this long (s) before the next one hops in. */
const SETTLE = 1.4;
/** TNT: seconds from being set off to going off (chains ripple). */
const TNT_DELAY = 0.12;
/**
 * Explosions. Players: damage = (safe / d)² × the share of the blast getting through to head,
 * chest and pelvis (each loose thing in the way passes 1 / (1 + mass / 40 kg), walls nothing);
 * ≥ 1 kills, ≥ 0.35 knocks you down. Blocks: strength × material.blast / d².
 */
const TNT_BLAST = { safe: 4.2, strength: 1, push: 900, maxSpeed: 14, range: 9 };
const BOMB_BLAST = { safe: 5.6, strength: 1.6, push: 1700, maxSpeed: 18, range: 12 };
const KNOCKDOWN = 0.35;
const COVER_MASS = 40;
/** A stone block moving at least this fast (m/s) into your head or chest squashes you. */
const SQUASH_SPEED = 4;
/** Points: the birds' board; a popped pig is worth this; the three stars. */
const PIG_POINTS = 5000;
const STARS = [10000, 20000, 30000];
const DEATH_SCREEN_DELAY = 1.8;
const CONTROLS = 'WASD move · Shift sprint · Space jump · Hold left click carry · Right-click throw';

type ShotKind = 'red' | 'blues' | 'chuck' | 'bomb' | 'terence';

interface ShotSpec {
  kind: ShotKind;
  bird: BirdKind;
  name: string;
  quip: string;
  color: string;
  /** Planned flight time (s); stretched if the arc wouldn't clear the wall. */
  flight: number;
  /** How much of your velocity (× flight time) it aims ahead of you. */
  lead: number;
  /** Random aim error (m). */
  error: number;
  /** Lobs over cover when the flat arc would hit something first. */
  smart?: boolean;
}

const SHOTS: ShotSpec[] = [
  { kind: 'red', bird: 'red', name: 'RED', quip: 'Nothing personal, pig.', color: '#ff5a4a', flight: 2.0, lead: 0, error: 0.7 },
  { kind: 'blues', bird: 'blue', name: 'THE BLUES', quip: "We're on a mission from God.", color: '#7ab8ff', flight: 2.1, lead: 0.35, error: 0.4 },
  { kind: 'chuck', bird: 'chuck', name: 'CHUCK', quip: 'I feel the need. The need for speed.', color: '#ffd84a', flight: 2.0, lead: 0.4, error: 0.3 },
  { kind: 'bomb', bird: 'bomb', name: 'BOMB', quip: 'Has a short fuse. Literally.', color: '#c8c8d0', flight: 2.1, lead: 0.7, error: 0.6 },
  { kind: 'red', bird: 'red', name: 'RED AGAIN', quip: "I'll be back. (He's back.)", color: '#ff5a4a', flight: 1.9, lead: 1, error: 0.25, smart: true },
  { kind: 'terence', bird: 'terence', name: 'TERENCE', quip: '...', color: '#ff8a7a', flight: 2.5, lead: 0.85, error: 0.4 },
];

const REVEAL_QUIPS = [
  "You took their eggs. Didn't you.",
  'That explains the snout.',
  'In fairness, you do look like one.',
  'Oink responsibly.',
];
const POPPED_QUIPS: Record<ShotKind, string[]> = {
  red: ['Red would like it known that it was nothing personal. It was a bit personal.', 'Pop goes the piggy.'],
  blues: ['Three birds, one pig.', 'The Blues are doing a little dance. It is not a nice dance.'],
  chuck: ['He felt the need. You felt the speed.', 'Chuck was fast. You were stationary.'],
  bomb: ['Hit by a bomb that did not even need to go off.', 'Bomb is embarrassed for you.'],
  terence: ['Terence did not say anything. Terence never does.', 'Flattened by forty stone of bird.'],
};
const HINTS: Record<ShotKind, string> = {
  red: 'They shoot from the west. Put something heavy between you and the slingshot, and move when you see where it\'s aiming.',
  blues: 'The Blues split in three halfway there. Get well clear sideways, or behind something solid.',
  chuck: 'Chuck zooms straight at where you ARE when he speeds up. Keep moving, or keep stone between you and him.',
  bomb: 'They shoot from the west. Put something heavy between you and the slingshot, and move when you see where it\'s aiming.',
  terence: 'Nothing stops Terence, least of all your fortress. Watch where he\'s aimed and get out of the way.',
};

const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

// --- Sounds ---------------------------------------------------------------------------------------
const sound = {
  squawk(pitch = 1) {
    tone(900 * pitch * rand(0.9, 1.15), 0.1, { to: 1500 * pitch, wave: 'square', vol: 0.04 });
    tone(1300 * pitch, 0.08, { to: 800 * pitch, wave: 'square', vol: 0.03, at: 0.09 });
  },
  battleCry(pitch = 1) {
    tone(380 * pitch, 0.75, { to: 620 * pitch, wave: 'sawtooth', vol: 0.08, attack: 0.05 });
    tone(760 * pitch, 0.6, { to: 1100 * pitch, wave: 'square', vol: 0.025, attack: 0.05 });
  },
  creak(pull: number) {
    noise(0.28, { freq: 260 + pull * 260, to: 180 + pull * 200, type: 'bandpass', q: 12, vol: 0.35 });
    tone(60 + pull * 50, 0.25, { to: 50 + pull * 40, wave: 'sawtooth', vol: 0.035 });
  },
  twang() {
    tone(105, 0.7, { to: 62, wave: 'triangle', vol: 0.4 });
    tone(210, 0.4, { to: 140, wave: 'sawtooth', vol: 0.07 });
    noise(0.18, { freq: 2200, to: 400, vol: 0.25 });
  },
  rumble() {
    noise(3.2, { freq: 220, to: 70, vol: 0.45 });
    for (let i = 0; i < 5; i++) tone(55 + i * 6, 0.5, { to: 45, wave: 'sawtooth', vol: 0.05, at: i * 0.55 });
  },
  wood() {
    noise(0.2, { freq: 1700, to: 450, type: 'bandpass', q: 1.4, vol: 0.4 });
    tone(230, 0.1, { to: 110, wave: 'square', vol: 0.05 });
  },
  glass() {
    noise(0.35, { freq: 5500, type: 'highpass', vol: 0.28 });
    for (let i = 0; i < 5; i++) tone(rand(2400, 5200), rand(0.12, 0.35), { wave: 'sine', vol: 0.05, at: i * 0.03 });
  },
  stone() {
    noise(0.4, { freq: 520, to: 140, vol: 0.5 });
    tone(80, 0.3, { to: 48, wave: 'sine', vol: 0.3 });
  },
  knock(vol: number) {
    tone(rand(160, 220), 0.08, { to: 90, wave: 'triangle', vol: 0.12 * vol });
    noise(0.07, { freq: 900, to: 300, vol: 0.15 * vol });
  },
  oink(at = 0) {
    for (let i = 0; i < 2; i++) {
      tone(310, 0.13, { to: 210, wave: 'sawtooth', vol: 0.11, at: at + i * 0.22 });
      noise(0.1, { freq: 650, to: 320, type: 'bandpass', q: 6, vol: 0.3, at: at + i * 0.22 });
    }
  },
  squeal() {
    tone(650, 0.45, { to: 1500, wave: 'sawtooth', vol: 0.11 });
    noise(0.5, { freq: 900, to: 250, vol: 0.35, at: 0.05 });
  },
  pigLaugh(at = 0) {
    for (let i = 0; i < 7; i++) {
      const t = at + i * 0.16 + (i > 3 ? (i - 3) * 0.05 : 0);
      noise(0.08, { freq: 520, to: 240, type: 'bandpass', q: 5, vol: 0.4, at: t });
      tone(270 - i * 9, 0.09, { to: 190, wave: 'sawtooth', vol: 0.1, at: t });
    }
  },
  whoosh() {
    noise(0.5, { freq: 700, to: 3500, type: 'bandpass', q: 2, vol: 0.35 });
    tone(500, 0.35, { to: 1300, wave: 'sine', vol: 0.08 });
  },
  tick(k: number) {
    tone(1500 + k * 900, 0.03, { wave: 'square', vol: 0.07 });
  },
  star(i: number) {
    tone(880 * Math.pow(1.26, i), 0.35, { wave: 'sine', vol: 0.18 });
    tone(1760 * Math.pow(1.26, i), 0.25, { wave: 'sine', vol: 0.05, at: 0.05 });
  },
  sag() {
    tone(330, 1.3, { to: 110, wave: 'sawtooth', vol: 0.08, attack: 0.05 });
    noise(1.0, { freq: 300, to: 120, type: 'bandpass', q: 8, vol: 0.25 });
  },
};

// --- Particles ------------------------------------------------------------------------------------
const enum Kind { Splinter, Shard, Chunk, Dust, Smoke, Feather, Trail }
const MAX_PARTICLES = 320;

interface Particle {
  active: boolean;
  kind: Kind;
  pos: Vec3;
  vel: Vec3;
  axis: Vec3;
  angle: number;
  spin: number;
  size: Vec3;
  grow: number;
  age: number;
  life: number;
  opacity: number;
  item: DrawItem;
}

const WOOD_BITS = [0.8, 0.55, 0.28];
const GLASS_BITS = [0.7, 0.9, 1.0];
const STONE_BITS = [0.58, 0.58, 0.62];
const DUST = [0.72, 0.64, 0.52];
const STONE_DUST = [0.7, 0.7, 0.72];
const SMOKE_DARK = [0.16, 0.15, 0.14];
const PIG_SMOKE = [0.45, 0.85, 0.3];
const TRAIL = [0.97, 0.97, 0.97];
const FEATHERS: Record<BirdKind, number[]> = {
  red: [0.86, 0.1, 0.07], blue: [0.35, 0.62, 0.96], chuck: [1, 0.84, 0.12], bomb: [0.15, 0.15, 0.17], terence: [0.5, 0.06, 0.05],
};

/** Writes axis-angle rotation × scale + translation into `m` (column-major), allocation-free. */
function writeModel(m: Mat4, pos: Vec3, axis: Vec3, angle: number, size: Vec3) {
  const [x, y, z] = axis;
  const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  m[0] = (t * x * x + c) * size[0]; m[1] = (t * x * y + s * z) * size[0]; m[2] = (t * x * z - s * y) * size[0]; m[3] = 0;
  m[4] = (t * x * y - s * z) * size[1]; m[5] = (t * y * y + c) * size[1]; m[6] = (t * y * z + s * x) * size[1]; m[7] = 0;
  m[8] = (t * x * z + s * y) * size[2]; m[9] = (t * y * z - s * x) * size[2]; m[10] = (t * z * z + c) * size[2]; m[11] = 0;
  m[12] = pos[0]; m[13] = pos[1]; m[14] = pos[2]; m[15] = 1;
}

function randomUnit(): Vec3 {
  for (;;) {
    const v: Vec3 = [rand(-1, 1), rand(-1, 1), rand(-1, 1)];
    const l = length(v);
    if (l > 0.1 && l <= 1) return scale(v, 1 / l);
  }
}

/** A bird's frame facing along `dir` (local -z), level-ish (local +y as close to up as it gets). */
function facingFrame(dir: Vec3, pos: Vec3): Mat4 {
  const back = scale(normalize(dir), -1);
  const helper: Vec3 = Math.abs(back[1]) > 0.98 ? [1, 0, 0] : [0, 1, 0];
  const x = normalize(cross(helper, back));
  const y = cross(back, x);
  return basis(x, y, back, pos);
}

/** Distance from point p to the segment a-b. */
function segDist(a: Vec3, b: Vec3, p: Vec3) {
  const ab = sub(b, a), ap = sub(p, a);
  const len2 = dot(ab, ab);
  const t = len2 > 1e-9 ? clamp(dot(ap, ab) / len2, 0, 1) : 0;
  return length(sub(p, add(a, scale(ab, t))));
}

/** Rough radius of each body part, for bird hits. */
const PART_RADIUS: Record<string, number> = {
  head: 0.21, chest: 0.3, pelvis: 0.22, upperArmL: 0.09, upperArmR: 0.09, foreArmL: 0.09, foreArmR: 0.09,
  thighL: 0.12, thighR: 0.12, shinL: 0.1, shinR: 0.1,
};

// --- Birds -----------------------------------------------------------------------------------------

interface Perched {
  bird: BirdKind;
  shot: number;
  pos: Vec3;
  /** Where it's hopping to along the wall top. */
  goal: Vec3;
  /** Hop animation: 0..1 while hopping (-1 idle). */
  hop: number;
  hopFrom: Vec3;
  /** Seconds until it appears (it pops up from behind the wall). */
  appear: number;
  shown: boolean;
  blink: number;
  yaw: number;
}

interface Flyer {
  shot: ShotSpec;
  bird: BirdKind;
  r: number;
  body: Body;
  prev: Vec3;
  lastVel: Vec3;
  age: number;
  /** Planned flight time (for the Blues' split and Chuck's dash). */
  flight: number;
  /** Seconds since it first hit something (-1: still flying). */
  landed: number;
  justLanded: boolean;
  /** The frame it had in flight, kept when it lands so it doesn't snap round. */
  frame: Mat4;
  trailT: number;
  trailBig: boolean;
  split: boolean;
  dashing: boolean;
  /** Bomb: seconds left on the fuse (-1 = not lit). */
  fuse: number;
  gone: boolean;
  blink: number;
}

interface Death {
  t: number;
  big: string;
  small: string;
  hint: string;
}

interface Blast {
  pos: Vec3;
  t: number;
  size: number;
}

interface Popup {
  label: WorldLabel;
  t: number;
}

type Phase = 'intro' | 'load' | 'aim' | 'hold' | 'flight' | 'end';

export class BirdsLevel implements Level {
  readonly number: number;
  readonly title = 'Angry Birds';
  status: LevelStatus = 'playing';

  private arrival: PortalArrival;
  private exit = new ExitPortal(EXIT_Z);
  private sling = new Slingshot(SLING_BASE);
  private blocks: Block[] = [];
  private perched: Perched[] = [];
  private flyers: Flyer[] = [];
  private particles: Particle[] = [];
  private nextParticle = 0;
  private blasts: Blast[] = [];
  private scorches: Vec3[] = [];
  private popups: Popup[] = [];

  private time = 0;
  /** Seconds since the arrival finished (-1 before). */
  private since = -1;
  private phase: Phase = 'intro';
  private phaseT = 0;
  private shotIndex = 0;
  /** The bird in the pouch (from loading until it's let go). */
  private loaded: Perched | null = null;
  private aimError: Vec3 = [0, 0, 0];
  private launchVel: Vec3 = [1, 0, 0];
  private launchT = 2;
  private creakT = 0;
  private endT = -1;
  private pigPop = 0;
  private revealed = false;
  private death: Death | null = null;
  private pendingDeath: { kind: 'squash'; vel: Vec3 } | null = null;

  private score = 0;
  private shownScore = 0;
  private scoreText: PixelText;
  private scoreRefresh = 0;
  private starsLit = 0;
  private starPop = [0, 0, 0];

  private nameLabel: WorldLabel = { pos: [0, 0, 0], text: '', size: 1.1, color: '#fff' };
  private quipLabel: WorldLabel = { pos: [0, 0, 0], text: '', size: 0.55, color: '#fff' };
  private labelList: WorldLabel[] = [];
  private breakSounds = 0;
  private knockSounds = 0;
  private skipTo = 0;

  constructor(private ctx: LevelContext) {
    this.number = ctx.number;
    const { hud, physics } = ctx;
    hud.setLevel(`The Chamber · Level ${this.number}`);
    hud.show(`LEVEL ${this.number}`, '', 2.5);
    hud.hint('');
    this.arrival = new PortalArrival(ctx, SPAWN);
    const params = new URLSearchParams(location.search);
    // `?birdShot=N` starts with the Nth bird (for testing).
    this.skipTo = clamp((Number(params.get('birdShot')) || 1) - 1, 0, SHOTS.length - 1);
    this.shotIndex = this.skipTo;

    this.buildFortress();
    this.perchBirds();

    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.particles.push({
        active: false, kind: Kind.Dust, pos: [0, 0, 0], vel: [0, 0, 0], axis: [0, 1, 0], angle: 0, spin: 0, size: [1, 1, 1], grow: 0,
        age: 0, life: 1, opacity: 1, item: { mesh: 'sphere', model: new Float32Array(16), color: DUST, shadow: false },
      });
    }
    for (let i = 0; i < 12; i++) this.popups.push({ label: { pos: [0, 0, 0], text: '', size: 0.55, color: '#fff' }, t: -1 });

    this.scoreText = new PixelText({
      centre: [0, 6.7, -CHAMBER_HALF + 0.07], right: [1, 0, 0], up: [0, 1, 0], pixel: 0.16,
      color: [1.35, 1.3, 1.15], pattern: Pattern.emissive, depth: 0.05,
    }, 'BIRDS: 0');

    physics.postStepHooks.push(() => this.afterStep());
  }

  // --- Setting up ----------------------------------------------------------------------------------

  private add(material: Material, x: number, y0: number, z: number, sx: number, sy: number, sz: number) {
    this.blocks.push(spawnBlock(this.ctx.physics, material, [x, y0 + sy / 2 + 0.002, z], [sx, sy, sz]));
  }

  /**
   * The pig's fortress: a west wall, two three-storey towers, the pig's house in the middle (with
   * TNT in it, naturally), and loose planks and blocks lying about to build with. Heights are
   * bottoms (y0), so pieces stack exactly.
   */
  private buildFortress() {
    const W = (x: number, y: number, z: number, sx: number, sy: number, sz: number) => this.add('wood', x, y, z, sx, sy, sz);
    const Gl = (x: number, y: number, z: number, sx: number, sy: number, sz: number) => this.add('glass', x, y, z, sx, sy, sz);
    const S = (x: number, y: number, z: number, sx: number, sy: number, sz: number) => this.add('stone', x, y, z, sx, sy, sz);
    const T = (x: number, y: number, z: number) => this.add('tnt', x, y, z, 0.8, 0.8, 0.8);

    // West wall: stone blocks, planks across them, glass panes on the planks.
    for (const z of [-2.2, 0, 2.2]) S(-7.5, 0, z, 1, 1, 1);
    for (const z of [-1.1, 1.1]) {
      W(-7.5, 1.0, z, 0.6, 0.22, 2.1);
      Gl(-7.5, 1.22, z, 0.14, 1.3, 2.0);
    }

    // North tower: posts under a stone roof; then posts, a glass wall and a plank roof; TNT on top.
    const nx = -4.6, nz = -5.2;
    for (const dx of [-1.05, 1.05]) for (const dz of [-1.05, 1.05]) W(nx + dx, 0, nz + dz, 0.3, 2.1, 0.3);
    S(nx, 2.1, nz, 2.7, 0.3, 2.7);
    for (const dx of [-1.05, 1.05]) for (const dz of [-1.05, 1.05]) W(nx + dx, 2.4, nz + dz, 0.25, 1.6, 0.25);
    Gl(nx - 1.05, 2.4, nz, 0.12, 1.6, 1.8);
    for (const dz of [-0.62, 0.62]) W(nx, 4.0, nz + dz, 2.7, 0.22, 1.24);
    T(nx, 4.22, nz);

    // South tower: stone pillars under a plank roof; a glass box with a stone on top; wood squares.
    const sx = -4.6, sz = 5.2;
    for (const dx of [-1.05, 1.05]) for (const dz of [-1.05, 1.05]) S(sx + dx, 0, sz + dz, 0.5, 2.1, 0.5);
    for (const dz of [-1.05, 1.05]) W(sx, 2.1, sz + dz, 2.6, 0.22, 0.5);
    for (const dx of [-0.9, 0, 0.9]) W(sx + dx, 2.32, sz, 0.86, 0.2, 2.6);
    Gl(sx - 0.45, 2.52, sz, 1.1, 1.1, 1.1);
    S(sx - 0.45, 3.62, sz, 0.9, 0.9, 0.9);
    W(sx + 0.8, 2.52, sz - 0.6, 0.8, 0.8, 0.8);
    W(sx + 0.8, 2.52, sz + 0.6, 0.8, 0.8, 0.8);

    // The pig's house: a stone and glass west wall, posts, a plank roof. TNT in the living room.
    const hx = -1.6;
    for (const dz of [-0.8, 0.8]) S(hx - 1.4, 0, dz, 1, 1, 1);
    Gl(hx - 1.4, 1.0, 0, 0.14, 1.0, 2.6);
    W(hx - 1.4, 2.0, 0, 0.5, 0.25, 3.3);
    for (const dz of [-1.45, 1.45]) W(hx + 1.3, 0, dz, 0.3, 2.0, 0.3);
    W(hx + 1.3, 2.0, 0, 0.35, 0.25, 3.3);
    for (const dz of [-1.2, -0.4, 0.4, 1.2]) W(hx, 2.25, dz, 3.4, 0.2, 0.78);
    Gl(hx - 0.6, 2.45, -0.5, 0.8, 0.8, 0.8);
    W(hx + 0.6, 2.45, 0.5, 0.8, 0.8, 0.8);
    T(hx - 0.3, 0, 0.9);

    // Out east: a stack of squares, a glass pane, and loose planks and blocks to build cover with.
    W(3, 0, -2.5, 0.9, 0.9, 0.9);
    W(3, 0.9, -2.5, 0.9, 0.9, 0.9);
    Gl(3, 1.8, -2.5, 0.9, 0.9, 0.9);
    Gl(2.2, 0, 2.2, 0.14, 1.6, 2.2);
    W(4.5, 0, 2.8, 2.4, 0.22, 0.45);
    W(4.7, 0.22, 3.1, 2.4, 0.22, 0.45);
    W(4.2, 0, -5, 0.3, 0.3, 2.4);
    W(1.2, 0, -5.2, 0.9, 0.9, 0.9);
    S(5.5, 0, -1.2, 0.7, 0.7, 0.7);
    S(0.6, 0, 4.4, 0.7, 0.7, 0.7);
    Gl(6, 0, 0.6, 1.6, 1.2, 0.14);
    T(4.2, 0, 6.4);
  }

  private perchBirds() {
    // One bird per shot along the top of the west wall, nearest the slingshot first.
    let z = 1.6;
    SHOTS.forEach((shot, i) => {
      if (i < this.skipTo) return;
      const r = BIRD_RADIUS[shot.bird];
      z += r;
      const pos: Vec3 = [WALL_X, WALL_TOP + r, z];
      this.perched.push({
        bird: shot.bird, shot: i, pos: [...pos], goal: [...pos], hop: -1, hopFrom: [...pos],
        appear: PERCH_AT + (i - this.skipTo) * PERCH_GAP, shown: false, blink: rand(1, 4), yaw: Math.PI / 2,
      });
      z += r + 0.35;
    });
  }

  // --- Update --------------------------------------------------------------------------------------

  update(dt: number) {
    const { player, hud } = this.ctx;
    this.time += dt;
    const death = this.death;
    if (death && this.status === 'playing') {
      death.t += dt;
      if (death.t > DEATH_SCREEN_DELAY) {
        this.status = 'lost';
        hud.show(death.big, `${death.small}\nPress R to try again.`);
        hud.tips([['Hint', death.hint], ['Controls', CONTROLS]]);
      }
    }
    this.arrival.update(dt);
    this.exit.update(dt, player);
    if (this.exit.entered && this.status === 'playing') this.status = 'exited';
    if (this.since < 0 && this.arrival.done) this.since = 0;
    else if (this.since >= 0) this.since += dt;

    this.breakSounds = Math.max(0, this.breakSounds - dt * 20);
    this.knockSounds = Math.max(0, this.knockSounds - dt * 12);

    if (this.pendingDeath && !this.death) this.squashed(this.pendingDeath.vel);
    this.pendingDeath = null;

    this.script(dt);
    this.updatePerched(dt);
    this.updateFlyers(dt);
    this.updateBlocks(dt);
    this.updateParticles(dt);
    this.sling.update(dt);
    this.updateScore(dt);

    // The pig reveal: snout and ears pop on.
    if (this.revealed) this.pigPop = Math.min(1, this.pigPop + dt * 2.2);
    for (const b of this.blasts) b.t += dt;
    if (this.blasts.length && this.blasts[0].t > 1) this.blasts.shift();
  }

  /** The level's timeline: slingshot up, birds perched, then one shot after another. */
  private script(dt: number) {
    const { player, hud, camera } = this.ctx;
    const s = this.since;
    if (s < 0) return;
    this.phaseT += dt;
    const was = s - dt;
    if (was < RISE_AT && s >= RISE_AT) {
      sound.rumble();
      camera.addShake(0.35);
    }
    this.sling.rise = clamp((s - RISE_AT) / RISE_TIME, 0, 1);
    if (!this.revealed && s >= REVEAL_AT) {
      this.revealed = true;
      if (!this.death) {
        hud.show('YOU ARE THE PIG.', pick(REVEAL_QUIPS), 3.2);
        sound.oink();
      }
    }
    const alive = !this.death && player.mode !== 'ragdoll';

    switch (this.phase) {
      case 'intro':
        if (s >= FIRST_SHOT_AT) this.startLoad();
        break;
      case 'load': {
        const p = this.loaded!;
        const k = clamp(this.phaseT / LOAD_TIME, 0, 1);
        // A big hop from the wall top up into the pouch.
        const pouch = this.pouchSeat(p);
        const flat = add(p.hopFrom, scale(sub(pouch, p.hopFrom), k));
        p.pos = [flat[0], flat[1] + 2.5 * 4 * k * (1 - k), flat[2]];
        if (k >= 1) {
          this.phase = 'aim';
          this.phaseT = 0;
          this.creakT = 0;
        }
        break;
      }
      case 'aim':
      case 'hold': {
        const p = this.loaded!;
        const shot = SHOTS[p.shot];
        if (this.phase === 'aim') {
          // Pull back while tracking where the pig will be.
          const { v, T } = this.aim(shot);
          this.launchVel = v;
          this.launchT = T;
          this.creakT -= dt;
          if (this.creakT <= 0) {
            sound.creak(clamp(this.phaseT / 0.8, 0, 1));
            this.creakT = 0.42;
          }
          if (this.phaseT >= AIM_TIME) {
            this.phase = 'hold';
            this.phaseT = 0;
          }
        } else if (this.phaseT >= HOLD_TIME) {
          this.launch(p, shot);
          break;
        }
        const pull = PULL * easeInOut(clamp(this.phaseT / 0.8 + (this.phase === 'hold' ? 1 : 0), 0, 1));
        const dir = normalize(this.launchVel);
        const tremble: Vec3 = this.phase === 'hold' ? [0, Math.sin(this.time * 60) * 0.03, 0] : [0, 0, 0];
        this.sling.pullTo(add(sub(this.sling.restPouch(), scale(dir, pull)), tremble), dir);
        p.pos = this.pouchSeat(p);
        break;
      }
      case 'flight': {
        if (this.flightResolved()) {
          if (alive) this.missed();
          this.nextShot();
        }
        break;
      }
      case 'end': {
        this.endT += dt;
        this.sling.sag = easeInOut(clamp(this.endT / 1.6, 0, 1));
        if (this.endT >= 1.4 && !this.exit.open && !this.death) this.exit.openNow();
        break;
      }
    }

    // Labels: the loaded bird's name and quip over the slingshot.
    const showName = this.loaded && (this.phase === 'load' || this.phase === 'aim' || this.phase === 'hold');
    if (showName) {
      const shot = SHOTS[this.loaded!.shot];
      const top = add(this.sling.restPouch(), [0, 4.6, 0]);
      this.nameLabel.pos = top;
      this.nameLabel.text = shot.name;
      this.nameLabel.color = shot.color;
      this.quipLabel.pos = add(top, [0, -1.25, 0]);
      this.quipLabel.text = shot.quip;
    } else {
      this.nameLabel.text = this.quipLabel.text = '';
    }
  }

  /** Where the loaded bird sits in the pouch. */
  private pouchSeat(p: Perched): Vec3 {
    const dir = normalize(this.launchVel);
    return add(this.sling.pouch, scale(dir, BIRD_RADIUS[p.bird] * 0.55 + 0.15));
  }

  private startLoad() {
    const p = this.perched.find((b) => b.shot === this.shotIndex);
    if (!p) {
      this.finish();
      return;
    }
    this.loaded = p;
    p.hopFrom = [...p.pos];
    p.hop = -1;
    this.phase = 'load';
    this.phaseT = 0;
    this.launchVel = [1, 0.3, 0];
    // A fixed aim error for this shot.
    const shot = SHOTS[p.shot];
    const a = Math.random() * Math.PI * 2, e = Math.sqrt(Math.random()) * shot.error;
    this.aimError = [Math.cos(a) * e, 0, Math.sin(a) * e];
    sound.squawk(p.bird === 'terence' ? 0.45 : p.bird === 'blue' ? 1.4 : 1);
    // The rest shuffle up toward the slingshot.
    let z = 1.6;
    for (const q of this.perched) {
      if (q === p || q.shot < this.shotIndex) continue;
      const r = BIRD_RADIUS[q.bird];
      z += r;
      if (Math.abs(q.goal[2] - z) > 0.01) {
        q.goal = [WALL_X, WALL_TOP + r, z];
        q.hopFrom = [...q.pos];
        q.hop = 0;
      }
      z += r + 0.35;
    }
  }

  /** Where to aim: at the pig's chest, ahead of them by the shot's lead, plus the shot's error. */
  private aim(shot: ShotSpec): { v: Vec3; T: number } {
    const { player } = this.ctx;
    const from = this.pouchSeat(this.loaded!);
    const chest = add(player.pos, [0, 1.15, 0]);
    let T = shot.flight;
    let target = chest;
    // Iterate once so the lead uses about the right flight time.
    let solved = { v: [1, 0, 0] as Vec3, T };
    for (let i = 0; i < 2; i++) {
      target = add(chest, add([player.vel[0] * T * shot.lead, 0, player.vel[2] * T * shot.lead], this.aimError));
      target[0] = clamp(target[0], -CHAMBER_HALF + 0.6, CHAMBER_HALF - 0.6);
      target[2] = clamp(target[2], -CHAMBER_HALF + 0.6, CHAMBER_HALF - 0.6);
      solved = this.solve(from, target, shot.flight, BIRD_RADIUS[shot.bird]);
      T = solved.T;
    }
    if (shot.smart && this.blocked(from, solved.v, solved.T, target)) {
      // Lob it over whatever's in the way instead.
      for (const extra of [0.7, 1.3]) {
        const lob = this.solve(from, target, shot.flight + extra, BIRD_RADIUS[shot.bird]);
        if (!this.blocked(from, lob.v, lob.T, target)) return lob;
      }
    }
    return solved;
  }

  /** Launch velocity reaching `target` in about `flight` s (longer if needed to clear the wall). */
  private solve(from: Vec3, target: Vec3, flight: number, r: number): { v: Vec3; T: number } {
    let v: Vec3 = [1, 0, 0];
    for (let T = flight; T < 5; T += 0.1) {
      v = [(target[0] - from[0]) / T, (target[1] - from[1] + 0.5 * G * T * T) / T, (target[2] - from[2]) / T];
      let ok = true;
      for (const wx of [WALL_X - 0.5 - r, WALL_X + 0.5 + r]) {
        const t = (wx - from[0]) / v[0];
        if (t <= 0 || t > T) continue;
        if (from[1] + v[1] * t - 0.5 * G * t * t < WALL_TOP + r + 0.4) ok = false;
      }
      if (ok) return { v, T };
    }
    return { v, T: 5 };
  }

  /** True if the arc's last stretch runs into something before reaching the target. */
  private blocked(from: Vec3, v: Vec3, T: number, target: Vec3): boolean {
    const { physics } = this.ctx;
    const at = (t: number): Vec3 => [from[0] + v[0] * t, from[1] + v[1] * t - 0.5 * G * t * t, from[2] + v[2] * t];
    let prev = at(T * 0.55);
    for (let i = 1; i <= 8; i++) {
      const p = at(T * (0.55 + (0.45 * i) / 8));
      const d = sub(p, prev);
      const len = length(d);
      const hit = physics.raycast(prev, scale(d, 1 / len), len, undefined, GROUPS_QUERY_WORLD);
      if (hit && length(sub(hit.point, target)) > 1.3) return true;
      prev = p;
    }
    return false;
  }

  private launch(p: Perched, shot: ShotSpec) {
    const from = this.pouchSeat(p);
    this.sling.release();
    sound.twang();
    sound.battleCry(p.bird === 'terence' ? 0.5 : p.bird === 'blue' ? 1.5 : p.bird === 'chuck' ? 1.25 : 1);
    this.perched.splice(this.perched.indexOf(p), 1);
    this.loaded = null;
    // Last shot's trail goes; this one's starts.
    for (const q of this.particles) if (q.active && q.kind === Kind.Trail) q.active = false;
    this.addFlyer(shot, p.bird, from, this.launchVel, this.launchT);
    this.phase = 'flight';
    this.phaseT = 0;
  }

  private addFlyer(shot: ShotSpec, bird: BirdKind, pos: Vec3, vel: Vec3, flight: number): Flyer {
    const { physics } = this.ctx;
    const r = BIRD_RADIUS[bird];
    const frame = facingFrame(vel, pos);
    const body = physics.addBall(pos, r, {
      mass: BIRD_MASS[bird], restitution: 0.35, friction: 0.8, hidden: true, grabbable: bird !== 'terence', rotation: toQuat(frame),
    });
    body.rb.setGravityScale(FLIGHT_GRAVITY, true);
    body.rb.setLinvel({ x: vel[0], y: vel[1], z: vel[2] }, true);
    const f: Flyer = {
      shot, bird, r, body, prev: [...pos], lastVel: [...vel], age: 0, flight, landed: -1, justLanded: false, frame,
      trailT: 0, trailBig: true, split: false, dashing: false, fuse: -1, gone: false, blink: rand(1, 3),
    };
    this.flyers.push(f);
    return f;
  }

  private flightResolved(): boolean {
    const live = this.flyers.filter((f) => !f.gone && f.shot === SHOTS[this.shotIndex]);
    if (this.phaseT > (SHOTS[this.shotIndex].kind === 'terence' ? 11 : 8)) return true;
    return live.every((f) => f.landed >= SETTLE + (f.bird === 'terence' ? 2 : 0) && f.fuse < 0 && (f.bird !== 'bomb' || f.gone));
  }

  private nextShot() {
    this.shotIndex++;
    if (this.shotIndex >= SHOTS.length) this.finish();
    else this.startLoad();
  }

  /** A shot that didn't get the pig: the birds on the wall hop about furiously. */
  private missed() {
    for (const q of this.perched) {
      if (q.hop < 0) {
        q.hopFrom = [...q.pos];
        q.hop = 0;
      }
    }
    if (this.perched.length) sound.squawk(1.2);
  }

  /** Out of birds: the slingshot wilts, LEVEL FAILED (for them), the pig laughs, the exit opens. */
  private finish() {
    if (this.phase === 'end') return;
    this.phase = 'end';
    this.endT = 0;
    if (this.death) return;
    const stars = STARS.filter((s) => this.score >= s).length;
    const starText = '★'.repeat(stars) + '☆'.repeat(3 - stars);
    this.ctx.hud.show('LEVEL FAILED', `Birds: ${fmt(this.score)} ${starText}\nThe pig lives. The birds are furious. (More than usual.)`, 5);
    sound.sag();
    sound.pigLaugh(0.8);
  }

  private updatePerched(dt: number) {
    const s = this.since;
    for (const p of this.perched) {
      if (!p.shown) {
        if (s >= 0 && s >= p.appear) {
          // Pops up from behind the wall with a squawk.
          p.shown = true;
          p.hopFrom = add(p.goal, [-1.5, -2.5, 0]);
          p.pos = [...p.hopFrom];
          p.hop = 0;
          sound.squawk(p.bird === 'terence' ? 0.45 : p.bird === 'blue' ? 1.4 : 1);
          if (p.bird === 'terence') sfx.thud(0.5);
        }
        continue;
      }
      if (p === this.loaded) continue;
      if (p.hop >= 0) {
        p.hop = Math.min(1, p.hop + dt * 2.6);
        const k = p.hop;
        const flat = add(p.hopFrom, scale(sub(p.goal, p.hopFrom), easeInOut(k)));
        p.pos = [flat[0], flat[1] + Math.sin(k * Math.PI) * (p.bird === 'terence' ? 0.4 : 0.8), flat[2]];
        if (k >= 1) p.hop = -1;
      }
      p.blink -= dt;
      if (p.blink < -0.12) p.blink = rand(1.5, 4.5);
      // Glare at the pig.
      const to = sub(this.ctx.player.pos, p.pos);
      p.yaw = Math.atan2(-to[0], -to[2]);
    }
  }

  private updateFlyers(dt: number) {
    const { player, camera } = this.ctx;
    const alive = !this.death && player.mode === 'control' && !player.inPortal;
    const frames = alive ? player.partFrames() : null;
    for (const f of this.flyers) {
      if (f.gone) continue;
      f.age += dt;
      f.blink -= dt;
      if (f.blink < -0.12) f.blink = rand(1.2, 3.5);
      const t = f.body.rb.translation();
      const pos: Vec3 = [t.x, t.y, t.z];
      const lv = f.body.rb.linvel();
      const vel: Vec3 = [lv.x, lv.y, lv.z];
      const speed = length(vel);

      if (f.justLanded) {
        f.justLanded = false;
        this.feathers(pos, f.bird, f.bird === 'terence' ? 12 : 5);
        if (f.bird === 'terence') {
          camera.addShake(Math.max(0.3, 1.2 - length(sub(player.pos, pos)) / 20));
          sfx.thud(0.9);
          for (let i = 0; i < 14; i++) this.dust(add(pos, [rand(-1.5, 1.5), -f.r + 0.3, rand(-1.5, 1.5)]), DUST, 0.6);
        } else sound.knock(1);
        if (f.bird === 'bomb') f.fuse = BOMB_FUSE;
      }

      if (f.landed < 0) {
        // In flight: specials, and the trail of puffs.
        if (f.bird === 'blue' && !f.split && f.shot.kind === 'blues' && f.age >= f.flight * SPLIT_AT) this.splitBlues(f, pos, vel);
        if (f.bird === 'chuck' && !f.dashing && f.age >= f.flight * DASH_AT) this.dash(f, pos);
        f.trailT -= dt;
        if (f.trailT <= 0) {
          f.trailT = f.dashing ? 0.025 : 0.05;
          const big = f.trailBig;
          f.trailBig = !big;
          const size = (big ? 0.17 : 0.1) * (f.bird === 'terence' ? 2 : f.bird === 'blue' ? 0.8 : 1);
          this.emit(Kind.Trail, sub(pos, scale(normalize(vel), f.r * 0.9)), [0, 0, 0], [size, size, size], 1e9, TRAIL);
        }
        f.frame = facingFrame(vel, pos);
      } else {
        f.landed += dt;
      }

      // Hitting the pig: tested along the whole step, fast birds skip a lot.
      const lethal = speed > (f.bird === 'terence' ? TERENCE_LETHAL_SPEED : LETHAL_SPEED);
      if (alive && frames && lethal && !this.death) {
        for (const name of PART_NAMES) {
          const m = frames[name];
          if (segDist(f.prev, pos, [m[12], m[13], m[14]]) < f.r + PART_RADIUS[name] + 0.04) {
            this.popped(f, pos, vel);
            break;
          }
        }
      }

      // Bomb's fuse.
      if (f.fuse >= 0) {
        const before = f.fuse;
        f.fuse -= dt;
        const period = lerp(0.35, 0.07, 1 - f.fuse / BOMB_FUSE);
        if (Math.floor(before / period) !== Math.floor(f.fuse / period)) sound.tick(1 - f.fuse / BOMB_FUSE);
        if (f.fuse <= 0) {
          f.fuse = -1;
          f.gone = true;
          this.ctx.physics.remove(f.body);
          this.explode(pos, BOMB_BLAST, 'bomb');
          continue;
        }
      }
      // Lost outside the chamber (e.g. clipped the wall top): gone.
      if (pos[1] < -5 || Math.abs(pos[0]) > 40 || Math.abs(pos[2]) > 40) {
        f.gone = true;
        this.ctx.physics.remove(f.body);
        continue;
      }
      f.prev = pos;
    }
  }

  /** The Blues: one becomes three, fanning out sideways. */
  private splitBlues(f: Flyer, pos: Vec3, vel: Vec3) {
    f.split = true;
    const side = normalize(cross(vel, [0, 1, 0]));
    for (const sgn of [-1, 1]) {
      const a = SPLIT_ANGLE * sgn;
      const c = Math.cos(a), s = Math.sin(a);
      const v: Vec3 = [vel[0] * c - vel[2] * s, vel[1] + sgn * 0.6, vel[0] * s + vel[2] * c];
      // Far enough apart that they don't bump into each other (which would count as landing).
      const g = this.addFlyer(f.shot, 'blue', add(pos, scale(side, -(2 * f.r + 0.15) * sgn)), v, f.flight);
      g.age = f.age;
      g.split = true;
    }
    for (let i = 0; i < 3; i++) sound.squawk(1.5 + i * 0.15);
    this.feathers(pos, 'blue', 4);
    for (let i = 0; i < 5; i++) this.dust(add(pos, randomUnit()), TRAIL, 0.35);
  }

  /** Chuck: SPEED! Straight at where the pig is right now. */
  private dash(f: Flyer, pos: Vec3) {
    const { player } = this.ctx;
    f.dashing = true;
    const chest = add(player.pos, [0, 1.1, 0]);
    const dir = normalize(sub(chest, pos));
    f.body.rb.setGravityScale(0, true);
    f.lastVel = scale(dir, DASH_SPEED);
    f.body.rb.setLinvel({ x: f.lastVel[0], y: f.lastVel[1], z: f.lastVel[2] }, true);
    sound.whoosh();
    for (let i = 0; i < 6; i++) this.dust(add(pos, scale(randomUnit(), 0.5)), TRAIL, 0.4);
  }

  private popped(f: Flyer, pos: Vec3, vel: Vec3) {
    const { player, camera } = this.ctx;
    const chest = add(player.pos, [0, 1.2, 0]);
    const dir = normalize(vel);
    player.kill(add(scale(dir, f.bird === 'terence' ? 14 : 9), [0, 5, 0]), { violence: f.bird === 'terence' ? 24 : 12, origin: pos });
    camera.addShake(0.8);
    sound.squeal();
    sfx.pop();
    for (let i = 0; i < 26; i++) {
      const d = randomUnit();
      this.emit(Kind.Smoke, add(chest, scale(d, 0.3)), add(scale(d, rand(1, 3.5)), [0, 0.8, 0]), [0.28, 0.28, 0.28], rand(1.2, 2.2), PIG_SMOKE, 1.6);
    }
    this.addScore(PIG_POINTS, chest, '#7dde4a');
    this.cheer();
    const kind = f.shot.kind;
    this.die('POPPED', pick(POPPED_QUIPS[kind]), HINTS[kind]);
  }

  private squashed(vel: Vec3) {
    const { player, camera } = this.ctx;
    player.kill(add(scale(normalize(vel), 3), [0, -2, 0]), { violence: 10 });
    camera.addShake(0.6);
    sound.squeal();
    this.addScore(PIG_POINTS, add(player.pos, [0, 1.2, 0]), '#7dde4a');
    this.cheer();
    this.die('SQUASHED', 'Your own house fell on you. The birds are taking the credit anyway.',
      "Stone falls hard. Don't shelter under a tower that's being shot at.");
  }

  /** The birds still on the wall celebrate. */
  private cheer() {
    for (const q of this.perched) {
      q.hopFrom = [...q.pos];
      q.hop = 0;
    }
  }

  private die(big: string, small: string, hint: string) {
    if (this.death) return;
    this.ctx.hud.hide();
    this.death = { t: 0, big, small, hint };
  }

  // --- Blocks, damage, explosions ------------------------------------------------------------------

  /** After every physics step: spot sudden hits on blocks and birds, and deal out the damage. */
  private afterStep() {
    const { physics, player } = this.ctx;
    const world = physics.world;
    const body = player.body;
    for (const b of this.blocks) {
      if (b.broken) continue;
      const lv = b.body.rb.linvel();
      const dv = Math.hypot(lv.x - b.lastVel[0], lv.y - b.lastVel[1], lv.z - b.lastVel[2]);
      b.lastVel[0] = lv.x; b.lastVel[1] = lv.y; b.lastVel[2] = lv.z;
      const def = MATERIALS[b.material];
      if (dv > BLOCK_EVENT_DV) {
        if (import.meta.env.DEV && dv > 2) this.debugLog.push(`dv ${b.material} ${dv.toFixed(1)}`);
        if (dv > def.dv0) this.damage(b, (dv - def.dv0) / def.dvScale);
        if (b.material === 'tnt' && dv > def.dv0) this.light(b, TNT_DELAY);
        this.crushPartners(b.body, b.body.rb.mass() * dv);
        if (dv > 3) this.knockSound(Math.min(1, dv / 10));
      }
      // Stone coming down on the pig.
      if (b.material === 'stone' && body && player.mode === 'control' && !this.death && !this.pendingDeath) {
        const speed = Math.hypot(lv.x, lv.y, lv.z);
        if (speed > SQUASH_SPEED && b.body.rb.mass() > 60) {
          world.contactPairsWith(b.body.collider, (other) => {
            const i = body.colliders.findIndex((c) => c.handle === other.handle);
            if (i < 0 || this.pendingDeath) return;
            const name = PART_NAMES[i];
            if (name === 'head' || name === 'chest') this.pendingDeath = { kind: 'squash', vel: [lv.x, lv.y, lv.z] };
          });
        }
      }
    }
    for (const f of this.flyers) {
      if (f.gone) continue;
      const lv = f.body.rb.linvel();
      const dv = Math.hypot(lv.x - f.lastVel[0], lv.y - f.lastVel[1], lv.z - f.lastVel[2]);
      f.lastVel = [lv.x, lv.y, lv.z];
      if (dv < BIRD_IMPACT_DV) continue;
      if (f.landed < 0) {
        f.landed = 0;
        f.justLanded = true;
        f.body.rb.setGravityScale(1, true);
        f.body.rb.setRotation(toQuat(f.frame), true);
        f.dashing = false;
      }
      const J = f.body.rb.mass() * dv;
      if (import.meta.env.DEV) this.debugLog.push(`bird ${f.bird} dv=${dv.toFixed(1)} J=${J.toFixed(0)}`);
      // Whatever it hit takes the blow; if the contact isn't there (fast hits), the nearest block does.
      if (!this.crushPartners(f.body, J)) {
        const t = f.body.rb.translation();
        const near = this.nearestBlock([t.x, t.y, t.z], f.r + 0.45);
        if (near) this.crush(near, J);
      }
    }
  }

  /** Crushes the blocks touching `body` by the impulse through each contact. Returns whether it touched any. */
  private crushPartners(body: Body, fallbackJ: number): boolean {
    const { physics } = this.ctx;
    const world = physics.world;
    let any = false;
    world.contactPairsWith(body.collider, (other) => {
      const b = this.blockFor(other);
      if (!b || b.broken) return;
      let J = 0;
      world.contactPair(body.collider, other, (manifold) => {
        for (let i = 0; i < manifold.numContacts(); i++) J += manifold.contactImpulse(i);
      });
      if (J <= 0) J = fallbackJ * 0.5;
      any = true;
      this.crush(b, J);
    });
    return any;
  }

  debugLog: string[] = [];
  private crush(b: Block, J: number) {
    const def = MATERIALS[b.material];
    if (import.meta.env.DEV && J > 20) this.debugLog.push(`crush ${b.material} J=${J.toFixed(0)}`);
    if (J <= def.j0) return;
    if (b.material === 'tnt') {
      this.light(b, TNT_DELAY);
      return;
    }
    this.damage(b, (J - def.j0) / def.jScale);
  }

  private damage(b: Block, amount: number) {
    // Nothing breaks while the fortress settles (and the pig arrives).
    if (b.broken || amount <= 0 || this.since < 0) return;
    if (b.material === 'tnt') {
      if (amount > 0.3) this.light(b, TNT_DELAY);
      return;
    }
    const before = b.hp;
    b.hp -= amount;
    // A little for every knock, the rest for breaking it.
    this.score += Math.round((Math.min(before, amount) * MATERIALS[b.material].points * 0.1) / 10) * 10;
  }

  private light(b: Block, delay: number) {
    if (b.broken || this.since < 0) return;
    if (b.fuse < 0 || b.fuse > delay) b.fuse = delay;
  }

  private blockFor(collider: RAPIER.Collider): Block | undefined {
    for (const b of this.blocks) if (!b.broken && b.body.collider.handle === collider.handle) return b;
    return undefined;
  }

  private nearestBlock(p: Vec3, within: number): Block | null {
    let best: Block | null = null, bestD = within;
    for (const b of this.blocks) {
      if (b.broken) continue;
      const d = this.distToBlock(b, p);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    return best;
  }

  /** Distance from `p` to a block's surface (0 inside). */
  private distToBlock(b: Block, p: Vec3): number {
    const t = b.body.rb.translation(), q = b.body.rb.rotation();
    const local = rotateInv(q, [p[0] - t.x, p[1] - t.y, p[2] - t.z]);
    const dx = Math.max(0, Math.abs(local[0]) - b.size[0] / 2);
    const dy = Math.max(0, Math.abs(local[1]) - b.size[1] / 2);
    const dz = Math.max(0, Math.abs(local[2]) - b.size[2] / 2);
    return Math.hypot(dx, dy, dz);
  }

  /** Once a frame: break what's broken, set off lit TNT. */
  private updateBlocks(dt: number) {
    for (const b of this.blocks) {
      if (b.broken) continue;
      if (b.fuse >= 0) {
        b.fuse -= dt;
        if (b.fuse <= 0) {
          const t = b.body.rb.translation();
          this.breakBlock(b);
          this.explode([t.x, t.y, t.z], TNT_BLAST, 'tnt');
        }
        continue;
      }
      if (b.hp <= 0) this.breakBlock(b);
    }
    if (this.blocks.some((b) => b.broken)) this.blocks = this.blocks.filter((b) => !b.broken);
  }

  private breakBlock(b: Block) {
    const { physics } = this.ctx;
    b.broken = true;
    const t = b.body.rb.translation(), q = b.body.rb.rotation();
    const lv = b.body.rb.linvel();
    const centre: Vec3 = [t.x, t.y, t.z];
    const vel: Vec3 = [lv.x * 0.5, lv.y * 0.5, lv.z * 0.5];
    const m = fromQuat(q, centre);
    const inside = (): Vec3 => {
      const l: Vec3 = [rand(-0.5, 0.5) * b.size[0], rand(-0.5, 0.5) * b.size[1], rand(-0.5, 0.5) * b.size[2]];
      return [m[0] * l[0] + m[4] * l[1] + m[8] * l[2] + m[12], m[1] * l[0] + m[5] * l[1] + m[9] * l[2] + m[13], m[2] * l[0] + m[6] * l[1] + m[10] * l[2] + m[14]];
    };
    const volume = b.size[0] * b.size[1] * b.size[2];
    const pieces = Math.round(clamp(4 + volume * 10, 5, 14));
    const burst = () => add(vel, add(scale(randomUnit(), rand(1.5, 4.5)), [0, rand(1, 3), 0]));
    if (b.material === 'wood' || b.material === 'tnt') {
      for (let i = 0; i < pieces; i++) {
        const len = rand(0.2, 0.6);
        this.emit(Kind.Splinter, inside(), burst(), [0.06, 0.06, len], rand(2.5, 4), WOOD_BITS);
      }
      for (let i = 0; i < 3; i++) this.dust(inside(), DUST, 0.45);
      if (this.breakSounds < 4) sound.wood();
    } else if (b.material === 'glass') {
      for (let i = 0; i < pieces + 2; i++) {
        const s = rand(0.18, 0.4);
        this.emit(Kind.Shard, inside(), burst(), [s, 0.02, s * rand(0.7, 1.3)], rand(2, 3.2), GLASS_BITS);
      }
      if (this.breakSounds < 4) sound.glass();
    } else {
      for (let i = 0; i < pieces; i++) {
        const s = rand(0.14, 0.32);
        this.emit(Kind.Chunk, inside(), burst(), [s, s * rand(0.6, 1), s * rand(0.7, 1.2)], rand(2.5, 4), STONE_BITS);
      }
      for (let i = 0; i < 5; i++) this.dust(inside(), STONE_DUST, 0.6);
      if (this.breakSounds < 4) sound.stone();
    }
    this.breakSounds++;
    physics.remove(b.body);
    const colors: Record<Material, string> = { wood: '#ffcf8a', glass: '#bfe9ff', stone: '#e0e0e6', tnt: '#ff9a6a' };
    this.addScore(MATERIALS[b.material].points, centre, colors[b.material]);
  }

  private explode(pos: Vec3, blast: typeof TNT_BLAST, source: 'tnt' | 'bomb') {
    const { physics, player, camera } = this.ctx;
    sfx.explosion(source === 'bomb' ? 0.9 : 0.7);
    camera.addShake(Math.max(0.25, (source === 'bomb' ? 1.5 : 1.1) - length(sub(player.pos, pos)) / 18));
    this.blasts.push({ pos, t: 0, size: source === 'bomb' ? 3.4 : 2.6 });
    if (pos[1] < 1.2 && this.scorches.length < 12) this.scorches.push([pos[0], 0.004 + this.scorches.length * 0.001, pos[2]]);
    for (let i = 0; i < 16; i++) {
      const d = randomUnit();
      this.emit(Kind.Smoke, add(pos, scale(d, 0.4)), add(scale(d, rand(2, 5)), [0, 1.5, 0]), [0.35, 0.35, 0.35], rand(1.4, 2.4), SMOKE_DARK, 1.8);
    }
    // Blocks: damage by distance, TNT sets off TNT.
    for (const b of this.blocks) {
      if (b.broken) continue;
      const d = this.distToBlock(b, pos);
      if (d > blast.range) continue;
      const dmg = (blast.strength * MATERIALS[b.material].blast) / Math.max(d, 0.5) ** 2;
      if (b.material === 'tnt') {
        if (dmg >= 1) this.light(b, TNT_DELAY + d * 0.04);
      } else this.damage(b, dmg);
    }
    // Shove everything loose away from it.
    for (const b of physics.bodies) {
      const p = b.rb.translation();
      const to = sub([p.x, p.y, p.z], pos);
      const d = length(to);
      if (d > blast.range || d < 1e-3) continue;
      const dir = normalize(add(to, [0, 0.8, 0]));
      const mass = b.rb.mass();
      const speed = Math.min(blast.maxSpeed, blast.push / Math.pow(d + 1, 1.5) / mass);
      b.rb.applyImpulse({ x: dir[0] * speed * mass, y: dir[1] * speed * mass, z: dir[2] * speed * mass }, true);
    }
    // The pig.
    if (this.death || player.mode !== 'control' || player.inPortal) return;
    const pb = player.body;
    const targets: Vec3[] = pb && pb.isEnabled
      ? [pb.position('head'), pb.position('chest'), pb.position('pelvis')]
      : [add(player.pos, [0, 1.7, 0]), add(player.pos, [0, 1.3, 0]), add(player.pos, [0, 1.0, 0])];
    const chest = targets[1];
    const d = length(sub(chest, pos));
    const pass = targets.reduce((sum, p) => sum + this.exposure(pos, p), 0) / targets.length;
    const damage = Math.pow(blast.safe / Math.max(d, 0.5), 2) * pass;
    const away = normalize(add(sub(chest, pos), [0, 0.6, 0]));
    if (damage >= 1) {
      player.kill(scale(away, Math.min(22, 8 * damage)), { violence: Math.min(34, 10 + 8 * damage), origin: pos });
      sound.squeal();
      this.addScore(PIG_POINTS, chest, '#7dde4a');
      this.cheer();
      if (source === 'bomb') {
        this.die('KABOOM', pick(['Bomb had a short fuse. You had a short life.', 'Bomb went off. So did you.']),
          'Bombs go off a couple of seconds after they land. Run, or put stone between you and it. You can also throw it away.');
      } else {
        this.die('KABOOM', pick(['Who keeps TNT in their own house? Pigs, apparently.', 'Crate expectations: exceeded.']),
          "TNT goes off when anything hits it hard. Don't hide next to it, or carry it somewhere far away.");
      }
    } else if (damage >= KNOCKDOWN) {
      player.knock(scale(away, 7 * damage), 0.5 + 1.2 * damage);
    }
  }

  /** How much of a blast at `from` reaches `to` (1 = all): loose things soak up some, walls all of it. */
  private exposure(from0: Vec3, to: Vec3): number {
    const { physics } = this.ctx;
    const from = add(from0, [0, 0.15, 0]);
    const delta = sub(to, from);
    const dist = length(delta);
    if (dist < 1e-3) return 1;
    const dir = scale(delta, 1 / dist);
    const ray = new RAPIER.Ray({ x: from[0], y: from[1], z: from[2] }, { x: dir[0], y: dir[1], z: dir[2] });
    let pass = 1;
    physics.world.intersectionsWithRay(ray, dist, true, (hit) => {
      const rb = hit.collider.parent();
      if (!rb || !rb.isDynamic()) {
        pass = 0;
        return false;
      }
      pass *= 1 / (1 + rb.mass() / COVER_MASS);
      return true;
    }, undefined, GROUPS_QUERY_WORLD);
    return pass;
  }

  private knockSound(vol: number) {
    if (this.knockSounds > 3) return;
    this.knockSounds++;
    sound.knock(vol);
  }

  // --- Score ---------------------------------------------------------------------------------------

  private addScore(points: number, at: Vec3, color: string) {
    this.score += points;
    const popup = this.popups.find((p) => p.t < 0) ?? this.popups[0];
    popup.t = 0;
    popup.label.pos = add(at, [0, 0.6, 0]);
    popup.label.text = fmt(points);
    popup.label.color = color;
    popup.label.size = points >= PIG_POINTS ? 0.9 : 0.55;
  }

  private updateScore(dt: number) {
    // The board counts up toward the real score.
    if (this.shownScore < this.score) this.shownScore = Math.min(this.score, this.shownScore + Math.max(200, (this.score - this.shownScore) * 4) * dt);
    this.scoreRefresh -= dt;
    if (this.scoreRefresh <= 0) {
      this.scoreRefresh = 1 / 12;
      this.scoreText.setText(`BIRDS: ${fmt(Math.floor(this.shownScore / 10) * 10)}`);
    }
    const lit = STARS.filter((s) => this.shownScore >= s).length;
    while (this.starsLit < lit) {
      this.starPop[this.starsLit] = 1;
      sound.star(this.starsLit);
      this.starsLit++;
    }
    for (let i = 0; i < 3; i++) this.starPop[i] = Math.max(0, this.starPop[i] - dt * 2.5);
    for (const p of this.popups) {
      if (p.t < 0) continue;
      p.t += dt;
      p.label.pos = add(p.label.pos, [0, dt * 0.8, 0]);
      if (p.t > 1.4) {
        p.t = -1;
        p.label.text = '';
      }
    }
  }

  // --- Particles -----------------------------------------------------------------------------------

  private emit(kind: Kind, pos: Vec3, vel: Vec3, size: Vec3, life: number, color: number[], grow = 0) {
    // Trails never get recycled for debris: look for a free slot, else take the next non-trail one.
    let p = this.particles[this.nextParticle];
    for (let i = 0; i < MAX_PARTICLES && p.active && (p.kind === Kind.Trail || kind === Kind.Trail); i++) {
      this.nextParticle = (this.nextParticle + 1) % MAX_PARTICLES;
      p = this.particles[this.nextParticle];
      if (!p.active) break;
    }
    if (p.active && p.kind === Kind.Trail && kind !== Kind.Trail) return;
    this.nextParticle = (this.nextParticle + 1) % MAX_PARTICLES;
    p.active = true;
    p.kind = kind;
    p.pos = [...pos];
    p.vel = [...vel];
    p.axis = randomUnit();
    p.angle = rand(0, Math.PI * 2);
    p.spin = kind === Kind.Dust || kind === Kind.Smoke || kind === Kind.Trail ? 0 : rand(4, 14) * (kind === Kind.Feather ? 0.3 : 1);
    p.size = [...size];
    p.grow = grow;
    p.age = 0;
    p.life = life;
    p.opacity = 1;
    const item = p.item;
    item.mesh = kind === Kind.Shard ? 'wedge' : kind === Kind.Chunk ? 'roundbox' : kind === Kind.Splinter || kind === Kind.Feather ? 'box' : 'sphere';
    item.color = color;
    item.pattern = kind === Kind.Chunk ? Pattern.rock : undefined;
    item.param = kind === Kind.Chunk ? 1 : undefined;
    item.spec = kind === Kind.Shard ? 1.4 : 0.1;
    item.shadow = kind === Kind.Splinter || kind === Kind.Chunk;
  }

  private dust(pos: Vec3, color: number[], size: number) {
    this.emit(Kind.Dust, pos, [rand(-0.6, 0.6), rand(0.3, 1.2), rand(-0.6, 0.6)], [size, size, size], rand(0.9, 1.6), color, 1.3);
  }

  private feathers(pos: Vec3, bird: BirdKind, n: number) {
    for (let i = 0; i < n; i++) {
      this.emit(Kind.Feather, add(pos, scale(randomUnit(), 0.3)), add(scale(randomUnit(), rand(1, 3)), [0, 2, 0]), [0.05, 0.012, 0.22], rand(2.5, 4), FEATHERS[bird]);
    }
  }

  private updateParticles(dt: number) {
    const lim = CHAMBER_HALF - 0.05;
    for (const p of this.particles) {
      if (!p.active) continue;
      p.age += dt;
      if (p.age >= p.life) {
        p.active = false;
        continue;
      }
      const v = p.vel;
      if (p.kind === Kind.Trail) continue;
      if (p.kind === Kind.Dust || p.kind === Kind.Smoke) {
        const drag = Math.exp(-dt * 2.2);
        v[0] *= drag; v[1] = v[1] * drag + dt * 0.6; v[2] *= drag;
      } else if (p.kind === Kind.Feather) {
        const drag = Math.exp(-dt * 3);
        v[0] = v[0] * drag + Math.sin(p.age * 5 + p.angle) * dt * 3; v[1] = Math.max(-1.2, v[1] * drag - 6 * dt); v[2] *= drag;
      } else {
        v[1] -= 20 * dt;
      }
      p.pos[0] += v[0] * dt; p.pos[1] += v[1] * dt; p.pos[2] += v[2] * dt;
      p.angle += p.spin * dt;
      const floor = Math.min(p.size[0], p.size[1], p.size[2]) * 0.5;
      if (p.pos[1] < floor && p.kind !== Kind.Dust && p.kind !== Kind.Smoke) {
        p.pos[1] = floor;
        if (v[1] < 0) v[1] = -v[1] * 0.25;
        v[0] *= 0.55; v[2] *= 0.55;
        p.spin *= 0.5;
      }
      for (const k of [0, 2]) {
        if (p.pos[k] > lim) { p.pos[k] = lim; v[k] = -Math.abs(v[k]) * 0.3; }
        if (p.pos[k] < -lim) { p.pos[k] = -lim; v[k] = Math.abs(v[k]) * 0.3; }
      }
    }
  }

  // --- Drawing -------------------------------------------------------------------------------------

  draw(out: DrawItem[]) {
    const { player } = this.ctx;
    this.arrival.draw(out);
    this.exit.draw(out);

    // The pig: green skin, and (once it dawns) a snout, ears and beady eyes.
    if (this.pigPop > 0 && player.mode !== 'hidden' && player.portalScale > 0.98) {
      const k = this.pigPop;
      const green = k >= 1 ? PIG_GREEN : [lerp(PLAYER_COLORS.skin[0], PIG_GREEN[0], k), lerp(PLAYER_COLORS.skin[1], PIG_GREEN[1], k), lerp(PLAYER_COLORS.skin[2], PIG_GREEN[2], k)];
      for (const item of out) if (item.color === PLAYER_COLORS.skin || item.color === PLAYER_COLORS.hair) item.color = green;
      // Elastic pop: overshoots, then settles.
      const pop = k >= 1 ? 1 : 1 + Math.sin(k * Math.PI * 2.5) * (1 - k) * 0.6 - (1 - k) * 0.4;
      drawPigFace(out, player.partFrames().head, Math.max(0, pop));
    }

    this.sling.draw(out);
    // Birds on the wall, and the one in the pouch.
    for (const p of this.perched) {
      if (!p.shown) continue;
      let m: Mat4;
      if (p === this.loaded) {
        m = facingFrame(this.launchVel, p.pos);
      } else {
        const c = Math.cos(p.yaw), s = Math.sin(p.yaw);
        m = basis([c, 0, -s], [0, 1, 0], [s, 0, c], p.pos);
      }
      const squash = p.hop >= 0 ? 1 + Math.sin(p.hop * Math.PI * 2) * 0.12 : 1;
      drawBird(out, p.bird, m, { blink: p.blink < 0, squash });
    }
    for (const f of this.flyers) {
      if (f.gone) continue;
      let m: Mat4;
      if (f.landed < 0) m = f.frame;
      else {
        const t = f.body.rb.translation();
        m = fromQuat(f.body.rb.rotation(), [t.x, t.y, t.z]);
      }
      const start = out.length;
      drawBird(out, f.bird, m, { blink: f.blink < 0 || f.landed >= 0 && f.landed < 0.4, fuse: f.fuse >= 0 ? 1 - f.fuse / BOMB_FUSE : -1 });
      if (f.body.highlight) for (let i = start; i < out.length; i++) out[i].highlight = f.body.highlight;
      if (f.dashing) {
        // Speed lines.
        const lv = f.body.rb.linvel();
        const back = scale(normalize([lv.x, lv.y, lv.z]), -1);
        const t = f.body.rb.translation();
        const side = normalize(cross(back, [0, 1, 0]));
        for (const o of [-0.35, 0, 0.35]) {
          const a = add(add([t.x, t.y, t.z], scale(side, o)), [0, o * 0.5, 0]);
          out.push({ mesh: 'cylinder', model: segment(add(a, scale(back, 0.6)), add(a, scale(back, 2.6)), 0.025), color: [1.6, 1.6, 1.5], pattern: Pattern.emissive, shadow: false, opacity: 0.8 });
        }
      }
    }

    // Particles.
    for (const p of this.particles) {
      if (!p.active) continue;
      const k = p.age / p.life;
      const item = p.item;
      let sx = p.size[0], sy = p.size[1], sz = p.size[2];
      if (p.kind === Kind.Dust || p.kind === Kind.Smoke) {
        const g = 1 + k * p.grow;
        sx *= g; sy *= g; sz *= g;
        item.opacity = (p.kind === Kind.Smoke ? 0.8 : 0.55) * (1 - k);
      } else if (p.kind !== Kind.Trail) {
        const fade = Math.min(1, (p.life - p.age) / 0.4);
        sx *= fade; sy *= fade; sz *= fade;
        item.opacity = p.kind === Kind.Shard ? 0.7 : undefined;
      } else item.opacity = undefined;
      writeModel(item.model, p.pos, p.axis, p.angle, [sx, sy, sz]);
      out.push(item);
    }

    // Explosions: a fireball that swells and collapses; scorch marks.
    for (const b of this.blasts) {
      if (b.t > 0.6) continue;
      const r = b.t < 0.12 ? lerp(0.3, b.size, b.t / 0.12) : lerp(b.size, 0, (b.t - 0.12) / 0.48);
      const heat = 1 - b.t / 0.6;
      out.push({ mesh: 'sphere', model: mul(translation(b.pos), scaling([r, r, r])), color: [2.2 * heat + 0.6, 0.55 * heat + 0.12, 0.08], pattern: Pattern.emissive, shadow: false, opacity: 0.8 });
      const c = r * 0.62;
      out.push({ mesh: 'sphere', model: mul(translation(b.pos), scaling([c, c, c])), color: [4 * heat + 0.8, 2.6 * heat + 0.3, 0.8 * heat], pattern: Pattern.emissive, shadow: false });
    }
    for (const s of this.scorches) {
      out.push({ mesh: 'cylinder', model: mul(translation(s), scaling([1.8, 0.002, 1.8])), color: [0.02, 0.02, 0.02], pattern: Pattern.blob, param: 0.8, shadow: false });
    }

    this.drawBoard(out);
  }

  /** The birds' score board on the north wall: three stars and the score. */
  private drawBoard(out: DrawItem[]) {
    const z = -CHAMBER_HALF;
    out.push({ mesh: 'bevelbox', model: mul(translation([0, 7.55, z + 0.04]), scaling([16, 4.4, 0.1])), color: [0.86, 0.6, 0.28], spec: 0.1 });
    out.push({ mesh: 'box', model: mul(translation([0, 7.55, z + 0.07]), scaling([15.4, 3.8, 0.08])), color: [0.1, 0.08, 0.07], spec: 0.2 });
    this.scoreText.draw(out);
    const lit = [2.4, 1.75, 0.25], unlit = [0.28, 0.26, 0.24];
    for (let i = 0; i < 3; i++) {
      const big = i === 1;
      const pop = 1 + this.starPop[i] * 0.6;
      const radius = (big ? 0.78 : 0.62) * pop;
      const on = i < this.starsLit;
      drawStar(out, [(i - 1) * 2.1, big ? 8.75 : 8.55, z + 0.14], [1, 0, 0], [0, 1, 0], radius, on ? lit : unlit, on ? { pattern: Pattern.emissive, shadow: false } : { spec: 0.2 });
    }
  }

  labels(): WorldLabel[] {
    const list = this.labelList;
    list.length = 0;
    if (this.nameLabel.text) list.push(this.nameLabel, this.quipLabel);
    for (const p of this.popups) if (p.t >= 0) list.push(p.label);
    return list;
  }

  trackedTargets(): TrackedTarget[] {
    const targets: TrackedTarget[] = [];
    if (!this.death) {
      if (this.loaded && this.phase !== 'load') targets.push({ pos: this.loaded.pos, radius: BIRD_RADIUS[this.loaded.bird] * 1.3 });
      for (const f of this.flyers) {
        if (f.gone) continue;
        if (f.landed < 0 || f.fuse >= 0) {
          const t = f.body.rb.translation();
          targets.push({ pos: [t.x, t.y, t.z], radius: f.r * 1.3 });
        }
      }
    }
    const exit = this.exit.target();
    if (exit) targets.push(exit);
    return targets;
  }

  environment() {
    return DEFAULT_ENV;
  }

  obstacles() {
    return [];
  }

  cameraShot(): CameraShot | null {
    // Dev only: `window.__cam = { pos, target, sharpness }` parks the camera for screenshots.
    const dbg = import.meta.env.DEV ? (window as unknown as { __cam?: CameraShot }).__cam : undefined;
    if (dbg) return dbg;
    return this.arrival.cameraShot();
  }
}

/** Rotates `v` by the inverse of unit quaternion `q`. */
function rotateInv(q: { x: number; y: number; z: number; w: number }, v: Vec3): Vec3 {
  const u: Vec3 = [-q.x, -q.y, -q.z];
  const t = scale(cross(u, v), 2);
  return add(add(v, scale(t, q.w)), cross(u, t));
}
