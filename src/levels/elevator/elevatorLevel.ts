import {
  add, clamp, dot, length, lerp, mul, normalize, rotationY, scale, scaling, segment, sub, toQuat, transformPoint, translation,
  type Vec3,
} from '../../engine/math';
import { note, noise, sfx, tone, Tune } from '../../engine/audio';
import { GRAVITY, type Body } from '../../engine/physics';
import { Pattern, type DrawItem, type Environment } from '../../engine/renderer';
import {
  addCarColliders, CABLE_OFFSETS, cableTop, CarPanel, carRails, DOOR_Z, drawCarTop, drawDoors, drawRails, drawShaft, floorAt, floorLabel, FloorIndicator,
  FLOOR_H, HITCH, landingY, railNearest, railPoint, SHAFT_HALF, STOP_BUTTON, TOP_FLOOR, type Rail,
} from '../../entities/elevator';
import { junk, spawnJunk } from '../../entities/junk';
import { drawPortal, ExitPortal, PortalArrival } from '../../entities/portal';
import { crouchLegs, PART_NAMES, poseFrames, standingRoot, type PartName, type Pose } from '../../game/body';
import { CHAMBER_HALF, WALL_HEIGHT } from '../../game/chamber';
import { DEFAULT_ENV, type CameraShot, type Level, type LevelContext, type LevelStatus, type TrackedTarget, type WorldLabel } from '../level';

/*
 * Going Down. The chamber is an elevator car, stopped at the 99th floor with its top level with
 * the roof. After the arrival it dings and sets off down its shaft (which slides up past the tops
 * of the walls), muzak and all, with a piano and a lot of other junk aboard. Then the cable
 * snaps: TWANG, the lights flicker, the shaft whizzes by, and everything in the car, you
 * included, goes weightless. You drift on your momentum, push off whatever you touch (Space,
 * toward where you look), and can grab the handrails round the walls (hold E or a mouse button).
 * When it hits the bottom, gravity comes back all at once: anyone not holding a rail is
 * pancaked, and anything heavy that comes down on you crushes you. Survive, and the doors grind
 * open onto the exit, seven floors below the ground floor.
 */

// --- Tuning -----------------------------------------------------------------------------------
const SPAWN: Vec3 = [-5, 0, 3];
/** Seconds after the arrival before the car dings and sets off. */
const DING_DELAY = 0.8;
/** Riding down normally: top speed (m/s), time to reach it (s), and how long until the cable snaps (s after the ding). */
const RIDE_SPEED = 2.5;
const RIDE_ACCEL_TIME = 1.5;
const RIDE_TIME = new URLSearchParams(location.search).has('quickRide') ? 4 : 13; // ?quickRide: straight to the snap, for testing
/** Foreshadowing: a creak, then one cable pinging off (s before the snap), then a groan. */
const CREAK_AT = 4.5;
const PING_BEFORE = 3.2;
const GROAN_BEFORE = 1.2;
/** The fall: seconds from the snap to the bottom, how hard it speeds up (m/s²), and the floor it ends at (B7). */
const FALL_TIME = 13;
const FALL_ACCEL = 9;
const IMPACT_FLOOR = -7;
/** The last seconds of the fall count down on the indicator (and flash BRACE FOR IMPACT). */
const BRACE_TIME = 6;
/** At the snap everything in the car jolts upward (m/s, a range), a little sideways, and starts to tumble (rad/s). */
const JOLT_UP: [number, number] = [0.9, 1.9];
const JOLT_SIDE = 0.55;
const JOLT_SPIN = 1.1;
/** Weightless junk slows down this much (1/s), so it hangs about the car rather than all ending up on the grate. */
const FLOAT_DAMPING = 0.2;
const FLOAT_SPIN_DAMPING = 0.03;
/**
 * Weightless junk drifts slowly toward the nearest wall (m/s², as if the car were tumbling a
 * little), so it ends up hanging over the handrails, not just in the middle of the room.
 */
const WALL_DRIFT = 0.15;
/** The weightless player: thrust toward where you look (m/s²) up to a top speed (m/s); push-off speed off anything you touch. */
const SWIM_THRUST = 3;
const SWIM_MAX = 4;
const PUSH_SPEED = 6;
/** The player's jolt at the snap (m/s up), and how much of their walking speed they keep drifting with. */
const PLAYER_JOLT = 1.5;
const PLAYER_KEEP = 0.5;
/** How bouncy walls, floor, ceiling and junk are to a weightless player, and the drift off a floor you're lying on. */
const BOUNCE = 0.35;
const FLOOR_LIFT = 0.3;
/** Pushing off a loose object shoves it back with this share of your momentum (kg: your mass). */
const PUSH_BACK = 0.5;
const PLAYER_MASS = 70;
/** Impact: everything loose is flung down at once (m/s), then gravity is this many times normal for SLAM_TIME (s). */
const SLAM_SPEED = 8;
const SLAM_GRAVITY = 3;
const SLAM_TIME = 0.6;
/**
 * Things at least this heavy (kg) crush you if they come down on you (still falling at CRUSH_SPEED
 * m/s or more) up to CRUSH_WINDOW s after impact. Lighter things just bonk off.
 */
const CRUSH_MASS = 40;
const CRUSH_SPEED = 2.5;
const CRUSH_WINDOW = 2.5;
/** Body parts that get crushed (hands on the rail and shins don't count). */
const CORE_PARTS: PartName[] = ['pelvis', 'chest', 'head', 'upperArmL', 'upperArmR', 'thighL', 'thighR'];
/** Grabbing a handrail: how close your chest must be (m); sliding along it (m/s); pulling in to it (1/s). */
const GRAB_REACH = 1.4;
const SHIMMY_SPEED = 2.2;
const GRAB_PULL = 14;
/** After a survivable impact: when the doors start to grind open (s), and how long they take. */
const DOORS_AT = 2.2;
const DOORS_TIME = 2.4;
const DEATH_SCREEN_DELAY = 1.8;
/** Where the broken cables part (world y), and how far up the frayed stubs reach. */
const CABLE_BREAK_Y = 16.5;
const STUB_Y = HITCH[1] + 1.1;

/**
 * What's in the car: junk name, where (x, extra height, z), and which way it faces. The heavy
 * things stand against the walls in front of the handrails, so once they float up, the rail under
 * them looks nice and free.
 */
const CARGO: [string, number, number, number, number][] = [
  ['piano', -3, 0, -11.4, Math.PI],
  ['couch', 5, 0, -11.3, Math.PI],
  ['CRT TV', 5.3, 0.85, -11.2, Math.PI - 0.2],
  ['vending machine', 6, 0, 11.35, 0],
  ['bathtub', -5, 0, 11.35, 0],
  ['fridge', -11.35, 0, -6, -Math.PI / 2],
  ['safe', -11.45, 0, 5.5, -Math.PI / 2 + 0.2],
  ['washing machine', 11.4, 0, -6.5, Math.PI / 2],
  ['filing cabinet', 11.45, 0, 6.5, Math.PI / 2],
  ['bookcase', 11.57, 0, -9.8, Math.PI / 2],
  ['oil drum', -9.6, 0, 11.3, 0],
  ['microwave', 11.4, 0.92, -6.5, Math.PI / 2 + 0.3],
  ['pillow', 4.3, 0.82, -11.1, 0.3],
  ['anvil', 2.5, 0, 3, 1.2],
  ['toilet', -4, 0, -7, 2.5],
  ['mattress', 4, 0, 7, 0.4],
  ['trash can', 8.5, 0, -4, 0],
  ['crate', -7, 0, -2.5, 0.2],
  ['crate', -7, 0.82, -2.5, 0.9],
  ['small crate', 5.6, 0, -2.6, 0.5],
  ['potted plant', -9.5, 0, -10, 0],
  ['rubber duck', 0.6, 0, 1, 2],
  ['traffic cone', 4.6, 0, -5.2, 0],
  ['garden gnome', -2, 0, -5.6, 0.5],
  ['beach ball', 2.6, 0, -2.2, 0],
  ['tire', -1.5, 0, 8, 0],
  ['cardboard box', 8, 0, 3.5, 0.4],
];

/** How each heavy thing kills you (by junk name). */
const CRUSHES: Record<string, [string, string]> = {
  piano: ["PIANO'D", 'Wile E. Coyote sends his condolences.\nThe piano is fine. Slightly out of tune.'],
  anvil: ["ANVIL'D", 'Straight out of the Acme catalogue. Meep meep.'],
  safe: ['NOT SO SAFE', 'A 150 kg safe, delivered directly to your head.'],
  fridge: ['CHILLED', 'You have been refrigerated. Permanently.'],
  'vending machine': ['VENDED', 'It finally dispensed something. It was you. Flat.'],
  bathtub: ['BATH TIME', 'Most accidents happen in the bathroom. The bathroom came to you.'],
  couch: ['COUCH POTATO', 'Mashed.'],
  'washing machine': ['SPIN CYCLE', 'Delicates: you.'],
  'filing cabinet': ['FILED AWAY', 'Your paperwork has been processed. So have you.'],
  bookcase: ['BOOKED', 'You always said you wanted to get into a good book.'],
  'oil drum': ['DRUMMED OUT', 'Ba-dum-tss.'],
};

/** What the EMERGENCY STOP button says, depending on how things are going. */
const STOP_RIDING = [
  'EMERGENCY STOP: this is not an emergency.',
  'Stopping between floors is a premium feature.',
  'Please stop pressing the button.',
  'The button has been reported to the button.',
];
const STOP_FALLING = [
  'Your emergency is important to us. Please hold.',
  'Emergency noted. Gravity has not been informed.',
  'You are caller number 99. No, 80. No, 61...',
  'Have you tried turning it off and on again?',
];
const STOP_LANDED = ["Stopped. You're welcome.", 'Emergency over. Mostly.'];
const STOP_COLOR = '#ffd9d0';

// --- Sound (every cue is also on screen) ---------------------------------------------------------

/** Smooth elevator muzak: an original little bossa loop in F. */
const MUZAK: [string | null, number][] = [
  ['A4', 1], ['C5', 0.5], ['F5', 1], ['E5', 0.5], ['D5', 1], ['C5', 1], [null, 0.5], ['A4', 0.5],
  ['Bb4', 1], ['D5', 1], ['C5', 1.5], [null, 0.5],
  ['G4', 1], ['Bb4', 0.5], ['E5', 1], ['D5', 0.5], ['C5', 1], ['Bb4', 1], ['A4', 1.5], [null, 0.5],
  ['F4', 0.5], ['A4', 0.5], ['C5', 1], ['Bb4', 0.5], ['G4', 1], ['F4', 2], [null, 1],
];

const SOUND = {
  hum() {
    tone(55, 2.4, { wave: 'sine', vol: 0.06, attack: 0.6 });
    tone(110, 2.4, { wave: 'sine', vol: 0.02, attack: 0.6 });
  },
  creak() {
    tone(260, 0.9, { to: 170, wave: 'sawtooth', vol: 0.035, attack: 0.25 });
    noise(0.9, { freq: 900, to: 500, type: 'bandpass', q: 6, vol: 0.08 });
  },
  ping() {
    tone(2600, 0.7, { to: 1900, wave: 'sine', vol: 0.12 });
    tone(3900, 0.3, { wave: 'sine', vol: 0.04 });
  },
  groan() {
    tone(80, 1.3, { to: 52, wave: 'sawtooth', vol: 0.08, attack: 0.3 });
    noise(1.2, { freq: 300, to: 140, vol: 0.12 });
  },
  twang() {
    tone(160, 1.5, { to: 42, wave: 'sawtooth', vol: 0.22 });
    tone(320, 0.8, { to: 90, wave: 'square', vol: 0.06 });
    noise(0.5, { freq: 3000, to: 300, vol: 0.3 });
  },
  screech() {
    noise(2.2, { freq: 4200, to: 3000, type: 'bandpass', q: 10, vol: 0.12 });
    tone(2900, 2, { to: 2500, wave: 'sawtooth', vol: 0.015, attack: 0.1 });
  },
  /** The wind and rattle of falling, louder as it goes (0-1). */
  rush(k: number) {
    noise(0.7, { freq: 180 + k * 250, to: 120, vol: 0.05 + 0.12 * k });
  },
  beep() {
    tone(1046, 0.16, { wave: 'square', vol: 0.06 });
  },
  crash() {
    sfx.explosion(0.8);
    noise(1.6, { freq: 700, to: 90, vol: 0.45, at: 0.05 });
  },
  clink() {
    tone(900, 0.1, { wave: 'triangle', vol: 0.08 });
    tone(1350, 0.14, { wave: 'triangle', vol: 0.05, at: 0.02 });
  },
  whoosh() {
    noise(0.3, { freq: 500, to: 1600, type: 'bandpass', q: 1, vol: 0.12 });
  },
  grind() {
    noise(2.3, { freq: 500, to: 260, type: 'bandpass', q: 3, vol: 0.2 });
    tone(55, 2.1, { wave: 'sawtooth', vol: 0.05, attack: 0.3 });
  },
  /** The muzak's last, sad note. */
  lastNote() {
    tone(note('C4'), 1.4, { to: note('A3'), wave: 'triangle', vol: 0.07, attack: 0.05 });
  },
};

const TIPS: [string, string][] = [
  ['Hint', "Grab a handrail (hold E or a mouse button) and be holding on when it hits the bottom. Don't be under anything heavy."],
  ['Controls', 'WASD move (A/D slides along a rail) · Space push off · Hold E or a click to grab a handrail'],
];

// --- Poses ------------------------------------------------------------------------------------

/** Clinging to a rail in front of you at about hip height, knees bent, braced. */
function gripPose(t: number, bracing: number): Pose {
  // Both ends keep the hands about 1 m up with the feet on the floor (so they meet the rail).
  const crouch = 0.02 + 0.18 * bracing;
  const legs = crouchLegs(crouch);
  const sway = Math.sin(t * 1.7) * 0.04 * (1 - bracing);
  const shoulder = 1.0 + 0.4 * bracing, elbow = 0.3 + 0.2 * bracing;
  return {
    crouch, lean: -0.3 - 0.15 * bracing, headPitch: 0.25 + 0.15 * bracing,
    shoulderL: shoulder + sway, shoulderR: shoulder - sway, armOut: 0.2, elbowL: elbow, elbowR: elbow,
    hipL: legs.hip + 0.05, hipR: legs.hip - 0.05, kneeL: legs.knee, kneeR: legs.knee,
  };
}

/** Weightless: arms and legs out, drifting and slowly paddling at nothing. */
function floatPose(t: number): Pose {
  const a = Math.sin(t * 1.4), b = Math.sin(t * 1.1 + 1);
  return {
    lean: 0.12 + 0.08 * b, headPitch: -0.1,
    shoulderL: 0.5 + 0.5 * a, shoulderR: 0.5 - 0.5 * a, armOut: 1.05 + 0.25 * b, elbowL: 0.5 + 0.3 * b, elbowR: 0.5 - 0.3 * b,
    hipL: 0.35 + 0.35 * b, hipR: -0.05 - 0.35 * b, kneeL: -0.7 - 0.3 * a, kneeR: -0.5 + 0.3 * a,
  };
}

/** Where the hands are (their midpoint, in the standing frame: feet at the origin, facing -z) in the grip pose. */
function gripHands(bracing: number): Vec3 {
  const f = poseFrames(standingRoot([0, 0, 0], 0), gripPose(0, bracing));
  const l = transformPoint(f.foreArmL, [0, -0.2, 0]), r = transformPoint(f.foreArmR, [0, -0.2, 0]);
  return scale(add(l, r), 0.5);
}
const GRIP_HANDS = gripHands(0);
const BRACE_HANDS = gripHands(1);

// --- Environment ------------------------------------------------------------------------------

/** Inside the shaft the sun is the car's own strip lights: from overhead, with a gloomy shaft around. */
const SHAFT_ENV: Environment = {
  sunDir: [0.3, 1, 0.45],
  sunColor: [1.3, 1.28, 1.2],
  skyColor: [0.3, 0.3, 0.33],
  groundColor: [0.2, 0.19, 0.18],
  fogColor: [0.02, 0.02, 0.025],
  fogDensity: 0.013,
};
/** The red of the alarm, mixed into the lights in the last seconds. */
const ALARM_SUN: Vec3 = [1.6, 0.25, 0.18];
const DUST = [0.42, 0.39, 0.35];
const SPARK = [6, 2.2, 0.35];
/** The car's strip lights at full glow. */
const STRIP_LIGHT = [2.4, 2.4, 2.2];

type Stage = 'arrive' | 'ride' | 'fall' | 'landed';

interface Cargo {
  name: string;
  body: Body;
  mass: number;
  /** Recent downward speed (m/s), fading: "was it just falling?". */
  fall: number;
  prevVy: number;
}

interface Sfx {
  label: WorldLabel;
  ttl: number;
  life: number;
  vel: Vec3;
  /** Bobbing (music notes). */
  bob: number;
}

interface Puff {
  pos: Vec3;
  vel: Vec3;
  age: number;
  life: number;
  size: number;
}

interface Spark {
  pos: Vec3;
  vel: Vec3;
  age: number;
  life: number;
}

interface Death {
  t: number;
  big: string;
  small: string;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

export class ElevatorLevel implements Level {
  readonly number: number;
  readonly title = 'Going Down';
  status: LevelStatus = 'playing';
  private arrival: PortalArrival;
  private exit = new ExitPortal(DOOR_Z);
  private stage: Stage = 'arrive';
  /** Seconds in the current stage. */
  private stageT = 0;
  private t = 0;
  /** How far the car has gone down from the top floor (m), and how fast it's going (m/s). */
  private depth = 0;
  private speed = 0;
  /** The fall's top speed, worked out at the snap so it hits the bottom on time. */
  private fallTop = 0;
  private cargo: Cargo[] = [];
  private rails: Rail[] = carRails();
  /** The rail being held, how far along it, and how long for. */
  private grip: { rail: Rail; s: number; t: number } | null = null;
  private indicators: FloorIndicator[];
  private doorOpen = 0;
  private death: Death | null = null;
  /** Light level of the car's lights (flickers), and the alarm's red pulse (0-1). */
  private light = 1;
  private alarm = 0;
  private flickerT = 0;
  private env: Environment = { ...DEFAULT_ENV, sunDir: [...DEFAULT_ENV.sunDir], sunColor: [...DEFAULT_ENV.sunColor], skyColor: [...DEFAULT_ENV.skyColor], groundColor: [...DEFAULT_ENV.groundColor], fogColor: [...DEFAULT_ENV.fogColor] };
  /** Cables: -1 while whole, else seconds since they broke (one pings early). */
  private pinged = -1;
  private snapped = -1;
  private sfx: Sfx[] = [];
  private noteTimer = 0;
  private puffs: Puff[] = [];
  private sparks: Spark[] = [];
  private beats = new Set<string>();
  private labelList: WorldLabel[] = [];
  private signs: WorldLabel[];
  private brace: WorldLabel[];
  private landingLabels: WorldLabel[] = [];
  /** The car's fixed fittings (crosshead, grate, lights, rails, signs), and its strip lights' glow. */
  private fittings: DrawItem[] = [];
  private glow = [...STRIP_LIGHT];
  private muzak = new Tune(MUZAK, 104, { wave: 'triangle', vol: 0.05, bass: true });
  private panel: CarPanel;
  private stopQuips: string[] = [];
  /** The weightless player's position and velocity after the last update (to spot bumping into things). */
  private lastPos: Vec3 = [0, 0, 0];
  private lastVel: Vec3 = [0, 0, 0];

  constructor(private ctx: LevelContext) {
    const { physics, hud } = ctx;
    this.number = ctx.number;
    hud.setLevel(`The Chamber · Level ${this.number}`);
    hud.show(`LEVEL ${this.number}`, '', 2.5);
    hud.hint('');
    this.arrival = new PortalArrival(ctx, SPAWN);
    addCarColliders(physics);

    for (const [name, x, lift, z, yaw] of CARGO) {
      const def = junk(name);
      const half = def.shape === 'box' ? def.size[1] / 2 : def.shape === 'cylinder' ? def.size[1] / 2 : def.size[0];
      const body = spawnJunk(physics, def, [x, lift + half + 0.02, z], toQuat(rotationY(yaw)));
      this.cargo.push({ name, body, mass: def.mass, fall: 0, prevVy: 0 });
    }

    // Floor indicators above the doors (east) and on the west wall.
    this.indicators = [
      new FloorIndicator([CHAMBER_HALF, 6.4, DOOR_Z], [0, 0, 1], [0, 1, 0]),
      new FloorIndicator([-CHAMBER_HALF, 6.4, 0], [0, 0, -1], [0, 1, 0]),
    ];
    for (const d of this.indicators) {
      d.setFloor(floorLabel(TOP_FLOOR));
      d.setMessage('');
    }

    const sign = (pos: Vec3, text: string, size = 0.2, color = '#f3e2b4'): WorldLabel => ({ pos, text, size, color });
    const e = CHAMBER_HALF - 0.1, n = -CHAMBER_HALF + 0.1;
    this.signs = [
      sign([e, 2.75, 4.9], 'MAXIMUM CAPACITY:'),
      sign([e, 2.45, 4.9], '1 TEST SUBJECT.'),
      sign([e, 2.15, 4.9], 'ALSO A PIANO.'),
      sign([e, 2.7, -4.9], 'LAST INSPECTED: NEVER', 0.19),
      sign([e, 2.4, -4.9], 'NEXT INSPECTION: ALSO NEVER', 0.16),
      sign([0, 2.75, n], 'PLEASE HOLD THE HANDRAIL.', 0.22),
      sign([0, 2.4, n], "OR DON'T. WE'RE A SIGN, NOT A COP.", 0.17),
    ];
    this.brace = [
      { pos: [0, 7.6, -CHAMBER_HALF + 0.3], text: 'BRACE FOR IMPACT', size: 0.9, color: '#ff3b2f' },
      { pos: [0, 7.6, CHAMBER_HALF - 0.3], text: 'BRACE FOR IMPACT', size: 0.9, color: '#ff3b2f' },
      { pos: [CHAMBER_HALF - 0.3, 8.3, DOOR_Z], text: 'BRACE FOR IMPACT', size: 0.7, color: '#ff3b2f' },
      { pos: [-CHAMBER_HALF + 0.3, 8.3, 0], text: 'BRACE FOR IMPACT', size: 0.7, color: '#ff3b2f' },
    ];
    for (let i = 0; i < 12; i++) this.landingLabels.push({ pos: [0, 0, 0], text: '', size: 1.3, color: '#d9d3bf' });

    drawCarTop(this.fittings, this.glow);
    this.panel = new CarPanel(physics, () => this.pressedStop());
    drawRails(this.fittings, this.rails);
    this.drawSigns(this.fittings);

    this.lastPos = [...ctx.player.pos];
  }

  // --- The ride --------------------------------------------------------------------------------

  private setStage(stage: Stage) {
    this.stage = stage;
    this.stageT = 0;
  }

  /** True once, the first time it's called with this key (for one-off beats). */
  private once(key: string, when: boolean) {
    if (!when || this.beats.has(key)) return false;
    this.beats.add(key);
    return true;
  }

  update(dt: number) {
    this.t += dt;
    this.stageT += dt;
    const { player, hud } = this.ctx;

    if (this.death && this.status === 'playing') {
      this.death.t += dt;
      if (this.death.t > DEATH_SCREEN_DELAY) {
        this.status = 'lost';
        hud.show(this.death.big, `${this.death.small}\nPress R to try again.`);
        hud.tips(TIPS);
      }
    }

    this.arrival.update(dt);
    switch (this.stage) {
      case 'arrive':
        if (this.arrival.done) this.setStage('ride');
        break;
      case 'ride':
        this.updateRide(dt);
        break;
      case 'fall':
        this.updateFall(dt);
        break;
      case 'landed':
        this.updateLanded();
        break;
    }

    this.updateGrip(dt);
    if (this.stage === 'fall') this.updateWeightless(dt);
    this.updateCargo(dt);
    this.panel.update(dt);
    this.updateEffects(dt);
    this.updateIndicators(dt);
    this.updateEnvironment(dt);

    this.exit.update(dt, player);
    if (this.exit.entered && this.status === 'playing') this.status = 'exited';
    for (let i = 0; i < 3; i++) {
      this.lastPos[i] = player.pos[i];
      this.lastVel[i] = player.vel[i];
    }
  }

  private updateRide(dt: number) {
    const t = this.stageT - DING_DELAY;
    if (t < 0) return;
    if (this.once('ding', true)) {
      this.say('DING!', [CHAMBER_HALF - 0.6, 8.3, DOOR_Z], 0.9, '#ffd166', 1.6);
      this.say('DING!', [-CHAMBER_HALF + 0.6, 8.3, 0], 0.9, '#ffd166', 1.6);
      sfx.ding();
      for (const d of this.indicators) {
        d.brightness = 1;
        d.arrowSpeed = 3;
        d.setMessage('GOING DOWN');
      }
    }
    if (t > 1.2 && !this.death) this.muzak.start();
    if (this.once('clunk', t > 0.5)) {
      this.say('*clunk*', [0, 9, 0], 0.4, '#cfcfcf', 1.2);
      this.ctx.camera.addShake(0.15);
      sfx.thud(0.3);
    }
    this.speed = RIDE_SPEED * clamp((t - 0.5) / RIDE_ACCEL_TIME, 0, 1);
    this.depth += this.speed * dt;
    // The motor's hum.
    if (this.once(`hum${Math.floor((t - 1) / 3.5)}`, t > 1 && t < RIDE_TIME - GROAN_BEFORE - 1)) {
      this.say('~ hmmmmmmmm ~', [rand(-3, 3), WALL_HEIGHT - 0.8, rand(-3, 3)], 0.3, 'rgba(230,230,230,0.55)', 2.6, [0, 0.15, 0]);
    }
    if (this.once(`humming${Math.floor(t / 2)}`, t > 0.5 && t < RIDE_TIME)) SOUND.hum();
    if (this.once('creak', t > CREAK_AT)) {
      this.say('*creak*', this.inView(7, 2.5), 0.45, '#cfcfcf', 1.5);
      SOUND.creak();
    }
    if (this.once('ping', t > RIDE_TIME - PING_BEFORE)) {
      this.pinged = 0;
      this.say('*PING*', this.inView(6, 2.2), 0.6, '#ffffff', 1.4, [0, 1, 0]);
      this.ctx.camera.addShake(0.25);
      SOUND.ping();
    }
    if (this.once('groan', t > RIDE_TIME - GROAN_BEFORE)) {
      this.say('*groooan*', this.inView(7, 1.8), 0.5, '#cfcfcf', 1.3);
      this.ctx.camera.addShake(0.3);
      SOUND.groan();
    }
    if (t > RIDE_TIME) this.snap();
  }

  /** The cable snaps: everything goes weightless. */
  private snap() {
    const { physics, player, camera } = this.ctx;
    this.setStage('fall');
    this.snapped = 0;
    this.flickerT = 0;
    this.say('TWANG!', this.inView(8, 1.5), 1.6, '#ffe066', 1.8, [0, 1.2, 0]);
    camera.addShake(1);
    SOUND.twang();
    // The muzak stops dead.
    this.muzak.stop();
    sfx.scratch();
    for (const d of this.indicators) {
      d.setMessage('UH OH');
      d.arrowSpeed = 0;
    }
    // How fast the fall must get to hit bottom (B7) on time.
    const distance = (TOP_FLOOR - IMPACT_FLOOR) * FLOOR_H - this.depth;
    this.fallTop = solveTopSpeed(this.speed, FALL_ACCEL, FALL_TIME, distance);

    physics.world.gravity = { x: 0, y: 0, z: 0 };
    for (const c of this.cargo) {
      const rb = c.body.rb;
      rb.setLinearDamping(FLOAT_DAMPING);
      rb.setAngularDamping(FLOAT_SPIN_DAMPING);
      const v = rb.linvel();
      rb.setLinvel({ x: v.x + rand(-JOLT_SIDE, JOLT_SIDE), y: v.y + rand(JOLT_UP[0], JOLT_UP[1]), z: v.z + rand(-JOLT_SIDE, JOLT_SIDE) }, true);
      rb.setAngvel({ x: rand(-JOLT_SPIN, JOLT_SPIN), y: rand(-JOLT_SPIN, JOLT_SPIN), z: rand(-JOLT_SPIN, JOLT_SPIN) }, true);
      c.body.grabbable = false; // no carrying things about in zero-g: the buttons are for rails now
    }
    if (player.mode === 'control') {
      player.gravityScale = 0;
      player.airControl = 0;
      if (!this.grip) {
        player.vel = [player.vel[0] * PLAYER_KEEP, Math.max(player.vel[1], 0) + PLAYER_JOLT, player.vel[2] * PLAYER_KEEP];
        player.onGround = false;
      }
    }
  }

  private updateFall(dt: number) {
    this.snapped += dt;
    this.speed = Math.min(this.fallTop, this.speed + FALL_ACCEL * dt);
    this.depth += this.speed * dt;
    const left = FALL_TIME - this.stageT;
    // Rattling, worse and worse.
    this.ctx.camera.addShake(0.06 + 0.22 * (this.stageT / FALL_TIME) ** 2);
    if (this.once('screech', this.stageT > 1.2)) {
      this.say('SKREEEEEEEEE', [0, 11.5, -CHAMBER_HALF + 0.5], 0.7, '#ffb347', 2.2, [0, 0.6, 0]);
      SOUND.screech();
    }
    if (this.once('screech2', this.stageT > 5.5)) {
      this.say('EEEEEEEEEEE', [0, 11.5, CHAMBER_HALF - 0.5], 0.7, '#ffb347', 2, [0, 0.6, 0]);
      SOUND.screech();
    }
    if (this.once(`rush${Math.floor(this.stageT * 2)}`, this.stageT > 0.8)) SOUND.rush(this.stageT / FALL_TIME);
    // A beep for every second of the countdown.
    if (left < BRACE_TIME && this.once(`beep${Math.ceil(left)}`, true)) SOUND.beep();
    this.alarm = left < BRACE_TIME ? 0.5 + 0.5 * Math.cos(this.stageT * Math.PI * 3) : 0;
    // Sparks where the safety brakes (uselessly) grab the guide rails.
    this.spawnSparks(dt);
    if (left <= 0) this.impact();
  }

  /** The bottom. Gravity comes back all at once. */
  private impact() {
    const { physics, player, camera } = this.ctx;
    this.setStage('landed');
    this.speed = 0;
    this.depth = (TOP_FLOOR - IMPACT_FLOOR) * FLOOR_H;
    this.alarm = 0;
    this.flickerT = 0;
    camera.addShake(1.8);
    this.say('KA-RUNCH!', this.inView(8, 0.5), 1.4, '#ffffff', 1.6);
    SOUND.crash();
    physics.world.gravity = { x: 0, y: -GRAVITY * SLAM_GRAVITY, z: 0 };
    for (const c of this.cargo) {
      const rb = c.body.rb;
      rb.setLinearDamping(0);
      rb.setAngularDamping(c.body.angularDamping);
      const v = rb.linvel();
      rb.setLinvel({ x: v.x * 0.5, y: Math.min(v.y, 0) - SLAM_SPEED, z: v.z * 0.5 }, true);
      rb.wakeUp();
      c.body.grabbable = true;
    }
    for (const d of this.indicators) {
      d.alarm = false;
      d.setMessage('');
      d.arrowSpeed = 0;
    }
    // Dust shaken off every wall.
    for (let i = 0; i < 36; i++) {
      const a = (i / 36) * 4;
      const side = Math.floor(a), k = (a - side) * 2 - 1;
      const w = CHAMBER_HALF - 0.4;
      const pos: Vec3 = side === 0 ? [k * w, 0.1, -w] : side === 1 ? [w, 0.1, k * w] : side === 2 ? [-k * w, 0.1, w] : [-w, 0.1, -k * w];
      this.puff(pos, 2, 0.8);
    }
    player.gravityScale = 1;
    player.airControl = 1;
    if (player.mode !== 'control' || player.inPortal) return;
    if (this.grip) {
      // Held on. Nothing but falling junk can hurt you now.
      player.stunImmunity = CRUSH_WINDOW + 0.5;
      return;
    }
    // Not holding on: pancake.
    const height = Math.max(0, player.pos[1]);
    const rising = player.vel[1] > 0.5;
    player.poseOverride = null;
    player.kill([player.vel[0] * 0.3, -(12 + height * 1.5), player.vel[2] * 0.3], { violence: 12 + height * 1.8 });
    this.puff(player.pos, 10, 0.8);
    if (rising) this.die('SPLAT.', 'The myth says jump at the last second.\nThe myth has never been in an elevator.');
    else if (height > 3) this.die('PANCAKED', 'What goes up must come down.\nUsually not quite that fast.');
    else this.die('SPLAT.', 'Terminal velocity, meet terminal floor.');
  }

  private updateLanded() {
    const { physics, player, hud } = this.ctx;
    if (this.stageT > SLAM_TIME && this.once('gravity', true)) physics.setGravityDirection([0, -1, 0]);
    if (this.stageT < CRUSH_WINDOW && !this.death) this.checkCrush();
    if (this.once('b7', this.stageT > 0.9)) for (const d of this.indicators) d.setFloor(floorLabel(IMPACT_FLOOR));
    // The muzak's last word.
    if (!this.death && this.once('lastNote', this.stageT > 1.3)) {
      this.say('♪...', [-CHAMBER_HALF + 0.5, 8.6, -4], 0.5, '#bdf3ff', 2.5, [0.3, -0.4, 0]);
      SOUND.lastNote();
    }
    if (this.death || this.stageT < DOORS_AT) return;
    if (this.once('grind', true)) {
      this.say('*grrrrrind*', [CHAMBER_HALF - 0.8, 4.8, DOOR_Z], 0.6, '#cfcfcf', 2);
      SOUND.grind();
    }
    this.doorOpen = clamp((this.stageT - DOORS_AT) / DOORS_TIME, 0, 1) ** 1.3;
    if (this.once('open', this.doorOpen > 0.55)) {
      this.exit.openNow();
      sfx.ding();
      this.say('DING!', [CHAMBER_HALF - 0.6, 8.6, DOOR_Z], 0.9, '#ffd166', 2);
      for (const d of this.indicators) d.setMessage('DING');
      if (player.mode === 'control') hud.show('DING.', 'Ground floor. Mind the gap.\n(The display says B7. The display is a pessimist.)', 4.5);
    }
  }

  /** Anything heavy still coming down, touching your body (not your hands or shins), crushes you. */
  private checkCrush() {
    const { player, physics, camera } = this.ctx;
    const body = player.body;
    if (!body || player.mode !== 'control' || player.inPortal) return;
    const world = physics.world;
    const pelvisY = body.position('pelvis')[1];
    for (const c of this.cargo) {
      if (c.mass < CRUSH_MASS || c.fall < CRUSH_SPEED) continue;
      const t = c.body.rb.translation();
      if (t.y < pelvisY - 0.2) continue;
      let touching = false;
      for (const name of CORE_PARTS) {
        const part = body.colliders[PART_NAMES.indexOf(name)];
        world.contactPair(c.body.collider, part, (m) => {
          if (m.numContacts() > 0) touching = true;
        });
        if (touching) break;
      }
      if (!touching) continue;
      this.releaseGrip();
      player.poseOverride = null;
      player.kill([0, -4, 0], { violence: 24, origin: [t.x, t.y, t.z] });
      camera.addShake(0.8);
      this.puff(player.pos, 12, 0.9);
      const [big, small] = CRUSHES[c.name] ?? ['CRUSHED', 'Something heavy came down on you. Everything does, eventually.'];
      this.die(big, small);
      return;
    }
  }

  /** The big red EMERGENCY STOP button. It has opinions, and no wiring. */
  private pressedStop() {
    const quips = this.stage === 'fall' ? STOP_FALLING : this.stage === 'landed' ? STOP_LANDED : STOP_RIDING;
    // Go through them in order of the list before repeating any.
    const unused = quips.filter((q) => !this.stopQuips.includes(q));
    const text = unused.length ? unused[0] : pick(quips);
    this.stopQuips.push(text);
    // One at a time: the new one replaces the last.
    for (const s of this.sfx) if (s.label.color === STOP_COLOR) s.ttl = 0;
    this.say(text, add(STOP_BUTTON, [-0.4, 0.55, 0]), 0.16, STOP_COLOR, 2.6, [0, 0.12, 0]);
    this.ctx.camera.addShake(0.05);
  }

  private die(big: string, small: string) {
    this.ctx.hud.hide();
    this.death = { t: 0, big, small };
    this.releaseGrip();
  }

  // --- Handrails -------------------------------------------------------------------------------

  private releaseGrip() {
    if (!this.grip) return;
    this.grip = null;
    this.ctx.player.poseOverride = null;
  }

  /**
   * Hold E or a mouse button (when not carrying anything) with your chest near a handrail to grab
   * it: you're held there, facing the wall, and A/D (whatever way you're looking) slides you along
   * it. Let go and you stay put (weightless) or stand (not). Space lets go and pushes off.
   */
  private updateGrip(dt: number) {
    const { player, input, camera } = this.ctx;
    const holding = input.actionDown && (!player.carrying || this.grip !== null);
    const alive = player.mode === 'control' && !player.inPortal && !this.death;
    const grip = this.grip;
    if (grip) {
      if (!alive || !holding || input.wasPressed('Space')) {
        const weightless = this.stage === 'fall';
        const pushing = alive && input.wasPressed('Space') && weightless;
        this.releaseGrip();
        // Weightless, you stay where you let go (or push off); otherwise you just stand there (or jump).
        if (weightless) player.vel = [0, 0, 0];
        if (pushing) this.pushOff(this.lookDir(), grip.rail.normal, undefined);
        return;
      }
      grip.t += dt;
      // Slide along the rail with the movement keys, in whatever direction they point on screen.
      const fx = -Math.sin(camera.yaw), fz = -Math.cos(camera.yaw);
      const rx = Math.cos(camera.yaw), rz = -Math.sin(camera.yaw);
      let mx = 0, mz = 0;
      if (input.isDown('KeyW')) { mx += fx; mz += fz; }
      if (input.isDown('KeyS')) { mx -= fx; mz -= fz; }
      if (input.isDown('KeyD')) { mx += rx; mz += rz; }
      if (input.isDown('KeyA')) { mx -= rx; mz -= rz; }
      const r = grip.rail;
      const along = ((r.b[0] - r.a[0]) * mx + (r.b[2] - r.a[2]) * mz) / r.length;
      const bracing = this.stage === 'fall' ? clamp(1 - (FALL_TIME - this.stageT) / BRACE_TIME, 0, 1) : this.stage === 'landed' ? 1 : 0;
      const shimmy = Math.abs(along) > 0.3 ? Math.sign(along) * SHIMMY_SPEED * (1 - 0.5 * bracing) : 0;
      grip.s = clamp(grip.s + shimmy * dt, 0.35, r.length - 0.35);
      // Body placed so the hands are on the rail, facing the wall.
      const facing = Math.atan2(r.normal[0], r.normal[2]);
      const hands = lerp3v(GRIP_HANDS, BRACE_HANDS, bracing);
      const c = Math.cos(facing), s = Math.sin(facing);
      // standingRoot's frame: local x -> (c, 0, -s), local z -> (s, 0, c).
      const offset: Vec3 = [hands[0] * c + hands[2] * s, hands[1], -hands[0] * s + hands[2] * c];
      const target = sub(railPoint(r, grip.s), offset);
      // Feet on the floor (weightless, they may float a touch).
      target[1] = this.stage === 'fall' ? Math.max(0, target[1]) : 0;
      const k = grip.t < 0.4 ? 1 - Math.exp(-dt * GRAB_PULL) : 1;
      player.pos = add(player.pos, scale(sub(target, player.pos), k));
      player.vel = [0, 0, 0];
      player.facing = facing;
      player.onGround = this.stage !== 'fall';
      player.poseOverride = gripPose(this.t, bracing);
      player.syncCollider();
      return;
    }
    if (!holding || !alive) return;
    // Grab the nearest rail within reach of your chest.
    const chest = add(player.pos, [0, 1.2, 0]);
    let best: { rail: Rail; s: number; d: number } | null = null;
    for (const r of this.rails) {
      const s = railNearest(r, chest);
      const d = length(sub(railPoint(r, s), chest));
      if (d < GRAB_REACH && (!best || d < best.d)) best = { rail: r, s, d };
    }
    if (!best) return;
    this.grip = { rail: best.rail, s: clamp(best.s, 0.35, best.rail.length - 0.35), t: 0 };
    player.vel = [0, 0, 0];
    this.say(pick(['*grab*', '*clang*', '*grip*']), add(railPoint(best.rail, best.s), [0, 0.5, 0]), 0.3, '#ffffff', 0.8, [0, 0.5, 0]);
    SOUND.clink();
  }

  // --- Weightless ------------------------------------------------------------------------------

  /** A point `dist` ahead of the camera and `up` above that: where a sound effect gets written so you see it. */
  private inView(dist: number, up: number): Vec3 {
    const cam = this.ctx.camera;
    return add(add(cam.pos, scale(this.lookDir(), dist)), [0, up, 0]);
  }

  private lookDir(): Vec3 {
    const cam = this.ctx.camera;
    return normalize(sub(cam.target, cam.pos));
  }

  /**
   * The player without gravity: they drift on their momentum, bounce softly off whatever they
   * bump into, can nudge themselves toward where they look (WASD, weakly), and Space pushes off
   * anything they're touching, toward where they look.
   */
  private updateWeightless(dt: number) {
    const { player, input, camera } = this.ctx;
    if (player.mode !== 'control' || player.inPortal || this.death) {
      player.poseOverride = null;
      return;
    }
    if (this.grip) return;
    player.poseOverride = floatPose(this.t);
    // Bumped into something: bounce back off it a little instead of sticking to it.
    // (Blocked: it hardly moved that way, or the player's own collision handling stopped it dead.)
    for (let i = 0; i < 3; i++) {
      const want = this.lastVel[i];
      if (Math.abs(want) < 0.4) continue;
      const moved = (player.pos[i] - this.lastPos[i]) / Math.max(dt, 1e-4);
      if (Math.abs(moved) < Math.abs(want) * 0.3 || Math.abs(player.vel[i]) < Math.abs(want) * 0.5) player.vel[i] = -want * BOUNCE;
    }
    // Lying on the floor you drift off it again.
    if (player.onGround) {
      player.vel[1] = Math.max(player.vel[1], FLOOR_LIFT);
      player.onGround = false;
    }
    // Weak "swimming" toward where you look.
    const look = this.lookDir();
    const rx = Math.cos(camera.yaw), rz = -Math.sin(camera.yaw);
    let dir: Vec3 = [0, 0, 0];
    if (input.isDown('KeyW')) dir = add(dir, look);
    if (input.isDown('KeyS')) dir = sub(dir, look);
    if (input.isDown('KeyD')) dir = add(dir, [rx, 0, rz]);
    if (input.isDown('KeyA')) dir = sub(dir, [rx, 0, rz]);
    if (length(dir) > 0.1) {
      dir = normalize(dir);
      if (dot(player.vel, dir) < SWIM_MAX) player.vel = add(player.vel, scale(dir, SWIM_THRUST * dt));
    }
    if (input.wasPressed('Space')) {
      const touch = this.touching();
      if (touch) this.pushOff(look, touch.normal, touch.body);
      else this.say(pick(['*flails*', '*swims at nothing*', '*paddles*', '*flaps*']), add(player.pos, [0, 2.3, 0]), 0.28, '#ffffff', 0.9, [0, 0.5, 0]);
    }
  }

  /** Something solid within reach of the player's body: its surface normal, and the loose object it belongs to. */
  private touching(): { normal: Vec3; body?: Body } | null {
    const { player, physics } = this.ctx;
    const centre = add(player.pos, [0, 0.9, 0]);
    for (const [dir, reach] of PROBES) {
      const hit = physics.raycast(centre, dir, reach, player.collider ?? undefined);
      if (hit) return { normal: hit.normal, body: physics.bodyFor(hit.collider) };
    }
    return null;
  }

  /** Kicks off a surface toward `look` (turned away from the surface if it points into it). */
  private pushOff(look: Vec3, normal: Vec3, body: Body | undefined) {
    const { player } = this.ctx;
    const into = dot(look, normal);
    const dir = into < 0.15 ? normalize(add(look, scale(normal, 0.15 - into * 2))) : look;
    player.vel = scale(dir, PUSH_SPEED);
    SOUND.whoosh();
    player.onGround = false;
    // (Light things fly off at most at your push-off speed, not hundreds of m/s.)
    if (body) body.rb.applyImpulse(vec(scale(dir, -Math.min(PUSH_SPEED * PLAYER_MASS * PUSH_BACK, body.rb.mass() * PUSH_SPEED))), true);
  }

  // --- Cargo, effects ----------------------------------------------------------------------------

  private updateCargo(dt: number) {
    for (const c of this.cargo) {
      if (this.stage === 'fall') {
        // Drift toward the nearest wall.
        const t = c.body.rb.translation(), v = c.body.rb.linvel();
        const alongX = Math.abs(t.x) > Math.abs(t.z);
        const push = WALL_DRIFT * dt;
        c.body.rb.setLinvel({ x: v.x + (alongX ? Math.sign(t.x) * push : 0), y: v.y, z: v.z + (alongX ? 0 : Math.sign(t.z) * push) }, true);
      }
      const v = c.body.rb.linvel();
      c.fall = Math.max(-v.y, c.fall - dt * 20, 0);
      // Heavy things landing hard kick up dust.
      if (this.stage === 'landed' && c.prevVy < -5 && v.y > -1.5) {
        const t = c.body.rb.translation();
        this.puff([t.x, Math.max(0.1, t.y - 0.4), t.z], Math.round(clamp(c.mass / 12, 2, 14)), 0.9);
        if (c.mass >= CRUSH_MASS) this.ctx.camera.addShake(0.35);
        sfx.thud(Math.min(0.6, 0.15 + c.mass / 400));
      }
      c.prevVy = v.y;
    }
  }

  private say(text: string, pos: Vec3, size: number, color: string, life: number, vel: Vec3 = [0, 0.4, 0], bob = 0) {
    this.sfx.push({ label: { pos: [...pos], text, size, color }, ttl: life, life, vel: [...vel], bob });
  }

  private puff(pos: Vec3, n: number, spread: number) {
    for (let i = 0; i < n; i++) {
      if (this.puffs.length > 220) this.puffs.shift();
      this.puffs.push({
        pos: add(pos, [rand(-spread, spread), rand(0, 0.3), rand(-spread, spread)]),
        vel: [rand(-2.2, 2.2), rand(0.2, 1.2), rand(-2.2, 2.2)],
        age: 0,
        life: rand(1.0, 2.0),
        size: rand(0.18, 0.34),
      });
    }
  }

  private spawnSparks(dt: number) {
    const n = Math.random() < dt * 90 ? 2 : 0;
    for (let i = 0; i < n; i++) {
      for (const side of [-1, 1]) {
        if (this.sparks.length > 160) this.sparks.shift();
        this.sparks.push({
          pos: [rand(-0.3, 0.3), WALL_HEIGHT + 0.3, side * (CHAMBER_HALF + 1.1)],
          vel: [rand(-3, 3), rand(12, 30), -side * rand(0.5, 4)],
          age: 0,
          life: rand(0.25, 0.6),
        });
      }
    }
  }

  private updateEffects(dt: number) {
    // Muzak, bouncing out of the speaker while the ride's smooth; weightless notes after.
    if (this.stage === 'ride' && this.beats.has('ding')) {
      this.noteTimer -= dt;
      if (this.noteTimer <= 0) {
        this.noteTimer = rand(0.35, 0.6);
        this.say(pick(['♪', '♫', '♬', '♩']), [-CHAMBER_HALF + 0.5, 8.6, rand(-4.5, -3.5)], rand(0.4, 0.7), pick(['#ffd6f5', '#bdf3ff', '#fff2a8', '#c8ffc0']), 3.4, [rand(0.7, 1.2), rand(-0.1, 0.2), rand(-0.3, 0.3)], rand(2, 3.5));
      }
    }
    for (let i = this.sfx.length - 1; i >= 0; i--) {
      const s = this.sfx[i];
      s.ttl -= dt;
      if (s.ttl <= 0) {
        this.sfx.splice(i, 1);
        continue;
      }
      const weightless = this.stage === 'fall';
      if (s.bob && weightless) {
        // The music goes weightless too: it just drifts off.
        s.vel = add(s.vel, [rand(-1, 1) * dt, dt * 0.8, rand(-1, 1) * dt]);
        s.bob = 0;
      }
      const p = s.label.pos;
      p[0] += s.vel[0] * dt;
      p[1] += (s.vel[1] + (s.bob ? Math.cos((s.life - s.ttl) * s.bob * 2) * 0.9 : 0)) * dt;
      p[2] += s.vel[2] * dt;
    }
    const drag = Math.exp(-dt * 1.8);
    for (const p of this.puffs) {
      p.age += dt;
      for (let i = 0; i < 3; i++) {
        p.pos[i] += p.vel[i] * dt;
        p.vel[i] *= drag;
      }
      p.vel[1] += dt * 0.15;
    }
    // (Puffs and sparks die in the order they were made, near enough.)
    while (this.puffs.length && this.puffs[0].age > this.puffs[0].life) this.puffs.shift();
    for (const s of this.sparks) {
      s.age += dt;
      for (let i = 0; i < 3; i++) s.pos[i] += s.vel[i] * dt;
    }
    while (this.sparks.length && this.sparks[0].age > this.sparks[0].life) this.sparks.shift();
    if (this.pinged >= 0) this.pinged += dt;
  }

  private updateIndicators(dt: number) {
    const floor = this.stage === 'landed' ? null : floorAt(this.depth);
    const flicker = this.stage === 'fall' || this.stage === 'landed' ? this.light : 1;
    // The message line has opinions about the ride.
    const ride = this.stageT - DING_DELAY;
    const msg = this.stage === 'ride'
      ? ride > RIDE_TIME - GROAN_BEFORE ? 'UH...' : ride > RIDE_TIME - PING_BEFORE && ride < RIDE_TIME - PING_BEFORE + 1.6 ? 'PING?' : 'GOING DOWN'
      : this.stage === 'landed' ? this.beats.has('open') ? 'DING' : this.stageT > 1.2 ? 'OW' : ''
      : null;
    for (const d of this.indicators) {
      if (floor !== null && this.beats.has('ding')) d.setFloor(floorLabel(floor));
      if (msg !== null && this.beats.has('ding')) d.setMessage(msg);
      if (this.stage === 'fall') {
        const left = FALL_TIME - this.stageT;
        if (this.stageT > 1.6 && left > BRACE_TIME) {
          d.setMessage(Math.floor(this.stageT * 1.5) % 2 ? 'GOING DOWN' : 'EXPRESS');
          d.arrowSpeed = 22;
          d.alarm = true;
        } else if (left <= BRACE_TIME) {
          d.setMessage(`BRACE ${Math.ceil(left)}`);
        }
      }
      if (this.beats.has('ding')) d.brightness = flicker;
      d.update(dt);
    }
  }

  /** The car's lights: flickers at the snap, now and then in the fall, and out for a moment at impact. */
  private updateEnvironment(dt: number) {
    this.flickerT += dt;
    let light = 1;
    if (this.stage === 'fall') {
      const f = this.flickerT;
      light = f < 1 ? [1, 0.1, 0.8, 0.05, 0.05, 0.9, 0.3, 1, 0.6, 1][Math.floor(f * 10)] : Math.random() < dt * 1.2 ? 0.2 : 0.72;
      if (f >= 1 && light < 0.5) this.flickerT = 0.9; // a short dip
    } else if (this.stage === 'landed') {
      const f = this.stageT;
      light = f < 0.35 ? 0 : f < 1.2 ? [0.6, 0, 0.8, 0.2, 1, 0.4, 0.9, 1, 1][Math.floor((f - 0.35) * 10)] ?? 1 : 1;
    }
    this.light = light;
    const inside = clamp(this.depth / 12, 0, 1);
    const env = this.env;
    const alarm = this.alarm;
    for (let i = 0; i < 3; i++) {
      env.sunDir[i] = lerp(DEFAULT_ENV.sunDir[i], SHAFT_ENV.sunDir[i], inside);
      const sun = lerp(DEFAULT_ENV.sunColor[i], SHAFT_ENV.sunColor[i], inside);
      env.sunColor[i] = lerp(sun, ALARM_SUN[i], alarm * 0.6) * light;
      env.skyColor[i] = lerp(DEFAULT_ENV.skyColor[i], SHAFT_ENV.skyColor[i], inside) * Math.max(light, 0.25);
      env.groundColor[i] = lerp(DEFAULT_ENV.groundColor[i], SHAFT_ENV.groundColor[i], inside) * Math.max(light, 0.25);
      env.fogColor[i] = lerp(DEFAULT_ENV.fogColor[i], SHAFT_ENV.fogColor[i], inside);
    }
    env.fogDensity = lerp(DEFAULT_ENV.fogDensity, SHAFT_ENV.fogDensity, inside);
  }

  // --- Drawing -------------------------------------------------------------------------------------

  draw(out: DrawItem[], time: number) {
    this.arrival.draw(out);
    drawShaft(out, this.depth, Math.min(this.speed, 45));
    // The car's fixed fittings are built once; the strip lights dim through the shared glow colour.
    for (let i = 0; i < 3; i++) this.glow[i] = STRIP_LIGHT[i] * this.light + 0.03;
    for (const item of this.fittings) out.push(item);
    drawDoors(out, this.doorOpen);
    if (this.doorOpen > 0.3) drawPortal(out, this.exit.centre, [-1, 0, 0], 1.2 * clamp((this.doorOpen - 0.3) / 0.4, 0, 1), true);
    for (const d of this.indicators) d.draw(out);
    this.panel.draw(out);
    this.drawCables(out, time);
    for (const p of this.puffs) {
      const k = p.age / p.life;
      if (k >= 1) continue;
      const size = p.size * (1 + k * 3.5);
      out.push({ mesh: 'sphere', model: mul(translation(p.pos), scaling([size, size * 0.8, size])), color: DUST, opacity: 0.55 * (1 - k) * (1 - k), shadow: false });
    }
    for (const s of this.sparks) {
      if (s.age >= s.life) continue;
      const tail = sub(s.pos, scale(s.vel, 0.02));
      out.push({ mesh: 'box', model: segment(tail, s.pos, 0.05), color: SPARK, pattern: Pattern.emissive, shadow: false });
    }
  }

  /** Sign plates and the speaker the muzak comes out of. */
  private drawSigns(out: DrawItem[]) {
    const e = CHAMBER_HALF - 0.02, n = -CHAMBER_HALF + 0.02;
    out.push({ mesh: 'box', model: mul(translation([e, 2.45, 4.9]), scaling([0.03, 0.95, 2.6])), color: [0.12, 0.1, 0.08], spec: 0.6 });
    out.push({ mesh: 'box', model: mul(translation([e, 2.55, -4.9]), scaling([0.03, 0.7, 2.9])), color: [0.12, 0.1, 0.08], spec: 0.6 });
    out.push({ mesh: 'box', model: mul(translation([0, 2.58, n]), scaling([4.4, 0.75, 0.03])), color: [0.12, 0.1, 0.08], spec: 0.6 });
    // The speaker the muzak comes out of.
    out.push({ mesh: 'box', model: mul(translation([-CHAMBER_HALF + 0.05, 8.6, -4]), scaling([0.1, 0.7, 1.1])), color: [0.15, 0.15, 0.16], spec: 0.4 });
    for (let i = 0; i < 5; i++) out.push({ mesh: 'box', model: mul(translation([-CHAMBER_HALF + 0.11, 8.36 + i * 0.12, -4]), scaling([0.02, 0.04, 0.9])), color: [0.05, 0.05, 0.05] });
  }

  /** The hoist cables: straight up the shaft, until one pings off and then the rest snap. */
  private drawCables(out: DrawItem[], time: number) {
    const top = cableTop(this.depth);
    const colour = [0.16, 0.16, 0.17];
    CABLE_OFFSETS.forEach(([dx, dz], i) => {
      const base: Vec3 = [dx, HITCH[1] + 0.2, dz];
      const broken = this.snapped >= 0 ? this.snapped : i === 2 && this.pinged >= 0 ? this.pinged : -1;
      if (broken < 0) {
        out.push({ mesh: 'cylinder', model: segment(base, [dx, top, dz], 0.03), color: colour, spec: 0.6 });
        return;
      }
      // The stub left on the car, frayed at the end (and waving about when weightless).
      const wave = this.stage === 'fall' ? Math.sin(time * 1.3 + i) * 0.35 : 0.15;
      const end: Vec3 = [dx + wave, STUB_Y + i * 0.08, dz + Math.cos(time * 1.1 + i) * 0.2];
      out.push({ mesh: 'cylinder', model: segment(base, end, 0.03), color: colour, spec: 0.6 });
      for (let k = 0; k < 3; k++) {
        const a = k * 2.1 + i;
        out.push({ mesh: 'cylinder', model: segment(end, add(end, [Math.cos(a) * 0.12, 0.15, Math.sin(a) * 0.12]), 0.008), color: [0.35, 0.35, 0.36] });
      }
      // The rest whips away up the shaft.
      const lift = 30 * broken * broken + 6 * broken;
      const low = CABLE_BREAK_Y + lift;
      if (low < top) {
        const whip = Math.sin(broken * 18 + i) * Math.min(2, broken * 4);
        out.push({ mesh: 'cylinder', model: segment([dx + whip, low, dz - whip * 0.5], [dx, top, dz], 0.03), color: colour, spec: 0.6 });
      }
    });
  }

  labels(): WorldLabel[] {
    const list = this.labelList;
    list.length = 0;
    for (const s of this.signs) list.push(s);
    for (const s of this.sfx) list.push(s.label);
    if (this.stage === 'fall' && FALL_TIME - this.stageT < BRACE_TIME && Math.floor(this.stageT * 3) % 2 === 0) {
      for (const b of this.brace) list.push(b);
    }
    // Floor numbers painted in the shaft, while they're slow enough to read.
    if (this.speed < 12 && this.depth > 0.5) {
      let i = 0;
      for (let n = floorAt(this.depth) - 1; n <= TOP_FLOOR && i < this.landingLabels.length - 1; n++) {
        const y = landingY(n, this.depth) + 2.2;
        if (y < WALL_HEIGHT + 0.8) continue;
        if (y > WALL_HEIGHT + 40) break;
        const east = this.landingLabels[i++], west = this.landingLabels[i++];
        east.pos[0] = SHAFT_HALF - 0.1;
        east.pos[1] = y;
        east.pos[2] = DOOR_Z + 3.4;
        west.pos[0] = -SHAFT_HALF + 0.1;
        west.pos[1] = y;
        west.pos[2] = 2.5;
        east.text = west.text = floorLabel(n);
        list.push(east, west);
      }
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
    return [];
  }

  cameraShot(): CameraShot | null {
    return this.arrival.cameraShot();
  }
}

/** Rays for "touching something": down and up from the middle of the body, and out to the sides. */
const PROBES: [Vec3, number][] = [
  [[0, -1, 0], 1.2], [[0, 1, 0], 1.2],
  [[1, 0, 0], 0.75], [[-1, 0, 0], 0.75], [[0, 0, 1], 0.75], [[0, 0, -1], 0.75],
  [normalize([1, 0, 1]), 0.75], [normalize([-1, 0, 1]), 0.75], [normalize([1, 0, -1]), 0.75], [normalize([-1, 0, -1]), 0.75],
];

function vec(v: Vec3) {
  return { x: v[0], y: v[1], z: v[2] };
}

function lerp3v(a: Vec3, b: Vec3, t: number): Vec3 {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

/**
 * The top speed a fall starting at `v0` and speeding up at `accel` must reach so it covers
 * `distance` in exactly `time`.
 */
function solveTopSpeed(v0: number, accel: number, time: number, distance: number): number {
  let lo = v0, hi = v0 + accel * time;
  for (let i = 0; i < 40; i++) {
    const top = (lo + hi) / 2;
    const t1 = (top - v0) / accel;
    const d = v0 * t1 + 0.5 * accel * t1 * t1 + top * (time - t1);
    if (d < distance) lo = top;
    else hi = top;
  }
  return (lo + hi) / 2;
}
