import { note, noise, sfx, tone, Tune } from '../../engine/audio';
import { add, clamp, easeInOut, lerp, mul, normalize, rotationX, rotationY, rotationZ, scale, scaling, sub, translation, type Mat4, type Vec3 } from '../../engine/math';
import { RAPIER, type Usable } from '../../engine/physics';
import { Pattern, type DrawItem, type Environment } from '../../engine/renderer';
import { Giant } from '../../entities/giant';
import { ExitPortal, PortalArrival } from '../../entities/portal';
import {
  ARROW_LEFT, BURGER, BURGER_COLORS, BURGER_LCD, CANDY, CANDY_COLORS, CANDY_LCD, EGG, EGG_CRACKED, GHOST, GRAVE,
  HEART_EMPTY, HEART_FULL, ICON_BITMAPS, MOON, PET_A, PET_ADULT, PET_B, PET_HAPPY, PET_SAD, PET_SLEEP, PixelSprite,
  POOP, POOP_COLORS, POOP_LCD, SKULL, STINK, SYRINGE_LCD, textSprite, WAVE_LCD,
} from '../../entities/tamagotchi';
import { drawBody, poseFrames, type BodyColors, type Pose } from '../../game/body';
import { CHAMBER_HALF, WALL_HEIGHT } from '../../game/chamber';
import { DEFAULT_ENV, type CameraShot, type Level, type LevelContext, type LevelStatus, type TrackedTarget, type WorldLabel } from '../level';

/*
 * Tamagotchi. The chamber boots up: the walls flood candy pink, the north wall turns into a
 * giant pet's LCD, three big buttons push out of the south wall, and an egg on the screen wobbles
 * and hatches... into you. You are the pet. Timmy (the giant kid, peeking over the south wall now
 * and then, bored) pokes the buttons: A walks the highlight along the menu icons, B picks one, and
 * whatever he picked happens to you, life size. FOOD drops a giant pixel burger or a candy (E eats
 * it; candy makes you fat and slow); PLAY slams a giant arrow down on the half of the floor that
 * flashes; BATHROOM flushes a wave across the floor (jump it) after you've pooped (don't step in
 * it: you get sick); LIGHT switches the room off (sleep on the glowing bed); DISCIPLINE fires the
 * letters of "NO!" out of the screen at you; MEDICINE, when you're sick, sends a syringe after you.
 * Your HUNGRY and HAPPY hearts drain all the while: either at zero and the pet dies. Live until it
 * evolves (into a slightly older test subject), Timmy gets bored and drops the toy, and the exit
 * opens.
 */

// --- Tunables ---------------------------------------------------------------------------------------

/** Seconds of life (after hatching) until the pet evolves and the exit opens. */
const LIFE = 80;
const HEARTS = 4;
/** Hearts lost per second, growing by DRAIN_RAMP (share) over the life; being sick multiplies them. */
const HUNGER_DRAIN = 1 / 14;
const HAPPY_DRAIN = 1 / 14;
const DRAIN_RAMP = 0.35;
const SICK_DRAIN = 1.6;
/** Awake in the dark (after a grace period) costs this many HAPPY hearts per second. */
const DARK_DRAIN = 0.32;
const DARK_GRACE = 1.6;
const DARK_TIME = 8;
/** What food does. */
const MEAL_HUNGER = 2.5;
const MEAL_WEIGHT = 1;
const SNACK_HAPPY = 1.5;
const SNACK_HUNGER = 0.5;
const SNACK_WEIGHT = 2;
/** Each arrow dodged in PLAY, a clean sweep bonus, sleeping through the night, getting scolded, a jab. */
const PLAY_HAPPY = 0.8;
const PLAY_SWEEP = 0.6;
const SLEEP_HAPPY = 1;
const SCOLD_HAPPY = 0.75;
const JAB_HAPPY = 0.5;
/** Weight (lb): above WEIGHT_SLOW each pound takes this much off your speed (down to SLOWEST). */
const START_WEIGHT = 5;
const WEIGHT_SLOW = 8;
const SLOW_PER_LB = 0.06;
const SLOWEST = 0.6;
const GIRTH_PER_LB = 0.035;
/** PLAY: rounds per game, and the warning before each slam (s): shorter every round and later in life. */
const PLAY_ROUNDS = 3;
const WARN_FIRST = 2.4;
const WARN_MIN = 1.4;
/** The slam: seconds to fall, lie there, rise. Standing within this of the line on its side still counts. */
const SLAM_FALL = 0.22;
const SLAM_DOWN = 0.45;
const SLAM_RISE = 0.45;
/** Between rounds the slab hovers this high (its underside), and comes down to SLAM_FROM during the warning. */
const SLAM_HOVER = 16;
const SLAM_FROM = 10.6;
const SLAM_EDGE = 0.3;
/** The flush: a wave WAVE_H high, its core WAVE_CORE thick, at WAVE_SPEED (m/s), after WAVE_BUILD s rising at a wall. */
const WAVE_H = 0.62;
const WAVE_CORE = 0.8;
const WAVE_SPEED = 8.5;
const WAVE_BUILD = 1.0;
/** Poops: the first comes this long into life, then every so often; Timmy flushes them after a while. */
const FIRST_POOP = 16;
/** The scolding: letter speed (m/s) and how far ahead of you they aim (s). */
const LETTER_SPEED = 12;
const LETTER_LEAD = 0.3;
/** The syringe: speed from SYRINGE_SLOW to SYRINGE_FAST over its chase, which lasts SYRINGE_TIME s. */
const SYRINGE_SLOW = 3.4;
const SYRINGE_FAST = 7;
const SYRINGE_TIME = 7.5;
const SYRINGE_TURN = 2.4;
/** From the syringe's middle to its needle tip (m). */
const SYRINGE_TIP = 3.5;
const DEATH_SCREEN_DELAY = 2.6;

// --- Timeline (seconds after the arrival) ------------------------------------------------------------

const FLOOD_TIME = 1.3;
const BUTTONS_AT = 1.2;
const EGG_AT = 1.7;
const CRACK_AT = 4.2;
const HATCH_AT = 5.2;
const LIFE_AT = HATCH_AT + 0.8;

// --- Looks ------------------------------------------------------------------------------------------

const SHELL = [0.88, 0.28, 0.56];
const SHELL_DARK = [0.6, 0.1, 0.38];
const BEZEL = [0.36, 0.2, 0.58];
const FLOOR = [0.5, 0.37, 0.62];
const FLOOR_WARN = [0.8, 0.04, 0.06];
const BUTTON = [1.0, 0.82, 0.22];
const LCD_BG = [0.5, 0.58, 0.41];
const PIX = [0.08, 0.1, 0.07];
const LCD_LIGHT = [0.56, 0.65, 0.46];
const WALL_IN = CHAMBER_HALF - 0.02;
/** The screen: x within ±LCD_HALF, y from LCD_Y0 to LCD_Y1, its surface at LCD_Z (recessed in a bezel). */
const LCD_HALF = 10.2;
const LCD_Y0 = 1.8;
const LCD_Y1 = 8.6;
const LCD_Z = -CHAMBER_HALF + 0.12;
const BEZEL_DEPTH = 0.45;
const ICON_Y = 7.85;
const ICON_PIXEL = 0.13;
const iconX = (i: number) => -8.6 + i * 3.44;
const PET_PIXEL = 0.23;
/** Where the pet stands on the screen. */
const PET_FLOOR = 3.78;
const ROW1 = 3.02;
const ROW2 = 2.22;
/** The buttons on the south wall. */
const BUTTON_Y = 3.4;
const BUTTON_R = 1.25;
// A on the left and C on the right, seen from inside (looking south, +x is on your left).
const BUTTON_X = [5.2, 0, -5.2];

const R: Vec3 = [1, 0, 0];
const U: Vec3 = [0, 1, 0];
const N: Vec3 = [0, 0, 1];

const GHOST_COLORS: BodyColors = {
  suit: [1.1, 1.5, 2.3], pants: [1.0, 1.35, 2.1], skin: [1.3, 1.6, 2.3], hair: [1.0, 1.3, 2.0], pack: null, boot: [0.9, 1.2, 2.0],
};

const JOKES: Record<Cause, string[]> = {
  starved: ['Timmy has already asked for a new one.', 'The burger was right there. You were right there.', 'It was hungry. It said so. Loudly. With hearts.'],
  sad: ['It died of boredom. Relatable.', 'Timmy has already asked for a new one.', 'Not one single heart left. Timmy blames the batteries.'],
  squashed: ['LEFT or RIGHT? You went with UNDER.', 'Timmy guessed right. That is the whole game.', 'Flattened into a single pixel. A dead one.'],
  flushed: ['Goodbye, little buddy. *flush*', 'Down the pipes to a better place.', 'You were supposed to jump. Tamagotchis can jump. Probably.'],
};
const HINTS: Record<Cause, string> = {
  starved: 'Keep both rows of hearts up: eat the food it drops (E), go the other way in PLAY, don\'t step in anything, and sleep when the lights go out.',
  sad: 'HAPPY drains all the time, faster when you\'re sick or awake in the dark. Dodge the arrows in PLAY, eat the candy, and when the lights go out stand still on the glowing bed.',
  squashed: 'In PLAY, the half of the floor that flashes is where the arrow lands (the screen points at it too). Be on the other half: the dashed line is the border.',
  flushed: 'When Timmy picks BATHROOM, a wave rises at one wall and sweeps the whole floor. Jump it as it reaches you.',
};
const CONTROLS = 'WASD move · Shift sprint · Space jump · E eat';

const TIMMY_BORED = ['hmm.', '*yawn*', 'do a trick!', 'it\'s looking at me', 'boring...', 'is it hungry AGAIN?', 'what does B do', 'mum said 1 hour'];

const ICON_NAMES = ['FOOD', 'LIGHT', 'PLAY', 'MEDICINE', 'BATHROOM', 'DISCIPLINE'];
type Kind = 'feed' | 'light' | 'play' | 'med' | 'flush' | 'scold';
const ICON_KINDS: Kind[] = ['feed', 'light', 'play', 'med', 'flush', 'scold'];
/** Roughly how long each takes, menu included (s): nothing starts that wouldn't be over by the end of its life. */
const KIND_TIME: Record<Kind, number> = { feed: 4, light: 11, play: 14, med: 10, flush: 8, scold: 7 };
type Cause = 'starved' | 'sad' | 'squashed' | 'flushed';

const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const smooth = (x: number) => easeInOut(clamp(x, 0, 1));

// --- Sounds -----------------------------------------------------------------------------------------

const beep = (f: number, d = 0.06, at = 0, vol = 0.06) => tone(f, d, { wave: 'square', vol, at });
function chirp(notes: string[], step = 0.08, vol = 0.06, at = 0) {
  notes.forEach((n, i) => tone(note(n), step * 0.9, { wave: 'square', vol, at: at + i * step }));
}
const sound = {
  a: () => beep(2700, 0.05),
  b: () => { beep(3100, 0.05); beep(2300, 0.08, 0.07); },
  c: () => beep(1500, 0.08),
  boot: () => chirp(['C7', 'G6', 'C7', 'E7'], 0.07, 0.05),
  wobble: () => beep(1900, 0.04, 0, 0.04),
  hatch: () => chirp(['C6', 'E6', 'G6', 'C7', 'E6', 'G6', 'C7', 'E7', 'G7'], 0.07, 0.06),
  munch: () => { for (let i = 0; i < 3; i++) noise(0.07, { freq: 1600, to: 500, vol: 0.25, at: i * 0.15 }); chirp(['E6', 'A6'], 0.09, 0.05, 0.5); },
  refuse: () => { tone(330, 0.16, { wave: 'square', vol: 0.06 }); tone(260, 0.2, { wave: 'square', vol: 0.06, at: 0.18 }); },
  plop: () => {
    tone(110, 0.4, { to: 55, wave: 'sawtooth', vol: 0.12 });
    tone(140, 0.25, { to: 80, wave: 'square', vol: 0.05, at: 0.08 });
    tone(700, 0.12, { to: 160, wave: 'sine', vol: 0.2, at: 0.35 });
  },
  squelch: () => { noise(0.25, { freq: 900, to: 200, q: 3, type: 'bandpass', vol: 0.4 }); chirp(['E5', 'C5', 'A4'], 0.1, 0.05, 0.2); },
  whoosh: () => noise(0.35, { freq: 300, to: 2500, type: 'bandpass', q: 1.5, vol: 0.3 }),
  slam: () => { sfx.thud(0.9); noise(0.7, { freq: 900, to: 60, vol: 0.6 }); },
  dodge: () => chirp(['C6', 'E6', 'G6'], 0.08, 0.06),
  sweep: () => chirp(['C6', 'E6', 'G6', 'C7', 'G6', 'C7'], 0.08, 0.06),
  gurgle: () => {
    noise(1.2, { freq: 300, to: 1400, type: 'bandpass', q: 2, vol: 0.3 });
    for (let i = 0; i < 5; i++) tone(rand(180, 320), 0.09, { to: rand(400, 700), wave: 'sine', vol: 0.1, at: i * 0.18 });
  },
  rush: () => noise(2.8, { freq: 800, to: 300, vol: 0.25 }),
  lightsOff: () => { sfx.click(); tone(1200, 0.35, { to: 300, wave: 'square', vol: 0.05, at: 0.05 }); },
  lightsOn: () => { sfx.click(); chirp(['G6', 'C7', 'E7'], 0.09, 0.05, 0.05); },
  no: () => { tone(200, 0.3, { wave: 'square', vol: 0.08 }); tone(200, 0.3, { wave: 'square', vol: 0.08, at: 0.38 }); },
  clack: () => { sfx.thud(0.3); noise(0.15, { freq: 2500, to: 800, vol: 0.2 }); },
  jab: () => { noise(0.2, { freq: 1800, to: 600, type: 'bandpass', q: 3, vol: 0.4 }); tone(1300, 0.25, { to: 2600, wave: 'square', vol: 0.06, at: 0.05 }); },
  alarm: () => { beep(3000, 0.07, 0, 0.05); beep(3000, 0.07, 0.13, 0.05); beep(3000, 0.07, 0.26, 0.05); },
  sick: () => chirp(['A5', 'F5', 'D5'], 0.12, 0.05),
  bonk: () => { sfx.thud(0.6); tone(900, 0.15, { to: 1800, wave: 'square', vol: 0.05 }); },
  die: () => chirp(['G6', 'E6', 'C6', 'G5', 'E5', 'C5'], 0.22, 0.06),
  evolve: () => { for (let k = 0; k < 3; k++) chirp(['C6', 'E6', 'G6', 'C7', 'E7'], 0.06, 0.05, k * 0.4); },
  whistle: () => tone(1500, 1.2, { to: 300, wave: 'sine', vol: 0.12 }),
};

const DAY_TUNE: [string | null, number][] = [
  ['E5', 0.5], ['G5', 0.5], ['C6', 0.5], ['G5', 0.5], ['A5', 0.5], ['F5', 0.5], ['D5', 1],
  ['F5', 0.5], ['A5', 0.5], ['D6', 0.5], ['A5', 0.5], ['B5', 0.5], ['G5', 0.5], ['E5', 1],
  ['C6', 0.5], ['B5', 0.5], ['A5', 0.5], ['G5', 0.5], ['F5', 0.5], ['E5', 0.5], ['D5', 0.5], ['E5', 0.5],
  ['C5', 1], [null, 1],
];
const NIGHT_TUNE: [string | null, number][] = [
  ['E5', 1], ['C5', 1], ['D5', 1], ['G4', 2], ['A4', 1], ['C5', 1], ['B4', 1], ['G4', 2], [null, 1],
];

// --- State ------------------------------------------------------------------------------------------

interface Food {
  kind: 'meal' | 'snack';
  pos: Vec3;
  vy: number;
  landed: boolean;
  bounces: number;
  spin: number;
  collider: RAPIER.Collider | null;
  usable: Usable;
  /** Seconds since it was eaten (-1: not yet). */
  eaten: number;
}

interface Poop {
  pos: Vec3;
  age: number;
  squished: boolean;
  /** Carried off by the flush. */
  carried: boolean;
  gone: boolean;
}

interface Bit {
  pos: Vec3;
  vel: Vec3;
  t: number;
  life: number;
  size: number;
  color: number[];
  glow?: boolean;
}

interface Letter {
  sprite: PixelSprite;
  /** Half its width (m), for hits. */
  half: number;
  pos: Vec3;
  dir: Vec3;
  t: number;
  sliding: boolean;
  hit: boolean;
  done: boolean;
}

interface PlayState {
  round: number;
  side: number;
  phase: 'intro' | 'warn' | 'fall' | 'down' | 'rise' | 'gap' | 'done';
  t: number;
  warn: number;
  wins: number;
  /** Height of the slab's underside, where the warning started it from, and its middle (x). */
  y: number;
  y0: number;
  x: number;
}

interface Popup {
  label: WorldLabel;
  base: Vec3;
  t: number;
  life: number;
}

interface Death {
  t: number;
  cause: Cause;
  /** Where the ghost rises from and the grave goes (set a moment after dying). */
  from: Vec3 | null;
  facing: number;
}

export class TamagotchiLevel implements Level {
  readonly number: number;
  readonly title = 'Tamagotchi';
  status: LevelStatus = 'playing';
  private arrival: PortalArrival;
  private exit = new ExitPortal(0);
  private giant = new Giant();
  private env: Environment = { ...DEFAULT_ENV, sunDir: [0.35, 1.25, 0.7] };

  /** Seconds since the arrival finished (-1 until then), and since the pet hatched into life (-1 until then). */
  private t = -1;
  private lifeT = -1;
  private hunger = 3;
  private happy = 3;
  private weight = START_WEIGHT;
  private sick = false;
  private sickT = 0;
  private death: Death | null = null;
  /** Evolving (the win): seconds since it started (-1: not yet). */
  private evolveT = -1;
  private dropped = false;

  // The owner and his menu.
  private sel = -1;
  private buttonT = [9, 9, 9];
  private timers: { at: number; fn: () => void }[] = [];
  private clock = 0;
  /** The menu is being driven or an action is running. */
  private busy = false;
  private action: Kind | null = null;
  private lastKind: Kind | null = null;
  private idleT = 0;
  private gap = 1.5;
  private eventCount = 0;
  private nights = 0;
  private lastNight = -99;
  private lastScold = -99;

  // FOOD
  private foodMenu: { choice: number; t: number } | null = null;
  private foods: Food[] = [];
  private eatCooldown = 0;
  private eatingT = 9;
  private refuseT = 9;
  // PLAY
  private play: PlayState | null = null;
  private joyT = 9;
  // BATHROOM
  private poops: Poop[] = [];
  private nextPoop = FIRST_POOP;
  private flushDelay = 5;
  private wave: { dir: number; t: number; x: number; phase: 'build' | 'run' | 'drain' } | null = null;
  // LIGHT
  private night: { t: number; bed: Vec3; asleep: boolean; stillT: number; sleptT: number; beeped: number; morning: boolean } | null = null;
  private light = 1;
  // DISCIPLINE
  private scold: { t: number; launched: number } | null = null;
  private letters: Letter[] = [];
  /** After a letter hits you, the others can't for a moment (you're already down). */
  private scoldedT = 9;
  // MEDICINE
  private syringe: { pos: Vec3; yaw: number; t: number; phase: 'drop' | 'chase' | 'jab' | 'leave'; from: Vec3; plunge: number } | null = null;

  // Timmy.
  private peekT = -1;
  private peekDur = 0;
  private nextPeek = 16;
  private timmyLine: WorldLabel = { pos: [0, 0, 0], text: '', size: 1.1, color: '#ffe08a' };

  private bits: Bit[] = [];
  private popups: Popup[] = [];
  private alarmT = 0;
  private dayTune = new Tune(DAY_TUNE, 132, { wave: 'square', vol: 0.035 });
  private nightTune = new Tune(NIGHT_TUNE, 76, { wave: 'triangle', vol: 0.06 });

  // Sprites.
  private petA = new PixelSprite(PET_A, { 1: PIX });
  private petB = new PixelSprite(PET_B, { 1: PIX });
  private petHappy = new PixelSprite(PET_HAPPY, { 1: PIX });
  private petSleep = new PixelSprite(PET_SLEEP, { 1: PIX });
  private petSad = new PixelSprite(PET_SAD, { 1: PIX });
  private petAdult = new PixelSprite(PET_ADULT, { 1: PIX });
  private egg = new PixelSprite(EGG, { 1: PIX });
  private eggCracked = new PixelSprite(EGG_CRACKED, { 1: PIX });
  private heartFull = new PixelSprite(HEART_FULL, { 1: PIX });
  private heartEmpty = new PixelSprite(HEART_EMPTY, { 1: PIX });
  private icons = ICON_BITMAPS.map((b) => new PixelSprite(b, { 1: PIX }));
  private arrow = new PixelSprite(ARROW_LEFT, { 1: PIX });
  private poopLcd = new PixelSprite(POOP_LCD, { 1: PIX });
  private skull = new PixelSprite(SKULL, { 1: PIX });
  private ghostLcd = new PixelSprite(GHOST, { 1: PIX });
  private graveLcd = new PixelSprite(GRAVE, { 1: PIX });
  private burgerLcd = new PixelSprite(BURGER_LCD, { 1: PIX });
  private candyLcd = new PixelSprite(CANDY_LCD, { 1: PIX });
  private syringeLcd = new PixelSprite(SYRINGE_LCD, { 1: PIX });
  private moon = new PixelSprite(MOON, { 1: PIX });
  private waveLcd = new PixelSprite(WAVE_LCD, { 1: PIX });
  private burger = new PixelSprite(BURGER, BURGER_COLORS, { spec: 0.3 });
  private candy = new PixelSprite(CANDY, CANDY_COLORS, { spec: 0.6 });
  private poop = new PixelSprite(POOP, POOP_COLORS, { spec: 0.4 });
  private stink = new PixelSprite(STINK, { 1: [0.45, 0.7, 0.15] }, { shadow: false });
  private skullWorld = new PixelSprite(SKULL, { 1: [0.2, 0.9, 0.3] }, { pattern: Pattern.emissive, shadow: false });
  private waveCrest = new PixelSprite(
    ['...ffff..', '..fwwwwf.', '.fwwwwwww', 'fwwwwdwww', 'wwwddddww', 'wdddddddd'],
    { f: [0.85, 0.95, 1], w: [0.22, 0.58, 0.98], d: [0.08, 0.3, 0.8] },
    { spec: 0.8 },
  );
  private slabArrow = new PixelSprite(ARROW_LEFT, { 1: [0.55, 0.65, 0.42] }, { pattern: Pattern.emissive, shadow: false });
  private textHungry = textSprite('HUNGRY', PIX);
  private textHappy = textSprite('HAPPY', PIX);
  private textMeal = textSprite('MEAL', PIX);
  private textSnack = textSprite('SNACK', PIX);
  private textNo = textSprite('NO!', PIX);
  private textWin = textSprite('WIN!', PIX);
  private textQ = textSprite('?', PIX);
  private textZ = textSprite('Z', [0.35, 0.45, 0.9], { pattern: Pattern.emissive, shadow: false });
  private textRip = textSprite('RIP', [0.2, 0.2, 0.22]);
  private textBang = textSprite('!', PIX);
  private letterSprites = ['N', 'O', '!'].map((c) => textSprite(c, [0.12, 0.14, 0.1], { spec: 0.4 }));
  private ageText = textSprite('AGE 0', PIX);
  private weightText = textSprite('WT 5 LB', PIX);
  private shownAge = 0;
  private shownWeight = START_WEIGHT;
  private decor: { sprite: PixelSprite; pos: Vec3; right: Vec3; normal: Vec3; pixel: number }[] = [];

  private petFlip = false;
  private petVel = 0;
  private labelList: WorldLabel[] = [];
  private iconLabels: WorldLabel[] = ICON_NAMES.map((name, i) => ({ pos: [iconX(i), 7.02, LCD_Z + 0.05] as Vec3, text: name, size: 0.3, color: '#27321f' }));
  private targets: TrackedTarget[] = [];
  private syringeTarget: TrackedTarget = { pos: [0, 0, 0], radius: 1.2 };

  constructor(private ctx: LevelContext) {
    this.number = ctx.number;
    const { hud, physics } = ctx;
    hud.setLevel(`The Chamber · Level ${this.number}`);
    hud.show(`LEVEL ${this.number}`, '', 2.5);
    hud.hint('');
    this.arrival = new PortalArrival(ctx, [0, 0, 5]);

    // Timmy waits below the horizon behind the south wall.
    this.giant.root = [0, -80, 31];
    this.giant.leanTarget = this.giant.lean = 0.25;
    this.giant.update(0, [10, -40, 30]);

    // The screen's bezel stands out of the north wall: keep people out of it.
    physics.addStaticBox([0, (LCD_Y0 + LCD_Y1) / 2, -CHAMBER_HALF + BEZEL_DEPTH / 2], [LCD_HALF * 2 + 1.2, LCD_Y1 - LCD_Y0 + 1.1, BEZEL_DEPTH]);

    // Printed decorations on the shell: pixel hearts and stars.
    const star = ['....1....', '....1....', '...111...', '111111111', '.1111111.', '..11111..', '..11.11..', '.11...11.', '11.....11'];
    const deco: [string[], number[], Vec3, Vec3, Vec3, number][] = [
      [HEART_FULL, [1, 0.95, 0.98], [-WALL_IN, 6.8, -6], [0, 0, -1], [1, 0, 0], 0.32],
      [star, [1, 0.92, 0.35], [-WALL_IN, 3.4, 1.5], [0, 0, -1], [1, 0, 0], 0.3],
      [HEART_FULL, [0.55, 0.9, 1], [-WALL_IN, 7.4, 7.5], [0, 0, -1], [1, 0, 0], 0.26],
      [star, [0.55, 0.9, 1], [WALL_IN, 7, -6.5], [0, 0, 1], [-1, 0, 0], 0.28],
      [HEART_FULL, [1, 0.92, 0.35], [WALL_IN, 6.8, 6.5], [0, 0, 1], [-1, 0, 0], 0.3],
      [star, [1, 0.95, 0.98], [8.8, 7.8, CHAMBER_HALF - 0.02], [-1, 0, 0], [0, 0, -1], 0.26],
      [HEART_FULL, [0.55, 0.9, 1], [-8.8, 7.6, CHAMBER_HALF - 0.02], [-1, 0, 0], [0, 0, -1], 0.26],
    ];
    for (const [rows, color, pos, right, normal, pixel] of deco) {
      this.decor.push({ sprite: new PixelSprite(rows, { 1: color }, { spec: 0.5 }), pos, right, normal, pixel });
    }
  }

  // --- Helpers ----------------------------------------------------------------------------------------

  private alive() {
    return this.ctx.player.mode === 'control' && !this.death;
  }

  private later(delay: number, fn: () => void) {
    this.timers.push({ at: this.clock + delay, fn });
  }

  private popup(text: string, color: string, at?: Vec3, size = 0.36) {
    const base = at ?? add(this.ctx.player.pos, [0, 2.3, 0]);
    this.popups.push({ label: { pos: [...base], text, size, color }, base, t: 0, life: 1.6 });
  }

  private burst(pos: Vec3, n: number, colors: number[][], speed = 4, size = 0.14, glow = false) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * rand(0.4, 1);
      this.bits.push({
        pos: [...pos], vel: [Math.cos(a) * s, rand(1.5, 5), Math.sin(a) * s], t: 0, life: rand(0.6, 1.2),
        size: size * rand(0.6, 1.2), color: pick(colors), glow,
      });
    }
  }

  private press(btn: number) {
    this.buttonT[btn] = 0;
    if (btn === 0) {
      this.sel = (this.sel + 1) % ICON_KINDS.length;
      sound.a();
    } else if (btn === 1) sound.b();
    else {
      this.sel = -1;
      sound.c();
    }
  }

  /** Timmy's head comes up over the south wall for `dur` seconds, saying `line`. */
  private peek(line: string, dur = 4.5) {
    if (this.peekT < 0) this.peekT = 0;
    else {
      // Already up, or on the way down: stay (rising again from wherever he is).
      const up = clamp(Math.min(this.peekT / 0.9, (this.peekDur - this.peekT) / 0.9), 0, 1);
      this.peekT = up * 0.9;
    }
    this.peekDur = this.peekT + dur;
    this.timmyLine.text = line;
  }

  private applyWeight() {
    const { player } = this.ctx;
    player.speedScale = clamp(1 - Math.max(0, this.weight - WEIGHT_SLOW) * SLOW_PER_LB, SLOWEST, 1);
    player.girth = 1 + Math.max(0, this.weight - START_WEIGHT) * GIRTH_PER_LB;
  }

  private addHearts(which: 'hunger' | 'happy', amount: number) {
    if (which === 'hunger') this.hunger = clamp(this.hunger + amount, 0, HEARTS);
    else this.happy = clamp(this.happy + amount, 0, HEARTS);
  }

  // --- The owner --------------------------------------------------------------------------------------

  /** Timmy decides what to do next (null: nothing, for now). */
  private chooseNext(): Kind | null {
    const fits = (k: Kind) => this.lifeT + KIND_TIME[k] < LIFE + 1;
    this.eventCount++;
    if (this.eventCount === 1) return 'feed';
    if (this.eventCount === 2) return 'play';
    const foodOut = this.foods.filter((f) => f.eaten < 0).length;
    // Even Timmy notices a starving pet, or a miserable one.
    if (this.hunger <= 2.4 && foodOut === 0 && fits('feed')) return 'feed';
    if (this.happy <= 1.6 && this.lastKind !== 'play' && fits('play')) return 'play';
    if (this.sick && this.sickT > 2 && fits('med')) return 'med';
    if (this.poops.some((p) => !p.gone && !p.carried && p.age > this.flushDelay) && fits('flush')) return 'flush';
    const weights: [Kind, number][] = [];
    if (foodOut < 2) weights.push(['feed', this.hunger <= 2.0 ? 6 : this.hunger <= 2.8 ? 1.5 : 0.2]);
    weights.push(['play', this.happy <= 2.2 ? 5 : 1.6]);
    if (this.nights < 2 && this.lifeT > 22 && this.lifeT - this.lastNight > 25) weights.push(['light', this.nights === 0 && this.lifeT > 35 ? 6 : 1.8]);
    if (this.lifeT > 12 && this.lifeT - this.lastScold > 14 && this.happy > 2) weights.push(['scold', this.lastScold < 0 && this.lifeT > 30 ? 5 : 1.4]);
    const options = weights.filter(([k]) => (k !== this.lastKind || k === 'feed') && fits(k));
    const total = options.reduce((s, [, w]) => s + w, 0);
    let r = Math.random() * total;
    for (const [k, w] of options) {
      r -= w;
      if (r <= 0) return k;
    }
    return options[0]?.[0] ?? null;
  }

  /** Walks the highlight to `kind` with A (sometimes all the way round, he's bored), then presses B. */
  private startMenu(kind: Kind) {
    this.busy = true;
    const target = ICON_KINDS.indexOf(kind);
    let presses = this.sel < 0 ? target + 1 : (target - this.sel + ICON_KINDS.length) % ICON_KINDS.length;
    if (Math.random() < 0.15 && this.eventCount > 2) presses += ICON_KINDS.length;
    let d = 0.2;
    for (let i = 0; i < presses; i++) {
      d += rand(0.24, 0.4);
      this.later(d, () => this.press(0));
    }
    this.later(d + 0.55, () => {
      this.press(1);
      this.begin(kind);
    });
  }

  private begin(kind: Kind) {
    if (this.death || this.evolveT >= 0) {
      this.busy = false;
      return;
    }
    this.action = kind;
    this.lastKind = kind;
    switch (kind) {
      case 'feed': {
        this.foodMenu = { choice: 0, t: 0 };
        // Candy if it looks sad (Timmy's theory of pet care), sometimes anyway.
        const snack = Math.random() < (this.hunger <= 1.8 ? 0.15 : this.happy < this.hunger - 0.5 ? 0.6 : 0.25) && this.eventCount > 1;
        let d = 0.7;
        const dither = Math.random() < 0.35;
        const toggles = (snack ? 1 : 0) + (dither ? 2 : 0);
        for (let i = 0; i < toggles; i++) {
          this.later(d, () => {
            this.press(0);
            if (this.foodMenu) this.foodMenu.choice = 1 - this.foodMenu.choice;
          });
          d += rand(0.35, 0.5);
        }
        this.later(d + 0.3, () => {
          this.press(1);
          if (!this.death) this.dropFood(snack ? 'snack' : 'meal');
          this.foodMenu = null;
          this.later(0.4, () => this.endAction());
        });
        break;
      }
      case 'play': {
        const warn = Math.max(WARN_MIN, WARN_FIRST - this.lifeT * 0.008);
        this.play = { round: 0, side: 1, phase: 'intro', t: 0, warn: warn + 0.3, wins: 0, y: 24, y0: 24, x: 0 };
        break;
      }
      case 'flush': {
        const p = this.ctx.player.pos[0];
        // From the wall further from you, mostly (more time to see it coming).
        const far = p > 0 ? -1 : 1;
        this.wave = { dir: Math.random() < 0.7 ? far : -far, t: 0, x: 0, phase: 'build' };
        this.wave.x = -this.wave.dir * (CHAMBER_HALF - 0.4);
        sound.gurgle();
        if (Math.random() < 0.5) this.peek(pick(['ew.', 'EWWW', 'flush it flush it']), 3.5);
        break;
      }
      case 'light': {
        this.nights++;
        this.lastNight = this.lifeT;
        const p = this.ctx.player.pos;
        let bed: Vec3 = [0, 0, 0];
        for (let tries = 0; tries < 40; tries++) {
          bed = [rand(-8.5, 8.5), 0, rand(-7.5, 8.5)];
          const d = Math.hypot(bed[0] - p[0], bed[2] - p[2]);
          if (d > 6 && d < 11) break;
        }
        this.night = { t: 0, bed, asleep: false, stillT: 0, sleptT: 0, beeped: 0, morning: false };
        sound.lightsOff();
        if (Math.random() < 0.5) this.peek('night night lol', 3);
        break;
      }
      case 'scold': {
        this.lastScold = this.lifeT;
        this.scold = { t: 0, launched: 0 };
        sound.no();
        this.peek('NO!', 3.5);
        break;
      }
      case 'med': {
        const p = this.ctx.player.pos;
        const a = Math.random() * Math.PI * 2;
        const from: Vec3 = [clamp(p[0] + Math.cos(a) * 9, -9.5, 9.5), 1.15, clamp(p[2] + Math.sin(a) * 9, -9.5, 9.5)];
        this.syringe = { pos: [from[0], 18, from[2]], yaw: 0, t: 0, phase: 'drop', from, plunge: 0 };
        sound.whoosh();
        if (Math.random() < 0.6) this.peek(pick(['medicine time!', 'hold STILL', 'is it supposed to be green']), 3.5);
        break;
      }
    }
  }

  private endAction() {
    if (!this.action) return;
    this.action = null;
    this.press(2);
    this.busy = false;
    this.idleT = 0;
    const k = clamp(this.lifeT / LIFE, 0, 1);
    this.gap = lerp(2.4, 1.0, k) + rand(0, 0.8);
  }

  // --- FOOD ------------------------------------------------------------------------------------------

  private dropFood(kind: 'meal' | 'snack') {
    const p = this.ctx.player.pos;
    let pos: Vec3 = [0, 0, 0];
    for (let tries = 0; tries < 40; tries++) {
      pos = [rand(-9.5, 9.5), 20, rand(-9, 9.5)];
      const d = Math.hypot(pos[0] - p[0], pos[2] - p[2]);
      const clear = this.foods.every((f) => f.eaten >= 0 || Math.hypot(f.pos[0] - pos[0], f.pos[2] - pos[2]) > 3);
      if (d > 3 && d < 12 && clear) break;
    }
    const food: Food = {
      kind, pos, vy: 0, landed: false, bounces: 0, spin: Math.random() * 6, collider: null, eaten: -1,
      usable: { highlight: 0, use: () => this.eat(food) },
    };
    this.foods.push(food);
    sound.whoosh();
  }

  private eat(food: Food) {
    if (food.eaten >= 0 || !food.landed || this.eatCooldown > 0 || !this.alive()) return;
    this.eatCooldown = 0.3;
    const meal = food.kind === 'meal';
    const full = meal ? this.hunger >= HEARTS - 0.05 : this.happy >= HEARTS - 0.05 && this.hunger >= HEARTS - 0.05;
    if (full) {
      sound.refuse();
      this.popup(pick(['FULL', 'no thanks', '*burp*']), '#27321f');
      this.refuseT = 0; // shakes its head on the screen
      return;
    }
    food.eaten = 0;
    if (food.collider) this.ctx.physics.world.removeCollider(food.collider, false);
    food.collider = null;
    sound.munch();
    this.eatingT = 0;
    if (meal) {
      this.addHearts('hunger', MEAL_HUNGER);
      this.weight += MEAL_WEIGHT;
      this.popup('+♥♥ HUNGRY', '#ff5a8a');
    } else {
      this.addHearts('happy', SNACK_HAPPY);
      this.addHearts('hunger', SNACK_HUNGER);
      this.weight += SNACK_WEIGHT;
      this.popup(`+♥ HAPPY  +${SNACK_WEIGHT} LB`, '#ff5a8a');
    }
    this.applyWeight();
    const colors = meal ? [BURGER_COLORS.b, BURGER_COLORS.l, BURGER_COLORS.p] : [CANDY_COLORS.p, CANDY_COLORS.r, CANDY_COLORS.w];
    this.burst(add(food.pos, [0, 0.2, 0]), 10, colors, 2.5, 0.12);
  }

  private updateFoods(dt: number) {
    const { player, physics, input } = this.ctx;
    this.eatCooldown = Math.max(0, this.eatCooldown - dt);
    this.eatingT += dt;
    this.refuseT += dt;
    for (const f of this.foods) {
      f.spin += dt * 1.4;
      if (f.eaten >= 0) {
        f.eaten += dt;
        continue;
      }
      if (!f.landed) {
        f.vy -= 22 * dt;
        f.pos[1] += f.vy * dt;
        const rest = f.kind === 'meal' ? 0.95 : 0.75;
        // Lands on your head?
        if (this.alive() && f.vy < -4 && Math.hypot(f.pos[0] - player.pos[0], f.pos[2] - player.pos[2]) < 1.0 &&
          f.pos[1] - rest < player.pos[1] + 1.95 && f.pos[1] - rest > player.pos[1] + 1.2) {
          const d = normalize([player.pos[0] - f.pos[0] + 0.01, 0, player.pos[2] - f.pos[2]]);
          player.knock([d[0] * 4, 2, d[2] * 4], 0.9);
          sound.bonk();
          this.popup('BONK', '#ffd166');
          f.vy = 5;
          f.pos[0] -= d[0] * 1.3;
          f.pos[2] -= d[2] * 1.3;
        }
        if (f.pos[1] <= rest) {
          f.pos[1] = rest;
          if (f.bounces < 1 && f.vy < -6) {
            f.bounces++;
            f.vy = -f.vy * 0.3;
            sfx.thud(0.35);
          } else {
            f.landed = true;
            f.vy = 0;
            const h = f.kind === 'meal' ? 1.6 : 1.0;
            f.collider = physics.world.createCollider(RAPIER.ColliderDesc.cylinder(h / 2, 0.75).setTranslation(f.pos[0], h / 2, f.pos[2]));
            physics.registerUsable(f.collider, f.usable);
          }
        }
      }
    }
    this.foods = this.foods.filter((f) => f.eaten < 0 || f.eaten < 0.6);
    // E next to food eats it, whether or not it's under the crosshair.
    if (input.wasPressed('KeyE') && this.alive()) {
      let best: Food | null = null, bestD = 2.4;
      for (const f of this.foods) {
        if (!f.landed || f.eaten >= 0) continue;
        const d = Math.hypot(f.pos[0] - player.pos[0], f.pos[2] - player.pos[2]);
        if (d < bestD) {
          best = f;
          bestD = d;
        }
      }
      if (best) this.eat(best);
    }
  }

  /** Something slammed down on food: it's gone. */
  private squashFood(f: Food) {
    if (f.eaten >= 0) return;
    f.eaten = 0.59;
    if (f.collider) this.ctx.physics.world.removeCollider(f.collider, false);
    f.collider = null;
    const colors = f.kind === 'meal' ? [BURGER_COLORS.b, BURGER_COLORS.l, BURGER_COLORS.p] : [CANDY_COLORS.p, CANDY_COLORS.r];
    this.burst([f.pos[0], 0.3, f.pos[2]], 14, colors, 6, 0.16);
  }

  // --- PLAY ------------------------------------------------------------------------------------------

  private updatePlay(dt: number) {
    const pl = this.play;
    if (!pl) return;
    const { player, camera } = this.ctx;
    pl.t += dt;
    switch (pl.phase) {
      case 'intro':
        if (pl.t > 0.8) this.nextRound(pl);
        break;
      case 'warn': {
        const k = clamp(pl.t / pl.warn, 0, 1);
        pl.y = lerp(pl.y0, SLAM_FROM, smooth(k));
        pl.x += (pl.side * 6 - pl.x) * Math.min(1, dt * 7);
        // A tick every so often, faster toward the end.
        const period = lerp(0.4, 0.12, k);
        if (Math.floor(pl.t / period) !== Math.floor((pl.t - dt) / period)) beep(pl.side < 0 ? 1600 : 2000, 0.04, 0, 0.05);
        if (pl.t >= pl.warn) {
          pl.phase = 'fall';
          pl.t = 0;
          sound.whoosh();
        }
        break;
      }
      case 'fall': {
        const k = clamp(pl.t / SLAM_FALL, 0, 1);
        pl.y = SLAM_FROM * (1 - k * k);
        pl.x = pl.side * 6;
        if (k >= 1) {
          pl.phase = 'down';
          pl.t = 0;
          pl.y = 0;
          sound.slam();
          const d = Math.abs(player.pos[0] - pl.side * 6);
          camera.addShake(d < 7 ? 0.8 : 0.45);
          for (const f of this.foods) if (f.pos[0] * pl.side > 0) this.squashFood(f);
          for (const p of this.poops) if (p.pos[0] * pl.side > 0) p.squished = true;
          for (let i = 0; i < 16; i++) {
            const z = rand(-11.5, 11.5);
            this.bits.push({ pos: [0.05 * pl.side, 0.2, z], vel: [-pl.side * rand(2, 6), rand(1, 4), rand(-1, 1)], t: 0, life: rand(0.4, 0.8), size: rand(0.1, 0.2), color: FLOOR });
          }
          if (this.alive() && player.pos[0] * pl.side > -SLAM_EDGE) {
            const chest = add(player.pos, [0, 1.1, 0]);
            player.kill([-pl.side * 3, -3, 0], { violence: 26, origin: chest });
            camera.addShake(1.1);
            this.die('squashed');
          } else if (this.alive()) {
            pl.wins++;
            this.addHearts('happy', PLAY_HAPPY);
            this.joyT = 0;
            sound.dodge();
            this.popup('+♥ HAPPY', '#ff5a8a');
          }
        }
        break;
      }
      case 'down':
        if (pl.t > SLAM_DOWN) {
          pl.phase = 'rise';
          pl.t = 0;
        }
        break;
      case 'rise': {
        const k = clamp(pl.t / SLAM_RISE, 0, 1);
        pl.y = (pl.round < PLAY_ROUNDS && !this.death ? SLAM_HOVER : 24) * smooth(k);
        if (k >= 1) {
          pl.phase = 'gap';
          pl.t = 0;
        }
        break;
      }
      case 'gap':
        if (pl.t > 0.25) {
          if (this.death) {
            pl.phase = 'done';
          } else if (pl.round >= PLAY_ROUNDS) {
            pl.phase = 'done';
            pl.t = 0;
            if (pl.wins >= PLAY_ROUNDS) {
              this.addHearts('happy', PLAY_SWEEP);
              this.weight = Math.max(1, this.weight - 1);
              this.applyWeight();
              sound.sweep();
              this.popup('WIN!  -1 LB', '#ff5a8a');
            }
          } else this.nextRound(pl);
        }
        break;
      case 'done':
        if (pl.t > 1.0 || this.death) {
          this.play = null;
          this.endAction();
        }
        break;
    }
  }

  private nextRound(pl: PlayState) {
    pl.round++;
    const px = this.ctx.player.pos[0];
    const mine = px > 0 ? 1 : -1;
    // He mostly "guesses" the side you're on, so you have to move.
    pl.side = Math.random() < 0.65 ? mine : -mine;
    pl.phase = 'warn';
    pl.t = 0;
    pl.y0 = pl.round === 1 ? 24 : pl.y;
    if (pl.round === 1) pl.x = pl.side * 6;
    pl.warn = Math.max(WARN_MIN, pl.warn - 0.3);
    this.buttonT[1] = 0; // he pushes B to make his guess
    beep(pl.side < 0 ? 1600 : 2000, 0.1);
  }

  // --- BATHROOM --------------------------------------------------------------------------------------

  private plop() {
    const { player } = this.ctx;
    const f = player.facing;
    const behind: Vec3 = [
      clamp(player.pos[0] + Math.sin(f) * 1.3, -11.2, 11.2), 0,
      clamp(player.pos[2] + Math.cos(f) * 1.3, -11, 11.2),
    ];
    this.poops.push({ pos: behind, age: 0, squished: false, carried: false, gone: false });
    this.flushDelay = rand(3.5, 6);
    sound.plop();
    this.popup(pick(['*plop*', 'oops', '*pfrrt*']), '#c89b5a', add(behind, [0, 1.6, 0]), 0.4);
  }

  private updatePoops(dt: number) {
    const { player } = this.ctx;
    for (const p of this.poops) {
      p.age += dt;
      if (p.gone || p.carried || p.squished) continue;
      if (this.alive() && p.age > 0.7 && Math.hypot(p.pos[0] - player.pos[0], p.pos[2] - player.pos[2]) < 0.8 && player.pos[1] < 0.8) {
        p.squished = true;
        sound.squelch();
        this.burst(add(p.pos, [0, 0.2, 0]), 8, [POOP_COLORS.b, POOP_COLORS.h], 2.5, 0.12);
        if (!this.sick) {
          this.sick = true;
          this.sickT = 0;
          sound.sick();
          this.popup('EW. SICK.', '#7cff6b');
        }
      }
    }
    this.poops = this.poops.filter((p) => !p.gone);
  }

  private updateWave(dt: number) {
    const w = this.wave;
    if (!w) return;
    const { player } = this.ctx;
    w.t += dt;
    if (w.phase === 'build') {
      if (w.t >= WAVE_BUILD) {
        w.phase = 'run';
        w.t = 0;
        sound.rush();
      }
    } else if (w.phase === 'run') {
      w.x += w.dir * WAVE_SPEED * dt;
      // Spray off the crest.
      for (let i = 0; i < 2; i++) {
        this.bits.push({
          pos: [w.x + w.dir * 0.4, rand(0.5, 0.9), rand(-11.6, 11.6)], vel: [w.dir * rand(3, 7), rand(2, 4.5), rand(-0.6, 0.6)],
          t: 0, life: rand(0.35, 0.6), size: rand(0.08, 0.16), color: Math.random() < 0.5 ? [0.95, 0.98, 1] : [0.5, 0.78, 1],
        });
      }
      for (const p of this.poops) if (!p.carried && Math.abs(p.pos[0] - w.x) < 0.9) p.carried = true;
      for (const p of this.poops) if (p.carried) p.pos[0] = w.x + w.dir * 0.4;
      if (this.alive() && Math.abs(player.pos[0] - w.x) < WAVE_CORE / 2 + 0.25 && player.pos[1] < WAVE_H) {
        player.kill([w.dir * 9, 3, rand(-1, 1)], { violence: 10 });
        this.die('flushed');
      }
      // A flushed body rides the wave.
      if (this.death?.cause === 'flushed' && player.body) {
        const pel = player.body.position('pelvis');
        if (Math.abs(pel[0] - w.x) < 2 && pel[1] < 2) player.body.addVelocity([w.dir * 20 * dt, 2 * dt, 0]);
      }
      if (w.x * w.dir >= CHAMBER_HALF - 0.5) {
        w.phase = 'drain';
        w.t = 0;
        for (const p of this.poops) if (p.carried) p.gone = true;
        this.burst([w.x, 0.6, 0], 12, [[0.45, 0.75, 1], [0.95, 0.98, 1]], 3, 0.18);
      }
    } else if (w.t > 1.0) {
      this.wave = null;
      this.endAction();
    }
  }

  // --- LIGHT -----------------------------------------------------------------------------------------

  private updateNight(dt: number) {
    const n = this.night;
    if (!n) return;
    const { player, input } = this.ctx;
    n.t += dt;
    if (n.t < DARK_TIME && this.alive()) {
      const dx = player.pos[0] - n.bed[0], dz = player.pos[2] - n.bed[2];
      const onBed = Math.abs(dx) < 1.35 && Math.abs(dz) < 1.75;
      const moving = input.isDown('KeyW') || input.isDown('KeyA') || input.isDown('KeyS') || input.isDown('KeyD');
      const speed = Math.hypot(player.vel[0], player.vel[2]);
      if (!n.asleep) {
        n.stillT = onBed && player.onGround && !moving && speed < 1.2 ? n.stillT + dt : 0;
        if (n.stillT > 0.35) {
          n.asleep = true;
          player.sitting = true;
          player.vel = [0, 0, 0];
          chirp(['E6', 'C6'], 0.15, 0.04);
        }
      }
      if (n.asleep) n.sleptT += dt;
      else if (n.t > DARK_GRACE) {
        this.addHearts('happy', -DARK_DRAIN * dt);
        if (Math.floor(n.t) !== n.beeped) {
          // Grumpy, once a second (a popup the first time).
          if (n.beeped === 0) this.popup(pick(['PAST YOUR BEDTIME  -♥', 'CRANKY  -♥', 'CAN\'T SLEEP  -♥']), '#8fb0ff');
          n.beeped = Math.floor(n.t);
          sound.alarm();
        }
      }
    }
    if (n.t >= DARK_TIME && !n.morning && !this.death) {
      n.morning = true;
      // Morning.
      sound.lightsOn();
      if (n.asleep) {
        player.sitting = false;
        if (n.sleptT > 3) {
          this.addHearts('happy', SLEEP_HAPPY);
          this.popup('WELL RESTED  +♥', '#ff5a8a');
          this.joyT = 0;
        }
      }
      n.asleep = false;
    }
    if (n.t >= DARK_TIME + 0.6 || (this.death && n.t > 0.5)) {
      player.sitting = false;
      this.night = null;
      this.endAction();
    }
  }

  // --- DISCIPLINE ------------------------------------------------------------------------------------

  private updateScold(dt: number) {
    const s = this.scold;
    const { player } = this.ctx;
    this.scoldedT += dt;
    if (s) {
      s.t += dt;
      const launchAt = [1.3, 1.75, 2.2];
      while (s.launched < 3 && s.t >= launchAt[s.launched]) {
        const i = s.launched++;
        const x = (i - 1) * 2.04;
        this.letters.push({
          sprite: this.letterSprites[i], half: i === 2 ? 0.3 : 0.85, pos: [x, 5.3, LCD_Z + 0.3], dir: [0, 0, 1], t: 0,
          sliding: false, hit: false, done: false,
        });
        sound.whoosh();
      }
      if (s.launched >= 3 && this.letters.every((l) => l.done)) {
        this.scold = null;
        this.endAction();
      }
    }
    for (const l of this.letters) {
      if (l.done) continue;
      l.t += dt;
      if (!l.sliding) {
        // Pops out of the screen and drops to the floor...
        const k = clamp(l.t / 0.35, 0, 1);
        l.pos[1] = lerp(5.3, 1.25, k * k);
        l.pos[2] = LCD_Z + 0.3 + 1.6 * k;
        if (k >= 1) {
          // ...then slides at where you're going.
          l.sliding = true;
          sfx.thud(0.3);
          const aim = add(player.pos, scale([player.vel[0], 0, player.vel[2]], LETTER_LEAD));
          l.dir = normalize([aim[0] - l.pos[0], 0, aim[2] - l.pos[2]]);
          if (l.dir[2] < 0.25) l.dir = normalize([l.dir[0], 0, 0.25]);
        }
        continue;
      }
      l.pos[0] += l.dir[0] * LETTER_SPEED * dt;
      l.pos[2] += l.dir[2] * LETTER_SPEED * dt;
      l.pos[1] = 1.25 + Math.abs(Math.sin(l.t * 9)) * 0.25;
      if (!l.hit && this.alive() && this.scoldedT > 1.2) {
        const dx = player.pos[0] - l.pos[0], dz = player.pos[2] - l.pos[2];
        const along = dx * l.dir[0] + dz * l.dir[2];
        const side = dx * l.dir[2] - dz * l.dir[0];
        if (Math.abs(along) < 0.3 + 0.35 && Math.abs(side) < l.half + 0.3 && player.pos[1] < 2.3) {
          l.hit = true;
          this.scoldedT = 0;
          player.knock([l.dir[0] * 9, 3.5, l.dir[2] * 9], 1.1);
          this.addHearts('happy', -SCOLD_HAPPY);
          this.popup('-♥ HAPPY', '#ff5a8a');
          this.ctx.camera.addShake(0.4);
        }
      }
      if (Math.abs(l.pos[0]) > CHAMBER_HALF - 0.6 || Math.abs(l.pos[2]) > CHAMBER_HALF - 0.4) {
        l.done = true;
        sound.clack();
        this.burst([...l.pos], 14, [[0.12, 0.14, 0.1], LCD_LIGHT], 4, 0.2);
      }
    }
    if (!this.scold && this.letters.every((l) => l.done)) this.letters.length = 0;
  }

  // --- MEDICINE --------------------------------------------------------------------------------------

  private syringeTip(): Vec3 {
    const s = this.syringe!;
    return [s.pos[0] - Math.sin(s.yaw) * SYRINGE_TIP, s.pos[1], s.pos[2] - Math.cos(s.yaw) * SYRINGE_TIP];
  }

  private updateSyringe(dt: number) {
    const s = this.syringe;
    if (!s) return;
    const { player } = this.ctx;
    s.t += dt;
    const chest = add(player.pos, [0, 1.1, 0]);
    const wantYaw = Math.atan2(-(chest[0] - s.pos[0]), -(chest[2] - s.pos[2]));
    if (s.phase === 'drop') {
      const k = clamp(s.t / 1.2, 0, 1);
      s.pos[1] = lerp(18, s.from[1], smooth(k));
      s.yaw = wantYaw;
      if (k >= 1) {
        s.phase = 'chase';
        s.t = 0;
      }
    } else if (s.phase === 'chase') {
      let dy = wantYaw - s.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      s.yaw += clamp(dy, -SYRINGE_TURN * dt, SYRINGE_TURN * dt);
      const speed = lerp(SYRINGE_SLOW, SYRINGE_FAST, clamp(s.t / SYRINGE_TIME, 0, 1));
      s.pos[0] = clamp(s.pos[0] - Math.sin(s.yaw) * speed * dt, -11, 11);
      s.pos[2] = clamp(s.pos[2] - Math.cos(s.yaw) * speed * dt, -11, 11);
      s.pos[1] = 1.15 + Math.sin(s.t * 3) * 0.1;
      const tip = this.syringeTip();
      const dx = tip[0] - player.pos[0], dz = tip[2] - player.pos[2];
      const within = Math.hypot(dx, dz) < 0.6 && tip[1] > player.pos[1] + 0.3 && tip[1] < player.pos[1] + 1.8;
      if (within && this.alive()) {
        s.phase = 'jab';
        s.t = 0;
        sound.jab();
        this.sick = false;
        this.addHearts('happy', -JAB_HAPPY);
        const d = normalize([-Math.sin(s.yaw), 0, -Math.cos(s.yaw)]);
        player.knock([d[0] * 7, 5, d[2] * 7], 0.8);
        this.popup('OW!  CURED', '#7cff6b');
        this.burst(tip, 8, [[0.3, 1, 0.4]], 2, 0.1, true);
      } else if (s.t > SYRINGE_TIME || this.death) {
        s.phase = 'leave';
        s.t = 0;
        if (!this.death) this.popup('fine. stay sick.', '#7cff6b', add(s.pos, [0, 1.5, 0]), 0.45);
      }
    } else if (s.phase === 'jab') {
      s.plunge = clamp(s.t / 0.3, 0, 1);
      if (s.t > 0.8) {
        s.phase = 'leave';
        s.t = 0;
      }
    } else {
      s.pos[1] += dt * lerp(2, 25, clamp(s.t, 0, 1));
      if (s.t > 1.2) {
        this.syringe = null;
        this.endAction();
      }
    }
  }

  // --- Life and death --------------------------------------------------------------------------------

  private die(cause: Cause) {
    if (this.death) return;
    const { player, hud } = this.ctx;
    this.death = { t: 0, cause, from: null, facing: player.facing };
    player.sitting = false;
    hud.hide();
    sound.die();
    this.later(0.9, () => this.peek(pick(['aww.', 'MUM! it died', 'can I get a new one', 'oops']), 4));
  }

  private starve(cause: Cause) {
    const { player } = this.ctx;
    player.kill([rand(-1, 1), 1.5, rand(-1, 1)], { violence: 0 });
    this.die(cause);
  }

  private startEvolve() {
    this.evolveT = 0;
    sound.evolve();
    this.ctx.hud.show('WHAT?', 'Your test subject is evolving!', 1.8);
    for (const p of this.poops) {
      this.burst(add(p.pos, [0, 0.4, 0]), 6, [[1.5, 1.4, 0.6]], 2, 0.1, true);
      p.gone = true;
    }
  }

  private updateEvolve(dt: number) {
    if (this.evolveT < 0) return;
    const before = this.evolveT;
    this.evolveT += dt;
    const t = this.evolveT;
    const { hud, player, camera } = this.ctx;
    const at = (x: number) => before < x && t >= x;
    if (at(1.9)) {
      hud.show('EVOLVED!', 'Your pet has evolved into: A SLIGHTLY OLDER TEST SUBJECT.\nIt learned MOUSTACHE.', 4.5);
      sfx.win();
      this.burst(add(player.pos, [0, 1.2, 0]), 24, [[1.8, 1.6, 0.6], [1.6, 0.8, 1.4], [0.8, 1.4, 1.8]], 4, 0.12, true);
    }
    if (at(3.0)) this.peek('ugh. it\'s OLD now.', 3.2);
    if (at(6.2)) this.peek('MUM! can I get a PHONE?', 3.2);
    if (at(8.4)) {
      sound.whistle();
      this.dropped = true;
    }
    if (at(9.6)) {
      sfx.explosion(0.7);
      noise(0.5, { freq: 4000, to: 1200, type: 'highpass', vol: 0.4 });
      camera.addShake(1.3);
      if (this.alive()) player.knock([rand(-2, 2), 5, rand(-2, 2)], 0.7);
      this.exit.openNow();
      this.burst([10.5, 1.8, 0], 20, [SHELL, SHELL_DARK], 5, 0.25);
      hud.show('DROPPED', 'Timmy has moved on to a phone game. You are free. Ish.', 4);
    }
  }

  // --- Update ----------------------------------------------------------------------------------------

  update(dt: number) {
    const { player, hud, camera } = this.ctx;
    this.clock += dt;
    const death = this.death;
    if (death) {
      death.t += dt;
      if (!death.from && death.t > 0.7) {
        death.from = [...player.pos];
        death.from[1] = 0;
      }
      if (death.t > DEATH_SCREEN_DELAY && this.status === 'playing') {
        this.status = 'lost';
        hud.show('YOUR TAMAGOTCHI HAS DIED', `${pick(JOKES[death.cause])}\nPress R to try again.`);
        hud.tips([['Hint', HINTS[death.cause]], ['Controls', CONTROLS]]);
      }
    }
    this.arrival.update(dt);
    this.exit.update(dt, player);
    if (this.exit.entered && this.status === 'playing') this.status = 'exited';

    if (this.arrival.done && this.t < 0) {
      this.t = 0;
      sound.boot();
    }
    if (this.t >= 0) {
      const before = this.t;
      this.t += dt;
      const t = this.t;
      // Turn the view toward the screen while it boots up (the player can still look away).
      if (t < 1.4 && !this.death) {
        const want = Math.atan2(player.pos[0], -(-CHAMBER_HALF - player.pos[2]));
        let d = want - camera.yaw;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        camera.yaw += d * Math.min(1, dt * 3.5);
        camera.pitch += (0.12 - camera.pitch) * Math.min(1, dt * 3);
      }
      if (before < BUTTONS_AT && t >= BUTTONS_AT) sfx.thud(0.4);
      if (t >= EGG_AT && t < CRACK_AT && Math.floor(t * 2.5) !== Math.floor(before * 2.5)) sound.wobble();
      if (before < CRACK_AT && t >= CRACK_AT) beep(1200, 0.12);
      if (before < HATCH_AT && t >= HATCH_AT) {
        sound.hatch();
        if (!this.death) hud.show('IT HATCHED!', 'Congratulations: it\'s a healthy baby test subject. Its owner is Timmy, aged 8.', 3.5);
        this.burst([0, 5.2, LCD_Z + 0.4], 18, [PIX, LCD_LIGHT], 3, 0.16);
      }
      if (before < LIFE_AT && t >= LIFE_AT) {
        this.lifeT = 0;
        this.peek('cool, it hatched', 3.5);
      }
    }

    // Timed button presses.
    if (this.timers.length) {
      const due = this.timers.filter((x) => x.at <= this.clock);
      if (due.length) {
        this.timers = this.timers.filter((x) => x.at > this.clock);
        for (const x of due) x.fn();
      }
    }
    for (let i = 0; i < 3; i++) this.buttonT[i] += dt;

    // Grown up (the life clock has run out): the hearts stop draining while Timmy finishes up.
    const living = this.lifeT >= 0 && this.lifeT < LIFE && !this.death && this.evolveT < 0;
    if (this.lifeT >= 0 && !this.death) this.lifeT += dt;
    if (living) {
      // The hearts drain.
      const ramp = 1 + DRAIN_RAMP * clamp(this.lifeT / LIFE, 0, 1);
      const sickK = this.sick ? SICK_DRAIN : 1;
      const asleep = this.night?.asleep ?? false;
      this.hunger -= HUNGER_DRAIN * ramp * sickK * dt;
      if (!asleep) this.happy -= HAPPY_DRAIN * ramp * sickK * dt;
      if (this.sick) this.sickT += dt;
      if (this.hunger <= 0 && this.alive()) {
        this.hunger = 0;
        this.starve('starved');
      } else if (this.happy <= 0 && this.alive()) {
        this.happy = 0;
        this.starve('sad');
      }
      // Calling for attention.
      this.alarmT -= dt;
      if (Math.min(this.hunger, this.happy) <= 1 && this.alarmT <= 0 && !this.night) {
        this.alarmT = 2;
        sound.alarm();
      }
      // The pet poops now and then (not in its sleep).
      if (this.lifeT >= this.nextPoop && this.lifeT < LIFE - 10 && !this.night && this.alive() && player.onGround) {
        this.nextPoop = this.lifeT + rand(24, 30);
        this.plop();
      }
      // Timmy's next move.
      if (!this.busy) {
        this.idleT += dt;
        if (this.idleT >= this.gap && this.lifeT > 1.2) {
          const next = this.chooseNext();
          if (next) this.startMenu(next);
          else this.idleT = this.gap - 0.5;
        }
      }
      // Now and then he checks on it.
      if (this.lifeT > this.nextPeek) {
        this.nextPeek = this.lifeT + rand(14, 22);
        const line = this.poops.length ? 'MUM, IT POOPED AGAIN' : this.sick ? 'why is it green' : pick(TIMMY_BORED);
        this.peek(line, rand(3.5, 5));
      }
    }

    if (this.lifeT >= LIFE && this.evolveT < 0 && !this.death && !this.busy && this.letters.length === 0) this.startEvolve();

    this.updateFoods(dt);
    this.updatePlay(dt);
    this.updatePoops(dt);
    this.updateWave(dt);
    this.updateNight(dt);
    this.updateScold(dt);
    this.updateSyringe(dt);
    this.updateEvolve(dt);

    // Lights.
    const dark = this.night && this.night.t < DARK_TIME && !this.death ? 1 : 0;
    this.light += ((dark ? 0.03 : 1) - this.light) * Math.min(1, dt * (dark ? 14 : 5));

    // Music: a jolly loop by day, a lullaby at night, nothing once it's dead or dropped.
    const musical = this.lifeT >= 0 && !this.death && !this.dropped && this.status === 'playing';
    if (musical && !dark) this.dayTune.start();
    else this.dayTune.stop();
    if (musical && dark) this.nightTune.start();
    else this.nightTune.stop();

    // The pet on screen follows you about.
    const vx = player.vel[0];
    this.petVel += (vx - this.petVel) * Math.min(1, dt * 8);
    if (Math.abs(this.petVel) > 0.6) this.petFlip = this.petVel > 0;
    this.joyT += dt;

    // Timmy.
    if (this.peekT >= 0) {
      this.peekT += dt;
      if (this.peekT > this.peekDur) {
        this.peekT = -1;
        this.peekDur = 0;
      }
    }
    const up = this.peekT < 0 ? 0 : smooth(Math.min(this.peekT / 0.9, (this.peekDur - this.peekT) / 0.9));
    this.giant.time += dt;
    this.giant.root[1] = lerp(-75, -39.5, up);
    this.giant.lookTarget = this.death ? add(player.pos, [0, 0.5, 0]) : add(player.pos, [0, 1.2, 0]);
    this.giant.update(dt, [10, -40, 30]);
    this.timmyLine.pos = add(this.giant.headCenter(), [0, 9.5, -4]);

    for (const b of this.bits) {
      b.t += dt;
      b.vel[1] -= 16 * dt;
      b.pos[0] += b.vel[0] * dt;
      b.pos[1] += b.vel[1] * dt;
      b.pos[2] += b.vel[2] * dt;
      if (b.pos[1] < b.size / 2) {
        b.pos[1] = b.size / 2;
        b.vel[1] *= -0.3;
        b.vel[0] *= 0.6;
        b.vel[2] *= 0.6;
      }
    }
    this.bits = this.bits.filter((b) => b.t < b.life);
    for (const p of this.popups) {
      p.t += dt;
      p.label.pos[1] = p.base[1] + p.t * 0.7;
    }
    this.popups = this.popups.filter((p) => p.t < p.life);

    // Status text.
    const age = Math.max(0, Math.floor(this.lifeT / (LIFE / 6)));
    if (age !== this.shownAge && this.evolveT < 0) {
      this.shownAge = age;
      this.ageText = textSprite(`AGE ${age}`, PIX);
    }
    if (this.weight !== this.shownWeight) {
      this.shownWeight = this.weight;
      this.weightText = textSprite(`WT ${this.weight} LB`, PIX);
    }
  }

  // --- Drawing ---------------------------------------------------------------------------------------

  draw(out: DrawItem[], time: number) {
    this.arrival.draw(out);
    this.exit.draw(out);
    const t = this.t;
    const flood = t < 0 ? 0 : smooth(t / FLOOD_TIME);
    this.drawShell(out, time, flood);
    this.drawButtons(out, time, t);
    if (flood > 0) this.drawLcd(out, time, flood);
    if (this.giant.root[1] > -74) this.giant.draw(out);
    this.drawFoods(out, time);
    this.drawPoops(out, time);
    this.drawWave(out, time);
    this.drawSlab(out, time);
    this.drawNight(out, time);
    this.drawLetters(out, time);
    this.drawSyringe(out);
    this.drawPlayerExtras(out, time);
    this.drawDeath(out, time);
    for (const b of this.bits) {
      const s = b.size * (1 - b.t / b.life * 0.5);
      out.push({ mesh: 'box', model: mul(translation(b.pos), rotationY(b.t * 5), scaling([s, s, s])), color: b.color, pattern: b.glow ? Pattern.emissive : undefined, shadow: false });
    }
  }

  private drawShell(out: DrawItem[], time: number, flood: number) {
    if (flood <= 0) return;
    const h = WALL_HEIGHT * flood;
    const y = h / 2;
    const wall = (pos: Vec3, size: Vec3) => out.push({ mesh: 'box', model: mul(translation(pos), scaling(size)), color: SHELL, spec: 0.55 });
    const W = CHAMBER_HALF * 2;
    wall([0, y, -CHAMBER_HALF + 0.02], [W, h, 0.04]);
    wall([0, y, CHAMBER_HALF - 0.02], [W, h, 0.04]);
    wall([-CHAMBER_HALF + 0.02, y, 0], [0.04, h, W]);
    // The east wall, round the exit (its panel is covered until it opens).
    const ex = CHAMBER_HALF - 0.02;
    wall([ex, y, -6.78], [0.04, h, 10.44]);
    wall([ex, y, 6.78], [0.04, h, 10.44]);
    if (h > 3.35) wall([ex, (3.35 + h) / 2, 0], [0.04, h - 3.35, 3.12]);
    if (!this.exit.open) wall([ex, Math.min(h, 3.35) / 2, 0], [0.04, Math.min(h, 3.35), 3.12]);
    // The floor: two halves (PLAY flashes one), with a dashed line down the middle.
    const pl = this.play;
    const base = [lerp(0.6, FLOOR[0], flood), lerp(0.61, FLOOR[1], flood), lerp(0.63, FLOOR[2], flood)];
    for (const side of [-1, 1]) {
      let c = base;
      if (pl && pl.side === side && (pl.phase === 'warn' || pl.phase === 'fall')) {
        // The half about to get it flashes (faster and faster), and darkens under the slab.
        const k = pl.phase === 'fall' ? 1 : pl.t / pl.warn;
        const on = Math.floor(pl.t * lerp(5, 12, k)) % 2 === 0;
        const dim = 1 - 0.45 * k;
        c = on ? FLOOR_WARN : [base[0] * dim, base[1] * dim, base[2] * dim];
      }
      out.push({ mesh: 'box', model: mul(translation([side * 6, 0.006 - 0.01 * (1 - flood), 0]), scaling([12, 0.012, W])), color: c, pattern: Pattern.panels, param: 2, spec: 0.3 });
    }
    if (flood > 0.99) {
      for (let z = -11; z <= 11; z += 2) out.push({ mesh: 'box', model: mul(translation([0, 0.014, z]), scaling([0.16, 0.01, 1.1])), color: [1, 1, 1], shadow: false });
    }
    // A thick rim round the top, like the edge of the plastic egg.
    if (flood > 0.99) {
      const r = 0.55, top = WALL_HEIGHT + 0.1;
      const rim = (pos: Vec3, len: number, alongX: boolean) => out.push({
        mesh: 'cylinder',
        model: mul(translation(pos), alongX ? rotationZ(Math.PI / 2) : rotationX(Math.PI / 2), scaling([r, len, r])),
        color: SHELL_DARK, spec: 0.6,
      });
      rim([0, top, -CHAMBER_HALF - 0.5], W + 1, true);
      rim([0, top, CHAMBER_HALF + 0.5], W + 1, true);
      rim([-CHAMBER_HALF - 0.5, top, 0], W + 1, false);
      rim([CHAMBER_HALF + 0.5, top, 0], W + 1, false);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        out.push({ mesh: 'sphere', model: mul(translation([sx * (CHAMBER_HALF + 0.5), top, sz * (CHAMBER_HALF + 0.5)]), scaling([r, r, r])), color: SHELL_DARK, spec: 0.6 });
      }
      // The keychain loop on top.
      out.push({ mesh: 'tube', model: mul(translation([0, WALL_HEIGHT + 2.1, -CHAMBER_HALF - 0.5]), rotationX(Math.PI / 2), scaling([2.2, 0.5, 2.2])), color: [0.82, 0.84, 0.9], spec: 1 });
      for (const d of this.decor) {
        const up: Vec3 = [0, 1, 0];
        d.sprite.draw(out, time, d.pos, d.right, up, d.normal, d.pixel, 0.05);
      }
    }
  }

  private drawButtons(out: DrawItem[], time: number, t: number) {
    if (t < BUTTONS_AT) return;
    const out1 = smooth((t - BUTTONS_AT) / 0.5);
    const z = CHAMBER_HALF - 0.02;
    for (let i = 0; i < 3; i++) {
      const bt = this.buttonT[i];
      const pressed = bt < 0.22 ? 1 - Math.abs(bt / 0.11 - 1) : 0;
      const stick = (0.6 - 0.45 * pressed) * out1;
      const x = BUTTON_X[i];
      out.push({ mesh: 'tube', model: mul(translation([x, BUTTON_Y, z - 0.05]), rotationX(Math.PI / 2), scaling([BUTTON_R * 1.35, 0.14, BUTTON_R * 1.35])), color: BEZEL, spec: 0.5 });
      out.push({ mesh: 'cylinder', model: mul(translation([x, BUTTON_Y, z - stick / 2]), rotationX(Math.PI / 2), scaling([BUTTON_R, stick, BUTTON_R])), color: BUTTON, spec: 0.7 });
      out.push({ mesh: 'sphere', model: mul(translation([x, BUTTON_Y, z - stick]), scaling([BUTTON_R * 0.98, BUTTON_R * 0.98, 0.18])), color: BUTTON, spec: 0.8 });
    }
    // A, B, C printed under them.
    if (out1 > 0.9) {
      const letters = this.buttonLetters;
      for (let i = 0; i < 3; i++) letters[i].draw(out, time, [BUTTON_X[i], BUTTON_Y - BUTTON_R - 0.75, z], [-1, 0, 0], [0, 1, 0], [0, 0, -1], 0.13, 0.04);
    }
  }
  private buttonLetters = ['A', 'B', 'C'].map((c) => textSprite(c, BEZEL, { spec: 0.4 }));

  /** Draws a sprite on the screen, centred at (x, y). */
  private lcd(out: DrawItem[], time: number, sprite: PixelSprite, x: number, y: number, pixel: number, opts: { flip?: boolean; color?: number[]; glow?: boolean } = {}) {
    sprite.draw(out, time, [x, y, LCD_Z], R, U, N, pixel, 0.05, {
      gap: 0.12, flip: opts.flip, color: opts.color, pattern: opts.glow ? Pattern.emissive : undefined,
    });
  }

  private drawLcd(out: DrawItem[], time: number, flood: number) {
    const s = flood;
    const cy = (LCD_Y0 + LCD_Y1) / 2, h = LCD_Y1 - LCD_Y0;
    const z0 = -CHAMBER_HALF;
    // Bezel: a violet frame standing out of the wall, and the screen recessed in it.
    const frame = (pos: Vec3, size: Vec3) => out.push({ mesh: 'roundbox', model: mul(translation(pos), scaling(size)), color: BEZEL, spec: 0.5 });
    const bw = 0.6, fz = z0 + BEZEL_DEPTH / 2;
    frame([0, LCD_Y1 + bw / 2, fz], [(LCD_HALF + bw) * 2 * s, bw, BEZEL_DEPTH]);
    frame([0, LCD_Y0 - bw / 2, fz], [(LCD_HALF + bw) * 2 * s, bw, BEZEL_DEPTH]);
    frame([-(LCD_HALF + bw / 2) * s, cy, fz], [bw, h + bw * 2, BEZEL_DEPTH]);
    frame([(LCD_HALF + bw / 2) * s, cy, fz], [bw, h + bw * 2, BEZEL_DEPTH]);
    out.push({ mesh: 'box', model: mul(translation([0, cy, z0 + 0.06]), scaling([LCD_HALF * 2 * s, h, 0.12])), color: LCD_BG, pattern: Pattern.panels, param: 0.2, spec: 0.35 });
    const t = this.t;
    if (s < 1 || t < 0) return;
    // Booting: static.
    if (t < EGG_AT - 0.3) {
      for (let i = 0; i < 40; i++) {
        const hx = Math.sin(i * 12.9898 + Math.floor(t * 12) * 78.233) * 43758.5453;
        const hy = Math.sin(i * 39.3468 + Math.floor(t * 12) * 11.135) * 24634.6345;
        const x = (hx - Math.floor(hx) - 0.5) * LCD_HALF * 2, y = LCD_Y0 + (hy - Math.floor(hy)) * h;
        out.push({ mesh: 'box', model: mul(translation([x, y, LCD_Z + 0.025]), scaling([0.22, 0.22, 0.05])), color: PIX, shadow: false });
      }
      return;
    }
    const evolving = this.evolveT >= 0 && this.evolveT < 1.9;
    // While evolving the screen flashes inverted.
    const inverted = evolving && Math.floor(this.evolveT * 6) % 2 === 0;
    const ink = inverted ? LCD_LIGHT : PIX;
    if (inverted) out.push({ mesh: 'box', model: mul(translation([0, cy, LCD_Z + 0.01]), scaling([LCD_HALF * 2, h, 0.02])), color: PIX, shadow: false });
    const opt = { color: inverted ? LCD_LIGHT : undefined };

    // The menu icons, the picked one inverted.
    for (let i = 0; i < 6; i++) {
      const on = this.sel === i;
      const x = iconX(i);
      if (on && !inverted) {
        out.push({ mesh: 'box', model: mul(translation([x, ICON_Y, LCD_Z + 0.02]), scaling([1.55, 1.5, 0.04])), color: PIX, shadow: false });
        this.lcd(out, time, this.icons[i], x, ICON_Y, ICON_PIXEL, { color: LCD_LIGHT });
      } else this.lcd(out, time, this.icons[i], x, ICON_Y, ICON_PIXEL, opt);
    }
    // Dividing lines.
    out.push({ mesh: 'box', model: mul(translation([0, 7.18, LCD_Z + 0.02]), scaling([LCD_HALF * 2 - 0.4, 0.05, 0.04])), color: ink, shadow: false });
    out.push({ mesh: 'box', model: mul(translation([0, 3.58, LCD_Z + 0.02]), scaling([LCD_HALF * 2 - 0.4, 0.05, 0.04])), color: ink, shadow: false });

    // The status rows.
    if (t >= HATCH_AT) {
      const blink = Math.floor(time * 4) % 2 === 0;
      this.lcd(out, time, this.textHungry, -9.7 + 1.75, ROW1, 0.1, opt);
      this.lcd(out, time, this.textHappy, -9.7 + 1.45, ROW2, 0.1, opt);
      for (let i = 0; i < HEARTS; i++) {
        const x = -5.3 + i * 1.05;
        for (const [value, y] of [[this.hunger, ROW1], [this.happy, ROW2]] as [number, number][]) {
          const full = value > i;
          // The heart that's going blinks when it's the last one.
          if (full && value <= 1 && i === 0 && blink && !this.death) continue;
          this.lcd(out, time, full ? this.heartFull : this.heartEmpty, x, y, 0.12, opt);
        }
      }
      this.lcd(out, time, this.ageText, 3.8 + this.ageText.w * 0.05, ROW1, 0.1, opt);
      this.lcd(out, time, this.weightText, 3.8 + this.weightText.w * 0.05, ROW2, 0.1, opt);
      if (this.sick && !this.death) this.lcd(out, time, this.skull, 0.9, 2.62, 0.14, opt);
      if (Math.min(this.hunger, this.happy) <= 1 && !this.death && blink) this.lcd(out, time, this.textBang, 2.3, 2.62, 0.12, opt);
    }

    // The play field.
    const petX = clamp(this.ctx.player.pos[0] * 0.75, -8.6, 8.6);
    const hop = clamp(this.ctx.player.pos[1] * 0.6, 0, 2);
    const petY = PET_FLOOR + 1.4 + hop;
    const moving = Math.abs(this.petVel) > 0.6;
    if (t < HATCH_AT) {
      const wob = t > EGG_AT ? Math.sin(t * lerp(6, 18, clamp((t - EGG_AT) / (HATCH_AT - EGG_AT), 0, 1))) * 0.3 : 0;
      this.lcd(out, time, t >= CRACK_AT ? this.eggCracked : this.egg, wob, PET_FLOOR + 1.4, 0.22);
      return;
    }
    if (this.death) {
      const d = this.death.t;
      const gx = clamp(petX, -7, 7);
      this.lcd(out, time, this.graveLcd, gx + 1.8, PET_FLOOR + 0.9, 0.2, opt);
      this.lcd(out, time, this.ghostLcd, gx - 1, PET_FLOOR + 1.3 + Math.min(1.5, d * 0.6) + Math.sin(d * 3) * 0.12, 0.2, opt);
      return;
    }
    if (this.foodMenu) {
      const m = this.foodMenu;
      this.lcd(out, time, this.textMeal, -0.6, 6.05, 0.16);
      this.lcd(out, time, this.textSnack, -0.3, 4.55, 0.16);
      this.lcd(out, time, this.burgerLcd, 3.6, 6.05, 0.16);
      this.lcd(out, time, this.candyLcd, 3.6, 4.55, 0.16);
      this.lcd(out, time, this.arrow, -3.9, m.choice === 0 ? 6.05 : 4.55, 0.13, { flip: true });
      return;
    }
    const night = this.night && this.light < 0.5;
    const adult = this.evolveT >= 0 && (this.evolveT >= 1.9 || Math.floor(this.evolveT * 8) % 2 === 1);
    let pet = moving && Math.floor(time * 5) % 2 ? this.petB : this.petA;
    if (!moving && Math.floor(time * 1.6) % 2) pet = this.petB;
    let dx = 0;
    if (adult) pet = this.petAdult;
    else if (night) pet = this.night!.asleep ? this.petSleep : this.petSad;
    else if (this.eatingT < 0.9) pet = Math.floor(this.eatingT * 7) % 2 ? this.petHappy : this.petA;
    else if (this.refuseT < 0.8) {
      pet = this.petA;
      dx = Math.sin(this.refuseT * 30) * 0.3;
    } else if (this.joyT < 1) pet = this.petHappy;
    else if (this.sick || Math.min(this.hunger, this.happy) <= 1) pet = this.petSad;
    const glowing = night ? { color: [0.3, 0.36, 0.25], glow: true } : opt;
    this.lcd(out, time, pet, petX + dx, adult ? petY + 0.3 : petY, PET_PIXEL, { ...glowing, flip: this.petFlip });
    if (this.sick) this.lcd(out, time, this.skull, petX + (this.petFlip ? -1.9 : 1.9), petY + 1.2, 0.14, opt);

    if (night) {
      this.lcd(out, time, this.moon, 8.2, 6.3, 0.2, { color: [0.35, 0.42, 0.3], glow: true });
      if (this.night!.asleep) {
        for (let i = 0; i < 3; i++) {
          const k = (time * 0.6 + i / 3) % 1;
          this.lcd(out, time, this.textZ, petX + 1.6 + k * 1.2, petY + 1.4 + k * 1.6, 0.08 + k * 0.08, { color: [0.35, 0.42, 0.3], glow: true });
        }
      }
    }
    // PLAY: the arrows, and which one Timmy picked.
    const pl = this.play;
    if (pl && pl.phase !== 'done') {
      const pickedOn = pl.phase === 'warn' ? Math.floor(pl.t * 8) % 2 === 0 : pl.phase !== 'intro' && pl.phase !== 'gap';
      for (const side of [-1, 1]) {
        const show = pl.phase === 'intro' || pl.phase === 'gap' || pl.side !== side || pickedOn;
        const big = pl.phase !== 'intro' && pl.phase !== 'gap' && pl.side === side;
        if (show) this.lcd(out, time, this.arrow, side * 7.4, 5.2, big ? 0.34 : 0.22, { flip: side > 0 });
      }
      if (pl.phase === 'intro' || pl.phase === 'gap') this.lcd(out, time, this.textQ, 0, 6.3, 0.14);
    } else if (pl && pl.phase === 'done' && pl.wins >= PLAY_ROUNDS) {
      this.lcd(out, time, this.textWin, 0, 6.35, 0.14);
    }
    // BATHROOM: poops, and the flush.
    for (const p of this.poops) {
      if (p.gone) continue;
      this.lcd(out, time, this.poopLcd, clamp(p.pos[0] * 0.75, -9.4, 9.4), PET_FLOOR + 0.4, 0.13, opt);
    }
    const w = this.wave;
    if (w) {
      const wx = clamp(w.x * 0.8, -9.6, 9.6);
      const rise = w.phase === 'build' ? w.t / WAVE_BUILD : w.phase === 'drain' ? 1 - w.t : 1;
      for (let k = 0; k < 3; k++) {
        if (k / 3 > rise) break;
        this.lcd(out, time, this.waveLcd, wx, PET_FLOOR + 0.45 + k * 1.05, 0.2, { flip: w.dir < 0 });
      }
    }
    // DISCIPLINE: NO!
    const sc = this.scold;
    if (sc && (sc.launched > 0 || Math.floor(sc.t * 6) % 2 === 0)) {
      for (let i = sc.launched; i < 3; i++) this.lcd(out, time, this.letterSprites[i], (i - 1) * 2.04, 5.3, 0.34, { color: PIX });
    }
    // MEDICINE.
    if (this.syringe && this.syringe.phase !== 'leave') this.lcd(out, time, this.syringeLcd, petX + (this.petFlip ? -3.6 : 3.6), petY, 0.16, { flip: !this.petFlip });
    // Dropped: the screen cracked.
    if (this.dropped && this.evolveT > 9.6) {
      const crack = (x: number, y: number, len: number, a: number) =>
        out.push({ mesh: 'box', model: mul(translation([x, y, LCD_Z + 0.03]), rotationZ(a), scaling([len, 0.06, 0.05])), color: PIX, shadow: false });
      crack(-3, 6.2, 5, 0.5);
      crack(-0.9, 7.1, 2.2, -0.9);
      crack(-5.2, 5.1, 2.6, -0.3);
      crack(1.2, 5.6, 3, 1.2);
    }
  }

  private drawFoods(out: DrawItem[], time: number) {
    for (const f of this.foods) {
      const k = f.eaten >= 0 ? clamp(1 - f.eaten / 0.5, 0, 1) : 1;
      if (k <= 0) continue;
      const bob = f.landed ? Math.sin(time * 2 + f.spin) * 0.08 : 0;
      const a = f.spin;
      const right: Vec3 = [Math.cos(a), 0, -Math.sin(a)];
      const normal: Vec3 = [Math.sin(a), 0, Math.cos(a)];
      const pos: Vec3 = [f.pos[0], f.pos[1] + bob, f.pos[2]];
      const hl = f.usable.highlight;
      if (f.kind === 'meal') {
        // Two crossed copies: a round voxel burger from any side.
        this.burger.draw(out, time, pos, right, U, normal, 0.15 * k, 0.75 * k, { lift: 0, highlight: hl });
        this.burger.draw(out, time, pos, normal, U, [-right[0], -right[1], -right[2]], 0.15 * k, 0.75 * k, { lift: 0, highlight: hl });
      }
      else {
        // A sweet faces you (wobbling), so you always see its stripes.
        const y = this.ctx.camera.yaw + Math.sin(time * 2.5 + f.spin) * 0.5;
        this.candy.draw(out, time, pos, [Math.cos(y), 0, -Math.sin(y)], U, [Math.sin(y), 0, Math.cos(y)], 0.14 * k, 0.9 * k, { lift: 0, highlight: hl });
      }
      // Its shadow (bigger and darker as it comes down).
      const hgt = f.pos[1];
      const r = f.landed ? 0.9 : clamp(1.6 - hgt * 0.05, 0.6, 1.6);
      out.push({ mesh: 'cylinder', model: mul(translation([f.pos[0], 0.02, f.pos[2]]), scaling([r, 0.01, r])), color: [0, 0, 0], pattern: Pattern.blob, param: f.landed ? 0.45 : clamp(0.9 - hgt * 0.03, 0.3, 0.9), shadow: false });
    }
  }

  private billboard(): { right: Vec3; normal: Vec3 } {
    const y = this.ctx.camera.yaw;
    return { right: [Math.cos(y), 0, -Math.sin(y)], normal: [Math.sin(y), 0, Math.cos(y)] };
  }

  private drawPoops(out: DrawItem[], time: number) {
    const { right, normal } = this.billboard();
    for (const p of this.poops) {
      if (p.gone) continue;
      const pop = p.age < 0.25 ? 1.2 * Math.sin((p.age / 0.25) * Math.PI * 0.5) : 1;
      const squash = p.squished ? 0.3 : 1;
      const px = 0.1 * pop;
      const tumble = p.carried ? time * 8 : 0;
      const up: Vec3 = p.carried ? [Math.sin(tumble), Math.cos(tumble), 0] : U;
      const r: Vec3 = p.carried ? [Math.cos(tumble), -Math.sin(tumble), 0] : right;
      const nrm: Vec3 = p.carried ? [0, 0, 1] : normal;
      const y = p.carried ? 0.5 : 0.5 * px * 10 * squash;
      this.poop.draw(out, time, [p.pos[0], y, p.pos[2]], r, up, nrm, px, 0.55 * pop, { lift: 0, sy: squash, sx: p.squished ? 1.5 : 1 });
      if (!p.squished && !p.carried) {
        for (let i = 0; i < 3; i++) {
          const k = (time * 0.5 + i / 3) % 1;
          const off = (i - 1) * 0.35;
          const pos: Vec3 = [p.pos[0] + right[0] * (off + Math.sin(time * 3 + i) * 0.08), 1.15 + k * 0.9, p.pos[2] + right[2] * (off + Math.sin(time * 3 + i) * 0.08)];
          if (k < 0.85) this.stink.draw(out, time, pos, right, U, normal, 0.07, 0.04, { lift: 0 });
        }
        // Two flies.
        for (let i = 0; i < 2; i++) {
          const a = time * (5 + i * 2) + i * 3;
          const fp: Vec3 = [p.pos[0] + Math.cos(a) * 0.6, 1.1 + Math.sin(a * 1.7) * 0.25, p.pos[2] + Math.sin(a) * 0.6];
          out.push({ mesh: 'sphere', model: mul(translation(fp), scaling([0.05, 0.05, 0.05])), color: [0.02, 0.02, 0.02], shadow: false });
        }
      }
    }
  }

  private drawWave(out: DrawItem[], time: number) {
    const w = this.wave;
    if (!w) return;
    const rise = w.phase === 'build' ? smooth(w.t / WAVE_BUILD) : w.phase === 'drain' ? 1 - smooth(w.t) : 1;
    const start = -w.dir * CHAMBER_HALF;
    // The crest.
    if (rise > 0.02) {
      this.waveCrest.draw(out, time, [w.x - w.dir * 0.2, (6 * 0.14 * rise) / 2, 0], R, U, N, 0.14, CHAMBER_HALF * 2 - 0.1, {
        flip: w.dir < 0, lift: 0, sy: rise,
      });
    }
    // The water left behind it.
    const len = Math.abs(w.x - start);
    if (len > 0.3) {
      const depth = 0.18 * rise;
      out.push({
        mesh: 'box', model: mul(translation([(start + w.x) / 2, depth / 2, 0]), scaling([len, depth, CHAMBER_HALF * 2 - 0.1])),
        color: [0.3, 0.6, 0.95], pattern: Pattern.lava, param: 3, opacity: 0.75, shadow: false,
      });
    }
  }

  private drawSlab(out: DrawItem[], time: number) {
    const pl = this.play;
    if (!pl || pl.phase === 'intro' || pl.phase === 'done' || pl.y > 23.5) return;
    const x = pl.x;
    const thick = 1.4;
    out.push({ mesh: 'box', model: mul(translation([x, pl.y + thick / 2, 0]), scaling([11.96, thick, 23.9])), color: [0.16, 0.19, 0.14], pattern: Pattern.panels, param: 1.2, spec: 0.3, shadow: false });
    // A big arrow on its underside, pointing at its side of the room.
    this.slabArrow.draw(out, time, [x, pl.y - 0.001, 0], R, [0, 0, -1], [0, 1, 0], 1.1, 0.06, { flip: x > 0, lift: -0.5 });
  }

  private drawNight(out: DrawItem[], time: number) {
    const n = this.night;
    if (!n || n.t > DARK_TIME + 0.5) return;
    const b = n.bed;
    const glow = 0.6 + 0.4 * Math.sin(time * 3);
    out.push({ mesh: 'bevelbox', model: mul(translation([b[0], 0.21, b[2]]), scaling([2.4, 0.42, 3.2])), color: [0.85, 0.9, 1.0], spec: 0.2 });
    out.push({ mesh: 'roundbox', model: mul(translation([b[0], 0.52, b[2] - 1.1]), scaling([1.8, 0.28, 0.75])), color: [1, 1, 1], spec: 0.2 });
    out.push({ mesh: 'bevelbox', model: mul(translation([b[0], 0.25, b[2] + 0.45]), scaling([2.5, 0.46, 2.1])), color: [0.35, 0.45, 0.95], spec: 0.3 });
    // A glowing outline so you can find it in the dark.
    const c = [0.5 * glow, 0.8 * glow, 1.6 * glow];
    const edge = (pos: Vec3, size: Vec3) => out.push({ mesh: 'box', model: mul(translation(pos), scaling(size)), color: c, pattern: Pattern.emissive, shadow: false });
    edge([b[0], 0.02, b[2] - 1.85], [3.1, 0.03, 0.12]);
    edge([b[0], 0.02, b[2] + 1.85], [3.1, 0.03, 0.12]);
    edge([b[0] - 1.5, 0.02, b[2]], [0.12, 0.03, 3.7]);
    edge([b[0] + 1.5, 0.02, b[2]], [0.12, 0.03, 3.7]);
    if (!n.asleep) {
      const { right, normal } = this.billboard();
      for (let i = 0; i < 3; i++) {
        const k = (time * 0.5 + i / 3) % 1;
        this.textZ.draw(out, time, [b[0] + right[0] * (k - 0.5), 1.4 + k * 1.6, b[2] + right[2] * (k - 0.5)], right, U, normal, 0.07 + k * 0.07, 0.05, { lift: 0 });
      }
    }
  }

  private drawLetters(out: DrawItem[], time: number) {
    for (const l of this.letters) {
      if (l.done) continue;
      const d = l.dir;
      const right: Vec3 = [d[2], 0, -d[0]];
      l.sprite.draw(out, time, l.pos, right, U, d, 0.34, 0.55, { lift: 0 });
    }
  }

  private drawSyringe(out: DrawItem[]) {
    const s = this.syringe;
    if (!s) return;
    // Drawn 1.35x: 4.9 m from thumb rest to needle tip (SYRINGE_TIP from its middle).
    const m = mul(translation(s.pos), rotationY(s.yaw), scaling([1.35, 1.35, 1.35]));
    const along = (z: number, len: number, r: number, color: number[], extra: Partial<DrawItem> = {}) =>
      out.push({ mesh: 'cylinder', model: mul(m, translation([0, 0, z]), rotationX(Math.PI / 2), scaling([r, len, r])), color, spec: 0.8, ...extra });
    const plunge = s.plunge * 1.2;
    along(0.4, 2.6, 0.45, [0.8, 0.9, 1], { opacity: 0.6 });
    along(0.4 + plunge / 2, 2.3 - plunge, 0.36, [0.3, 1.4, 0.45], { pattern: Pattern.emissive, shadow: false });
    along(1.75, 0.14, 0.75, [0.95, 0.22, 0.28]);
    along(2.35 - plunge, 1.1, 0.1, [0.9, 0.9, 0.95]);
    along(2.92 - plunge, 0.1, 0.45, [0.95, 0.3, 0.35]);
    along(-0.33 - plunge * 0, 0.12, 0.34, [0.95, 0.3, 0.35]);
    out.push({ mesh: 'cone', model: mul(m, translation([0, 0, -1.02]), rotationX(-Math.PI / 2), scaling([0.22, 0.4, 0.22])), color: [0.85, 0.92, 1], spec: 0.8 });
    along(-1.85, 1.5, 0.05, [0.8, 0.82, 0.86]);
  }

  private drawPlayerExtras(out: DrawItem[], time: number) {
    const { player } = this.ctx;
    if (player.mode === 'hidden') return;
    // Sick: a little green skull over your head.
    if (this.sick && !this.death) {
      const { right, normal } = this.billboard();
      this.skullWorld.draw(out, time, add(player.pos, [0, 2.3 + Math.sin(time * 3) * 0.06, 0]), right, U, normal, 0.05, 0.05, { lift: 0 });
    }
    // Asleep: z's.
    if (this.night?.asleep) {
      const { right, normal } = this.billboard();
      for (let i = 0; i < 3; i++) {
        const k = (time * 0.6 + i / 3) % 1;
        this.textZ.draw(out, time, add(player.pos, [right[0] * (0.3 + k * 0.5), 1.8 + k * 1.3, right[2] * (0.3 + k * 0.5)]), right, U, normal, 0.04 + k * 0.05, 0.03, { lift: 0 });
      }
    }
    // Evolved: a fine moustache.
    if (this.evolveT >= 1.9) {
      const head = player.partFrames().head;
      for (const side of [-1, 1]) {
        out.push({ mesh: 'roundbox', model: mul(head, translation([0.055 * side, -0.075, -0.2]), rotationZ(0.35 * side), scaling([0.12, 0.04, 0.05])), color: [0.18, 0.1, 0.05] });
      }
    }
  }

  private drawDeath(out: DrawItem[], time: number) {
    const d = this.death;
    if (!d || !d.from) return;
    const t = d.t - 0.7;
    // A gravestone rises out of the floor next to you...
    const g = smooth(t / 0.6);
    const toCam = normalize([this.ctx.camera.pos[0] - d.from[0], 0, this.ctx.camera.pos[2] - d.from[2]]);
    const side: Vec3 = [toCam[2], 0, -toCam[0]];
    let gp: Vec3 = add(d.from, scale(side, 1.4));
    gp = [clamp(gp[0], -11, 11), 0, clamp(gp[2], -11, 11)];
    const yaw = Math.atan2(toCam[0], toCam[2]);
    const gm = mul(translation([gp[0], -1.8 + 1.8 * g, gp[2]]), rotationY(yaw));
    out.push({ mesh: 'roundbox', model: mul(gm, translation([0, 0.85, 0]), scaling([1.3, 1.7, 0.35])), color: [0.55, 0.56, 0.6], spec: 0.2 });
    out.push({ mesh: 'box', model: mul(gm, translation([0, 0.05, 0]), scaling([1.6, 0.14, 0.6])), color: [0.45, 0.46, 0.5] });
    const face: Vec3 = [gp[0] + toCam[0] * 0.18, -1.8 + 1.8 * g + 1.2, gp[2] + toCam[2] * 0.18];
    this.textRip.draw(out, time, face, [Math.cos(yaw), 0, -Math.sin(yaw)], U, [Math.sin(yaw), 0, Math.cos(yaw)], 0.07, 0.04);
    // ...and your ghost floats up out of your body, halo and all.
    if (t < 0.2) return;
    const rise = (t - 0.2) * 0.9;
    const fade = clamp((t - 0.2) / 0.8, 0, 1);
    const root: Mat4 = mul(translation([d.from[0], d.from[1] + 0.2 + rise, d.from[2]]), rotationY(d.facing + Math.sin(time * 1.3) * 0.2));
    const pose: Pose = {
      lean: 0.05, headPitch: 0.15, shoulderL: 0.4 + Math.sin(time * 2) * 0.2, shoulderR: 0.4 - Math.sin(time * 2) * 0.2, armOut: 0.7,
      elbowL: 0.4, elbowR: 0.4, hipL: 0.15, hipR: 0.05, kneeL: -0.35, kneeR: -0.2,
    };
    const frames = poseFrames(root, pose);
    const first = out.length;
    drawBody(out, frames, 1, GHOST_COLORS);
    for (let i = first; i < out.length; i++) {
      out[i].opacity = 0.6 * fade;
      out[i].pattern = Pattern.emissive;
      out[i].shadow = false;
    }
    const head = frames.head;
    out.push({ mesh: 'tube', model: mul(head, translation([0, 0.36, 0]), scaling([0.24, 0.04, 0.24])), color: [2.2, 1.9, 0.6], pattern: Pattern.emissive, opacity: fade, shadow: false });
    const chest = frames.chest;
    for (const s of [-1, 1]) {
      const flap = Math.sin(time * 6) * 0.35;
      out.push({ mesh: 'sphere', model: mul(chest, translation([0.3 * s, 0.12, 0.22]), rotationY(0.5 * s), rotationZ((0.6 + flap) * s), translation([0.3 * s, 0, 0]), scaling([0.4, 0.16, 0.05])), color: [1.8, 1.8, 1.9], pattern: Pattern.emissive, opacity: 0.55 * fade, shadow: false });
    }
  }

  // --- The rest of the Level interface -----------------------------------------------------------------

  labels(): WorldLabel[] {
    const list = this.labelList;
    list.length = 0;
    if (this.peekT >= 0 && this.peekT > 0.6 && this.timmyLine.text && this.peekT < this.peekDur - 0.5) list.push(this.timmyLine);
    if (this.t >= EGG_AT && this.light > 0.5) for (const l of this.iconLabels) list.push(l);
    for (const p of this.popups) list.push(p.label);
    return list;
  }

  trackedTargets(): TrackedTarget[] {
    const list = this.targets;
    list.length = 0;
    const exit = this.exit.target();
    if (exit) list.push(exit);
    if (this.death) return list;
    for (const f of this.foods) if (f.landed && f.eaten < 0) list.push({ pos: [f.pos[0], f.pos[1], f.pos[2]], radius: 1, color: 'purple' });
    const s = this.syringe;
    if (s && s.phase === 'chase') {
      this.syringeTarget.pos = s.pos;
      list.push(this.syringeTarget);
    }
    for (const l of this.letters) if (l.sliding && !l.done && !l.hit) list.push({ pos: l.pos, radius: 1.2 });
    return list;
  }

  environment(): Environment {
    const e = this.env;
    const l = this.light;
    let flash = 1;
    if (this.evolveT >= 0 && this.evolveT < 1.9) flash = 1 + 0.8 * (Math.floor(this.evolveT * 6) % 2);
    const pink = this.t < 0 ? 0 : smooth(this.t / FLOOD_TIME);
    e.sunColor = [1.7 * l * flash, 1.62 * l * flash, 1.55 * l * flash];
    const sky = lerp(1, 0.035, 1 - l);
    e.skyColor = [lerp(0.2, 0.34, pink) * sky, lerp(0.3, 0.3, pink) * sky, lerp(0.5, 0.46, pink) * sky];
    e.groundColor = [lerp(0.22, 0.3, pink) * sky, lerp(0.2, 0.22, pink) * sky, lerp(0.18, 0.26, pink) * sky];
    e.fogColor = [lerp(0.72, 0.9, pink) * sky, lerp(0.8, 0.76, pink) * sky, lerp(0.9, 0.86, pink) * sky];
    e.fogDensity = 0.002;
    const n = this.night;
    e.pointLight = n && l < 0.9 ? { pos: [n.bed[0], 2.2, n.bed[2]], color: [0.6, 0.8, 1.6], range: 9 } : undefined;
    return e;
  }

  obstacles() {
    return [];
  }

  cameraShot(): CameraShot | null {
    return this.arrival.cameraShot();
  }
}
