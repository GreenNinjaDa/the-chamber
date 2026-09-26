import { noise, note, tone } from '../../engine/audio';
import { add, basis, clamp, mul, scale, scaling, translation, type Vec3 } from '../../engine/math';
import { RAPIER, type Body, type RayHit } from '../../engine/physics';
import { Pattern, type DrawItem, type Environment } from '../../engine/renderer';
import { CHAMBER_HALF } from '../../game/chamber';
import { DUCK_BACK, DUCK_HALF, GiantDuck } from '../../entities/giantDuck';
import { junk, spawnJunk } from '../../entities/junk';
import {
  armchair, beanbag, COFFEE_TABLE, drawPainting, drawRug, FLOOR_LAMP, PIANO_BENCH, sofa, spawnFurniture, type FurnitureDef,
} from '../../entities/livingRoom';
import { ExitPortal, PortalArrival } from '../../entities/portal';
import { DEFAULT_ENV, type CameraShot, type Level, type LevelContext, type LevelStatus, type TrackedTarget, type WorldLabel } from '../level';

/*
 * The Floor Is Lava: the kids' game, taken literally. A living room full of furniture, and a host
 * on the wall screens announcing rules, each with a 3-2-1 countdown: the floor is lava, then the
 * couches, then the floor and the crates, everything blue, whatever you're standing on, lava that
 * rises... Whatever is lava visibly turns to lava (it heats up during the countdown), and touching
 * it for more than a moment burns you. The finale: everything is lava except a giant rubber duck
 * that drops out of the sky, which then turns out to be a boat, and sails you to the exit.
 *
 * `?lavaStep=N` starts at step N of the script (0 = the intro, 8 = the duck).
 */

const SPAWN: Vec3 = [0, 0, 6];
/** The exit: in the east wall, low enough to step into from the duck's back once it docks. */
const EXIT_Z = 4;
const EXIT_FLOOR = 0.9;
/** Countdown before a rule takes effect (s). */
const COUNT = 3;
const FINALE_COUNT = 5;
const RISING_COUNT = 5;
/** Touching lava for this long (in total, since last standing somewhere safe) burns you. */
const GRACE = 0.25;
/** Every new touch costs at least this much of the grace, so hopping across lava only goes so far. */
const TOUCH_MIN = 0.05;
/** Standing somewhere safe cools you back down at this rate (grace-seconds per second). */
const COOL_RATE = 2;
const DEATH_SCREEN_DELAY = 1.9;

/** Floor tiles (the chamber's 2 m panels) turn to lava in a ripple spreading at this speed (m/s). */
const TILE = 2;
const TILES = (CHAMBER_HALF * 2) / TILE;
const RIPPLE_SPEED = 45;
const TILE_GROW = 0.12;
/** The rising lava: its height, and how long it rises, holds and drains (s). */
const HIGH_TIDE = 1.0;
const RISE_TIME = 5.5;
const HOLD_TIME = 2.5;
const DRAIN_TIME = 2.5;
/** The finale: the lava rises this high and the duck floats with this much of it under water. */
const FINALE_TIDE = 0.55;
const DUCK_DRAFT = 0.25;
const DUCK_DROP_AT = 0.9;
const DUCK_DROP_HEIGHT = 18;
const DUCK_GRAVITY = 22;
const SAIL_SPEED = 2.4;
/**
 * Where the duck may land (clear spots in the room, all a good sail from the exit); it picks the
 * nearest one that isn't too near you.
 */
const DUCK_SPOTS: [number, number][] = [[-2.5, 7.4], [-6.3, -6.8], [2.8, -8.1]];
const DOCK: Vec3 = [CHAMBER_HALF - DUCK_HALF[0] - 0.06, 0, EXIT_Z];

/** The rug in the middle of the room (it's floor, obviously). */
const RUG_CENTRE: Vec3 = [0, 0, 0.1];
const RUG_SIZE: [number, number] = [6.4, 4.4];

/** Wall screens: width, height, centre height. */
const SCREEN_W = 9;
const SCREEN_H = 4.3;
const SCREEN_Y = 5.8;

const HOT = [1, 0.3, 0.06];
const CRUST = [0.08, 0.035, 0.02];
const FLOOR = [0.6, 0.61, 0.63];

const RED_FABRIC = [0.55, 0.08, 0.06];
const BLUE_FABRIC = [0.1, 0.25, 0.72];
const MUSTARD_FABRIC = [0.78, 0.56, 0.1];
const ORANGE_FABRIC = [0.95, 0.42, 0.08];

const CONTROLS = 'WASD move · Space jump · Shift sprint · Hold left click drag/carry · Right-click throw';
const HINT = "When something is lava, don't touch it. Get onto something that isn't before the countdown ends. You can drag light furniture to make a path.";

type Kind =
  | 'sofa' | 'armchair' | 'table' | 'crate' | 'piano' | 'bench' | 'fridge' | 'washer' | 'bathtub' | 'mattress'
  | 'pillow' | 'beanbag' | 'bookcase' | 'lamp' | 'plant';

interface Item {
  kind: Kind;
  blue: boolean;
  body: Body;
  colliders: RAPIER.Collider[];
  surface: Surface;
  /** Picked by the current rule (heats up during the countdown). */
  doomed: boolean;
  molten: boolean;
  /** 0-1: heating up, shown during the countdown. */
  warn: number;
  /** 1 → 0: cooling down from lava (a dark crust fading back to its colours). */
  cool: number;
  /** The finale: seconds since it started sinking into the lava (-1: not sinking). */
  sinkT: number;
}

type SurfaceKind = 'floor' | 'rug' | 'item' | 'duck' | 'tide' | 'other';
interface Surface {
  kind: SurfaceKind;
  item?: Item;
}

type Cause = 'floor' | 'rug' | 'sofa' | 'crate' | 'blue' | 'underfoot' | 'rising' | 'duck' | 'overboard' | 'squashed';

const DEATHS: Record<Cause, { big: string; small: string[]; hint: string }> = {
  floor: {
    big: 'YOU TOUCHED THE FLOOR',
    small: ['The floor was lava. It said so. On every wall.', 'You had one job, and the job was "not the floor".', "That's the rules. I don't make them. Well, I do."],
    hint: HINT,
  },
  rug: {
    big: 'THE RUG IS FLOOR',
    small: ['That rug really tied the room together. Now it has tied you to the floor.', 'A rug is just floor wearing a hat.'],
    hint: HINT,
  },
  sofa: {
    big: 'THE COUCH WAS LAVA',
    small: ['Couch potato: fully baked.', 'Very comfy, though. For about a quarter of a second.'],
    hint: HINT,
  },
  crate: {
    big: 'THE CRATES WERE LAVA',
    small: ["Wood you believe it? They're lava.", 'It said crates. That was a crate. Crate choice.'],
    hint: HINT,
  },
  blue: {
    big: 'THAT WAS BLUE',
    small: ['Feeling blue? Not any more. Feeling crispy.', 'Everything blue. It was the bluest thing in the room.'],
    hint: HINT,
  },
  underfoot: {
    big: 'YOU WERE STANDING ON IT',
    small: ["Whatever you're standing on. You were standing on it. That's how that works."],
    hint: "When it says \"whatever you're standing on\", that thing turns to lava: get off it and onto something else before the countdown ends.",
  },
  rising: {
    big: 'IT SAID RISING',
    small: ["It's over. The lava has the high ground.", "The lava was rising. You weren't."],
    hint: 'When the lava rises, climb: the piano (hop on the bench first), the fridge (from the washing machine), or the stacked crates in the south corners.',
  },
  duck: {
    big: 'YOU ARE NOT THE DUCK',
    small: ['Everything was lava except the duck. You were not on the duck.', 'Nobody puts Duck in a corner. You should have been on it, though.'],
    hint: 'Everything means everything: get on the duck (jump onto its back) before the countdown ends, and stay on it.',
  },
  overboard: {
    big: 'MAN OVERBOARD',
    small: ['The duck was a boat. You were supposed to stay in the boat.', 'Please keep your arms, legs and everything else inside the duck at all times.'],
    hint: 'Stay on the duck until it docks by the exit, then walk (or jump) into the portal.',
  },
  squashed: {
    big: 'QUACKED',
    small: ['Squashed by a rubber duck. Squeak in peace.'],
    hint: "Don't stand where a giant duck is about to land. Watch for its shadow.",
  },
};

type Step =
  | { kind: 'say'; line1: string; line2: string; time: number }
  | {
    kind: 'rule';
    header: string;
    line1: string;
    line2: string;
    floor: boolean;
    items?: (it: Item) => boolean;
    underfoot?: boolean;
    active: number;
    after: [string, string];
    afterTime: number;
    /** What killed you if an item burnt you in this rule. */
    cause?: Cause;
  }
  | { kind: 'fake'; header: string; line1: string; line2: string; reveal: [string, string]; revealTime: number }
  | { kind: 'rising'; header: string; line1: string; line2: string; after: [string, string]; afterTime: number }
  | { kind: 'finale' };

const SCRIPT: Step[] = [
  { kind: 'say', line1: 'OK. NEW GAME.', line2: "I MADE IT UP. IT'S THE BEST GAME.", time: 3 },
  {
    kind: 'rule', header: 'RULE #1', line1: 'THE FLOOR IS LAVA!', line2: '', floor: true, active: 6,
    after: ['OK. THE FLOOR IS NOT LAVA.', "GO ON, TOUCH IT. IT'S FINE."], afterTime: 2.4,
  },
  {
    kind: 'rule', header: 'RULE #2', line1: 'THE COUCHES ARE LAVA!', line2: 'ARMCHAIRS ARE NOT COUCHES. RELAX.', floor: false,
    items: (it) => it.kind === 'sofa', cause: 'sofa', active: 4.5, after: ['COUCHES ARE COUCHES AGAIN.', 'SIT ON THEM. I DARE YOU.'], afterTime: 2.2,
  },
  {
    kind: 'rule', header: 'RULE #3', line1: 'THE FLOOR IS LAVA AGAIN.', line2: 'SO ARE THE CRATES.', floor: true,
    items: (it) => it.kind === 'crate', cause: 'crate', active: 6, after: ['BREAK TIME.', 'NOTHING IS LAVA. FOR NOW.'], afterTime: 2.2,
  },
  {
    kind: 'fake', header: 'RULE #4', line1: 'THE CEILING IS LAVA!', line2: '',
    reveal: ["...WE DON'T HAVE A CEILING.", "YOU'RE FINE. WHY ARE YOU DUCKING?"], revealTime: 2.8,
  },
  {
    kind: 'rule', header: 'RULE #5', line1: 'EVERYTHING BLUE IS LAVA.', line2: 'AND THE FLOOR. OBVIOUSLY.', floor: true,
    items: (it) => it.blue, cause: 'blue', active: 6, after: ['BLUE IS BACK.', 'I LIKE BLUE AGAIN.'], afterTime: 2.2,
  },
  {
    kind: 'rule', header: 'RULE #6', line1: 'THE FLOOR IS LAVA.', line2: "SO IS WHATEVER YOU'RE STANDING ON.", floor: true,
    underfoot: true, cause: 'underfoot', active: 5.5, after: ['NICE MOVES.', "I WAS HOPING YOU'D FALL IN."], afterTime: 2.2,
  },
  { kind: 'rising', header: 'RULE #7', line1: 'THE FLOOR IS LAVA', line2: "AND IT'S RISING.", after: ["OK. IT'S GOING DOWN.", "IT'S GOING DOWN. STILL LAVA, THOUGH."], afterTime: 0 },
  { kind: 'finale' },
];

const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
const smooth = (x: number) => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };
const mix = (a: ArrayLike<number>, b: ArrayLike<number>, t: number) =>
  [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

interface Death {
  t: number;
  big: string;
  small: string;
  hint: string;
}

interface Screen {
  pos: Vec3;
  normal: Vec3;
  header: WorldLabel;
  line1: WorldLabel;
  line2: WorldLabel;
  count: WorldLabel;
}

/** A spark or a puff of smoke. */
interface Particle {
  pos: Vec3;
  vel: Vec3;
  age: number;
  life: number;
  size: number;
  smoke: boolean;
  dark: number;
}

const PARTICLES = 220;
const EMBERS_PER_SECOND = 45;
const DOWN: Vec3 = [0, -1, 0];
/** Where the feet rays start around the player's feet (the capsule is 0.35 m in radius). */
const FEET: [number, number][] = [[0, 0], [0.28, 0], [-0.28, 0], [0, 0.28], [0, -0.28], [0.2, 0.2], [-0.2, 0.2], [0.2, -0.2], [-0.2, -0.2]];

const FLOOR_SURFACE: Surface = { kind: 'floor' };
const RUG_SURFACE: Surface = { kind: 'rug' };
const DUCK_SURFACE: Surface = { kind: 'duck' };
const TIDE_SURFACE: Surface = { kind: 'tide' };
const OTHER_SURFACE: Surface = { kind: 'other' };

export class FloorLavaLevel implements Level {
  readonly number: number;
  readonly title = 'The Floor Is Lava';
  status: LevelStatus = 'playing';
  private arrival: PortalArrival;
  private exit = new ExitPortal(EXIT_Z, EXIT_FLOOR);
  private env: Environment = { ...DEFAULT_ENV };
  private time = 0;

  private items: Item[] = [];
  private byCollider = new Map<number, Item>();
  private duck: GiantDuck;

  // The script.
  private index = -1;
  private stepT = 0;
  private started = false;
  /** Whatever you were standing on when "whatever you're standing on" was announced. */
  private underfootItem: Item | null = null;

  // The floor: warming up, lava (and since when, for the ripple), cooling.
  private floorWarn = 0;
  /** Blink cycles so far: things about to turn to lava blink faster as the countdown runs out. */
  private blinkT = 0;
  private floorMolten = false;
  private floorT = 0;
  private floorCool = 0;
  private ripple: [number, number] = [0, 0];
  /** Lava height over the floor (rising lava and the finale). */
  private tide = 0;
  private heat = 0;

  // The player's feet.
  private standing: Surface | null = null;
  private lastStanding: Surface | null = null;
  private contact = 0;
  private wasTouching = false;
  private boarded = false;
  private death: Death | null = null;
  private burning = -1;
  private shownHeader = '';

  // The finale.
  private duckSpot: Vec3 = [0, 0, 0];
  private duckLandT = -1;
  private moltenT = -1;
  private sailing = false;
  private exitShown = false;
  private sailVel: Vec3 = [0, 0, 0];

  private screens: Screen[] = [];
  private labelList: WorldLabel[] = [];
  private tags: (WorldLabel & { ttl: number })[] = [];
  private particles: Particle[] = [];
  private nextParticle = 0;
  /** Embers owed to the lava floor (fractions carry over between frames). */
  private emberDue = 0;
  private countShown = -1;

  constructor(private ctx: LevelContext) {
    const { physics, hud } = ctx;
    this.number = ctx.number;
    hud.setLevel(`The Chamber · Level ${this.number}`);
    hud.show(`LEVEL ${this.number}`, '', 2.5);
    hud.hint('');
    this.arrival = new PortalArrival(ctx, SPAWN);

    // The living room.
    this.addFurniture(sofa(RED_FABRIC), 'sofa', 0, -3.4, Math.PI);
    this.addFurniture(sofa(BLUE_FABRIC), 'sofa', -4.7, 0.2, -Math.PI / 2, true);
    this.addFurniture(armchair(BLUE_FABRIC), 'armchair', 4.3, 0.9, Math.PI / 2, true);
    this.addFurniture(armchair(MUSTARD_FABRIC), 'armchair', 3.9, -2.7, 2.3);
    this.addFurniture(COFFEE_TABLE, 'table', 0, 0.1, 0.05);
    this.addFurniture(beanbag(BLUE_FABRIC), 'beanbag', -2.7, 3.9, 0, true);
    this.addFurniture(beanbag(ORANGE_FABRIC), 'beanbag', 7.6, 7.3, 0);
    this.addFurniture(PIANO_BENCH, 'bench', -6.5, 10.4, 0);
    this.addJunk('piano', 'piano', -6.5, 11.35, 0);
    this.addJunk('fridge', 'fridge', 10.95, -11.2, Math.PI);
    this.addJunk('washing machine', 'washer', 9.85, -11.25, Math.PI);
    this.addJunk('bathtub', 'bathtub', 11.05, -7.9, Math.PI / 2);
    this.addJunk('mattress', 'mattress', -9.9, -10.2, 0.08);
    this.addJunk('bookcase', 'bookcase', -11.72, -5.2, -Math.PI / 2);
    this.addFurniture(FLOOR_LAMP, 'lamp', -5.25, -1.6, 0);
    this.addJunk('potted plant', 'plant', -11.3, -8.0, 0.4);
    this.addJunk('potted plant', 'plant', 7.3, -11.3, 2);
    // Crates: stairs up to a double stack in each south corner, and a couple lying around.
    for (const [x, z, y] of [[-11.1, 11.1, 0], [-11.1, 11.1, 1], [-11.1, 10.0, 0], [-10.0, 11.1, 0], [11.1, 11.1, 0], [11.1, 11.1, 1], [10.0, 11.1, 0], [6.8, -5.9, 0], [-7.8, -2.9, 0]]) {
      this.addJunk('crate', 'crate', x, z, (Math.random() - 0.5) * (y ? 0.3 : 0.2), 0.4 + y * 0.8);
    }
    // Pillows: on the sofas, the mattress and the floor.
    for (const [x, y, z] of [[-0.6, 0.62, -3.35], [0.7, 0.62, -3.3], [-4.7, 0.62, 0.8], [-10.2, 0.35, -10.6], [1.9, 0.1, 3.4]]) {
      this.addJunk('pillow', 'pillow', x, z, Math.random() * Math.PI, y);
    }

    // The duck waits out of sight until the finale.
    this.duck = new GiantDuck(physics, [0, -30, 0], 0);
    this.duck.visible = false;
    this.duck.setSolid(false);

    // A screen on every wall (the east one clear of the exit), so one is always in view.
    const wall = CHAMBER_HALF - 0.16;
    const faces: [Vec3, Vec3][] = [
      [[0, SCREEN_Y, -wall], [0, 0, 1]],
      [[0, SCREEN_Y, wall], [0, 0, -1]],
      [[-wall, SCREEN_Y, 0], [1, 0, 0]],
      [[wall, SCREEN_Y, -5], [-1, 0, 0]],
    ];
    for (const [pos, normal] of faces) {
      const at = (y: number): Vec3 => add([pos[0], y, pos[2]], scale(normal, 0.25));
      const screen: Screen = {
        pos,
        normal,
        header: { pos: at(SCREEN_Y + 1.5), text: '', size: 0.42, color: '#8fd8ff' },
        line1: { pos: at(SCREEN_Y + 0.62), text: '', size: 0.9, color: '#ffd166' },
        line2: { pos: at(SCREEN_Y - 0.3), text: '', size: 0.5, color: '#ffffff' },
        count: { pos: at(SCREEN_Y - 1.35), text: '', size: 1.05, color: '#ff7a3d' },
      };
      this.screens.push(screen);
    }

    for (let i = 0; i < PARTICLES; i++) this.particles.push({ pos: [0, 0, 0], vel: [0, 0, 0], age: 1, life: 0, size: 0, smoke: false, dark: 0 });

    const skip = Number(new URLSearchParams(location.search).get('lavaStep'));
    if (skip > 0) this.index = Math.min(SCRIPT.length - 1, skip) - 1;
  }

  // --- Setting up -------------------------------------------------------------------------------

  private register(kind: Kind, body: Body, colliders: RAPIER.Collider[], blue: boolean) {
    const item: Item = { kind, blue, body, colliders, surface: null!, doomed: false, molten: false, warn: 0, cool: 0, sinkT: -1 };
    item.surface = { kind: 'item', item };
    for (const c of colliders) this.byCollider.set(c.handle, item);
    // Draw it as it normally looks, heating up, as lava, or cooling down.
    const model = body.model!;
    body.model = (out, m) => {
      const first = out.length;
      model(out, m);
      this.styleItem(item, out, first);
    };
    this.items.push(item);
    return item;
  }

  private addFurniture(def: FurnitureDef, kind: Kind, x: number, z: number, yaw: number, blue = false) {
    const { body, colliders } = spawnFurniture(this.ctx.physics, def, x, z, yaw);
    return this.register(kind, body, colliders, blue);
  }

  private addJunk(name: string, kind: Kind, x: number, z: number, yaw: number, y?: number) {
    const def = junk(name);
    const body = spawnJunk(this.ctx.physics, def, [x, (y ?? def.size[1] / 2) + 0.01, z], { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) });
    return this.register(kind, body, [body.collider], false);
  }

  private styleItem(item: Item, out: DrawItem[], first: number) {
    if (item.molten || item.sinkT >= 0) {
      for (let i = first; i < out.length; i++) {
        out[i].pattern = Pattern.lava;
        out[i].param = 2;
      }
    } else if (item.cool > 0) {
      const k = item.cool;
      for (let i = first; i < out.length; i++) out[i].color = mix(out[i].color, CRUST, k);
    } else if (item.warn > 0) {
      // Heating up: blinking molten, faster and longer as the countdown runs out.
      if (this.blink(item.warn)) {
        for (let i = first; i < out.length; i++) {
          out[i].pattern = Pattern.lava;
          out[i].param = 2;
        }
      } else {
        const k = item.warn * 0.45;
        for (let i = first; i < out.length; i++) out[i].color = mix(out[i].color, HOT, k);
      }
    }
  }

  /** During a countdown, whether things about to turn to lava show as lava right now (they blink). */
  private blink(warn: number) {
    return warn > 0.02 && this.blinkT % 1 < 0.3 + warn * 0.45;
  }

  // --- Screens ----------------------------------------------------------------------------------

  private show(header: string, line1: string, line2: string) {
    if (header && header !== this.shownHeader) ['C5', 'E5', 'G5'].forEach((m, k) => tone(note(m), 0.14, { wave: 'triangle', vol: 0.14, at: k * 0.08 }));
    this.shownHeader = header;
    const fit = (text: string, max: number) => Math.min(max, (SCREEN_W - 0.8) / (0.74 * Math.max(1, text.length)));
    for (const s of this.screens) {
      s.header.text = header;
      s.line1.text = line1;
      s.line2.text = line2;
      s.count.text = '';
      s.line1.size = fit(line1, 0.95);
      s.line2.size = fit(line2, 0.55);
    }
    this.countShown = -1;
  }

  /** Shows `n` on the screens (and big on the HUD, with the rule under it) when it changes. */
  private countdown(n: number, rule: string) {
    if (n === this.countShown) return;
    this.countShown = n;
    for (const s of this.screens) s.count.text = n > 0 ? `${n}` : '';
    if (n > 0) this.ctx.hud.show(`${n}`, rule, 1.05);
    // Beep, beep, beep... and the hiss as it turns.
    if (n > 0) tone(n === 1 ? 990 : 660, 0.15, { wave: 'square', vol: 0.12 });
    else noise(0.9, { freq: 900, to: 250, vol: 0.3 });
  }

  // --- The script -------------------------------------------------------------------------------

  private get step(): Step | undefined {
    return SCRIPT[this.index];
  }

  private begin(i: number) {
    this.index = i;
    this.stepT = 0;
    const step = SCRIPT[i];
    if (!step) return;
    switch (step.kind) {
      case 'say':
        this.show('', step.line1, step.line2);
        break;
      case 'rule': {
        this.underfootItem = step.underfoot ? (this.standing ?? this.lastStanding)?.item ?? null : null;
        const onFloor = step.underfoot && !this.underfootItem;
        this.show(step.header, step.line1, onFloor ? "SO IS WHATEVER YOU'RE ON. WHICH IS THE FLOOR." : step.line2);
        for (const it of this.items) it.doomed = (step.items?.(it) ?? false) || it === this.underfootItem;
        break;
      }
      case 'fake':
      case 'rising':
        this.show(step.header, step.line1, step.line2);
        break;
      case 'finale':
        this.show('RULE #8', 'EVERYTHING IS LAVA', 'EXCEPT...');
        this.duckSpot = this.pickDuckSpot();
        break;
    }
  }

  /** Crossed time `t` (s into the current step) this frame. */
  private at(t: number, dt: number) {
    return this.stepT >= t && this.stepT - dt < t;
  }

  private script(dt: number) {
    if (!this.started) {
      this.started = true;
      this.begin(this.index + 1);
      return;
    }
    const step = this.step;
    if (!step) return;
    this.stepT += dt;
    const t = this.stepT;
    const hud = this.ctx.hud;
    // The rule as it reads on the screens, for under the countdown on the HUD.
    const rule = () => {
      const s = this.screens[0];
      return s.line2.text ? `${s.line1.text} ${s.line2.text}` : s.line1.text;
    };
    switch (step.kind) {
      case 'say':
        if (t >= step.time) this.begin(this.index + 1);
        break;
      case 'rule': {
        const end = COUNT + step.active;
        if (t < COUNT) {
          this.countdown(Math.ceil(COUNT - t), rule());
          const w = t / COUNT;
          if (step.floor) this.floorWarn = w;
          for (const it of this.items) if (it.doomed) it.warn = w;
        }
        if (this.at(COUNT, dt)) {
          this.countdown(0, '');
          hud.show('LAVA!', '', 0.8);
          if (step.floor) this.meltFloor();
          for (const it of this.items) if (it.doomed) this.melt(it);
        }
        if (this.at(end, dt)) {
          this.show('', step.after[0], step.after[1]);
          if (step.floor) this.coolFloor();
          for (const it of this.items) if (it.molten) this.solidify(it);
        }
        if (t >= end + step.afterTime) this.begin(this.index + 1);
        break;
      }
      case 'fake':
        if (t < COUNT) this.countdown(Math.ceil(COUNT - t), rule());
        if (this.at(COUNT, dt)) {
          this.countdown(0, '');
          hud.show('...', '', 1);
        }
        if (this.at(COUNT + 0.9, dt)) this.show('', step.reveal[0], step.reveal[1]);
        if (t >= COUNT + 0.9 + step.revealTime) this.begin(this.index + 1);
        break;
      case 'rising': {
        // A longer count: the high ground is all in the corners.
        const count = RISING_COUNT;
        const drainAt = count + RISE_TIME + HOLD_TIME, end = drainAt + DRAIN_TIME;
        if (t < count) {
          this.countdown(Math.ceil(count - t), rule());
          this.floorWarn = t / count;
        }
        if (this.at(count, dt)) {
          this.countdown(0, '');
          hud.show('LAVA!', '', 0.8);
          this.meltFloor();
        }
        if (t >= count) {
          const rise = smooth((t - count) / RISE_TIME), drain = smooth((t - drainAt) / DRAIN_TIME);
          this.tide = HIGH_TIDE * rise * (1 - drain);
        }
        if (this.at(drainAt, dt)) this.show('', step.after[0], step.after[1]);
        if (this.at(end, dt)) {
          this.tide = 0;
          this.coolFloor();
          this.show('', 'OK. NOTHING IS LAVA.', 'CATCH YOUR BREATH. YOU WILL NEED IT.');
        }
        if (t >= end + 2.2) this.begin(this.index + 1);
        break;
      }
      case 'finale':
        this.finale(dt);
        break;
    }
  }

  private meltFloor() {
    this.floorMolten = true;
    this.floorT = 0;
    this.floorWarn = 0;
    this.floorCool = 0;
    this.ripple = [(Math.random() - 0.5) * 16, (Math.random() - 0.5) * 16];
  }

  private coolFloor() {
    this.floorMolten = false;
    this.floorCool = 1;
  }

  private melt(it: Item) {
    it.molten = true;
    it.warn = 0;
    it.cool = 0;
    it.doomed = false;
    const p = it.body.rb.translation();
    this.sparks([p.x, p.y, p.z], 10);
  }

  private solidify(it: Item) {
    it.molten = false;
    it.cool = 1;
  }

  /** Seconds after the floor melted when the tile at (x, z) turns (the ripple). */
  private tileDelay(x: number, z: number) {
    const tx = (Math.floor((x + CHAMBER_HALF) / TILE) + 0.5) * TILE - CHAMBER_HALF;
    const tz = (Math.floor((z + CHAMBER_HALF) / TILE) + 0.5) * TILE - CHAMBER_HALF;
    return Math.hypot(tx - this.ripple[0], tz - this.ripple[1]) / RIPPLE_SPEED;
  }

  private floorLavaAt(x: number, z: number) {
    return this.floorMolten && this.floorT >= this.tileDelay(x, z);
  }

  private onRug(x: number, z: number) {
    return Math.abs(x - RUG_CENTRE[0]) < RUG_SIZE[0] / 2 && Math.abs(z - RUG_CENTRE[2]) < RUG_SIZE[1] / 2;
  }

  // --- The finale -------------------------------------------------------------------------------

  /** The duck lands on the nearest clear spot that isn't on top of you. */
  private pickDuckSpot(): Vec3 {
    const p = this.ctx.player.pos;
    let best = DUCK_SPOTS[0], bestD = Infinity;
    for (const s of DUCK_SPOTS) {
      const d = Math.hypot(s[0] - p[0], s[1] - p[2]);
      const score = d < 4.5 ? 100 + d : d;
      if (score < bestD) {
        bestD = score;
        best = s;
      }
    }
    return [best[0], 0, best[1]];
  }

  private finale(dt: number) {
    const { player, hud, camera } = this.ctx;
    const t = this.stepT;
    const duck = this.duck;
    // Out of the sky.
    if (this.duckLandT < 0 && t >= DUCK_DROP_AT) {
      if (!duck.visible) {
        duck.visible = true;
        duck.setSolid(true);
        duck.yaw = Math.atan2(this.duckSpot[0] - player.pos[0], this.duckSpot[2] - player.pos[2]) + Math.PI / 2;
      }
      const fall = t - DUCK_DROP_AT;
      const y = Math.max(0, DUCK_DROP_HEIGHT - 0.5 * DUCK_GRAVITY * fall * fall);
      duck.moveTo([this.duckSpot[0], y, this.duckSpot[2]], duck.yaw);
      // Anyone underneath is about to have a very bad day.
      const alive = player.mode === 'control' && !this.death;
      if (alive && y < player.pos[1] + 1.8 && y > player.pos[1] - 0.5 && duck.over(player.pos[0], player.pos[2], 0.2)) this.squash();
      if (y <= 0) {
        this.duckLandT = t;
        duck.squash = 0.35;
        camera.addShake(0.45);
        this.tag(add(duck.pos, [0, DUCK_BACK + 1.6, 0]), 'SQUEAK.');
        // A ring of dust where it hit the floor.
        for (let i = 0; i < 12; i++) {
          const a = (i / 12) * Math.PI * 2;
          this.puff([duck.pos[0] + Math.cos(a) * DUCK_HALF[0], 0.1, duck.pos[2] + Math.sin(a) * DUCK_HALF[1]], 1, -0.6);
        }
        this.show('RULE #8', 'EVERYTHING IS LAVA', 'EXCEPT THE DUCK.');
      }
      return;
    }
    if (this.duckLandT < 0) return;
    const sinceLand = t - this.duckLandT;
    if (sinceLand < FINALE_COUNT) {
      this.countdown(Math.ceil(FINALE_COUNT - sinceLand), 'EVERYTHING IS LAVA EXCEPT THE DUCK.');
      const w = sinceLand / FINALE_COUNT;
      this.floorWarn = w;
      for (const it of this.items) it.warn = w;
      return;
    }
    if (this.moltenT < 0) {
      this.moltenT = 0;
      this.countdown(0, '');
      hud.show('LAVA!', '', 0.8);
      this.meltFloor();
      for (const it of this.items) this.melt(it);
    }
    const m = this.moltenT;
    if (m >= 3.2 && !this.sailing) {
      this.sailing = true;
      this.show('RULE #9', 'THE DUCK IS A BOAT NOW.', "DON'T ASK.");
    }
    if (this.sailing && !this.exitShown && Math.hypot(DOCK[0] - duck.pos[0], DOCK[2] - duck.pos[2]) < 6) {
      this.exitShown = true;
      this.show('RULE #10', 'THE EXIT IS NOT LAVA.', 'PROBABLY.');
      this.exit.openNow();
    }
  }

  private startSinking(it: Item) {
    it.sinkT = 0;
    const rb = it.body.rb;
    rb.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    for (const c of it.colliders) c.setEnabled(false);
  }

  /** Floats the duck on the lava (and sails it to the exit). */
  private moveDuck(dt: number) {
    const duck = this.duck;
    if (this.duckLandT < 0) return;
    // Once everything is lava, it rises and swallows the furniture, whatever happens to you.
    if (this.moltenT >= 0) {
      const m = (this.moltenT += dt);
      this.tide = FINALE_TIDE * smooth(m / 2.2);
      // Everything but the duck sinks (once anyone standing on it has had a chance to burn).
      if (m > 1.2) for (const it of this.items) if (it.sinkT < 0) this.startSinking(it);
    }
    duck.squash = Math.max(0, duck.squash - dt * 1.6);
    const bob = this.moltenT >= 0 ? Math.sin(this.time * 1.7) * 0.04 : 0;
    const y = Math.max(0, this.tide - DUCK_DRAFT) + bob * smooth(this.moltenT);
    let yaw = duck.yaw;
    const pos: Vec3 = [duck.pos[0], y, duck.pos[2]];
    if (this.sailing && !this.death) {
      const dx = DOCK[0] - pos[0], dz = DOCK[2] - pos[2];
      const d = Math.hypot(dx, dz);
      const speed = Math.min(SAIL_SPEED, d * 0.7);
      const want: Vec3 = d > 1e-3 ? [(dx / d) * speed, 0, (dz / d) * speed] : [0, 0, 0];
      const k = 1 - Math.exp(-dt * 1.2);
      this.sailVel = [this.sailVel[0] + (want[0] - this.sailVel[0]) * k, 0, this.sailVel[2] + (want[2] - this.sailVel[2]) * k];
      pos[0] += this.sailVel[0] * dt;
      pos[2] += this.sailVel[2] * dt;
      // Beak first, then turn side-on to the wall to dock.
      const heading = Math.hypot(this.sailVel[0], this.sailVel[2]) > 0.3 && d > 3 ? Math.atan2(-this.sailVel[0], -this.sailVel[2]) : 0;
      const diff = Math.atan2(Math.sin(heading - yaw), Math.cos(heading - yaw));
      yaw += clamp(diff, -dt * 0.9, dt * 0.9);
      duck.roll = Math.sin(this.time * 1.1) * 0.03;
    }
    // Anyone on it goes along for the ride.
    duck.moveTo(pos, yaw, this.ctx.player);
  }

  // --- Your feet --------------------------------------------------------------------------------

  private classify(hit: RayHit): Surface {
    if (this.duck.owns(hit.collider)) return DUCK_SURFACE;
    const item = this.byCollider.get(hit.collider.handle);
    if (item) return item.surface;
    if (hit.point[1] < 0.06) return this.onRug(hit.point[0], hit.point[2]) ? RUG_SURFACE : FLOOR_SURFACE;
    return OTHER_SURFACE;
  }

  private isLava(s: Surface, x: number, z: number) {
    switch (s.kind) {
      case 'floor':
      case 'rug':
        return this.floorLavaAt(x, z);
      case 'item':
        return s.item!.molten || s.item!.sinkT >= 0;
      case 'tide':
        return true;
      default:
        return false;
    }
  }

  /** What the player stands on, and whether it's lava (null: nothing / safe). */
  private feet(): Surface | null {
    const { player, physics } = this.ctx;
    const p = player.pos;
    this.standing = null;
    let lava: Surface | null = null;
    let safe = false;
    // Rising lava: anything under its surface is in it, whatever it stands on.
    if (this.tide > 0.05 && p[1] < this.tide - 0.03) lava = TIDE_SURFACE;
    // Whatever is right under the feet counts (a bit further down while standing, as the capsule's
    // round bottom can rest on an edge; not so far while in the air, or jumping over lava would burn).
    const reach = player.onGround ? 0.22 : 0.08;
    for (const [ox, oz] of FEET) {
      const x = p[0] + ox, z = p[2] + oz;
      const hit = physics.raycast([x, p[1] + 0.35, z], DOWN, 0.6, player.collider ?? undefined);
      if (!hit || hit.point[1] < p[1] - reach) continue;
      const s = this.classify(hit);
      if (!this.standing || (ox === 0 && oz === 0)) this.standing = s;
      if (this.isLava(s, hit.point[0], hit.point[2])) lava ??= s;
      else safe = true;
    }
    if (!this.standing && p[1] < 0.06) {
      this.standing = this.onRug(p[0], p[2]) ? RUG_SURFACE : FLOOR_SURFACE;
      if (this.isLava(this.standing, p[0], p[2])) lava ??= this.standing;
    }
    if (this.standing) this.lastStanding = this.standing;
    if (lava === TIDE_SURFACE) return lava;
    return safe ? null : lava;
  }

  private checkFeet(dt: number) {
    const { player } = this.ctx;
    const lava = this.feet();
    if (this.standing === DUCK_SURFACE) this.boarded = true;
    if (lava) {
      if (!this.wasTouching) this.contact += TOUCH_MIN;
      this.contact += dt;
      // Sizzle.
      if (Math.random() < dt * 30) this.puff(add(player.pos, [(Math.random() - 0.5) * 0.4, 0.05, (Math.random() - 0.5) * 0.4]), 1, 0.2);
      player.char = Math.max(player.char, clamp(this.contact / GRACE, 0, 1) * 0.25);
      if (this.contact >= GRACE) this.burn(lava);
    } else if (this.standing) {
      this.contact = Math.max(0, this.contact - dt * COOL_RATE);
    }
    this.wasTouching = !!lava;
  }

  // --- Deaths -----------------------------------------------------------------------------------

  private causeOf(s: Surface): Cause {
    const step = this.step;
    if (step?.kind === 'finale') return this.boarded && this.sailing ? 'overboard' : 'duck';
    if (s.kind === 'tide' || step?.kind === 'rising') return 'rising';
    if (s.kind === 'rug') return 'rug';
    if (s.kind === 'item' && step?.kind === 'rule') {
      if (step.underfoot && s.item === this.underfootItem) return 'underfoot';
      return step.cause ?? 'floor';
    }
    return 'floor';
  }

  private burn(s: Surface) {
    const { player, camera } = this.ctx;
    if (this.death || player.mode !== 'control') return;
    player.kill([(Math.random() - 0.5) * 2, 4.5, (Math.random() - 0.5) * 2], { violence: 3 });
    camera.addShake(0.35);
    this.burning = 0;
    noise(1.2, { freq: 5000, to: 1500, type: 'highpass', vol: 0.3 });
    this.puff(add(player.pos, [0, 0.8, 0]), 14, 0.1);
    this.die(this.causeOf(s));
  }

  /** Flattened by a falling duck. */
  private squash() {
    const { player, camera } = this.ctx;
    if (this.death || player.mode !== 'control') return;
    player.kill([0, -6, 0], { violence: 20, origin: add(player.pos, [0, 1.8, 0]) });
    camera.addShake(0.9);
    this.die('squashed');
  }

  private die(cause: Cause) {
    const d = DEATHS[cause];
    this.ctx.hud.hide();
    this.show('', "YOU'RE OUT!", "THAT'S THE RULES.");
    this.death = { t: 0, big: d.big, small: pick(d.small), hint: d.hint };
  }

  // --- Particles --------------------------------------------------------------------------------

  private particle(pos: Vec3, vel: Vec3, life: number, size: number, smoke: boolean, dark = 0) {
    const p = this.particles[this.nextParticle];
    this.nextParticle = (this.nextParticle + 1) % PARTICLES;
    p.pos[0] = pos[0]; p.pos[1] = pos[1]; p.pos[2] = pos[2];
    p.vel[0] = vel[0]; p.vel[1] = vel[1]; p.vel[2] = vel[2];
    p.age = 0;
    p.life = life;
    p.size = size;
    p.smoke = smoke;
    p.dark = dark;
  }

  private puff(pos: Vec3, n: number, dark: number) {
    for (let i = 0; i < n; i++) {
      this.particle(
        [pos[0] + (Math.random() - 0.5) * 0.3, pos[1], pos[2] + (Math.random() - 0.5) * 0.3],
        [(Math.random() - 0.5) * 0.7, 0.9 + Math.random() * 1.1, (Math.random() - 0.5) * 0.7],
        1.1 + Math.random() * 1.1, 0.06 + Math.random() * 0.07, true, dark,
      );
    }
  }

  private sparks(pos: Vec3, n: number) {
    for (let i = 0; i < n; i++) {
      this.particle(
        [pos[0] + (Math.random() - 0.5) * 0.8, pos[1] + Math.random() * 0.3, pos[2] + (Math.random() - 0.5) * 0.8],
        [(Math.random() - 0.5) * 1.2, 1 + Math.random() * 2, (Math.random() - 0.5) * 1.2],
        0.8 + Math.random() * 0.8, 0.025 + Math.random() * 0.03, false,
      );
    }
  }

  /** Embers rising off everything that's lava right now. */
  private embers(dt: number) {
    if (this.floorMolten || this.tide > 0.02) {
      this.emberDue += dt * EMBERS_PER_SECOND;
      for (; this.emberDue >= 1; this.emberDue--) {
        const x = (Math.random() * 2 - 1) * (CHAMBER_HALF - 0.3), z = (Math.random() * 2 - 1) * (CHAMBER_HALF - 0.3);
        if (!this.floorLavaAt(x, z) && this.tide <= 0.02) continue;
        this.particle([x, Math.max(0.02, this.tide), z], [(Math.random() - 0.5) * 0.3, 0.6 + Math.random() * 1.4, (Math.random() - 0.5) * 0.3], 1.2 + Math.random() * 1.4, 0.02 + Math.random() * 0.035, false);
      }
    }
    for (const it of this.items) {
      if (!it.molten || it.sinkT > 2) continue;
      if (Math.random() > dt * 5) continue;
      const p = it.body.rb.translation();
      this.particle([p.x + (Math.random() - 0.5) * 0.6, p.y + 0.3, p.z + (Math.random() - 0.5) * 0.6], [(Math.random() - 0.5) * 0.3, 0.8 + Math.random(), (Math.random() - 0.5) * 0.3], 1 + Math.random(), 0.02 + Math.random() * 0.03, false);
    }
  }

  private tag(pos: Vec3, text: string) {
    this.tags.push({ pos, text, size: 0.6, color: '#ffd166', ttl: 2.2 });
  }

  // --- Update -----------------------------------------------------------------------------------

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

    const alive = player.mode === 'control' && !player.inPortal && !this.death;
    if (this.arrival.done && alive) this.script(dt);
    if (this.floorMolten) this.floorT += dt;
    this.floorCool = Math.max(0, this.floorCool - dt / 1.3);
    if (!this.floorMolten && this.floorCool <= 0 && !this.isCounting()) this.floorWarn = Math.max(0, this.floorWarn - dt * 2);
    let warn = this.floorWarn;
    for (const it of this.items) {
      it.cool = Math.max(0, it.cool - dt / 1.3);
      if (!it.doomed && !this.isCounting()) it.warn = Math.max(0, it.warn - dt * 2);
      if (it.sinkT >= 0) this.sink(it, dt);
      warn = Math.max(warn, it.warn);
    }
    // Blinking speeds up as the countdown runs out (and starts on the normal look).
    this.blinkT = warn > 0 ? this.blinkT + dt * (1.2 + warn * warn * 6) : 0.5;
    this.moveDuck(dt);
    if (this.arrival.done && alive) this.checkFeet(dt);

    // Burning up.
    if (this.burning >= 0) {
      this.burning += dt;
      player.char = Math.max(player.char, Math.min(1, this.burning / 0.7));
      if (this.burning < 3.5 && Math.random() < dt * 18) {
        const f = player.partFrames();
        const part = pick([f.chest, f.head, f.pelvis, f.thighL, f.thighR]);
        this.puff([part[12], part[13], part[14]], 1, 0.08);
      }
    }

    // The room heats up with the lava (warm light from below, orange haze).
    const lit = this.floorMolten ? smooth(this.floorT / 0.6) : this.floorCool * 0.6;
    const items = this.items.reduce((n, it) => n + (it.molten ? 1 : 0), 0) / this.items.length;
    const target = Math.max(lit, Math.min(1, items * 1.5) * 0.5, this.floorWarn * 0.25);
    this.heat += (target - this.heat) * (1 - Math.exp(-dt * 3));
    const h = this.heat;
    this.env.groundColor = mix(DEFAULT_ENV.groundColor, [1.25, 0.42, 0.1], h) as Vec3;
    this.env.fogColor = mix(DEFAULT_ENV.fogColor, [0.95, 0.62, 0.45], h * 0.6) as Vec3;
    this.env.sunColor = mix(DEFAULT_ENV.sunColor, [2.1, 1.55, 1.15], h * 0.6) as Vec3;
    this.env.fogDensity = DEFAULT_ENV.fogDensity * (1 + h * 1.5);

    this.embers(dt);
    for (const p of this.particles) {
      if (p.age >= p.life) continue;
      p.age += dt;
      p.pos[0] += p.vel[0] * dt;
      p.pos[1] += p.vel[1] * dt;
      p.pos[2] += p.vel[2] * dt;
      if (p.smoke) p.vel[1] += dt * 0.4;
    }
    for (const tag of this.tags) {
      tag.ttl -= dt;
      tag.pos[1] += dt * 0.4;
    }
    if (this.tags.length && this.tags[0].ttl <= 0) this.tags = this.tags.filter((g) => g.ttl > 0);
  }

  /** In a countdown right now (things are heating up)? */
  private isCounting() {
    const step = this.step;
    if (!step) return false;
    if (step.kind === 'rule') return this.stepT < COUNT;
    if (step.kind === 'rising') return this.stepT < RISING_COUNT;
    if (step.kind === 'finale') return this.duckLandT >= 0 && this.moltenT < 0;
    return false;
  }

  /** Lowers an item slowly into the lava, tilting a little, and gets rid of it once it's gone. */
  private sink(it: Item, dt: number) {
    it.sinkT += dt;
    const rb = it.body.rb;
    if (!this.ctx.physics.bodies.includes(it.body)) return;
    const p = rb.translation();
    const speed = 0.25 + it.sinkT * 0.25;
    rb.setNextKinematicTranslation({ x: p.x, y: p.y - speed * dt, z: p.z });
    if (p.y < -2.5) this.ctx.physics.remove(it.body);
  }

  // --- Drawing ----------------------------------------------------------------------------------

  draw(out: DrawItem[]) {
    this.arrival.draw(out);
    this.exit.draw(out);
    this.drawFloor(out);
    this.drawScreens(out);
    drawPainting(out, [-CHAMBER_HALF + 0.02, 3.3, 8.2], [1, 0, 0], 2.6, 1.8, 'volcano');
    drawPainting(out, [-8.5, 3.6, CHAMBER_HALF - 0.02], [0, 0, -1], 2.0, 1.5, 'duck');

    // The duck, and its shadow as it falls.
    const duck = this.duck;
    duck.draw(out);
    if (duck.visible && this.duckLandT < 0 && this.stepT >= DUCK_DROP_AT) {
      const fall = clamp(duck.pos[1] / DUCK_DROP_HEIGHT, 0, 1);
      duck.drawShadow(out, 0, 0.75 * (1 - fall * 0.7));
    } else if (!duck.visible && this.step?.kind === 'finale') {
      // Before it drops: a shadow growing where it'll land.
      const k = clamp(this.stepT / DUCK_DROP_AT, 0, 1);
      out.push({
        mesh: 'cylinder',
        model: mul(translation([this.duckSpot[0], 0.02, this.duckSpot[2]]), scaling([DUCK_HALF[0] * k, 0.01, DUCK_HALF[1] * k])),
        color: [0, 0, 0], pattern: Pattern.blob, param: 0.35 * k, shadow: false,
      });
    }

    // Flames on a burning player.
    if (this.burning >= 0 && this.burning < 3.5) {
      const f = this.ctx.player.partFrames();
      const k = 1 - clamp((this.burning - 2.2) / 1.3, 0, 1);
      for (const part of [f.chest, f.head, f.pelvis, f.thighL, f.thighR, f.upperArmL, f.upperArmR]) {
        const h = (0.25 + 0.15 * Math.sin(this.time * 23 + part[12] * 7)) * k;
        if (h <= 0.01) continue;
        out.push({ mesh: 'cone', model: mul(translation([part[12], part[13] + h * 0.5, part[14]]), scaling([0.12 * k, h, 0.12 * k])), color: [6, 2.4, 0.4], pattern: Pattern.emissive, shadow: false });
      }
    }

    for (const p of this.particles) {
      if (p.age >= p.life) continue;
      const k = p.age / p.life;
      if (p.smoke) {
        const size = p.size * (1 + k * 2.5);
        const g = 0.45 - p.dark * 0.4;
        out.push({ mesh: 'sphere', model: mul(translation(p.pos), scaling([size, size, size])), color: [g, g, g], opacity: 0.55 * (1 - k), shadow: false });
      } else {
        const s = p.size * (1 - k * 0.6);
        const b = 1 - k;
        out.push({ mesh: 'box', model: mul(translation(p.pos), scaling([s, s, s])), color: [4 * b + 0.3, 1.3 * b + 0.05, 0.25 * b], pattern: Pattern.emissive, shadow: false });
      }
    }
  }

  private drawFloor(out: DrawItem[]) {
    const H = CHAMBER_HALF;
    // The rug: blue, until it's lava like the rest of the floor.
    const rugLava = this.floorLavaAt(RUG_CENTRE[0], RUG_CENTRE[2]);
    if (!rugLava) {
      const first = out.length;
      drawRug(out, RUG_CENTRE, RUG_SIZE);
      if (this.floorCool > 0) for (let i = first; i < out.length; i++) out[i].color = mix(out[i].color, CRUST, this.floorCool);
      else if (this.floorWarn > 0) for (let i = first; i < out.length; i++) out[i].color = mix(out[i].color, CRUST, this.floorWarn * 0.5);
    }

    // Warming up: the seams between the floor panels (and across the rug) glow, brighter and wider.
    if (this.floorWarn > 0 && !this.floorMolten) {
      const w = this.floorWarn;
      const flicker = 0.75 + 0.25 * Math.sin(this.time * (10 + w * 20));
      const c = [2.6 * w * flicker + 0.2 * w, 0.5 * w * flicker, 0.06 * w];
      for (let i = 0; i <= TILES; i++) {
        const v = -H + i * TILE;
        out.push({ mesh: 'box', model: mul(translation([v, 0.016, 0]), scaling([0.05 + w * 0.08, 0.004, H * 2])), color: c, pattern: Pattern.emissive, shadow: false });
        out.push({ mesh: 'box', model: mul(translation([0, 0.016, v]), scaling([H * 2, 0.004, 0.05 + w * 0.08])), color: c, pattern: Pattern.emissive, shadow: false });
      }
    }

    // Lava: tile by tile as it spreads, then one sheet (or a rising pool).
    if (this.floorMolten || this.tide > 0.02) {
      const spreading = this.floorMolten && this.floorT < 34 / RIPPLE_SPEED + TILE_GROW;
      if (spreading && this.tide <= 0.02) {
        for (let i = 0; i < TILES; i++) for (let j = 0; j < TILES; j++) {
          const x = -H + (i + 0.5) * TILE, z = -H + (j + 0.5) * TILE;
          const g = clamp((this.floorT - this.tileDelay(x, z)) / TILE_GROW, 0, 1);
          if (g <= 0) continue;
          const s = TILE * (0.3 + 0.7 * g) + 0.01;
          out.push({ mesh: 'box', model: mul(translation([x, 0.012, z]), scaling([s, 0.024 * g, s])), color: [1, 1, 1], pattern: Pattern.lava, shadow: false });
        }
      } else {
        const top = Math.max(0.024, this.tide);
        out.push({ mesh: 'box', model: mul(translation([0, top / 2, 0]), scaling([H * 2 - 0.02, top, H * 2 - 0.02])), color: [1, 1, 1], pattern: Pattern.lava, shadow: false });
      }
    } else if (this.floorCool > 0) {
      // Cooling: a dark crust that fades back to the floor.
      const k = this.floorCool;
      out.push({
        mesh: 'box', model: mul(translation([0, 0.012, 0]), scaling([H * 2 - 0.02, 0.024, H * 2 - 0.02])),
        color: mix(FLOOR, CRUST, Math.min(1, k * 1.3)), opacity: Math.min(1, k * 1.6), shadow: false, spec: 0.3,
      });
    }
  }

  private drawScreens(out: DrawItem[]) {
    for (const s of this.screens) {
      const [nx, , nz] = s.normal;
      const across: Vec3 = [nz, 0, -nx];
      out.push({ mesh: 'bevelbox', model: basis(scale(across, SCREEN_W + 0.5), [0, SCREEN_H + 0.5, 0], scale(s.normal, 0.3), s.pos), color: [0.12, 0.12, 0.14], spec: 0.5 });
      out.push({ mesh: 'box', model: basis(scale(across, SCREEN_W), [0, SCREEN_H, 0], scale(s.normal, 0.32), s.pos), color: [0.02, 0.025, 0.05], spec: 0.9 });
      // A little red standby light.
      out.push({ mesh: 'box', model: basis(scale(across, 0.12), [0, 0.06, 0], scale(s.normal, 0.34), add(s.pos, add(scale(across, SCREEN_W / 2 - 0.2), [0, -SCREEN_H / 2 - 0.12, 0]))), color: [2, 0.2, 0.1], pattern: Pattern.emissive });
    }
  }

  labels(): WorldLabel[] {
    this.labelList.length = 0;
    for (const s of this.screens) this.labelList.push(s.header, s.line1, s.line2, s.count);
    for (const t of this.tags) this.labelList.push(t);
    return this.labelList;
  }

  trackedTargets(): TrackedTarget[] {
    const exit = this.exit.target();
    if (exit) return [exit];
    // The duck may land behind you: it's somewhere to go, until you're on it.
    if (this.duckLandT >= 0 && this.moltenT < 0 && !this.boarded) {
      this.duckTarget.pos = add(this.duck.pos, [0, 1.2, 0]);
      return [this.duckTarget];
    }
    return [];
  }
  private duckTarget: TrackedTarget = { pos: [0, 0, 0], radius: 1.8, color: 'purple' };

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

