import { note, noise, sfx, tone, Tune } from '../../engine/audio';
import {
  add, clamp, cross, easeInOut, length, lerp, mul, normalize, quatConj, rotateByQuat, rotationY, scale, scaling, sub, translation,
  type Mat4, type Quat, type Vec3,
} from '../../engine/math';
import { GRAVITY, RAPIER, type Body } from '../../engine/physics';
import { Pattern, type DrawItem, type Environment } from '../../engine/renderer';
import { junk, spawnJunk } from '../../entities/junk';
import { drawLounger, drawParasol, drawPoolLadder, spawnFloatingCouch, spawnPoolFloat, Water, type PoolFloatKind } from '../../entities/pool';
import { ExitPortal, PortalArrival } from '../../entities/portal';
import { CursorHand, drawBubble, drawGrimReaper, drawPlumbob, NeedsPanel } from '../../entities/sims';
import type { Pose } from '../../game/body';
import { CHAMBER_HALF, WALL_HEIGHT } from '../../game/chamber';
import { DEFAULT_ENV, type CameraShot, type Level, type LevelContext, type LevelStatus, type TrackedTarget, type WorldLabel } from '../level';

/*
 * The Pool. The Sims' most famous prank. A plumbob pops up over your head, the camera swings up
 * into build mode, and a giant cursor hand drags out a swimming pool under your feet. Everything
 * in the room goes in with you. A ladder is placed... and deleted the moment you swim for it
 * (+§50). Swimming drains your ENERGY (on the needs panel, and the plumbob goes yellow, then red);
 * at zero your Sim drowns and the Grim Reaper floats in with his clipboard. The way out: climb
 * onto the floating junk (Space from the water), push or stack it against the side and jump up
 * onto the deck. Then the cursor thinks about deleting the exit too. Classic.
 */

// --- Tuning -----------------------------------------------------------------------------------------
/** The pool: interior x within ±X_HALF, z within ±Z_HALF. The deck round it is the old floor (y = 0). */
const X_HALF = 9;
const Z_HALF = 8;
const WATER_Y = -1.7;
const POOL_FLOOR = -4.2;
const SPAWN: Vec3 = [0, 0, 1];
/** Swimming: feet this far under the surface, speed (share of walking), sluggishness in the water. */
const FLOAT_DEPTH = 1.3;
const SWIM_SPEED = 0.42;
const SWIM_STEER = 2.2;
/** The float spring (1/s²) and its damping (1/s) that holds a swimmer at FLOAT_DEPTH. */
const FLOAT_SPRING = 30;
const FLOAT_DAMP = 7;
/** Seconds of swimming from full ENERGY to nothing (then you drown). */
const ENERGY_TIME = 55;
/** A hop in the water (m/s up), and climbing onto something floating: its top at most this far over the water, this far away, taking this long. */
const HOP_SPEED = 3.4;
const CLAMBER_MAX = 0.9;
const CLAMBER_TIME = 0.5;
/** How hard someone standing on a floating thing presses it down (kg). */
const PLAYER_LOAD = 60;
/** Jumping off a floating thing kicks it down and back (kg·m/s). */
const JUMP_KICK = 90;
/** Swim within this far of the ladder and the cursor deletes it (and it does anyway after LADDER_PATIENCE s). */
const LADDER_TRIGGER = 3.8;
const LADDER_PATIENCE = 9;
const DEATH_SCREEN_DELAY = 1.8;
const DROWN_SCREEN_DELAY = 5.6;

// The intro, in seconds after the arrival: the plumbob, the build-mode camera, the drag, the sink.
const POP_AT = 0.2;
const OVERVIEW_AT = 1.3;
const CURSOR_IN_AT = 1.4;
const CLICK_AT = 2.7;
const DRAG_TIME = 1.6;
const RELEASE_AT = CLICK_AT + DRAG_TIME + 0.2;
const SINK_TIME = 1.3;
const OVERVIEW_END = RELEASE_AT + SINK_TIME + 0.7;
const LADDER_AT = OVERVIEW_END + 0.6;
/** Price per square metre of pool (Simoleons). */
const POOL_PRICE = 16;

/** The lights when the Grim Reaper turns up. */
const GLOOM = {
  sunColor: [0.55, 0.6, 0.85] as Vec3,
  skyColor: [0.06, 0.08, 0.16] as Vec3,
  groundColor: [0.05, 0.05, 0.08] as Vec3,
  fogColor: [0.1, 0.12, 0.2] as Vec3,
};

const WALL = [0.86, 0.87, 0.88];
const FLOOR = [0.6, 0.61, 0.63];
const DECK = [0.84, 0.79, 0.69];
const COPING = [0.95, 0.94, 0.9];
const TILE = [0.62, 0.86, 0.92];
const TILE_DRY = [0.78, 0.92, 0.95];
const TILE_BAND = [0.08, 0.2, 0.5];
const LANE = [0.06, 0.16, 0.45];
const HAZE = [0.03, 0.2, 0.32];
const BUILD_BLUE = [0.35, 0.75, 1.6];

const SIMLISH_HI = ['Sul sul!', 'Sul sul!', 'Dag dag... wait, sul sul!'];
const SIMLISH_SPLASH = ['Waaah!', 'Nooboo?!', 'Blarg!'];
const SIMLISH_WALL = ['Hnnng!', 'Nib! Nib!', 'Grah!', 'Frabbit!', 'Ooof...'];
const SIMLISH_TIRED = ['Zzz... blub.', 'Nooboo...', 'Hoo... hoo...', 'Blub.'];
const DROWN_LINES = [
  'The ladder was right there. Then it wasn\'t.',
  'Contributing factors: no ladder. Also, the cursor.',
  'Your Sim was having a great time. The needs panel said so.',
  'Somewhere, a player is laughing. It was always going to be this way.',
];

const TIPS: [string, string][] = [
  ['Hint', 'Push the floating stuff against the side and climb it (Space, right next to it). Stack it if you have to: a crate on the pallet, or the couch. Your energy drops while you swim.'],
  ['Controls', 'WASD swim / move · Space hop, or climb onto something floating · Hold click carry · Right-click throw'],
];

// --- Sound ------------------------------------------------------------------------------------------

/** A breezy build-mode noodle in C: an original little loop. */
const BUILD_TUNE: [string | null, number][] = [
  ['E5', 0.5], ['G5', 0.5], ['C6', 0.5], ['B5', 0.5], ['G5', 1], ['E5', 0.5], ['D5', 0.5],
  ['F5', 0.5], ['A5', 0.5], ['G5', 1], [null, 0.5], ['E5', 0.5], ['C5', 1],
  ['D5', 0.5], ['E5', 0.5], ['F5', 0.5], ['A5', 0.5], ['G5', 0.5], ['F5', 0.5], ['E5', 0.5], ['D5', 0.5],
  ['E5', 1.5], [null, 0.5], ['G4', 0.5], ['A4', 0.5], ['C5', 1],
  ['A5', 0.5], ['G5', 0.5], ['E5', 0.5], ['G5', 0.5], ['A5', 1], ['C6', 0.5], ['B5', 0.5],
  ['A5', 0.5], ['G5', 0.5], ['E5', 1], [null, 0.5], ['D5', 0.5], ['E5', 1],
  ['F5', 0.5], ['E5', 0.5], ['D5', 0.5], ['C5', 0.5], ['D5', 0.5], ['E5', 0.5], ['G4', 0.5], ['B4', 0.5],
  ['C5', 2], [null, 2],
];

const SOUND = {
  /** The plumbob popping into existence. */
  bling() {
    tone(note('E6'), 0.25, { wave: 'sine', vol: 0.12 });
    tone(note('B6'), 0.45, { wave: 'sine', vol: 0.1, at: 0.08 });
    tone(note('E7'), 0.5, { wave: 'sine', vol: 0.04, at: 0.12 });
  },
  click() {
    tone(2200, 0.025, { wave: 'square', vol: 0.07 });
    noise(0.03, { freq: 4000, type: 'highpass', vol: 0.12 });
  },
  /** Snapping to the next grid line while dragging. */
  tick() {
    tone(3100, 0.018, { wave: 'square', vol: 0.025 });
  },
  rumble() {
    noise(1.4, { freq: 300, to: 90, vol: 0.35 });
    tone(55, 1.3, { to: 38, wave: 'sawtooth', vol: 0.08, attack: 0.1 });
    noise(1.5, { freq: 900, to: 2400, type: 'bandpass', q: 1.2, vol: 0.18, at: 0.3 }); // the water rushing in
  },
  splash(k: number) {
    const v = clamp(k, 0.15, 1);
    noise(0.55, { freq: 2600, to: 350, vol: 0.4 * v });
    noise(0.25, { freq: 900, to: 300, type: 'bandpass', q: 2, vol: 0.25 * v, at: 0.05 });
    tone(220, 0.25, { to: 90, wave: 'sine', vol: 0.12 * v });
  },
  paddle() {
    noise(0.16, { freq: 1100 + Math.random() * 500, to: 450, type: 'bandpass', q: 1.6, vol: 0.05 });
  },
  hop() {
    noise(0.3, { freq: 1500, to: 400, type: 'bandpass', q: 1, vol: 0.12 });
  },
  clamber() {
    noise(0.3, { freq: 1200, to: 300, type: 'bandpass', q: 1, vol: 0.14 });
    tone(160, 0.12, { to: 110, wave: 'sawtooth', vol: 0.04, at: 0.1 });
  },
  tada() {
    tone(note('C6'), 0.12, { wave: 'triangle', vol: 0.12 });
    tone(note('G6'), 0.35, { wave: 'triangle', vol: 0.12, at: 0.1 });
  },
  /** The cash register of selling something back. */
  kaching() {
    noise(0.05, { freq: 5000, type: 'highpass', vol: 0.2 });
    tone(note('A6'), 0.12, { wave: 'square', vol: 0.05, at: 0.04 });
    tone(note('E7'), 0.5, { wave: 'sine', vol: 0.1, at: 0.12 });
    tone(note('A7'), 0.4, { wave: 'sine', vol: 0.04, at: 0.14 });
  },
  poof() {
    noise(0.35, { freq: 3500, to: 800, type: 'bandpass', q: 0.8, vol: 0.18 });
  },
  whoosh() {
    noise(0.4, { freq: 400, to: 1800, type: 'bandpass', q: 1, vol: 0.12 });
  },
  /** A motive failing: the Sims' little warning. */
  warn() {
    tone(note('A5'), 0.18, { wave: 'triangle', vol: 0.1 });
    tone(note('F5'), 0.3, { wave: 'triangle', vol: 0.1, at: 0.18 });
  },
  blub() {
    const f = 300 + Math.random() * 200;
    tone(f, 0.12, { to: f * 2.2, wave: 'sine', vol: 0.08 });
  },
  /** He's here. */
  reaper() {
    for (const [n, at] of [['D3', 0], ['F3', 0.05], ['A3', 0.1], ['C#4', 0.15]] as [string, number][]) {
      tone(note(n), 2.4, { wave: 'sawtooth', vol: 0.035, at, attack: 0.4 });
    }
    noise(2, { freq: 300, to: 120, vol: 0.12, at: 0.1 });
  },
  scribble() {
    for (let i = 0; i < 5; i++) noise(0.08, { freq: 3000 + Math.random() * 1500, type: 'bandpass', q: 3, vol: 0.06, at: i * 0.11 });
  },
  hmm() {
    tone(180, 0.35, { to: 240, wave: 'triangle', vol: 0.08 });
  },
  nah() {
    tone(260, 0.16, { wave: 'triangle', vol: 0.09 });
    tone(190, 0.3, { wave: 'triangle', vol: 0.09, at: 0.17 });
  },
  yay() {
    ['C5', 'E5', 'G5', 'C6', 'E6'].forEach((n, i) => tone(note(n), 0.16, { wave: 'triangle', vol: 0.09, at: i * 0.07 }));
  },
};

/** Simlish: one little voiced blip per syllable, rising at the end of a question. */
function babble(text: string, pitch = 1) {
  const syllables = Math.min(6, Math.max(1, (text.match(/[aeiouy]+/gi) ?? []).length));
  const ask = text.includes('?');
  for (let i = 0; i < syllables; i++) {
    const last = i === syllables - 1;
    const f = (210 + Math.random() * 110) * pitch * (last && ask ? 1.3 : 1);
    tone(f, 0.12, { to: f * (last && ask ? 1.4 : 0.8 + Math.random() * 0.3), wave: 'triangle', vol: 0.1, at: i * 0.13, attack: 0.015 });
    tone(f * 2.01, 0.09, { wave: 'sine', vol: 0.03, at: i * 0.13 });
  }
}

// --- Poses ------------------------------------------------------------------------------------------

function blendPose(a: Pose, b: Pose, k: number): Pose {
  const out = { ...a };
  for (const key of Object.keys(b) as (keyof Pose)[]) out[key] = lerp(a[key] ?? 0, b[key] ?? 0, k);
  return out;
}

/** Treading water (arms sculling out to the sides) blended into a doggy paddle as they move. */
function swimPose(t: number, moving: number, tired: number): Pose {
  const w = 5.5 - tired * 2;
  const s = Math.sin(t * w), c = Math.cos(t * w), k = Math.sin(t * w * 2);
  const tread: Pose = {
    lean: -0.08, headPitch: 0.15 + tired * 0.35,
    shoulderL: 0.35 + 0.35 * s, shoulderR: 0.35 - 0.35 * s, armOut: 1.05 + 0.15 * c, elbowL: 0.55, elbowR: 0.55,
    hipL: 0.45 + 0.35 * s, hipR: 0.45 - 0.35 * s, kneeL: -0.9 - 0.3 * c, kneeR: -0.9 + 0.3 * c,
  };
  const paddle: Pose = {
    lean: -0.55, headPitch: 0.55 + tired * 0.2,
    shoulderL: 1.35 + 0.7 * s, shoulderR: 1.35 - 0.7 * s, armOut: 0.25, elbowL: 0.9 + 0.5 * c, elbowR: 0.9 - 0.5 * c,
    hipL: -0.25 + 0.4 * k, hipR: -0.25 - 0.4 * k, kneeL: -0.35 - 0.3 * Math.max(0, k), kneeR: -0.35 - 0.3 * Math.max(0, -k),
  };
  return blendPose(tread, paddle, clamp(moving, 0, 1));
}

// --- Bits and pieces ------------------------------------------------------------------------------

type Stage = 'arrive' | 'intro' | 'pool' | 'out';

interface Floater {
  name: string;
  body: Body;
}

interface Say {
  label: WorldLabel;
  ttl: number;
  vel: Vec3;
}

interface Drop {
  pos: Vec3;
  vel: Vec3;
  age: number;
  life: number;
  size: number;
  /** Rises (a bubble under water) instead of falling. */
  bubble: boolean;
  /** Glittery sparkle (unlit) rather than water. */
  sparkle: boolean;
}

interface Ripple {
  pos: Vec3;
  age: number;
  life: number;
  size: number;
}

interface Death {
  t: number;
  big: string;
  small: string;
  delay: number;
  drowned: boolean;
}

type CursorTask =
  | 'hidden' | 'intro' | 'fetch' | 'ladder-bring' | 'ladder-hover' | 'ladder-grab' | 'ladder-lift'
  | 'decor-up' | 'decor-bring' | 'decor-away' | 'idle' | 'panel' | 'door' | 'leave';

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

export class PoolLevel implements Level {
  readonly number: number;
  readonly title = 'The Pool';
  readonly chamber = { none: true };
  status: LevelStatus = 'playing';
  private arrival: PortalArrival;
  private exit = new ExitPortal(0, 0);
  private stage: Stage = 'arrive';
  /** Seconds since the intro started (the Sim up on their feet after the arrival). */
  private t = 0;
  private upT = 0;
  private time = 0;
  private beats = new Set<string>();
  private death: Death | null = null;

  // The pool itself.
  private water: Water;
  private slab: RAPIER.RigidBody;
  /** Height of the top of the sinking floor (0 before, POOL_FLOOR after). */
  private slabTop = 0;
  private poolMade = false;
  /** 0 until the drag is released, then 1: the room's look switches over to a pool. */
  private built = 0;
  private floaters: Floater[] = [];
  /** Where the drag rectangle has got to (its far corner), while dragging and just after. */
  private dragTo: Vec3 | null = null;
  private dragFade = 0;
  private lastGrid = '';

  // The Sim.
  private energy = 1;
  private swimming = false;
  private wet = false;
  private clamber: { body: Body; local: Vec3; from: Vec3; t: number } | null = null;
  private standingOn: Body | null = null;
  private lastStanding: Body | null = null;
  private hopCooldown = 0;
  private paddleT = 0;
  private warned = new Set<number>();
  private plumbob = 0;
  private mood = 1;
  private outT = 0;
  private everOut = false;

  // The cursor and what it does.
  private cursor = new CursorHand([0, 40, 0]);
  private task: CursorTask = 'hidden';
  private taskT = 0;
  private carrying: 'ladder' | 'fridge' | 'couch' | null = null;
  private ladder: { pos: Vec3; yaw: number; placed: number; gone: boolean } | null = null;
  private decor: ('fridge' | 'couch')[] = ['fridge', 'couch'];
  private dropAt: Vec3 = [0, 0, 0];
  private idleAngle = 0;
  private fetchDone = -1;

  // Talking, and effects.
  private bubble: { text: string; ttl: number; ladder: boolean; next: boolean } | null = null;
  private bubbleLabel: WorldLabel = { pos: [0, 0, 0], text: '', size: 0.3, color: '#16213a' };
  private says: Say[] = [];
  private drops: Drop[] = [];
  private ripples: Ripple[] = [];
  private labelList: WorldLabel[] = [];
  private needs: NeedsPanel;
  private reaper: { pos: Vec3; from: Vec3; to: Vec3; t: number; yaw: number } | null = null;
  private music = new Tune(BUILD_TUNE, 118, { wave: 'triangle', vol: 0.045, bass: true });
  private env: Environment = { ...DEFAULT_ENV, sunColor: [...DEFAULT_ENV.sunColor], skyColor: [...DEFAULT_ENV.skyColor], groundColor: [...DEFAULT_ENV.groundColor], fogColor: [...DEFAULT_ENV.fogColor] };
  private drownHooked = false;

  constructor(private ctx: LevelContext) {
    this.number = ctx.number;
    const { physics, hud, camera } = ctx;
    hud.setLevel(`The Chamber · Level ${this.number}`);
    hud.show(`LEVEL ${this.number}`, '', 2.5);
    hud.hint('');
    camera.confine = false;
    this.arrival = new PortalArrival(ctx, SPAWN);

    // Walls, as in the standard chamber.
    const H = CHAMBER_HALF, wy = (WALL_HEIGHT - 0.2) / 2;
    for (const [pos, size] of WALLS) physics.addStaticBox(pos, size);
    // The deck: the floor round the pool, solid all the way down to the pool's bottom.
    const depth = -POOL_FLOOR + 0.5, cy = -depth / 2;
    physics.addStaticBox([0, cy, -(H + Z_HALF) / 2], [H * 2, depth, H - Z_HALF]);
    physics.addStaticBox([0, cy, (H + Z_HALF) / 2], [H * 2, depth, H - Z_HALF]);
    physics.addStaticBox([-(H + X_HALF) / 2, cy, 0], [H - X_HALF, depth, Z_HALF * 2]);
    physics.addStaticBox([(H + X_HALF) / 2, cy, 0], [H - X_HALF, depth, Z_HALF * 2]);
    void wy;
    // The middle of the floor: a slab that sinks to become the bottom of the pool (a fixed body,
    // moved by hand, so the player can stand on it).
    this.slab = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.25, 0));
    physics.world.createCollider(RAPIER.ColliderDesc.cuboid(X_HALF, 0.25, Z_HALF), this.slab);

    this.water = new Water(physics, { x0: -X_HALF, x1: X_HALF, z0: -Z_HALF, z1: Z_HALF }, WATER_Y);
    this.water.enabled = false;
    for (const p of PROPS) this.spawnProp(p.kind, p.pos, p.yaw);

    this.needs = new NeedsPanel([0, 5.6, -H + 0.02], [1, 0, 0], [0, 0, 1], [
      { name: 'ENERGY', value: 1, caption: 'Fine' },
      { name: 'FUN', value: 0.96, caption: 'Very high' },
      { name: 'HYGIENE', value: 1, caption: 'Excellent' },
      { name: 'SOCIAL', value: 0.9, caption: 'The cursor is your friend' },
      { name: 'BLADDER', value: 0.4, caption: "Don't. Just don't." },
    ], 11);

    // The ragdoll of a drowned Sim sinks, slowly.
    physics.substepHooks.push((h) => this.sinkBody(h));
  }

  private spawnProp(kind: string, pos: Vec3, yaw: number) {
    const { physics } = this.ctx;
    const w = this.water;
    let body: Body;
    if (kind === 'ring' || kind === 'noodle' || kind === 'lilo' || kind === 'pallet') {
      body = spawnPoolFloat(physics, w, kind as PoolFloatKind, pos, yaw, kind === 'noodle' && this.floaters.some((f) => f.name === 'noodle') ? [1, 0.35, 0.7] : undefined);
    } else if (kind === 'couch') {
      body = spawnFloatingCouch(physics, w, pos, yaw);
    } else {
      const def = junk(kind);
      body = spawnJunk(physics, def, pos, { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) });
      const capacity = CAPACITY[kind] ?? def.mass * 2;
      if (def.shape === 'ball') w.add(body, { capacity, points: [[0, 0, 0]], half: def.size[0] });
      else w.add(body, { capacity, righting: kind.includes('crate') ? 90 : 0, anyFace: true });
    }
    this.floaters.push({ name: kind, body });
    return body;
  }

  /** True once, the first time `when` holds, for each key. */
  private once(key: string, when = true) {
    if (!when || this.beats.has(key)) return false;
    this.beats.add(key);
    return true;
  }

  // --- Update ---------------------------------------------------------------------------------------

  update(dt: number) {
    const { player, hud } = this.ctx;
    this.time += dt;
    const death = this.death;
    if (death && this.status === 'playing') {
      death.t += dt;
      if (death.drowned) this.updateReaper(dt);
      if (death.t > death.delay) {
        this.status = 'lost';
        hud.show(death.big, `${death.small}\nPress R to try again.`);
        hud.tips(TIPS);
      }
    }
    this.arrival.update(dt);
    // The show starts once the Sim is back on their feet.
    if (this.stage === 'arrive' && this.arrival.done) {
      this.upT += dt;
      if (!player.gettingUp || this.upT > 1.5) this.stage = 'intro';
    }
    if (this.stage !== 'arrive') this.t += dt;

    if (this.stage !== 'arrive') this.updateScript(dt);
    this.updateSink();
    this.updateSim(dt);
    this.updateCursor(dt);
    this.updateEffects(dt);
    this.updateNeeds(dt);

    if (this.t > POP_AT && !this.death && this.status === 'playing') this.music.start();
    this.exit.update(dt, player);
    if (this.exit.open && player.mode === 'control' && this.once('dagdag', Math.hypot(player.pos[0] - CHAMBER_HALF, player.pos[2]) < 3.2)) this.speak('Dag dag!', 1.5);
    if (this.exit.entered && this.status === 'playing') this.status = 'exited';
  }

  /** The intro, the ladder and the rest of the cursor's plans, by the clock. */
  private updateScript(dt: number) {
    const { player, camera } = this.ctx;
    const t = this.t;
    if (this.once('pop', t > POP_AT)) {
      SOUND.bling();
      this.speak(pick(SIMLISH_HI), 2.2);
    }
    this.plumbob = t > POP_AT ? Math.min(1, this.plumbob + dt * 4) : 0;
    if (this.once('cursorIn', t > CURSOR_IN_AT)) {
      this.task = 'intro';
      this.cursor.visible = true;
      this.cursor.tip = [-X_HALF - 3, 22, -Z_HALF - 2];
      this.cursor.flyTo([-X_HALF, 0.05, -Z_HALF], CLICK_AT - CURSOR_IN_AT - 0.2);
      SOUND.whoosh();
    }
    if (this.once('click', t > CLICK_AT)) {
      SOUND.click();
      this.say('*click*', [-X_HALF, 2.4, -Z_HALF], 0.5, '#ffffff', 1, [0, 0.6, 0]);
      this.dragTo = [-X_HALF, 0, -Z_HALF];
      this.cursor.flyTo([X_HALF, 0.05, Z_HALF], DRAG_TIME);
    }
    if (this.dragTo && t > CLICK_AT && t < RELEASE_AT) {
      const tip = this.cursor.tip;
      this.dragTo = [clamp(tip[0], -X_HALF, X_HALF), 0, clamp(tip[2], -Z_HALF, Z_HALF)];
      const grid = `${Math.round(this.dragTo[0])},${Math.round(this.dragTo[2])}`;
      if (grid !== this.lastGrid) {
        this.lastGrid = grid;
        SOUND.tick();
      }
    }
    if (this.once('release', t > RELEASE_AT)) this.release();
    this.dragFade = t > RELEASE_AT ? Math.max(0, this.dragFade - dt * 1.2) : 1;

    // The build-mode camera goes back down to the Sim, then the ladder.
    if (this.once('ladder', t > Math.max(LADDER_AT, this.overviewEnd() + 0.8) && this.task === 'idle' && !this.death && player.mode === 'control')) {
      this.bringLadder();
    }
    void camera;
  }

  private overviewEnd() {
    return Math.max(OVERVIEW_END, this.fetchDone >= 0 ? this.fetchDone + 0.8 : 0) + (this.task === 'fetch' ? 99 : 0);
  }

  /** Let go of the mouse: the floor sinks and the pool fills. */
  private release() {
    const { player } = this.ctx;
    SOUND.click();
    SOUND.rumble();
    this.built = 1;
    this.poolMade = true;
    this.water.enabled = true;
    this.water.level = 0;
    const cost = X_HALF * 2 * Z_HALF * 2 * POOL_PRICE;
    this.say(`-§${cost.toLocaleString('en-US')}`, add(this.cursor.tip, [0, 3.6, 0]), 0.9, '#ff5a4a', 2.2, [0, 1, 0]);
    this.ctx.camera.addShake(0.35);
    // Buy mode throws in some poolside furniture.
    for (const [kind, x, z] of FURNITURE) {
      if (kind === 'lounger') this.ctx.physics.addStaticBox([x, 0.2, z], [2, 0.4, 0.7]);
      else this.ctx.physics.addStaticCylinder([x, 1.15, z], 0.06, 2.3);
    }
    // Anyone not standing over the pool gets helped in.
    const p = player.pos;
    if (player.mode === 'control' && !this.water.contains(p[0], p[2], -0.3)) {
      this.task = 'fetch';
      this.taskT = 0;
      this.cursor.flyTo(add(p, [0, 2.3, 0]), 0.7, 1.5);
    } else {
      this.task = 'idle';
      this.cursor.flyTo(add(this.cursor.tip, [0, 7, 0]), 1.2);
    }
  }

  private updateSink() {
    if (!this.poolMade) return;
    const k = clamp((this.t - RELEASE_AT) / SINK_TIME, 0, 1);
    const top = lerp(0, POOL_FLOOR, k * k * (3 - 2 * k));
    const moved = top !== this.slabTop;
    this.slabTop = top;
    if (moved) this.slab.setTranslation({ x: 0, y: top - 0.25, z: 0 }, true);
    // The water stays on the sinking floor until it's down to the waterline.
    this.water.level = Math.max(top, WATER_Y);
  }

  // --- The Sim in the water -------------------------------------------------------------------------

  private updateSim(dt: number) {
    const { player, input, camera } = this.ctx;
    this.water.clearLoads();
    this.hopCooldown = Math.max(0, this.hopCooldown - dt);
    if (this.clamber) {
      this.updateClamber(dt);
      return;
    }
    const alive = player.mode === 'control' && !player.inPortal && !this.death;
    if (!alive) {
      if (this.swimming) this.leaveWater();
      this.clamber = null;
      this.standingOn = this.lastStanding = null;
      player.platformVel = [0, 0, 0];
      return;
    }
    if (!this.poolMade) return;
    const p = player.pos;
    const inRect = this.water.contains(p[0], p[2], -0.05);
    if (!this.swimming && inRect && p[1] < WATER_Y - 0.6) this.enterWater();
    else if (this.swimming && (!inRect || p[1] > WATER_Y - 0.25)) this.leaveWater();

    if (this.swimming) {
      const tired = 1 - this.energy;
      player.gravityScale = 0;
      player.airControl = SWIM_STEER;
      player.speedScale = SWIM_SPEED * (1 - 0.3 * tired * tired);
      player.stunImmunity = Math.max(player.stunImmunity, 0.2);
      player.platformVel = [0, 0, 0];
      // Floating: a spring holds the feet under the surface (lower as they tire), bobbing.
      const target = WATER_Y - FLOAT_DEPTH - tired * tired * 0.22 + Math.sin(this.time * 2.3) * (0.04 + 0.06 * tired);
      player.vel[1] += ((target - p[1]) * FLOAT_SPRING - player.vel[1] * FLOAT_DAMP) * dt;
      if (player.vel[1] < -3) player.vel[1] *= Math.exp(-dt * 6); // the water stops a fall
      player.onGround = false; // no proper jumping out of water
      const moving = Math.hypot(player.vel[0], player.vel[2]) / 2;
      player.poseOverride = swimPose(this.time, moving, tired);
      this.energy = Math.max(0, this.energy - dt / ENERGY_TIME);
      for (const level of [0.3, 0.15]) {
        if (this.energy < level && !this.warned.has(level)) {
          this.warned.add(level);
          SOUND.warn();
          this.speak(pick(SIMLISH_TIRED), 2);
        }
      }
      if (this.energy <= 0) {
        this.drown();
        return;
      }
      // Splashing about.
      this.paddleT -= dt * (0.4 + moving);
      if (this.paddleT <= 0) {
        this.paddleT = 0.55;
        if (moving > 0.3) SOUND.paddle();
        this.ripple([p[0], this.water.level, p[2]], 0.5 + moving * 0.3);
      }
      if (input.wasPressed('Space') && this.hopCooldown <= 0) this.hopOrClimb();
      return;
    }

    // Out of the water: standing on something floating presses it down and carries you along.
    const onFloat = player.onGround ? this.floatUnder() : null;
    if (onFloat) {
      this.water.setLoad(onFloat.body, onFloat.point, PLAYER_LOAD);
      const rb = onFloat.body.rb;
      const c = rb.translation(), v = rb.linvel(), w = rb.angvel();
      const r = sub(onFloat.point, [c.x, c.y, c.z]);
      const pv = add([v.x, v.y, v.z], cross([w.x, w.y, w.z], r));
      player.platformVel = [pv[0], clamp(pv[1], -2, 2), pv[2]];
      this.standingOn = onFloat.body;
    } else if (player.onGround) {
      player.platformVel = [0, 0, 0];
      this.standingOn = null;
    } else {
      player.platformVel[1] = 0;
      // Just jumped off something floating: it gets kicked down and back.
      const was = this.lastStanding;
      if (was && player.vel[1] > 4) {
        const push = scale(normalize([player.vel[0], 0, player.vel[2]]), -JUMP_KICK * 0.3 * Math.min(1, Math.hypot(player.vel[0], player.vel[2]) / 4));
        was.rb.applyImpulse({ x: push[0], y: -JUMP_KICK, z: push[2] }, true);
      }
      this.standingOn = null;
    }
    this.lastStanding = this.standingOn;
    void camera;
    // Out of the pool, on the deck: the cursor has a last idea.
    const onDeck = player.onGround && p[1] > -0.25 && !this.water.contains(p[0], p[2], 0.1);
    this.outT = onDeck ? this.outT + dt : 0;
    if (this.stage === 'pool' && this.wet && this.outT > 0.4) this.climbedOut();
  }

  private enterWater() {
    const { player } = this.ctx;
    this.swimming = true;
    player.gravityScale = 0;
    player.airControl = SWIM_STEER;
    const v = -player.vel[1];
    if (v > 2.5) this.splash([player.pos[0], this.water.level, player.pos[2]], v * 70);
    if (!this.wet) {
      this.wet = true;
      this.stage = 'pool';
      this.speak(pick(SIMLISH_SPLASH), 1.8);
    }
  }

  private leaveWater() {
    const { player } = this.ctx;
    this.swimming = false;
    player.gravityScale = 1;
    player.airControl = 1;
    player.speedScale = 1;
    player.poseOverride = null;
  }

  /** Space in the water: climb onto something floating that's right there, or just a feeble hop. */
  private hopOrClimb() {
    const { player } = this.ctx;
    this.hopCooldown = 0.45;
    const target = this.findClamber();
    if (target) {
      const q = target.body.rb.rotation() as Quat, c = target.body.rb.translation();
      const local = rotateByQuat(quatConj(q), sub(target.point, [c.x, c.y, c.z]));
      this.clamber = { body: target.body, local, from: [...player.pos], t: 0 };
      // Hauling themselves up is scripted (the physical body is off meanwhile, so it doesn't
      // shove the thing away): the hanging pose, arms up over the top.
      this.leaveWater();
      player.mode = 'swinging';
      player.vel = [0, 0, 0];
      player.cancelJump(); // that Space was for climbing
      SOUND.clamber();
      this.ripple([player.pos[0], this.water.level, player.pos[2]], 1);
      return;
    }
    player.vel[1] = HOP_SPEED;
    player.cancelJump();
    SOUND.hop();
    this.ripple([player.pos[0], this.water.level, player.pos[2]], 0.9);
    // Right by the side: the deck is too high. They know.
    const p = player.pos;
    const edge = Math.min(X_HALF - Math.abs(p[0]), Z_HALF - Math.abs(p[2]));
    if (edge < 1.1) {
      const ladderGone = this.ladder?.gone ?? false;
      this.speak(pick(SIMLISH_WALL), 1.6, ladderGone && Math.random() < 0.5);
    }
  }

  /**
   * Something floating with its top within reach round the Sim: the highest such top (a crate
   * stacked on the pallet beats the pallet), preferring what's in front of them.
   */
  private findClamber(): { body: Body; point: Vec3 } | null {
    const { player, physics, camera } = this.ctx;
    const p = player.pos;
    const dirs: Vec3[] = [
      [-Math.sin(camera.yaw), 0, -Math.cos(camera.yaw)],
      [-Math.sin(player.facing), 0, -Math.cos(player.facing)],
    ];
    for (let i = 0; i < 8; i++) dirs.push([Math.cos((i / 8) * Math.PI * 2), 0, Math.sin((i / 8) * Math.PI * 2)]);
    let best: { body: Body; point: Vec3; score: number } | null = null;
    dirs.forEach((d, di) => {
      for (const reach of [0.45, 0.75, 1.05, 1.3]) {
        const origin: Vec3 = [p[0] + d[0] * reach, WATER_Y + 1.8, p[2] + d[2] * reach];
        const hit = physics.raycast(origin, [0, -1, 0], 2.6, player.collider ?? undefined);
        if (!hit) continue;
        const body = this.water.bodyFor(hit.collider);
        if (!body || hit.normal[1] < 0.55) continue;
        if (hit.point[1] > WATER_Y + CLAMBER_MAX || hit.point[1] < WATER_Y - 0.4) continue;
        // Climb onto the middle of it (or as far in as half a metre), not its very edge.
        let point = hit.point;
        const c = body.rb.translation();
        const toward: Vec3 = [c.x - hit.point[0], 0, c.z - hit.point[2]];
        const len = Math.hypot(toward[0], toward[2]);
        if (len > 0.05) {
          const k = Math.min(len, 0.5) / len;
          const inner: Vec3 = [hit.point[0] + toward[0] * k, WATER_Y + 1.8, hit.point[2] + toward[2] * k];
          const top = physics.raycast(inner, [0, -1, 0], 2.6, player.collider ?? undefined);
          if (top && this.water.bodyFor(top.collider) === body && top.normal[1] > 0.55 && top.point[1] < WATER_Y + CLAMBER_MAX + 0.1) point = top.point;
        }
        const score = point[1] - reach * 0.1 + (di < 2 ? 0.15 : 0);
        if (!best || score > best.score) best = { body, point, score };
      }
    });
    return best;
  }

  private updateClamber(dt: number) {
    const { player } = this.ctx;
    const c = this.clamber!;
    c.t += dt / CLAMBER_TIME;
    const rb = c.body.rb;
    const q = rb.rotation() as Quat, ct = rb.translation();
    const top = add(add([ct.x, ct.y, ct.z], rotateByQuat(q, c.local)), [0, 0.05, 0]);
    const k = Math.min(1, c.t);
    if (player.mode !== 'swinging' || this.death) {
      this.clamber = null;
      return;
    }
    const rise = 1 - (1 - Math.min(1, k * 1.5)) ** 2;
    const over = easeInOut(clamp((k - 0.3) / 0.7, 0, 1));
    player.pos = [lerp(c.from[0], top[0], over), lerp(c.from[1], top[1] + 0.12 * (1 - over), rise), lerp(c.from[2], top[2], over)];
    // Face the thing being climbed.
    const dx = top[0] - c.from[0], dz = top[2] - c.from[2];
    if (Math.hypot(dx, dz) > 0.05) player.facing = Math.atan2(-dx, -dz);
    player.syncCollider();
    this.water.setLoad(c.body, top, PLAYER_LOAD * k);
    if (k >= 1) {
      this.clamber = null;
      player.pos = top;
      player.resume([0, 0, 0]);
      player.stunImmunity = 0.6;
      this.lastStanding = c.body;
    }
  }

  /** The floating thing under the Sim's feet, if any (a few rays round the feet). */
  private floatUnder(): { body: Body; point: Vec3 } | null {
    const { player, physics } = this.ctx;
    const p = player.pos;
    for (const [dx, dz] of FOOT_RAYS) {
      const hit = physics.raycast([p[0] + dx, p[1] + 0.3, p[2] + dz], [0, -1, 0], 0.65, player.collider ?? undefined);
      if (!hit) continue;
      const body = this.water.bodyFor(hit.collider);
      if (body) return { body, point: hit.point };
    }
    return null;
  }

  /** Out of the pool at last. The cursor considers the exit... */
  private climbedOut() {
    this.stage = 'out';
    this.everOut = true;
    SOUND.yay();
    this.speak(pick(['Vadish!', 'Yibs!', 'Woo-hoo... no. Yibs!']), 2);
    this.mood = 1;
    this.task = 'door';
    this.taskT = 0;
    this.carrying = null;
    this.cursor.pinch = 0;
    this.cursor.flyTo(DOOR_TIP, 1.3, 2);
  }

  private drown() {
    const { player, camera } = this.ctx;
    this.leaveWater();
    player.kill([0, -0.4, 0], { violence: 0 });
    this.drownHooked = true;
    camera.addShake(0.2);
    this.speak('Blub...', 2.5);
    this.music.stop();
    SOUND.warn();
    this.die('SIM DIED', `Cause of death: drowning.\n${pick(DROWN_LINES)}`, DROWN_SCREEN_DELAY, true);
  }

  private die(big: string, small: string, delay = DEATH_SCREEN_DELAY, drowned = false) {
    this.ctx.hud.hide();
    this.death = { t: 0, big, small, delay, drowned };
  }

  /** A drowned Sim's body sinks slowly (each part nearly floats), with drag. */
  private sinkBody(h: number) {
    if (!this.drownHooked) return;
    const body = this.ctx.player.body;
    if (!body) return;
    for (const rb of Object.values(body.parts)) {
      const t = rb.translation();
      if (t.y > this.water.level || !this.water.contains(t.x, t.z)) continue;
      const m = rb.mass(), v = rb.linvel();
      rb.applyImpulse({ x: -v.x * m * 2.5 * h, y: m * GRAVITY * 0.88 * h - v.y * m * 2.5 * h, z: -v.z * m * 2.5 * h }, true);
    }
  }

  private updateReaper(dt: number) {
    const death = this.death!;
    const body = this.ctx.player.body;
    const at = body ? body.position('chest') : this.ctx.player.pos;
    if (Math.random() < dt * 6 && death.t < 3.5) {
      this.drops.push({ pos: add(at, [rand(-0.2, 0.2), 0.2, rand(-0.2, 0.2)]), vel: [0, rand(0.8, 1.6), 0], age: 0, life: 2.5, size: rand(0.04, 0.1), bubble: true, sparkle: false });
      if (Math.random() < 0.4) SOUND.blub();
    }
    if (!this.reaper && death.t > 1.1) {
      const cam = this.ctx.camera.pos;
      const toCam = normalize([cam[0] - at[0], 0, cam[2] - at[2]]);
      const side: Vec3 = [toCam[2], 0, -toCam[0]];
      const hover: Vec3 = [clamp(at[0] + side[0] * 1.3 + toCam[0] * 0.6, -X_HALF + 1, X_HALF - 1), WATER_Y + 0.35, clamp(at[2] + side[2] * 1.3 + toCam[2] * 0.6, -Z_HALF + 1, Z_HALF - 1)];
      // Facing the camera (his yaw 0 faces -z).
      this.reaper = { pos: [hover[0], 14, hover[2]], from: [hover[0], 14, hover[2]], to: hover, t: 0, yaw: Math.atan2(-toCam[0], -toCam[2]) };
      SOUND.reaper();
    }
    const r = this.reaper;
    if (!r) return;
    r.t += dt;
    const to = r.to;
    const k = easeInOut(clamp(r.t / 1.8, 0, 1));
    r.pos = [to[0], lerp(r.from[1], to[1], k) + Math.sin(this.time * 1.7) * 0.08 * k, to[2]];
    if (this.once('scribble', r.t > 2.1)) {
      SOUND.scribble();
      this.say('*scribble scribble*', add(r.pos, [0, 3.1, 0]), 0.3, '#d8d8e8', 1.2, [0, 0.25, 0]);
    }
    if (this.once('classic', r.t > 3.3)) this.say('Drowned. Classic.', add(r.pos, [0, 3.1, 0]), 0.34, '#a8ffcf', 2.5, [0, 0.15, 0]);
  }

  // --- The cursor ---------------------------------------------------------------------------------------

  private bringLadder() {
    const { player, camera } = this.ctx;
    // A spot on the edge a fair swim away (not right next to them, not right across the pool),
    // and somewhere they're looking.
    let best: { pos: Vec3; yaw: number; score: number } | null = null;
    const fx = -Math.sin(camera.yaw), fz = -Math.cos(camera.yaw);
    for (const [x, z, yaw] of LADDER_SPOTS) {
      const dx = x - player.pos[0], dz = z - player.pos[2];
      const d = Math.hypot(dx, dz);
      const ahead = (dx * fx + dz * fz) / Math.max(d, 0.01);
      const score = Math.abs(d - 7) + (1 - ahead) * 4 + Math.random() * 0.8;
      if (!best || score < best.score) best = { pos: [x, 0, z], yaw, score };
    }
    this.ladder = { pos: best!.pos, yaw: best!.yaw, placed: -1, gone: false };
    this.carrying = 'ladder';
    this.cursor.pinch = 1;
    this.cursor.tip = add(best!.pos, [0, 16, 0]);
    this.cursor.flyTo(add(best!.pos, [0, 1.35, 0]), 1.0);
    this.task = 'ladder-bring';
    this.taskT = 0;
    SOUND.whoosh();
  }

  private updateCursor(dt: number) {
    const cursor = this.cursor;
    const { player, camera } = this.ctx;
    this.taskT += dt;
    // The back of the hand faces the camera, more or less.
    const cam = camera.pos;
    cursor.yaw = Math.atan2(cam[0] - cursor.tip[0], cam[2] - cursor.tip[2]);
    switch (this.task) {
      case 'fetch': {
        const p = player.pos;
        if (player.mode === 'control' && this.water.contains(p[0], p[2], -0.3)) {
          this.task = 'idle'; // they jumped in by themselves
          this.fetchDone = this.t;
          break;
        }
        if (player.mode === 'control' && this.taskT < 0.75) {
          if (this.taskT > 0.35) cursor.follow(add(p, [0, 2.3, 0]), dt, 12);
        } else if (player.mode === 'control' && this.taskT >= 0.75 && this.taskT < 1) {
          // Got them by the scruff.
          player.mode = 'held';
          player.vel = [0, 0, 0];
          cursor.pinch = 1;
          SOUND.click();
          this.speak('Nooboo?!', 1.6);
          const free = this.pickDropSpot(0, 3.5);
          const drop: Vec3 = [free[0], 4.5, free[2]];
          cursor.flyTo(add(drop, [0, 2.3, 0]), 1.3, 1.5);
        }
        if (player.mode === 'held') {
          player.pos = sub(cursor.tip, [0, 2.3, 0]);
          player.syncCollider();
          if (cursor.arrived && this.taskT > 1.2) {
            player.resume([0, -1, 0]);
            cursor.pinch = 0;
            SOUND.click();
            this.say('*click*', add(cursor.tip, [0, 0.8, 0]), 0.5, '#ffffff', 1, [0, 0.6, 0]);
            this.task = 'idle';
            this.fetchDone = this.t;
            cursor.flyTo(add(cursor.tip, [0, 5, 0]), 1.2);
          }
        }
        break;
      }
      case 'ladder-bring':
        if (cursor.arrived) {
          this.carrying = null;
          cursor.pinch = 0;
          this.ladder!.placed = this.time;
          SOUND.click();
          SOUND.tada();
          this.say('Pool Ladder  -§50', add(this.ladder!.pos, [0, 2.2, 0]), 0.42, '#ffffff', 2.2, [0, 0.4, 0]);
          this.task = 'ladder-hover';
          this.taskT = 0;
          this.speak('Yibs!', 1.4);
          cursor.flyTo(add(this.ladder!.pos, [0, 4.2, 0]), 0.8);
        }
        break;
      case 'ladder-hover': {
        const l = this.ladder!;
        // Hovering nearby, as if admiring its work.
        if (cursor.arrived) cursor.follow(add(l.pos, [Math.sin(this.time * 0.9) * 0.8, 4 + Math.sin(this.time * 1.7) * 0.3, 0]), dt, 2);
        const d = Math.hypot(player.pos[0] - l.pos[0], player.pos[2] - l.pos[2]);
        if (d < LADDER_TRIGGER || this.taskT > LADDER_PATIENCE || !this.swimming) {
          if (this.taskT > 1 || d < LADDER_TRIGGER) {
            this.task = 'ladder-grab';
            this.taskT = 0;
            cursor.flyTo(add(l.pos, [0, 0.95, 0]), 0.3);
          }
        }
        break;
      }
      case 'ladder-grab':
        if (cursor.arrived) {
          cursor.pinch = 1;
          SOUND.click();
          this.carrying = 'ladder';
          this.task = 'ladder-lift';
          this.taskT = 0;
          cursor.flyTo(add(this.ladder!.pos, [0, 2.6, 0]), 0.55);
        }
        break;
      case 'ladder-lift':
        if (cursor.arrived && this.taskT > 0.7) {
          // Sold back. Full refund, too.
          const at = sub(cursor.tip, [0, 1.35, 0]);
          this.carrying = null;
          this.ladder!.gone = true;
          cursor.pinch = 0;
          SOUND.poof();
          SOUND.kaching();
          this.sparkle(at, 26);
          this.say('+§50', add(at, [0, 1.2, 0]), 0.9, '#6bff7a', 2.4, [0, 0.9, 0]);
          this.speak('Nooboo!', 1.3, true);
          this.task = 'decor-up';
          this.taskT = 0;
          cursor.flyTo(add(cursor.tip, [0, 1.2, 0]), 1.4);
        }
        break;
      case 'decor-up':
        if (this.taskT > 1.4) {
          const next = this.decor.shift();
          if (!next || this.death) {
            this.task = 'idle';
            break;
          }
          this.carrying = next;
          cursor.pinch = 1;
          this.dropAt = this.pickDropSpot(next === 'couch' ? 4.5 : 4, next === 'couch' ? 7.5 : 9);
          cursor.tip = add(this.dropAt, [0, 18, 0]);
          cursor.flyTo(add(this.dropAt, [0, next === 'couch' ? 3.6 : 4.4, 0]), 1.2);
          this.task = 'decor-bring';
          this.taskT = 0;
          SOUND.whoosh();
        }
        break;
      case 'decor-bring':
        if (cursor.arrived && this.taskT > 1.4) {
          const what = this.carrying!;
          this.carrying = null;
          cursor.pinch = 0;
          SOUND.click();
          const at = sub(cursor.tip, [0, what === 'couch' ? 0.95 : 1.55, 0]);
          const body = this.spawnProp(what, at, rand(-0.4, 0.4));
          body.rb.setLinvel({ x: 0, y: -1, z: 0 }, true);
          this.say(what === 'couch' ? 'Couch  -§180  (floats, apparently)' : 'Fridge  -§400  (does not float)', add(at, [0, 1.6, 0]), 0.4, '#ffffff', 2.8, [0, 0.35, 0]);
          if (what === 'fridge') this.speak('Fwah?', 1.4);
          this.task = 'decor-away';
          this.taskT = 0;
          cursor.flyTo(add(cursor.tip, [0, 3, 0]), 1);
        }
        break;
      case 'decor-away':
        if (this.taskT > 1.6) {
          this.task = this.decor.length ? 'decor-up' : 'idle';
          this.taskT = 0;
        }
        break;
      case 'idle': {
        if (!cursor.arrived) break;
        // Getting low on energy? The cursor goes and taps the gauge.
        if (this.swimming && this.energy < 0.42 && !this.death && this.decor.length === 0 && this.once('tapPanel')) {
          this.task = 'panel';
          this.taskT = 0;
          cursor.flyTo(add(this.panelTap(), [0, 0.5, 0.35]), 1.4, 1);
          break;
        }
        // Circling over the pool, watching.
        this.idleAngle += dt * 0.35;
        const p = player.pos;
        const around: Vec3 = [clamp(p[0] + Math.cos(this.idleAngle) * 6.5, -X_HALF, X_HALF), 3.4 + Math.sin(this.time * 0.8) * 0.4, clamp(p[2] + Math.sin(this.idleAngle) * 6.5, -Z_HALF, Z_HALF)];
        cursor.follow(around, dt, 0.8);
        break;
      }
      case 'panel': {
        // Tap, tap. Hm.
        if (!cursor.arrived && this.taskT < 1.5) break;
        const tt = this.taskT - 1.4;
        const at = this.panelTap();
        cursor.tip = add(at, [0, 0.5 - 0.45 * Math.max(0, Math.sin(Math.max(0, tt) * Math.PI * 4)) * (tt < 0.5 ? 1 : 0), 0.35]);
        if (this.once('tap1', tt > 0.1)) SOUND.click();
        if (this.once('tap2', tt > 0.35)) {
          SOUND.click();
          this.say('*tap tap*', add(at, [0.8, 0.9, 0.3]), 0.36, '#ffffff', 1.4, [0, 0.3, 0]);
        }
        if (this.once('tapHm', tt > 1.1)) {
          SOUND.hmm();
          this.say('Hm. Still going down.', add(at, [0.8, 1.5, 0.3]), 0.36, '#ffffff', 2.2, [0, 0.2, 0]);
        }
        if (tt > 2.2) {
          this.task = 'idle';
          this.taskT = 0;
          cursor.flyTo(add(player.pos, [4, 5, 4]), 1.6);
        }
        break;
      }
      case 'door': {
        // Over to the exit, "delete door?", a long hesitation... nah.
        if (this.once('doorThere', cursor.arrived)) {
          this.taskT = 0;
          SOUND.hmm();
          this.say('DELETE DOOR?', add(DOOR_TIP, [-0.6, 1.2, 0]), 0.55, '#ff6b5a', 2.4, [0, 0.1, 0]);
          this.speak('Nib! Nib!', 1.8);
        }
        if (!this.beats.has('doorThere')) break;
        const tt = this.taskT;
        if (tt < 2.2) {
          cursor.tip = add(DOOR_TIP, [0, Math.sin(tt * 3) * 0.12, Math.sin(tt * 7) * 0.35 * Math.min(1, tt)]);
          cursor.pinch = 0.25 + 0.2 * Math.sin(tt * 5);
        }
        if (this.once('dots', tt > 0.9)) this.say('...', add(DOOR_TIP, [-0.6, 2.2, 0]), 0.6, '#ffffff', 1.2, [0, 0.2, 0]);
        if (this.once('nah', tt > 2.2)) {
          SOUND.nah();
          this.say('...nah.', add(DOOR_TIP, [-0.8, 2.4, 0]), 0.5, '#ffffff', 2, [0, 0.3, 0]);
          cursor.pinch = 0;
          cursor.flyTo([4, 24, -4], 2.2, 1);
          this.task = 'leave';
          this.taskT = 0;
        }
        break;
      }
      case 'leave':
        if (this.once('exitOpen', this.taskT > 0.5)) this.exit.openNow();
        if (cursor.arrived) cursor.visible = false;
        break;
    }
    cursor.update(dt);
  }

  /** The end of the ENERGY bar on the needs panel (where the cursor taps it). */
  private panelTap(): Vec3 {
    const e = this.needs.barEnd(0);
    return [e[0], e[1] + 0.2, e[2]];
  }

  /** Somewhere in the pool, `min`-`max` m from the Sim, not too near a side. */
  private pickDropSpot(min: number, max: number): Vec3 {
    const p = this.ctx.player.pos;
    let best: Vec3 = [0, 0, 0];
    let bestScore = Infinity;
    for (let i = 0; i < 40; i++) {
      const c: Vec3 = [rand(-X_HALF + 2, X_HALF - 2), 0, rand(-Z_HALF + 2, Z_HALF - 2)];
      const d = Math.hypot(c[0] - p[0], c[2] - p[2]);
      const crowd = this.floaters.reduce((s, f) => {
        const t = f.body.rb.translation();
        return s + Math.max(0, 1.6 - Math.hypot(t.x - c[0], t.z - c[2]));
      }, 0);
      const score = (d < min ? (min - d) * 3 : d > max ? d - max : 0) + crowd;
      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    }
    return best;
  }

  // --- Effects --------------------------------------------------------------------------------------

  /** The Sim says something (Simlish, in a bubble over their head), then maybe thinks wistfully of a ladder. */
  private speak(text: string, seconds: number, thenLadder = false) {
    this.bubble = { text, ttl: seconds, ladder: false, next: thenLadder };
    this.bubbleLabel.text = text;
    babble(text, 1);
  }

  /** A thought bubble: a ladder, crossed out. */
  private thinkLadder(seconds: number) {
    this.bubble = { text: '', ttl: seconds, ladder: true, next: false };
    this.bubbleLabel.text = '';
  }

  private say(text: string, pos: Vec3, size: number, color: string, life: number, vel: Vec3 = [0, 0.4, 0]) {
    this.says.push({ label: { pos: [...pos], text, size, color }, ttl: life, vel: [...vel] });
  }

  private splash(pos: Vec3, strength: number) {
    const k = clamp(strength / 900, 0.1, 1);
    SOUND.splash(k);
    const n = Math.round(6 + 28 * k);
    for (let i = 0; i < n; i++) {
      if (this.drops.length > 260) this.drops.shift();
      const a = Math.random() * Math.PI * 2, out = rand(0.5, 2.5) * (0.5 + k);
      this.drops.push({ pos: [pos[0] + Math.cos(a) * 0.3, pos[1] + 0.05, pos[2] + Math.sin(a) * 0.3], vel: [Math.cos(a) * out, rand(2.5, 6.5) * (0.6 + k * 0.6), Math.sin(a) * out], age: 0, life: 2, size: rand(0.05, 0.12), bubble: false, sparkle: false });
    }
    this.ripple(pos, 0.8 + k);
    this.ripple(pos, 0.4 + k * 0.6);
  }

  private ripple(pos: Vec3, size: number) {
    if (this.ripples.length > 24) this.ripples.shift();
    this.ripples.push({ pos: [pos[0], pos[1], pos[2]], age: 0, life: 1.4, size });
  }

  private sparkle(pos: Vec3, n: number) {
    for (let i = 0; i < n; i++) {
      this.drops.push({ pos: add(pos, [rand(-0.6, 0.6), rand(-1.2, 1.2), rand(-0.6, 0.6)]), vel: [rand(-2, 2), rand(-0.5, 2.5), rand(-2, 2)], age: 0, life: rand(0.5, 1), size: rand(0.06, 0.14), bubble: false, sparkle: true });
    }
  }

  private updateEffects(dt: number) {
    // Things hitting the water.
    const w = this.water;
    while (w.splashes.length) {
      const s = w.splashes.pop()!;
      if (s.strength > 25) this.splash(s.pos, s.strength);
    }
    if (this.bubble) {
      this.bubble.ttl -= dt;
      if (this.bubble.ttl <= 0) {
        if (this.bubble.next && !this.death) this.thinkLadder(1.8);
        else this.bubble = null;
      }
    }
    for (let i = this.says.length - 1; i >= 0; i--) {
      const s = this.says[i];
      s.ttl -= dt;
      if (s.ttl <= 0) {
        this.says.splice(i, 1);
        continue;
      }
      for (let k = 0; k < 3; k++) s.label.pos[k] += s.vel[k] * dt;
    }
    const level = this.water.level;
    for (const d of this.drops) {
      d.age += dt;
      if (d.sparkle) {
        for (let k = 0; k < 3; k++) {
          d.pos[k] += d.vel[k] * dt;
          d.vel[k] *= Math.exp(-dt * 2);
        }
      } else if (d.bubble) {
        d.pos[1] += d.vel[1] * dt;
        d.pos[0] += Math.sin(d.age * 9 + d.size * 50) * 0.2 * dt;
        if (d.pos[1] > level) d.age = d.life;
      } else {
        d.vel[1] -= 16 * dt;
        for (let k = 0; k < 3; k++) d.pos[k] += d.vel[k] * dt;
        if (d.pos[1] < level && d.vel[1] < 0 && w.contains(d.pos[0], d.pos[2])) d.age = d.life;
      }
    }
    this.drops = this.drops.filter((d) => d.age < d.life);
    for (const r of this.ripples) r.age += dt;
    while (this.ripples.length && this.ripples[0].age > this.ripples[0].life) this.ripples.shift();
    this.needs.update(dt);
  }

  private updateNeeds(dt: number) {
    const n = this.needs;
    n.shown = this.t > POP_AT ? Math.min(1, n.shown + dt * 3) : 0;
    // Out of the pool, it comes back.
    if (this.everOut) this.energy = Math.min(1, this.energy + dt * 0.25);
    const e = this.energy;
    const energy = n.needs[0];
    energy.value = e;
    energy.caption = e > 0.7 ? 'Fine' : e > 0.45 ? 'Tired' : e > 0.2 ? 'Very tired' : e > 0 ? 'Blub' : 'Gone';
    n.alarm = e < 0.3 && !this.everOut;
    n.needs[2].caption = this.wet ? 'Excellent (you are in a pool)' : 'Excellent';
    if (!this.everOut) this.mood = this.swimming || this.wet ? this.energy : 1;
  }

  // --- Drawing --------------------------------------------------------------------------------------

  draw(out: DrawItem[], time: number) {
    this.arrival.draw(out);
    this.exit.draw(out);
    this.drawRoom(out);
    this.drawPool(out);
    if (this.dragTo && this.dragFade > 0) this.drawDrag(out);
    this.needs.draw(out);
    this.drawLadder(out);
    this.drawFurniture(out);
    this.drawCursor(out);
    this.drawSim(out, time);
    if (this.reaper) drawGrimReaper(out, this.reaper.pos, this.reaper.yaw, this.time, clamp((this.reaper.t - 1.8) / 0.5, 0, 1));
    this.drawEffects(out);
  }

  private drawRoom(out: DrawItem[]) {
    for (const [pos, size] of WALLS) out.push({ mesh: 'box', model: mul(translation(pos), scaling(size)), color: WALL, pattern: Pattern.panels, param: 2, spec: 0.15 });
    // The deck: the old floor, repaved as a pool deck once there's a pool.
    const H = CHAMBER_HALF;
    const deck = this.built ? DECK : FLOOR;
    const param = this.built ? 1 : 2;
    const slab = (x0: number, x1: number, z0: number, z1: number) => out.push({
      mesh: 'box', model: mul(translation([(x0 + x1) / 2, -0.25, (z0 + z1) / 2]), scaling([x1 - x0, 0.5, z1 - z0])), color: deck, pattern: Pattern.panels, param, spec: 0.12,
    });
    slab(-H, H, -H, -Z_HALF);
    slab(-H, H, Z_HALF, H);
    slab(-H, -X_HALF, -Z_HALF, Z_HALF);
    slab(X_HALF, H, -Z_HALF, Z_HALF);
  }

  private drawPool(out: DrawItem[]) {
    // The floor that sinks: the chamber's floor, then the bottom of the pool (tiles, lane lines).
    const top = this.slabTop;
    out.push({
      mesh: 'box', model: mul(translation([0, top - 0.25, 0]), scaling([X_HALF * 2, 0.5, Z_HALF * 2])),
      color: this.built ? TILE : FLOOR, pattern: Pattern.panels, param: this.built ? -0.5 : 2, spec: this.built ? 0.3 : 0.12,
    });
    if (!this.built) return;
    for (const z of [-4, 0, 4]) {
      out.push({ mesh: 'box', model: mul(translation([0, top + 0.004, z]), scaling([X_HALF * 2 - 3, 0.01, 0.3])), color: LANE, shadow: false });
      for (const x of [-(X_HALF - 1.5), X_HALF - 1.5]) out.push({ mesh: 'box', model: mul(translation([x, top + 0.004, z]), scaling([0.3, 0.01, 1.1])), color: LANE, shadow: false });
    }
    // The walls of the pool: tiles under the water (with caustics), a dark band along the waterline, dry tiles above.
    const wall = (y0: number, y1: number, color: number[], param: number) => {
      const cy = (y0 + y1) / 2, h = y1 - y0;
      out.push({ mesh: 'box', model: mul(translation([0, cy, -Z_HALF - 0.05]), scaling([X_HALF * 2, h, 0.1])), color, pattern: Pattern.panels, param, spec: 0.3 });
      out.push({ mesh: 'box', model: mul(translation([0, cy, Z_HALF + 0.05]), scaling([X_HALF * 2, h, 0.1])), color, pattern: Pattern.panels, param, spec: 0.3 });
      out.push({ mesh: 'box', model: mul(translation([-X_HALF - 0.05, cy, 0]), scaling([0.1, h, Z_HALF * 2])), color, pattern: Pattern.panels, param, spec: 0.3 });
      out.push({ mesh: 'box', model: mul(translation([X_HALF + 0.05, cy, 0]), scaling([0.1, h, Z_HALF * 2])), color, pattern: Pattern.panels, param, spec: 0.3 });
    };
    wall(POOL_FLOOR, WATER_Y - 0.12, TILE, -0.3);
    wall(WATER_Y - 0.12, WATER_Y + 0.12, TILE_BAND, 0.12);
    wall(WATER_Y + 0.12, -0.12, TILE_DRY, 0.3);
    // The coping round the edge.
    const c = 0.2;
    out.push({ mesh: 'bevelbox', model: mul(translation([0, -0.05, -Z_HALF - c / 2 + 0.06]), scaling([X_HALF * 2 + c * 2, 0.14, c + 0.12])), color: COPING, spec: 0.3 });
    out.push({ mesh: 'bevelbox', model: mul(translation([0, -0.05, Z_HALF + c / 2 - 0.06]), scaling([X_HALF * 2 + c * 2, 0.14, c + 0.12])), color: COPING, spec: 0.3 });
    out.push({ mesh: 'bevelbox', model: mul(translation([-X_HALF - c / 2 + 0.06, -0.05, 0]), scaling([c + 0.12, 0.14, Z_HALF * 2])), color: COPING, spec: 0.3 });
    out.push({ mesh: 'bevelbox', model: mul(translation([X_HALF + c / 2 - 0.06, -0.05, 0]), scaling([c + 0.12, 0.14, Z_HALF * 2])), color: COPING, spec: 0.3 });
    // The water, and a blue haze further down so the deep end looks deep.
    out.push({
      mesh: 'box', model: mul(translation([0, this.water.level - 0.02, 0]), scaling([X_HALF * 2 - 0.01, 0.04, Z_HALF * 2 - 0.01])),
      color: [1, 1, 1], pattern: Pattern.lava, param: 3, opacity: 0.5, shadow: false,
    });
    const haze = Math.min(this.water.level - 1.75, (this.water.level + this.slabTop) / 2);
    if (haze > this.slabTop + 0.2) {
      out.push({
        mesh: 'box', model: mul(translation([0, haze, 0]), scaling([X_HALF * 2 - 0.02, 0.02, Z_HALF * 2 - 0.02])),
        color: HAZE, pattern: Pattern.emissive, opacity: 0.28, shadow: false,
      });
    }
  }

  /** Build mode: the blue rectangle being dragged out, with a grid, while the mouse is held. */
  private drawDrag(out: DrawItem[]) {
    const a: Vec3 = [-X_HALF, 0, -Z_HALF], b = this.dragTo!;
    const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]) + 0.001, z0 = Math.min(a[2], b[2]), z1 = Math.max(a[2], b[2]) + 0.001;
    const y = Math.max(this.slabTop, 0) + 0.02;
    const k = this.dragFade;
    const glow = [BUILD_BLUE[0] * k, BUILD_BLUE[1] * k, BUILD_BLUE[2] * k];
    out.push({ mesh: 'box', model: mul(translation([(x0 + x1) / 2, y, (z0 + z1) / 2]), scaling([x1 - x0, 0.01, z1 - z0])), color: glow, pattern: Pattern.emissive, opacity: 0.22 * k, shadow: false });
    const line = (cx: number, cz: number, sx: number, sz: number, o: number) => out.push({ mesh: 'box', model: mul(translation([cx, y + 0.01, cz]), scaling([sx, 0.02, sz])), color: glow, pattern: Pattern.emissive, opacity: o, shadow: false });
    for (let x = Math.ceil(x0); x < x1; x++) line(x, (z0 + z1) / 2, 0.04, z1 - z0, 0.45 * k);
    for (let z = Math.ceil(z0); z < z1; z++) line((x0 + x1) / 2, z, x1 - x0, 0.04, 0.45 * k);
    line((x0 + x1) / 2, z0, x1 - x0 + 0.12, 0.12, k);
    line((x0 + x1) / 2, z1, x1 - x0 + 0.12, 0.12, k);
    line(x0, (z0 + z1) / 2, 0.12, z1 - z0, k);
    line(x1, (z0 + z1) / 2, 0.12, z1 - z0, k);
  }

  private drawLadder(out: DrawItem[]) {
    const l = this.ladder;
    if (!l || l.gone) return;
    let m: Mat4;
    if (this.carrying === 'ladder') m = mul(translation(sub(this.cursor.tip, [0, 0.95, 0])), rotationY(l.yaw), rotationY(Math.sin(this.time * 3) * 0.1));
    else if (l.placed >= 0) m = mul(translation(l.pos), rotationY(l.yaw));
    else return;
    drawPoolLadder(out, m);
  }

  /** Loungers and parasols, popping in one after another once the pool's built. */
  private drawFurniture(out: DrawItem[]) {
    if (!this.built) return;
    FURNITURE.forEach(([kind, x, z, yaw], i) => {
      const k = clamp((this.t - RELEASE_AT - 0.3 - i * 0.12) / 0.3, 0, 1);
      if (k <= 0) return;
      const s = k < 1 ? k * (1 + Math.sin(k * Math.PI) * 0.3) : 1;
      const m = mul(translation([x, 0, z]), rotationY(yaw), scaling([s, s, s]));
      if (kind === 'lounger') drawLounger(out, m);
      else drawParasol(out, m);
    });
  }

  private drawCursor(out: DrawItem[]) {
    const cursor = this.cursor;
    if (!cursor.visible) return;
    cursor.draw(out);
    // Whatever it's carrying hangs from the fingertip.
    if (this.carrying === 'fridge') junk('fridge').model(out, mul(translation(sub(cursor.tip, [0, 1.55, 0])), rotationY(Math.sin(this.time * 2) * 0.15)));
    if (this.carrying === 'couch') junk('couch').model(out, mul(translation(sub(cursor.tip, [0, 0.95, 0])), rotationY(0.3 + Math.sin(this.time * 2) * 0.1)));
    // The build-mode ground cursor under it: a glowing ring on whatever's below.
    const tip = cursor.tip;
    const inPool = this.poolMade && this.water.contains(tip[0], tip[2]);
    const ground = inPool ? this.water.level : 0;
    if (tip[1] - ground < 12) {
      const r = 0.45 + Math.sin(this.time * 5) * 0.05;
      out.push({ mesh: 'tube', model: mul(translation([tip[0], ground + 0.03, tip[2]]), scaling([r, 0.02, r])), color: BUILD_BLUE, pattern: Pattern.emissive, opacity: 0.8, shadow: false });
    }
  }

  private drawSim(out: DrawItem[], _time: number) {
    const { player, camera } = this.ctx;
    if (player.mode === 'hidden' || player.inPortal || player.portalScale < 0.99) return;
    const head = player.partFrames().head;
    const headPos: Vec3 = [head[12], head[13], head[14]];
    // The plumbob: green, then yellow, then red as the energy goes. Gone once drowned.
    const size = this.plumbob * (this.death ? Math.max(0, 1 - this.death.t * 1.5) : 1);
    if (size > 0.01) {
      const pop = size < 1 ? size * (1 + Math.sin(size * Math.PI) * 0.4) : 1;
      const blink = this.mood < 0.25 && !this.death && Math.floor(this.time * 3) % 2 === 0 ? 0.85 : 1;
      drawPlumbob(out, add(headPos, [0, 0.62 + Math.sin(this.time * 2) * 0.04, 0]), this.time * 1.6, this.mood, 0.55 * pop * blink);
    }
    const b = this.bubble;
    if (b) {
      const fwd = normalize(sub(camera.target, camera.pos));
      const right = normalize(cross(fwd, [0, 1, 0]));
      const up = cross(right, fwd);
      const centre = add(add(headPos, [0, 1.15, 0]), scale(right, 0.75));
      const width = b.ladder ? 0.85 : Math.max(0.9, 0.2 + b.text.length * 0.13);
      drawBubble(out, centre, right, up, width, 0.62, b.ladder, b.ladder ? drawLadderIcon : undefined);
      this.bubbleLabel.pos = [centre[0], centre[1], centre[2]];
    }
  }

  private drawEffects(out: DrawItem[]) {
    for (const d of this.drops) {
      const k = d.age / d.life;
      if (d.sparkle) {
        const s = d.size * (1 - k);
        out.push({ mesh: 'sphere', model: mul(translation(d.pos), scaling([s, s, s])), color: [1.6, 2.2, 2.6], pattern: Pattern.emissive, shadow: false });
      } else if (d.bubble) {
        out.push({ mesh: 'sphere', model: mul(translation(d.pos), scaling([d.size, d.size, d.size])), color: [0.85, 0.97, 1], spec: 1, opacity: 0.7, shadow: false });
      } else {
        out.push({ mesh: 'sphere', model: mul(translation(d.pos), scaling([d.size, d.size * 1.3, d.size])), color: [0.8, 0.93, 1], spec: 1, opacity: 0.8, shadow: false });
      }
    }
    // Ripples: thin rings of foam spreading out on the surface.
    const y = this.water.level + 0.012;
    for (const r of this.ripples) {
      const k = r.age / r.life;
      const s = r.size * (0.3 + k * 1.6);
      const n = 14, seg = ((2 * Math.PI * s) / n) * 1.08, width = 0.04 + 0.05 * (1 - k);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + r.size * 3;
        out.push({
          mesh: 'box', model: mul(translation([r.pos[0] + Math.cos(a) * s, y, r.pos[2] + Math.sin(a) * s]), rotationY(-a), scaling([width, 0.01, seg])),
          color: [0.95, 0.99, 1], opacity: 0.5 * (1 - k), shadow: false,
        });
      }
    }
  }

  labels(): WorldLabel[] {
    const list = this.labelList;
    list.length = 0;
    for (const l of this.needs.labels()) list.push(l);
    if (this.status !== 'lost') for (const s of this.says) list.push(s.label);
    if (this.bubble && this.bubbleLabel.text && this.ctx.player.mode !== 'hidden' && !this.ctx.player.inPortal) list.push(this.bubbleLabel);
    // Build mode: the pool's size and price while dragging.
    if (this.dragTo && this.t < RELEASE_AT) {
      const w = Math.round(Math.abs(this.dragTo[0] + X_HALF)), l = Math.round(Math.abs(this.dragTo[2] + Z_HALF));
      DRAG_LABELS[0].text = `${w} x ${l}`;
      DRAG_LABELS[0].pos = [(this.dragTo[0] - X_HALF) / 2, 0.8, this.dragTo[2] + 0.8];
      DRAG_LABELS[1].text = `§${(w * l * POOL_PRICE).toLocaleString('en-US')}`;
      DRAG_LABELS[1].pos = add(this.cursor.tip, [1.4, 2.8, 0]);
      list.push(DRAG_LABELS[0], DRAG_LABELS[1]);
    }
    return list;
  }

  trackedTargets(): TrackedTarget[] {
    // The ladder is somewhere to go. For a moment.
    const l = this.ladder;
    if (l && !l.gone && l.placed >= 0 && this.carrying !== 'ladder' && !this.death && this.stage === 'pool') {
      LADDER_TARGET.pos = add(l.pos, [0, 0.3, 0]);
      return [LADDER_TARGET];
    }
    const exit = this.exit.target();
    return exit ? [exit] : [];
  }

  environment() {
    // When the Reaper comes, the lights go down to a cold gloom.
    const k = this.death?.drowned ? clamp((this.death.t - 0.8) / 1.5, 0, 1) * 0.72 : 0;
    if (k <= 0) return DEFAULT_ENV;
    const env = this.env;
    for (let i = 0; i < 3; i++) {
      env.sunColor[i] = lerp(DEFAULT_ENV.sunColor[i], GLOOM.sunColor[i], k);
      env.skyColor[i] = lerp(DEFAULT_ENV.skyColor[i], GLOOM.skyColor[i], k);
      env.groundColor[i] = lerp(DEFAULT_ENV.groundColor[i], GLOOM.groundColor[i], k);
      env.fogColor[i] = lerp(DEFAULT_ENV.fogColor[i], GLOOM.fogColor[i], k);
    }
    return env;
  }

  obstacles() {
    return [];
  }

  // --- Camera -----------------------------------------------------------------------------------------

  cameraShot(): CameraShot | null {
    const arrival = this.arrival.cameraShot();
    if (arrival) return arrival;
    if (this.death?.drowned) return this.deathShot();
    if (this.stage !== 'arrive' && this.t > OVERVIEW_AT && this.t < this.overviewEnd()) {
      // Build mode's camera: high over a corner, looking down at the whole room (and following
      // the Sim about if the cursor has to go and fetch them).
      if (this.task === 'fetch' || this.fetchDone >= 0) {
        const p = this.ctx.player.pos;
        const k = 0.55;
        return { pos: [lerp(-7.5, p[0] - 7, k), 12.5, lerp(9, p[2] + 8, k)], target: [lerp(1.5, p[0], k), lerp(-2.5, p[1], k), lerp(-1.5, p[2], k)], sharpness: 2.2 };
      }
      return { pos: [-7.5, 12.5, 9], target: [1.5, -2.5, -1.5], sharpness: 2.2 };
    }
    const since = this.t - this.overviewEnd();
    return this.followShot(since > 0 && since < 1.2 ? 3 : 18);
  }

  /**
   * The usual over-the-shoulder view, kept inside the walls, above the water in the pool, and
   * lifted over the deck when the Sim backs up against a side.
   */
  private followShot(sharpness: number): CameraShot {
    const { camera, player } = this.ctx;
    const cp = Math.cos(camera.pitch), sp = Math.sin(camera.pitch);
    const fwd: Vec3 = [-Math.sin(camera.yaw) * cp, sp, -Math.cos(camera.yaw) * cp];
    const right: Vec3 = [Math.cos(camera.yaw), 0, -Math.sin(camera.yaw)];
    const shoulder = add(add(player.pos, [0, 1.65, 0]), scale(right, 0.6));
    const pos = sub(shoulder, scale(fwd, 3.2));
    const lim = CHAMBER_HALF - 0.3;
    const cx = clamp(pos[0], -lim, lim), cz = clamp(pos[2], -lim, lim);
    const pushed = Math.hypot(pos[0] - cx, pos[2] - cz);
    pos[0] = cx;
    pos[2] = cz;
    pos[1] += pushed * 0.8;
    if (this.poolMade && this.water.contains(pos[0], pos[2], -0.2)) {
      pos[1] = Math.max(pos[1], this.water.level + 0.45);
    } else {
      const outside = this.poolMade ? Math.max(Math.abs(pos[0]) - X_HALF, Math.abs(pos[2]) - Z_HALF) : 1;
      pos[1] = Math.max(pos[1], 0.4 + (pos[1] < 0.4 ? clamp(outside, 0, 1) * 0.4 : 0));
    }
    return { pos, target: add(shoulder, scale(fwd, 10)), sharpness };
  }

  /** Drowned: watch the Reaper arrive over the spot. */
  private deathShot(): CameraShot {
    const { camera, player } = this.ctx;
    const body = player.body;
    const at = body ? body.position('chest') : player.pos;
    const focus: Vec3 = this.reaper ? add(this.reaper.pos, [0, 1.3, 0]) : [at[0], this.water.level + 0.3, at[2]];
    const back = normalize([camera.pos[0] - focus[0], 0, camera.pos[2] - focus[2]]);
    const pos = add(focus, add(scale(back, 5), [0, 1.2, 0]));
    const lim = CHAMBER_HALF - 0.4;
    pos[0] = clamp(pos[0], -lim, lim);
    pos[2] = clamp(pos[2], -lim, lim);
    pos[1] = Math.max(pos[1], this.water.level + 1);
    return { pos, target: focus, sharpness: 2.5 };
  }
}

/** A little pool ladder drawn in a thought bubble (x right, y up, 1 = the bubble's half height). */
function drawLadderIcon(out: DrawItem[], m: Mat4) {
  const chrome = [0.12, 0.2, 0.34];
  for (const x of [-0.28, 0.28]) out.push({ mesh: 'box', model: mul(m, translation([x, 0, 0]), scaling([0.08, 1.3, 0.05])), color: chrome, pattern: Pattern.emissive, shadow: false });
  for (const y of [-0.35, 0, 0.35]) out.push({ mesh: 'box', model: mul(m, translation([0, y, 0]), scaling([0.56, 0.07, 0.05])), color: chrome, pattern: Pattern.emissive, shadow: false });
  // ...crossed out.
  for (const a of [0.8, -0.8]) {
    out.push({ mesh: 'box', model: mul(m, translation([0, 0, 0.04]), mulRot(a), scaling([0.12, 1.7, 0.05])), color: [2.2, 0.2, 0.15], pattern: Pattern.emissive, shadow: false });
  }
}

function mulRot(a: number): Mat4 {
  const c = Math.cos(a), s = Math.sin(a);
  return new Float32Array([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

// --- Layout -----------------------------------------------------------------------------------------

const H = CHAMBER_HALF;
const WY = (WALL_HEIGHT - 0.2) / 2;
/** The four walls, as in the standard chamber (the deck round the pool is the floor). */
const WALLS: [Vec3, Vec3][] = [
  [[0, WY, -H - 0.5], [H * 2 + 2, WALL_HEIGHT + 0.2, 1]],
  [[0, WY, H + 0.5], [H * 2 + 2, WALL_HEIGHT + 0.2, 1]],
  [[-H - 0.5, WY, 0], [1, WALL_HEIGHT + 0.2, H * 2]],
  [[H + 0.5, WY, 0], [1, WALL_HEIGHT + 0.2, H * 2]],
];

/** What's in the room before it's a pool (it all ends up floating in it). */
const PROPS: { kind: string; pos: Vec3; yaw: number }[] = [
  { kind: 'crate', pos: [-5, 0.41, -3.5], yaw: 0.3 },
  { kind: 'crate', pos: [-5, 1.23, -3.5], yaw: 0.9 },
  { kind: 'crate', pos: [5.5, 0.41, 3.5], yaw: 0.2 },
  { kind: 'small crate', pos: [3.5, 0.31, -5], yaw: 0.6 },
  { kind: 'pallet', pos: [-4.5, 0.09, 4.5], yaw: 0.2 },
  { kind: 'lilo', pos: [6.2, 0.11, -2.5], yaw: 1.2 },
  { kind: 'ring', pos: [-7, 0.13, 0.5], yaw: 0 },
  { kind: 'noodle', pos: [2, 0.1, 5.5], yaw: 0.4 },
  { kind: 'noodle', pos: [-1.5, 0.1, -6], yaw: 1.9 },
  { kind: 'beach ball', pos: [7, 0.36, 6], yaw: 0 },
  { kind: 'rubber duck', pos: [-2.5, 0.26, -4.5], yaw: 1 },
];

/** Buoyancy (kg, all under) of the junk that ends up in the pool. The fridge sinks. */
const CAPACITY: Record<string, number> = {
  crate: 128,
  'small crate': 56,
  'beach ball': 48,
  'rubber duck': 16,
  fridge: 70,
};

/** Where a ladder may go: on the edge (x, z) facing into the pool (yaw of its -z). */
const LADDER_SPOTS: [number, number, number][] = [
  [-4, Z_HALF, 0], [4, Z_HALF, 0], [-4, -Z_HALF, Math.PI], [4, -Z_HALF, Math.PI],
  [-X_HALF, -3, -Math.PI / 2], [-X_HALF, 3, -Math.PI / 2], [X_HALF, -3, Math.PI / 2], [X_HALF, 3, Math.PI / 2],
];

/** Where the cursor points while it thinks about deleting the exit. */
const DOOR_TIP: Vec3 = [CHAMBER_HALF - 0.9, 2.2, 0];

const LADDER_TARGET: TrackedTarget = { pos: [0, 0, 0], radius: 0.8, color: 'purple' };

/** Poolside furniture that turns up with the pool: kind, x, z, yaw. Nothing on the east deck (the exit). */
const FURNITURE: ['lounger' | 'parasol', number, number, number][] = [
  ['lounger', -6.4, -10.2, 0],
  ['lounger', -3.1, -10.2, 0],
  ['parasol', -8.9, -10.5, 0],
  ['lounger', 4.6, 10.3, Math.PI],
  ['parasol', 7.6, 10.6, 0],
];

const FOOT_RAYS: [number, number][] = [[0, 0], [0.22, 0], [-0.22, 0], [0, 0.22], [0, -0.22]];

const DRAG_LABELS: WorldLabel[] = [
  { pos: [0, 0, 0], text: '', size: 0.7, color: '#bfe4ff' },
  { pos: [0, 0, 0], text: '', size: 0.75, color: '#8dff8f' },
];

void length;
