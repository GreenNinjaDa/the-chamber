import { Drone, noise, note, sfx, tone, Tune } from '../../engine/audio';
import { add, clamp, mul, scaling, translation, type Mat4, type Vec3 } from '../../engine/math';
import type { RAPIER, Usable } from '../../engine/physics';
import { Pattern, type DrawItem, type Environment } from '../../engine/renderer';
import { CHAMBER_HALF } from '../../game/chamber';
import type { Circle } from '../../game/player';
import { Crewmate, CREW_COLORS, CREW_RADIUS, type CrewColor } from '../../entities/crewmate';
import { ExitPortal, PortalArrival } from '../../entities/portal';
import { addMeetingTable, drawMeetingTable, TABLE_RADIUS, TaskStation, Vent, type StationKind } from '../../entities/spaceship';
import { drawTrapdoor } from '../../entities/trapdoor';
import { DEFAULT_ENV, type CameraShot, type Level, type LevelContext, type LevelStatus, type TrackedTarget, type WorldLabel } from '../level';

/*
 * Among Us. The chamber is a spaceship cafeteria (open to space): a round table with the big red
 * EMERGENCY button, task stations round the walls and four floor vents. Six crewmates waddle from
 * station to station doing tasks (the station's screen lights up and the task bar on the north
 * wall fills). One of them, a different one every attempt, is the impostor: it fakes tasks (the
 * screen stays dark), sometimes follows you about standing much too close, and every 12-18 s it
 * kills somebody nobody else is near enough to see (a lunge, a flip-top mouth, a tongue; the
 * victim's top half flies off and the bottom half stays, with a bone), then hops down the
 * nearest vent and pops out of another. Report a body (E near it) or press the button (E) and
 * everyone warps round the table to argue, then vote: stand next to a suspect (or on SKIP) and
 * press E. Eject the impostor and the exit opens; eject anyone else and the lights go out.
 * Being alone with it, or being the last one left with it, ends the same way.
 */

const params = new URLSearchParams(location.search);
/** `?impostor=RED` (a colour name) picks the impostor, for testing. */
const FORCE_IMPOSTOR = params.get('impostor')?.toUpperCase() ?? null;

const SPAWN: Vec3 = [0, 0, 8];
const SEAT_R = 3.7;
const SKIP_POS: Vec3 = [0, 0, 6.9];
const SKIP_R = 1.0;
const NPC_COUNT = 6;
const WALK_SPEED = 2.9;
const HUNT_SPEED = 3.3;
/** The impostor's first kill comes this long after you arrive; then one every KILL_COOLDOWN. */
const FIRST_KILL = 10;
const KILL_COOLDOWN: [number, number] = [10, 15];
const AFTER_MEETING_COOLDOWN: [number, number] = [7, 10];
const KILL_RANGE = 1.3;
/** Nobody else (a crewmate) within this of the victim, and the player no nearer than PLAYER_WITNESS. */
const NPC_WITNESS = 5.5;
const PLAYER_WITNESS = 8.5;
/** Crewmates notice a body this close. */
const REPORT_RANGE = 4.5;
const PLAYER_REPORT_RANGE = 2.4;
const TASKS_TOTAL = 32;
const PLAYER_TASK_TIME = 3;
const PLAYER_TASK_VALUE = 2;
const MEETINGS = 2;
const BUTTON_COOLDOWN = 8;
const CALL_TIME = 1.8;
const DISCUSS_TIME = 6;
const VOTE_TIME = 10;
const REVEAL_TIME = 2.6;
const EJECT_TIME = 4.6;
const DEATH_SCREEN_DELAY = 1.8;
const EXIT_Z = 0;
const VOTE_REACH = 1.9;

const PLAYER_COLOR = [0.95, 0.4, 0.07];
const PLAYER_CSS = '#ff9a4a';

const STATIONS: { kind: StationKind; name: string; anchor: Vec3; normal: Vec3 }[] = [
  { kind: 'wires', name: 'FIX WIRING', anchor: [-6.5, 0, -CHAMBER_HALF], normal: [0, 0, 1] },
  { kind: 'terminal', name: 'DOWNLOAD DATA', anchor: [6, 0, -CHAMBER_HALF], normal: [0, 0, 1] },
  { kind: 'swipe', name: 'SWIPE CARD', anchor: [-CHAMBER_HALF, 0, -5], normal: [1, 0, 0] },
  { kind: 'chute', name: 'EMPTY GARBAGE', anchor: [-CHAMBER_HALF, 0, 5], normal: [1, 0, 0] },
  { kind: 'wires', name: 'FIX WIRING', anchor: [-6.5, 0, CHAMBER_HALF], normal: [0, 0, -1] },
  { kind: 'terminal', name: 'UPLOAD DATA', anchor: [6, 0, CHAMBER_HALF], normal: [0, 0, -1] },
  { kind: 'dials', name: 'CALIBRATE DISTRIBUTOR', anchor: [CHAMBER_HALF, 0, -7], normal: [-1, 0, 0] },
  { kind: 'dials', name: 'PRIME SHIELDS', anchor: [CHAMBER_HALF, 0, 7.5], normal: [-1, 0, 0] },
];
const VENT_SPOTS: Vec3[] = [[-8.2, 0, -8.2], [8.6, 0, -8.8], [-8.4, 0, 8.6], [7.6, 0, 3.8]];

type NpcMode = 'idle' | 'walk' | 'task' | 'fake' | 'follow' | 'hunt' | 'lunge' | 'toVent' | 'vent' | 'seat' | 'gloat';
type Phase = 'play' | 'call' | 'discuss' | 'vote' | 'reveal' | 'eject' | 'won' | 'dark' | 'over';
type Vote = Npc | 'skip' | 'player';

interface Npc {
  c: Crewmate;
  impostor: boolean;
  mode: NpcMode;
  modeT: number;
  target: Vec3;
  speed: number;
  station: TaskStation | null;
  lastStation: TaskStation | null;
  taskDur: number;
  seat: Vec3;
  seatYaw: number;
  label: WorldLabel;
  bubble: WorldLabel;
  bubbleT: number;
  /** What they saw since the last meeting. */
  sawVent: Npc | null;
  sawFake: Npc | null;
  /** When the VOTED badge pops up during a vote (s into it). */
  voteAt: number;
  /** The vote they cast. */
  vote: Vote | null;
}

interface Corpse {
  npc: Npc;
  pos: Vec3;
  collider: RAPIER.Collider;
  usable: CorpseUsable;
  age: number;
}

interface Line {
  npc: Npc;
  text: string;
  at: number;
  shown: boolean;
}

interface Meeting {
  kind: 'button' | 'body';
  reporter: Npc | 'player';
  victim: Npc | null;
  suspect: Npc | 'player' | null;
  lines: Line[];
  /** The player's vote: locked in with E, or wherever they stand when time runs out. */
  playerVote: Vote | null;
  locked: boolean;
  /** Who got how many votes (voter colours, for the chips). */
  chips: { at: Vec3; color: number[]; t: number }[];
  ejected: Npc | 'player' | null;
  tie: boolean;
  announced: boolean;
  trapdoor: { pos: Vec3; t: number } | null;
}

interface Lunge {
  imp: Npc;
  victim: Npc | 'player';
  t: number;
  from: Vec3;
  done: boolean;
}

interface VentTrip {
  imp: Npc;
  from: Vent;
  to: Vent;
  t: number;
  popped: boolean;
}

interface Death {
  t: number;
  delay: number;
  big: string;
  small: string;
  hint: string;
  /** The impostor that did it, for the camera. */
  killer: Npc | null;
}

const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const lower = (n: Npc | 'player') => (n === 'player' ? 'orange' : n.c.color.name.toLowerCase());
const upper = (n: Npc | 'player') => (n === 'player' ? 'ORANGE' : n.c.color.name);
const flat = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[2] - b[2]);

const CHATTER = [
  'where', 'who', '?', 'wait what', 'i was in electrical', 'i was doing wires', 'it was the gnome', 'skip', 'trust me bro',
  'why is orange so tall', 'orange has KNEES??', 'same', 'i was afk', 'im not sus', 'dead body where', 'can we vote already',
  'i did all my tasks', 'check the task bar', 'its always red', 'sus', 'who even is the impostor', 'lol', 'i was in admin',
  'we dont have an admin', 'no evidence. skip', 'is this a test chamber?', 'the cake is a lie', 'i was with {C}', '{C} sus',
  'vote {C}', '{C} was acting weird', 'where was {C}?', 'i saw {C} by the table', '{C} is too quiet', 'not me',
];
const IMPOSTOR_CHATTER = [
  '{C} sus', 'i was doing tasks', 'i was in wires the whole time', 'skip', 'i saw {C} near there', '{C} was following me',
  'vote {C}', 'why is everyone looking at me', 'orange sus', 'i was with {C}', 'i was literally doing tasks', 'skip. trust me',
  '{C} was faking tasks', "{C}'s screen was off",
];
const BODY_OPENERS = ['{V} is dead', 'BODY BY {P}', '{V} is in two pieces', 'found {V} by {P}', 'uh. {V} has a bone now', '{V} dead. {P}'];
const BUTTON_REACTIONS = ['orange why', 'who pressed it', 'this better be good', 'orange called it', 'what did orange see', 'emergency?? where'];
const REPORT_REACTIONS = ['where', 'rip {V}', 'noooo {V}', 'orange found {V}?', 'who was near {P}?', 'self report?'];
const VENT_WITNESS = ['I SAW {X} VENT!!', '{X} VENTED', '{X} came out of a VENT', 'VENT. {X}. I SAW IT.'];
const FAKE_WITNESS = ['{X} was faking tasks', "{X}'s screen was off", '{X} did {S} with the screen off??', '{X} just stood at {S}'];
const DEATH_HINT = "The impostor fakes tasks (its screen stays dark), follows people too closely and uses the vents. Report bodies (E) or press the red button (E), then vote: stand next to someone and press E.";

/** A body you can report by pressing E on it. */
class CorpseUsable implements Usable {
  highlight = 0;
  constructor(private onUse: () => void) {}
  use() {
    this.onUse();
  }
}

/** A station you can do yourself (E): its screen lights up, like a real crewmate's. */
class StationUsable implements Usable {
  highlight = 0;
  constructor(private onUse: () => void) {}
  use() {
    this.onUse();
  }
}

/** The EMERGENCY button in the middle of the table. */
class ButtonUsable implements Usable {
  highlight = 0;
  constructor(private onUse: () => void) {}
  use() {
    this.onUse();
  }
}

// Sounds (all original, all synthesised).
function clank() {
  tone(190, 0.12, { to: 120, wave: 'square', vol: 0.12 });
  noise(0.18, { freq: 2600, to: 900, type: 'bandpass', q: 3, vol: 0.35 });
  tone(420, 0.08, { wave: 'triangle', vol: 0.08, at: 0.09 });
  noise(0.1, { freq: 1800, type: 'bandpass', q: 4, vol: 0.25, at: 0.1 });
}
function stab() {
  noise(0.12, { freq: 4000, to: 1200, type: 'highpass', vol: 0.4 });
  sfx.splat();
  tone(note('C#3'), 0.5, { to: note('G2'), wave: 'sawtooth', vol: 0.12, at: 0.05 });
}
function taskBlip() {
  tone(note('E6'), 0.07, { wave: 'square', vol: 0.05 });
  tone(note('B6'), 0.1, { wave: 'square', vol: 0.05, at: 0.07 });
}
function alarm() {
  for (let i = 0; i < 3; i++) {
    tone(740, 0.22, { to: 520, wave: 'square', vol: 0.11, at: i * 0.5 });
    tone(520, 0.2, { to: 740, wave: 'square', vol: 0.09, at: i * 0.5 + 0.25 });
  }
}
function bodySting() {
  tone(note('A2'), 0.9, { wave: 'sawtooth', vol: 0.14 });
  tone(note('A#2'), 0.9, { wave: 'sawtooth', vol: 0.1 });
  noise(0.6, { freq: 300, to: 3000, type: 'bandpass', q: 2, vol: 0.25 });
  tone(note('E4'), 0.6, { to: note('A4'), wave: 'triangle', vol: 0.1, at: 0.3 });
}
function roleSting() {
  ['E4', 'G4', 'B4', 'E5'].forEach((n, i) => tone(note(n), 0.5, { wave: 'triangle', vol: 0.09, at: i * 0.12 }));
  noise(1.2, { freq: 200, to: 2000, type: 'bandpass', q: 1, vol: 0.12 });
}
function whoosh() {
  noise(1.4, { freq: 300, to: 4000, type: 'bandpass', q: 1.5, vol: 0.35 });
  sfx.thud(0.4);
}
function powerDown() {
  tone(220, 1.2, { to: 30, wave: 'sawtooth', vol: 0.15 });
  noise(0.3, { freq: 800, to: 100, vol: 0.2 });
}
function fanfare() {
  const notes: [string, number][] = [['C5', 0], ['E5', 0.14], ['G5', 0.28], ['C6', 0.42], ['G5', 0.66], ['C6', 0.8]];
  for (const [n, at] of notes) tone(note(n), 0.3, { wave: 'square', vol: 0.1, at });
  tone(note('C3'), 1, { wave: 'triangle', vol: 0.15, at: 0.42 });
}

/** Meetings: a tense little bass line (original). */
const MEETING_RIFF: [string | null, number][] = [
  ['E2', 0.5], [null, 0.25], ['E2', 0.25], ['G2', 0.5], ['E2', 0.5], ['A#2', 0.5], ['A2', 0.5], ['G2', 0.5], [null, 0.5],
];

export class ImpostorLevel implements Level {
  readonly number: number;
  readonly title = 'Among Us';
  status: LevelStatus = 'playing';
  private arrival: PortalArrival;
  private exit = new ExitPortal(EXIT_Z);
  private npcs: Npc[] = [];
  private impostor!: Npc;
  private stations: TaskStation[] = [];
  private vents: Vent[] = [];
  private ventClose: number[] = [];
  private corpses: Corpse[] = [];
  private phase: Phase = 'play';
  private phaseT = 0;
  private time = 0;
  private started = false;
  private startedAt = 0;
  private cool = FIRST_KILL;
  private huntT = 0;
  private victim: Npc | 'player' | null = null;
  private lunge: Lunge | null = null;
  private vent: VentTrip | null = null;
  private kills = 0;
  private tasks = 0;
  private taskShown = 0;
  private meetingsLeft = MEETINGS;
  private buttonCool = 0;
  private buttonPressedAt = -10;
  private buttonUsable: ButtonUsable;
  private meeting: Meeting | null = null;
  private pendingReport: { npc: Npc; corpse: Corpse; t: number } | null = null;
  private playerTask: { station: TaskStation; t: number } | null = null;
  private playerDone = new Map<TaskStation, number>();
  private death: Death | null = null;
  private light = 1;
  private darkReason: 'wrongVote' | 'numbers' = 'numbers';
  private darkPlaced = false;
  private darkEjected: Npc | null = null;
  private playerEjected = false;
  private hum = new Drone(55, { wave: 'sawtooth', vol: 0.022, wobble: 0.25 });
  private riff = new Tune(MEETING_RIFF, 104, { wave: 'triangle', vol: 0.12 });
  private stars: Mat4[] = [];
  private decor: DrawItem[] = [];
  private labelList: WorldLabel[] = [];
  private stationLabels: WorldLabel[] = [];
  private youLabel: WorldLabel = { pos: [0, 0, 0], text: 'YOU', size: 0.22, color: PLAYER_CSS };
  private buttonLabel: WorldLabel = { pos: [0, 1.75, 0], text: 'EMERGENCY', size: 0.2, color: '#ff4a3d' };
  private barLabel: WorldLabel = { pos: [0, 8.25, -CHAMBER_HALF + 0.2], text: 'TOTAL TASKS COMPLETED', size: 0.5, color: '#ffffff' };
  private wallLabel: WorldLabel = { pos: [0, 5.6, -CHAMBER_HALF + 0.2], text: '', size: 0.85, color: '#ffffff' };
  private wallSub: WorldLabel = { pos: [0, 4.7, -CHAMBER_HALF + 0.2], text: '', size: 0.4, color: '#ffffff' };
  private skipLabel: WorldLabel = { pos: [SKIP_POS[0], 1.1, SKIP_POS[2]], text: 'SKIP VOTE', size: 0.3, color: '#dddddd' };
  private obstacleList: Circle[] = [];
  private targetList: TrackedTarget[] = [];
  private voteTarget: TrackedTarget = { pos: [0, 0, 0], radius: 0.75, color: 'purple' };
  private env: Environment = {
    ...DEFAULT_ENV,
    sunDir: [0.3, 1, 0.45],
    sunColor: [1.75, 1.72, 1.7],
    skyColor: [0.1, 0.12, 0.22],
    groundColor: [0.2, 0.2, 0.22],
    fogColor: [0.02, 0.025, 0.06],
    fogDensity: 0.0015,
    pointLight: { pos: [0, 0, 0], color: [0, 0, 0], range: 7 },
  };

  constructor(private ctx: LevelContext) {
    this.number = ctx.number;
    const { hud, physics } = ctx;
    hud.setLevel(`The Chamber · Level ${this.number}`);
    hud.show(`LEVEL ${this.number}`, '', 2.5);
    hud.hint('');
    this.arrival = new PortalArrival(ctx, SPAWN);

    // The cafeteria: table and button, task stations round the walls, vents in the floor.
    const buttonCollider = addMeetingTable(physics, [0, 0, 0]);
    this.buttonUsable = new ButtonUsable(() => this.pressButton());
    physics.registerUsable(buttonCollider, this.buttonUsable);
    for (const s of STATIONS) {
      const st = new TaskStation(physics, s.kind, s.name, s.anchor, s.normal);
      physics.registerUsable(st.collider, new StationUsable(() => this.startPlayerTask(st)));
      this.stations.push(st);
      this.stationLabels.push({ pos: st.labelPos(), text: s.name, size: 0.17, color: '#cfd8e3' });
    }
    for (const p of VENT_SPOTS) {
      this.vents.push(new Vent(p, Math.abs(p[0]) > Math.abs(p[2]) ? Math.PI / 2 : 0));
      this.ventClose.push(0);
    }

    // The crew: red always comes (someone has to be sus), plus five others; they start round the table.
    const others = CREW_COLORS.filter((c) => c.name !== 'RED').sort(() => Math.random() - 0.5).slice(0, NPC_COUNT - 1);
    const colors: CrewColor[] = [CREW_COLORS[0], ...others].sort(() => Math.random() - 0.5);
    for (let i = 0; i < NPC_COUNT; i++) {
      const a = ((i + 1) / (NPC_COUNT + 1)) * Math.PI * 2;
      const seat: Vec3 = [Math.sin(a) * SEAT_R, 0, Math.cos(a) * SEAT_R];
      const c = new Crewmate(colors[i], seat, a);
      const npc: Npc = {
        c, impostor: false, mode: 'idle', modeT: rand(0, 1.5), target: [...seat], speed: 0, station: null, lastStation: null, taskDur: 0,
        seat, seatYaw: a,
        label: { pos: [0, 0, 0], text: colors[i].name, size: 0.26, color: colors[i].css },
        bubble: { pos: [0, 0, 0], text: '', size: 0.34, color: '#ffffff' },
        bubbleT: 0, sawVent: null, sawFake: null, voteAt: 0, vote: null,
      };
      this.npcs.push(npc);
      this.obstacleList.push({ x: 0, z: 0, r: CREW_RADIUS });
    }
    const forced = this.npcs.find((n) => n.c.color.name === FORCE_IMPOSTOR);
    this.impostor = forced ?? pick(this.npcs);
    this.impostor.impostor = true;
    for (const n of this.npcs) n.modeT = -rand(0.3, 2);

    // Ship dressing (built once): a steel deck over the floor, dark skirting, a stripe round the walls.
    const H = CHAMBER_HALF;
    this.decor.push({ mesh: 'box', model: mul(translation([0, 0.0015, 0]), scaling([H * 2, 0.003, H * 2])), color: [0.44, 0.48, 0.54], pattern: Pattern.panels, param: 3, spec: 0.35, shadow: false });
    for (const [x, z, w, d] of [[0, -H, H * 2, 0], [0, H, H * 2, 0], [-H, 0, 0, H * 2], [H, 0, 0, H * 2]]) {
      const sx = w || 0.06, sz = d || 0.06;
      this.decor.push({ mesh: 'box', model: mul(translation([x, 0.2, z]), scaling([sx, 0.4, sz])), color: [0.18, 0.2, 0.24], spec: 0.3 });
      this.decor.push({ mesh: 'box', model: mul(translation([x, 3.25, z]), scaling([sx, 0.28, sz])), color: [0.22, 0.34, 0.55], spec: 0.3 });
      this.decor.push({ mesh: 'box', model: mul(translation([x, 3.52, z]), scaling([sx, 0.07, sz])), color: [0.9, 0.7, 0.15], spec: 0.3 });
    }
    // Stars, out in space above the (roofless) cafeteria.
    for (let i = 0; i < 150; i++) {
      const az = Math.random() * Math.PI * 2;
      const el = Math.asin(rand(0.12, 1));
      const r = 380;
      const s = rand(0.35, 1.0);
      this.stars.push(mul(translation([Math.cos(az) * Math.cos(el) * r, Math.sin(el) * r, Math.sin(az) * Math.cos(el) * r]), scaling([s, s, s])));
    }
  }

  // --- Helpers -----------------------------------------------------------------------------------

  private get player() {
    return this.ctx.player;
  }

  private playerAlive() {
    return this.player.mode === 'control' && !this.death && !this.player.inPortal;
  }

  private innocents() {
    return this.npcs.filter((n) => !n.impostor && n.c.alive);
  }

  private say(n: Npc, text: string, time = 2.6) {
    n.bubble.text = text;
    n.bubbleT = time;
  }

  /** Fills in {C} (someone else), {V} (the victim), {P} (the place), {X} (the one they saw), {S}. */
  private fill(text: string, speaker: Npc, extra: { v?: Npc | null; p?: string; x?: Npc | null; s?: string } = {}) {
    return text.replace(/\{(\w)\}/g, (_, k: string) => {
      if (k === 'C') {
        const pool: (Npc | 'player')[] = this.npcs.filter((n) => n !== speaker && n.c.alive);
        pool.push('player');
        return lower(pick(pool));
      }
      if (k === 'V') return extra.v ? lower(extra.v) : 'someone';
      if (k === 'X') return extra.x ? upper(extra.x) : 'SOMEONE';
      if (k === 'P') return extra.p ?? 'the table';
      if (k === 'S') return extra.s ?? 'wires';
      return '';
    });
  }

  /** Where something is, in words (for "BODY BY ..."). */
  private placeOf(p: Vec3) {
    let best = 'THE TABLE', bd = Math.hypot(p[0], p[2]) - 2;
    for (const s of this.stations) {
      const d = flat(p, s.stand);
      if (d < bd) {
        bd = d;
        best = s.name.split(' ').pop()!;
      }
    }
    return best.toLowerCase();
  }

  private nextTask(n: Npc) {
    n.modeT = 0;
    if (Math.random() < 0.15) {
      // A little wander instead: somewhere in the room, clear of the table.
      const a = Math.random() * Math.PI * 2, r = rand(TABLE_RADIUS + 1.5, 9.5);
      n.target = [Math.cos(a) * r, 0, Math.sin(a) * r];
      n.station = null;
      n.mode = 'walk';
      return;
    }
    const free = this.stations.filter((s) => s !== n.lastStation && !this.npcs.some((o) => o !== n && o.c.alive && o.station === s));
    const s = free.length ? pick(free) : pick(this.stations);
    n.station = s;
    n.target = [...s.stand];
    n.mode = 'walk';
  }

  // --- The impostor's brain -------------------------------------------------------------------

  /** True if nobody is close enough to see the impostor kill `victim` (the player may be far off, watching). */
  private unwitnessed(victim: Npc | 'player') {
    const vp = victim === 'player' ? this.player.pos : victim.c.pos;
    // The longer the hunt drags on, the bolder it gets.
    const r = NPC_WITNESS - Math.min(2, this.huntT * 0.2);
    for (const o of this.npcs) {
      if (o.impostor || o === victim || !o.c.alive || o.c.hidden) continue;
      if (flat(o.c.pos, vp) < r || flat(o.c.pos, this.impostor.c.pos) < r) return false;
    }
    if (victim !== 'player' && this.playerAlive() && flat(this.player.pos, vp) < PLAYER_WITNESS) return false;
    return true;
  }

  private pickVictim(): Npc | 'player' | null {
    const imp = this.impostor;
    let best: Npc | 'player' | null = null, bestScore = -Infinity;
    const candidates: (Npc | 'player')[] = this.innocents();
    // Not you, at first: you get to see how this works.
    if (this.kills > 0 && this.playerAlive()) candidates.push('player');
    for (const v of candidates) {
      const vp = v === 'player' ? this.player.pos : v.c.pos;
      let lonely = 14;
      for (const o of this.innocents()) if (o !== v) lonely = Math.min(lonely, flat(o.c.pos, vp));
      if (v !== 'player' && this.playerAlive()) lonely = Math.min(lonely + 2, lonely * 0.6 + flat(this.player.pos, vp) * 0.4);
      const score = lonely - flat(vp, imp.c.pos) * 0.15 + Math.random() * 3 - (v === 'player' ? 2 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = v;
      }
    }
    return best;
  }

  private impostorNext(n: Npc) {
    n.modeT = 0;
    if (this.playerAlive() && Math.random() < 0.3) {
      n.mode = 'follow';
      n.taskDur = rand(4, 6.5);
      n.station = null;
      return;
    }
    const free = this.stations.filter((s) => s !== n.lastStation && !this.npcs.some((o) => o !== n && o.c.alive && o.station === s));
    const s = free.length ? pick(free) : pick(this.stations);
    n.station = s;
    n.target = [...s.stand];
    n.mode = 'walk';
  }

  private updateImpostor(n: Npc, dt: number) {
    const c = n.c;
    const hunting = this.started && this.phase === 'play' && this.cool <= 0;
    if (hunting && (n.mode === 'idle' || n.mode === 'walk' || n.mode === 'fake' || n.mode === 'follow')) {
      this.victim = this.pickVictim();
      if (this.victim) {
        n.mode = 'hunt';
        n.station = null;
        this.huntT = 0;
      }
    }
    switch (n.mode) {
      case 'idle':
        n.speed = 0;
        if (n.modeT > 0) this.impostorNext(n);
        break;
      case 'walk':
        n.speed = WALK_SPEED;
        if (flat(c.pos, n.target) < 0.2) {
          if (n.station) {
            n.mode = 'fake';
            n.modeT = 0;
            n.taskDur = rand(3.5, 6);
          } else {
            n.mode = 'idle';
            n.modeT = -rand(1, 2);
          }
        }
        break;
      case 'fake': {
        // Pretending: standing at the station, face to the screen. The screen stays dark.
        n.speed = 0;
        if (n.station) c.lookAt(add(n.station.stand, [-n.station.normal[0], 0, -n.station.normal[2]]), dt);
        if (n.modeT >= n.taskDur) {
          // Anyone close by (and paying attention) noticed.
          for (const o of this.innocents()) if (flat(o.c.pos, c.pos) < 4.5 && Math.random() < 0.5) o.sawFake = n;
          n.lastStation = n.station;
          n.station = null;
          this.impostorNext(n);
        }
        break;
      }
      case 'follow': {
        // Standing much too close to you.
        const p = this.player.pos;
        const d = flat(c.pos, p);
        const k = 1.05 / Math.max(d, 0.01);
        n.target = [p[0] + (c.pos[0] - p[0]) * k, 0, p[2] + (c.pos[2] - p[2]) * k];
        n.speed = d > 2.2 ? HUNT_SPEED : d > 1.25 ? 1.4 : 0;
        if (n.speed === 0) c.lookAt(p, dt);
        if (n.modeT > n.taskDur || !this.playerAlive()) this.impostorNext(n);
        break;
      }
      case 'hunt': {
        const v = this.victim;
        if (!v || (v === 'player' ? !this.playerAlive() : !v.c.alive)) {
          this.victim = this.pickVictim();
          this.huntT = 0;
          if (!this.victim) this.impostorNext(n);
          break;
        }
        const vp = v === 'player' ? this.player.pos : v.c.pos;
        n.target = [vp[0], 0, vp[2]];
        const d = flat(c.pos, vp);
        n.speed = d > KILL_RANGE * 0.8 ? HUNT_SPEED : 0;
        this.huntT += dt;
        if (d < KILL_RANGE && this.unwitnessed(v)) {
          this.startLunge(n, v);
        } else if (this.huntT > 9) {
          this.victim = this.pickVictim();
          this.huntT = 0;
        }
        break;
      }
      case 'lunge':
      case 'vent':
        n.speed = 0;
        break;
      case 'toVent': {
        n.speed = HUNT_SPEED + 0.4;
        if (flat(c.pos, n.target) < 0.25) {
          const from = this.nearestVent(c.pos);
          // Somebody looking? Walk it off instead.
          const seen = this.innocents().some((o) => flat(o.c.pos, c.pos) < NPC_WITNESS - 1) || (this.playerAlive() && flat(this.player.pos, c.pos) < PLAYER_WITNESS);
          if (seen || !from) {
            this.impostorNext(n);
            break;
          }
          this.startVent(n, from);
        }
        break;
      }
      case 'gloat':
        n.speed = 0;
        c.lookAt(this.player.pos, dt);
        c.mouth = 0.35 + 0.35 * Math.sin(this.time * 7);
        break;
      default:
        n.speed = 0;
    }
  }

  private nearestVent(p: Vec3): Vent | null {
    let best: Vent | null = null, bd = Infinity;
    for (const v of this.vents) {
      const d = flat(v.pos, p);
      if (d < bd) {
        bd = d;
        best = v;
      }
    }
    return best;
  }

  private startLunge(imp: Npc, victim: Npc | 'player') {
    imp.mode = 'lunge';
    imp.station = null;
    this.lunge = { imp, victim, t: 0, from: [...imp.c.pos], done: false };
    if (victim !== 'player') {
      victim.mode = 'idle';
      victim.station = null;
      victim.c.frozen = true;
      this.say(victim, '!', 1);
    }
  }

  private updateLunge(dt: number) {
    const L = this.lunge;
    if (!L) return;
    L.t += dt;
    const c = L.imp.c;
    const v = L.victim;
    const vp: Vec3 = v === 'player' ? this.player.pos : v.c.pos;
    let head: Vec3;
    if (v === 'player') {
      const h = this.player.partFrames().head;
      head = [h[12], h[13], h[14]];
    } else head = v.c.visor();
    c.lookAt(vp, dt, 30);
    if (v !== 'player') v.c.lookAt(c.pos, dt, 20);
    // Leap in close.
    const dx = vp[0] - L.from[0], dz = vp[2] - L.from[2];
    const d = Math.hypot(dx, dz) || 1;
    const k = clamp(L.t / 0.16, 0, 1);
    const stop = Math.max(0, d - 0.8);
    c.pos[0] = L.from[0] + (dx / d) * stop * k;
    c.pos[2] = L.from[2] + (dz / d) * stop * k;
    c.lift = Math.sin(k * Math.PI) * 0.25;
    c.mouth = L.t < 0.42 ? clamp(L.t / 0.12, 0, 1) : clamp(1 - (L.t - 0.42) / 0.2, 0, 1);
    c.tongue = L.t < 0.3 ? clamp((L.t - 0.1) / 0.16, 0, 1) : clamp(1 - (L.t - 0.3) / 0.14, 0, 1);
    c.tongueTo = head;
    if (!L.done && L.t >= 0.26) {
      L.done = true;
      stab();
      this.ctx.camera.addShake(v === 'player' ? 0.8 : flat(this.player.pos, vp) < 12 ? 0.15 : 0);
      if (v === 'player') {
        const away: Vec3 = [dx / d, 0, dz / d];
        this.player.kill([away[0] * 6, 4, away[2] * 6], { violence: 30, origin: head });
        this.playerKilled(L.imp);
      } else {
        v.c.frozen = false;
        v.c.kill(c.pos);
        v.bubble.text = '';
        this.addCorpse(v);
        this.kills++;
      }
    }
    if (L.t >= 0.7) {
      c.mouth = c.tongue = 0;
      c.lift = 0;
      this.lunge = null;
      this.cool = rand(...KILL_COOLDOWN);
      if (v === 'player') {
        L.imp.mode = 'gloat';
        return;
      }
      if (this.innocents().length === 0) {
        // Just you and it now.
        L.imp.mode = 'idle';
        L.imp.modeT = -99;
        this.startDark('numbers');
        return;
      }
      const vent = this.nearestVent(c.pos);
      if (vent && flat(vent.pos, c.pos) < 9) {
        L.imp.mode = 'toVent';
        L.imp.target = [vent.pos[0], 0, vent.pos[2]];
      } else this.impostorNext(L.imp);
    }
  }

  private startVent(imp: Npc, from: Vent) {
    const others = this.vents.filter((v) => v !== from);
    const quiet = others.filter((v) => !this.innocents().some((o) => flat(o.c.pos, v.pos) < 6) && !(this.playerAlive() && flat(this.player.pos, v.pos) < PLAYER_WITNESS));
    const to = quiet.length && Math.random() < 0.8 ? pick(quiet) : pick(others);
    imp.mode = 'vent';
    imp.c.pos = [from.pos[0], 0, from.pos[2]];
    this.vent = { imp, from, to, t: 0, popped: false };
    from.target = 1;
    this.ventClose[this.vents.indexOf(from)] = 0.75;
    clank();
  }

  private updateVent(dt: number) {
    const V = this.vent;
    if (!V) return;
    V.t += dt;
    const c = V.imp.c;
    const t = V.t;
    if (t < 0.55) {
      // A little hop, then straight down the hole.
      c.lift = t < 0.18 ? Math.sin((t / 0.18) * Math.PI / 2) * 0.5 : Math.max(-1.8, 0.5 - ((t - 0.18) / 0.3) * 2.3);
      c.hidden = c.lift < -1.6;
      V.imp.label.text = t > 0.3 ? '' : c.color.name;
      return;
    }
    const travel = 1.3;
    if (t < 0.55 + travel) {
      c.hidden = true;
      c.pos = [V.to.pos[0], 0, V.to.pos[2]];
      return;
    }
    if (!V.popped) {
      V.popped = true;
      V.to.target = 1;
      this.ventClose[this.vents.indexOf(V.to)] = 0.9;
      clank();
      c.hidden = false;
      V.imp.label.text = c.color.name;
      // Anyone nearby sees it pop out.
      for (const o of this.innocents()) if (flat(o.c.pos, V.to.pos) < 6.5 && Math.random() < 0.75) o.sawVent = V.imp;
    }
    const k = (t - 0.55 - travel) / 0.5;
    c.lift = k < 0.6 ? -1.8 + (k / 0.6) * 2.3 : 0.5 * (1 - (k - 0.6) / 0.4);
    if (k >= 1) {
      c.lift = 0;
      this.vent = null;
      this.impostorNext(V.imp);
    }
  }

  // --- Bodies, reports, meetings -----------------------------------------------------------------

  private addCorpse(npc: Npc) {
    const { physics } = this.ctx;
    const pos: Vec3 = [npc.c.pos[0], 0, npc.c.pos[2]];
    const collider = physics.addStaticCylinder([pos[0], 0.45, pos[2]], CREW_RADIUS, 0.9);
    const corpse: Corpse = { npc, pos, collider, usable: new CorpseUsable(() => this.report('player', corpse)), age: 0 };
    physics.registerUsable(collider, corpse.usable);
    this.corpses.push(corpse);
  }

  private report(by: Npc | 'player', corpse: Corpse) {
    if (this.phase !== 'play') return;
    if (by === 'player' && !this.playerAlive()) return;
    this.startMeeting('body', by, corpse);
  }

  private pressButton() {
    if (this.phase !== 'play' || !this.playerAlive() || !this.started) return;
    const { hud } = this.ctx;
    this.buttonPressedAt = this.time;
    sfx.button();
    if (this.meetingsLeft <= 0) {
      hud.show('NO MEETINGS LEFT', "You've used them all. Try finding a body. There'll be one along shortly.", 2.5);
      return;
    }
    if (this.buttonCool > 0) {
      hud.show(`${Math.ceil(this.buttonCool)}`, 'The button is cooling down. So should you.', 1.5);
      return;
    }
    this.meetingsLeft--;
    this.startMeeting('button', 'player', null);
  }

  private startMeeting(kind: 'button' | 'body', reporter: Npc | 'player', corpse: Corpse | null) {
    const { hud } = this.ctx;
    this.phase = 'call';
    this.phaseT = 0;
    this.pendingReport = null;
    this.cancelPlayerTask();
    // Whatever the impostor was up to stops (a kill not yet landed doesn't land).
    if (this.lunge && !this.lunge.done) {
      const v = this.lunge.victim;
      if (v !== 'player') v.c.frozen = false;
    }
    this.lunge = null;
    this.vent = null;
    const victim = corpse?.npc ?? null;
    let suspect: Npc | 'player' | null = null;
    if (corpse) {
      let bd = Infinity;
      for (const n of this.npcs) {
        if (!n.c.alive || n === reporter) continue;
        const d = flat(n.c.pos, corpse.pos);
        if (d < bd) {
          bd = d;
          suspect = n;
        }
      }
      if (reporter !== 'player' && flat(this.player.pos, corpse.pos) < bd) suspect = 'player';
    }
    const who = reporter === 'player' ? 'You' : upper(reporter);
    if (kind === 'body') {
      hud.show('DEAD BODY REPORTED', `${who} found ${victim ? upper(victim) : 'someone'}. Well, most of ${victim ? upper(victim) : 'them'}.`, CALL_TIME);
      bodySting();
    } else {
      hud.show('EMERGENCY MEETING!', `${who} pressed the big red button.`, CALL_TIME);
      alarm();
    }
    this.meeting = {
      kind, reporter, victim, suspect, lines: [], playerVote: null, locked: false, chips: [], ejected: null, tie: false, announced: false, trapdoor: null,
    };
    for (const n of this.npcs) {
      n.bubble.text = '';
      n.c.vel[0] = n.c.vel[2] = 0;
      if (n.c.alive) n.c.frozen = true;
    }
  }

  /** Everyone round the table (the bodies are tidied away), and the arguing starts. */
  private warpToTable() {
    const { player, camera, physics } = this.ctx;
    for (const cp of this.corpses) {
      cp.collider.setEnabled(false);
      cp.npc.c.hidden = true;
    }
    this.corpses.length = 0;
    for (const n of this.npcs) {
      if (!n.c.alive) continue;
      const c = n.c;
      c.pos = [...n.seat];
      c.facing = n.seatYaw;
      c.vel = [0, 0, 0];
      c.lift = c.mouth = c.tongue = 0;
      c.hidden = false;
      c.frozen = false;
      n.label.text = c.color.name;
      n.mode = 'seat';
      n.station = null;
      n.vote = null;
    }
    player.pos = [0, 0, SEAT_R];
    player.facing = 0;
    player.resume([0, 0, 0]);
    camera.yaw = 0;
    camera.pitch = -0.28;
    void physics;
    this.scriptLines();
    this.phase = 'discuss';
    this.phaseT = 0;
  }

  /** Who says what, and when. */
  private scriptLines() {
    const m = this.meeting!;
    const alive = this.npcs.filter((n) => n.c.alive);
    const lines: Line[] = [];
    const place = m.victim ? this.placeOf(m.victim.c.pos) : 'the table';
    const extra = { v: m.victim, p: place };
    let t = 0.3;
    if (m.reporter !== 'player') {
      lines.push({ npc: m.reporter, text: this.fill(pick(BODY_OPENERS), m.reporter, extra), at: t, shown: false });
    } else {
      const n = pick(alive);
      lines.push({ npc: n, text: this.fill(pick(m.kind === 'button' ? BUTTON_REACTIONS : REPORT_REACTIONS), n, extra), at: t, shown: false });
    }
    const order = alive.slice().sort(() => Math.random() - 0.5);
    for (const n of order) {
      if (lines.some((l) => l.npc === n)) continue;
      t += rand(0.5, 1.1);
      let text: string;
      if (n.impostor) text = this.fill(pick(IMPOSTOR_CHATTER), n, extra);
      else if (n.sawVent) text = this.fill(pick(VENT_WITNESS), n, { ...extra, x: n.sawVent });
      else if (n.sawFake && n.sawFake.c.alive) text = this.fill(pick(FAKE_WITNESS), n, { ...extra, x: n.sawFake, s: n.sawFake.lastStation?.name.toLowerCase() ?? 'wires' });
      else text = this.fill(pick(CHATTER), n, extra);
      lines.push({ npc: n, text, at: t, shown: false });
    }
    // A second, shorter round from some of them.
    for (const n of order) {
      if (Math.random() < 0.45) {
        t = Math.min(DISCUSS_TIME - 1.2, t + rand(0.4, 0.9));
        lines.push({ npc: n, text: this.fill(pick(n.impostor ? IMPOSTOR_CHATTER : CHATTER), n, extra), at: t, shown: false });
      }
    }
    m.lines = lines;
  }

  /** Who the player would vote for right now: the crewmate they're standing by, or SKIP. */
  private voteCandidate(): Vote | null {
    const p = this.player.pos;
    let best: Npc | null = null, bd = VOTE_REACH;
    for (const n of this.npcs) {
      if (!n.c.alive) continue;
      const d = flat(n.c.pos, p);
      if (d < bd) {
        bd = d;
        best = n;
      }
    }
    if (best) return best;
    if (flat(SKIP_POS, p) < SKIP_R + 0.35) return 'skip';
    return null;
  }

  private tally() {
    const m = this.meeting!;
    const pv = m.locked ? m.playerVote : this.voteCandidate();
    m.playerVote = pv;
    const alive = this.npcs.filter((n) => n.c.alive);
    for (const n of alive) {
      let v: Vote;
      const others = alive.filter((o) => o !== n);
      const randomVote = (): Vote => (Math.random() < 0.25 ? 'skip' : Math.random() < 0.2 ? 'player' : others.length ? pick(others) : 'skip');
      if (n.impostor) {
        if (pv && pv !== n && pv !== 'skip') v = Math.random() < 0.7 ? pv : 'player';
        else if (pv === n) v = Math.random() < 0.6 || !others.length ? 'player' : pick(others);
        else v = Math.random() < 0.5 ? 'skip' : randomVote();
      } else if (n.sawVent && n.sawVent.c.alive) {
        v = Math.random() < 0.9 ? n.sawVent : randomVote();
      } else {
        // Most of them go along with you (and with nothing to go on, they skip).
        const r = Math.random();
        if (r < 0.68 && pv !== n) v = pv ?? 'skip';
        else if (r < 0.86) v = (n.sawFake && n.sawFake.c.alive && n.sawFake !== n ? n.sawFake : m.suspect && m.suspect !== n ? m.suspect : 'skip');
        else v = randomVote();
      }
      n.vote = v;
    }
    // Count (the player's vote too), and hand out the chips.
    const counts = new Map<Vote, number>();
    const chipAt = (v: Vote, i: number): Vec3 => {
      const base: Vec3 = v === 'skip' ? [SKIP_POS[0], 1.5, SKIP_POS[2]] : v === 'player' ? [this.player.pos[0], 2.55, this.player.pos[2]] : [v.c.pos[0], 2.05, v.c.pos[2]];
      const row = Math.floor(i / 4), col = i % 4;
      // Along the ring (tangent), so the row faces the middle of the table.
      const r = Math.hypot(base[0], base[2]) || 1;
      const tx = -base[2] / r, tz = base[0] / r;
      const off = (col - 1.5) * 0.4;
      return [base[0] + tx * off, base[1] + row * 0.4, base[2] + tz * off];
    };
    let i = 0;
    const add1 = (v: Vote | null, color: number[]) => {
      if (!v) return;
      const k = counts.get(v) ?? 0;
      counts.set(v, k + 1);
      m.chips.push({ at: chipAt(v, k), color, t: 0.4 + i++ * 0.28 });
    };
    add1(pv, PLAYER_COLOR);
    for (const n of alive) add1(n.vote, n.c.color.body);
    let top: Vote | null = null, topN = 0, tie = false;
    for (const [v, k] of counts) {
      if (k > topN) {
        top = v;
        topN = k;
        tie = false;
      } else if (k === topN) tie = true;
    }
    // A tie goes the player's way if they're in it (they have the casting vote; they're tallest).
    if (tie && pv && counts.get(pv) === topN) {
      top = pv;
      tie = false;
    }
    m.tie = tie;
    m.ejected = tie || !top || top === 'skip' ? null : top;
  }

  // --- The player's own tasks ------------------------------------------------------------------

  private startPlayerTask(st: TaskStation) {
    if (this.phase !== 'play' && this.phase !== 'won') return;
    if (!this.playerAlive() || this.playerTask) return;
    const cool = this.playerDone.get(st) ?? 0;
    if (cool > 0) {
      this.ctx.hud.show('DONE', pick(["Already done. Doing it twice doesn't make it more done.", 'You did that one. Go find another.', 'Task complete. Still.']), 1.8);
      return;
    }
    this.playerTask = { station: st, t: 0 };
    sfx.click();
  }

  /** Where you stand to do a station's task. */
  private stationFront(s: TaskStation): Vec3 {
    return s.stand;
  }

  private cancelPlayerTask() {
    this.playerTask = null;
  }

  private taskDone(value: number) {
    if (this.phase === 'won' || this.phase === 'over' || this.phase === 'dark') return;
    this.tasks = Math.min(TASKS_TOTAL, this.tasks + value);
    taskBlip();
    if (this.tasks >= TASKS_TOTAL && this.phase === 'play') this.win('tasks');
  }

  // --- Endings ---------------------------------------------------------------------------------

  private win(how: 'vote' | 'tasks') {
    const { hud } = this.ctx;
    this.phase = 'won';
    this.phaseT = 0;
    this.lunge = null;
    const imp = this.impostor;
    if (how === 'vote') {
      hud.show('VICTORY', pick([`${imp.c.color.name} was the impostor. The crew celebrates by going straight back to work.`, 'Crewmates win. The cafeteria is safe. The food is still terrible.']), 4);
    } else {
      hud.show('VICTORY', `Tasks complete. ${imp.c.color.name} was the impostor, and is now unemployed.`, 4);
      if (imp.c.alive) {
        this.say(imp, 'gg', 99);
        imp.mode = 'idle';
        imp.modeT = -999;
        imp.station = null;
      }
    }
    fanfare();
    for (const n of this.npcs) {
      if (!n.c.alive || n.impostor) continue;
      n.c.cheering = true;
      n.mode = 'idle';
      n.modeT = -2.8;
      n.station = null;
      n.c.frozen = false;
      this.say(n, pick(['GG', 'WE WON', 'EZ', 'told u', 'crewmates!!', 'yay']), 2.5);
    }
    this.exit.openNow();
  }

  /** The lights go out; the impostor comes for you. */
  private startDark(reason: 'wrongVote' | 'numbers', ejected: Npc | null = null) {
    this.phase = 'dark';
    this.phaseT = 0;
    this.darkReason = reason;
    this.darkEjected = ejected;
    this.darkPlaced = false;
    this.cancelPlayerTask();
    this.ctx.hud.hide();
    powerDown();
  }

  private die(big: string, small: string, hint: string, killer: Npc | null, delay = DEATH_SCREEN_DELAY) {
    if (this.death) return;
    this.death = { t: 0, delay, big, small, hint, killer };
    this.phase = 'over';
    this.cancelPlayerTask();
  }

  // --- Update ----------------------------------------------------------------------------------

  update(dt: number) {
    const { player, hud, input } = this.ctx;
    this.time += dt;
    this.phaseT += dt;
    const death = this.death;
    if (death && this.status === 'playing') {
      death.t += dt;
      if (death.t > death.delay) {
        this.status = 'lost';
        hud.show(death.big, `${death.small}\nPress R to try again.`);
        hud.tips([['Hint', death.hint], ['Controls', 'WASD move · Shift sprint · E use / report / vote · Mouse look']]);
      }
    }
    this.arrival.update(dt);
    this.exit.update(dt, player);
    if (this.exit.entered && this.status === 'playing') this.status = 'exited';
    if (!this.started && this.arrival.done) {
      this.started = true;
      this.startedAt = this.time;
      hud.show('CREWMATE', 'There is 1 impostor among us.\n(It is not you. We checked.)', 3.2);
      roleSting();
    }
    if (this.phase !== 'vote' && this.phase !== 'discuss' && this.phase !== 'reveal') this.riff.stop();
    else this.riff.start();
    if (this.phase === 'play' || this.phase === 'won') this.hum.start();
    else this.hum.stop();

    // Lights: out in the dark ending, flickering red during a call.
    const wantLight = this.phase === 'dark' ? 0.035 : this.phase === 'over' && this.darkPlaced ? 0.16 : 1;
    this.light += (wantLight - this.light) * (1 - Math.exp(-dt * (wantLight < this.light ? 5 : 1.5)));

    this.buttonCool = Math.max(0, this.buttonCool - dt);
    for (const [s, t] of this.playerDone) this.playerDone.set(s, Math.max(0, t - dt));
    if (this.started && this.phase === 'play') this.cool -= dt;
    // The task bar creeps toward the real count.
    this.taskShown += (this.tasks - this.taskShown) * (1 - Math.exp(-dt * 3));

    switch (this.phase) {
      case 'play':
      case 'won':
      case 'over':
        this.updateCrew(dt);
        break;
      case 'call':
        if (this.phaseT >= CALL_TIME) this.warpToTable();
        break;
      case 'discuss':
      case 'vote':
      case 'reveal':
      case 'eject':
        this.updateMeeting(dt);
        break;
      case 'dark':
        this.updateDark(dt);
        break;
    }
    this.updateLunge(dt);
    this.updateVent(dt);

    // Stations: lit only while a real crewmate (or you) is doing the task.
    for (const s of this.stations) {
      s.lit = 0;
      s.update(dt);
    }
    for (const n of this.npcs) {
      if (n.mode === 'task' && n.station && n.c.alive && !n.impostor) {
        n.station.lit = 1;
        n.station.progress = clamp(n.modeT / n.taskDur, 0, 1);
      }
    }
    const pt = this.playerTask;
    if (pt) {
      const st = pt.station;
      if (!this.playerAlive() || flat(player.pos, this.stationFront(st)) > 2.4) this.cancelPlayerTask();
      else {
        pt.t += dt;
        st.lit = 1;
        st.progress = pt.t / PLAYER_TASK_TIME;
        if (pt.t >= PLAYER_TASK_TIME) {
          this.playerTask = null;
          this.playerDone.set(st, 25);
          this.taskDone(PLAYER_TASK_VALUE);
        }
      }
    }

    // Vents shut themselves after a moment.
    for (let i = 0; i < this.vents.length; i++) {
      if (this.ventClose[i] > 0) {
        this.ventClose[i] -= dt;
        if (this.ventClose[i] <= 0) this.vents[i].target = 0;
      }
      this.vents[i].update(dt);
    }

    // Bodies: found by whoever walks past (or reported by you: E near one).
    for (const cp of this.corpses) cp.age += dt;
    if (this.phase === 'play' && this.started) {
      if (this.playerAlive() && input.wasPressed('KeyE')) {
        // E near a body reports it; E in front of a station does the task (the crosshair works too).
        const near = this.corpses.find((cp) => flat(cp.pos, player.pos) < PLAYER_REPORT_RANGE);
        if (near) this.report('player', near);
        else {
          const st = this.stations.find((s) => flat(this.stationFront(s), player.pos) < 1.7);
          if (st) this.startPlayerTask(st);
        }
      }
      if (this.phase === 'play' && !this.pendingReport) {
        for (const cp of this.corpses) {
          if (cp.age < 1.2) continue;
          const finder = this.innocents().find((n) => flat(n.c.pos, cp.pos) < REPORT_RANGE && n.mode !== 'lunge');
          if (finder) {
            this.pendingReport = { npc: finder, corpse: cp, t: 0 };
            finder.mode = 'idle';
            finder.modeT = -5;
            finder.station = null;
            this.say(finder, pick(['BODY!!', 'AAAA', 'omg', '!!!']), 1.5);
            break;
          }
        }
      }
      const pr = this.pendingReport;
      if (pr) {
        pr.t += dt;
        pr.npc.c.lookAt(pr.corpse.pos, dt);
        if (pr.t > 0.8) this.report(pr.npc, pr.corpse);
      }
    }

    // Speech bubbles fade.
    for (const n of this.npcs) {
      if (n.bubbleT > 0) {
        n.bubbleT -= dt;
        if (n.bubbleT <= 0) n.bubble.text = '';
      }
      n.c.update(dt);
    }
  }

  /** Crewmates going about their business (and the impostor going about its). */
  private updateCrew(dt: number) {
    const player = this.player;
    for (const n of this.npcs) {
      const c = n.c;
      if (!c.alive) continue;
      n.modeT += dt;
      if (n.impostor && this.phase === 'play') {
        this.updateImpostor(n, dt);
      } else if (n.impostor && this.phase === 'over') {
        if (n.mode !== 'gloat') n.speed = 0;
        if (n.mode === 'gloat') this.updateImpostor(n, dt);
      } else {
        if (this.phase === 'won' && c.cheering && n.modeT > 0) c.cheering = false;
        if (n.impostor && this.phase === 'won') {
          n.speed = 0;
        } else {
          switch (n.mode) {
            case 'idle':
            case 'seat':
              n.speed = 0;
              if (n.modeT > 0 && !c.frozen) this.nextTask(n);
              break;
            case 'walk':
              n.speed = WALK_SPEED;
              if (flat(c.pos, n.target) < 0.2) {
                if (n.station) {
                  n.mode = 'task';
                  n.modeT = 0;
                  n.taskDur = rand(3.5, 5.5);
                } else {
                  n.mode = 'idle';
                  n.modeT = -rand(1, 2.5);
                }
              }
              break;
            case 'task':
              n.speed = 0;
              if (n.station) c.lookAt(add(n.station.stand, [-n.station.normal[0], 0, -n.station.normal[2]]), dt);
              if (n.modeT >= n.taskDur) {
                n.lastStation = n.station;
                n.station = null;
                this.taskDone(1);
                this.nextTask(n);
              }
              break;
            default:
              n.speed = 0;
          }
        }
      }
      if (c.frozen || n.mode === 'lunge' || n.mode === 'vent') {
        c.vel[0] = c.vel[2] = 0;
        continue;
      }
      this.steer(n, dt);
    }
    this.separate(player.pos);
  }

  /** Walks toward `target`, round the table. */
  private steer(n: Npc, dt: number) {
    const c = n.c, p = c.pos;
    const dx = n.target[0] - p[0], dz = n.target[2] - p[2];
    const d = Math.hypot(dx, dz);
    if (d < 0.06 || n.speed <= 0) {
      c.vel[0] = c.vel[2] = 0;
      return;
    }
    let ux = dx / d, uz = dz / d;
    const A = TABLE_RADIUS + CREW_RADIUS + 0.4;
    const r = Math.hypot(p[0], p[2]);
    const along = clamp(-(p[0] * ux + p[2] * uz), 0, d);
    const cx = p[0] + ux * along, cz = p[2] + uz * along;
    if (Math.hypot(cx, cz) < A && r > 0.01) {
      // Heading through the table: go round it the short way.
      const ap = Math.atan2(p[2], p[0]), at = Math.atan2(n.target[2], n.target[0]);
      let delta = at - ap;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      const s = delta >= 0 ? 1 : -1;
      const out = clamp((A + 0.3 - r) / 0.6, 0, 1);
      ux = (-p[2] / r) * s + (p[0] / r) * out;
      uz = (p[0] / r) * s + (p[2] / r) * out;
      const l = Math.hypot(ux, uz);
      ux /= l;
      uz /= l;
    }
    const sp = Math.min(n.speed, d * 5 + 0.3);
    c.vel[0] = ux * sp;
    c.vel[2] = uz * sp;
    void dt;
  }

  /** Keeps crewmates out of each other, the player, the table, the stations and the walls. */
  private separate(playerPos: Vec3) {
    const live = this.npcs;
    for (let i = 0; i < live.length; i++) {
      const a = live[i].c;
      if (!a.alive || a.hidden || live[i].mode === 'lunge' || live[i].mode === 'vent') continue;
      for (let j = i + 1; j < live.length; j++) {
        const b = live[j].c;
        if (!b.alive || b.hidden || live[j].mode === 'lunge' || live[j].mode === 'vent') continue;
        const dx = b.pos[0] - a.pos[0], dz = b.pos[2] - a.pos[2];
        const d = Math.hypot(dx, dz), min = CREW_RADIUS * 2 + 0.05;
        if (d < min && d > 1e-4) {
          const push = (min - d) / 2;
          a.pos[0] -= (dx / d) * push;
          a.pos[2] -= (dz / d) * push;
          b.pos[0] += (dx / d) * push;
          b.pos[2] += (dz / d) * push;
        }
      }
      // Not through the player either (unless it's the impostor lunging).
      if (this.playerAlive()) {
        const dx = a.pos[0] - playerPos[0], dz = a.pos[2] - playerPos[2];
        const d = Math.hypot(dx, dz), min = CREW_RADIUS + 0.4;
        if (d < min && d > 1e-4) {
          a.pos[0] += (dx / d) * (min - d);
          a.pos[2] += (dz / d) * (min - d);
        }
      }
      const r = Math.hypot(a.pos[0], a.pos[2]), A = TABLE_RADIUS + CREW_RADIUS + 0.05;
      if (r < A && r > 1e-4) {
        a.pos[0] *= A / r;
        a.pos[2] *= A / r;
      }
      for (const s of this.stations) {
        // Stations stick out of the walls: keep out of their boxes.
        const along = Math.abs(s.normal[0]) > 0.5 ? 2 : 0, out = along === 2 ? 0 : 2;
        const half = s.kind === 'terminal' || s.kind === 'chute' ? 0.75 : 0.45;
        const depth = s.kind === 'terminal' ? 0.8 : s.kind === 'chute' ? 0.95 : 0.3;
        const du = a.pos[along] - s.anchor[along];
        const dn = (a.pos[out] - s.anchor[out]) * (s.normal[out] || 1);
        if (Math.abs(du) < half + CREW_RADIUS && dn < depth + CREW_RADIUS) {
          a.pos[out] = s.anchor[out] + (s.normal[out] || 1) * (depth + CREW_RADIUS);
        }
      }
      const lim = CHAMBER_HALF - CREW_RADIUS - 0.05;
      a.pos[0] = clamp(a.pos[0], -lim, lim);
      a.pos[2] = clamp(a.pos[2], -lim, lim);
    }
  }

  private updateMeeting(dt: number) {
    const m = this.meeting!;
    const { hud, input } = this.ctx;
    const t = this.phaseT;
    for (const n of this.npcs) {
      if (!n.c.alive) continue;
      n.c.vel[0] = n.c.vel[2] = 0;
      if (this.phase !== 'eject' || m.ejected !== n) n.c.lookAt(this.phase === 'vote' ? this.player.pos : [0, 0, 0], dt, 3);
    }
    switch (this.phase) {
      case 'discuss':
        for (const l of m.lines) {
          if (!l.shown && t >= l.at && l.npc.c.alive) {
            l.shown = true;
            this.say(l.npc, l.text, 2.6);
            tone(rand(500, 800), 0.05, { wave: 'square', vol: 0.04 });
          }
        }
        if (t >= DISCUSS_TIME) {
          this.phase = 'vote';
          this.phaseT = 0;
          // (What they said stays up a moment longer; their VOTED badges come after.)
          for (const n of this.npcs) n.voteAt = rand(2.5, VOTE_TIME - 1.5);
          hud.show('WHO IS THE IMPOSTOR?', 'Stand next to your suspect and press E. Or stand on SKIP. No pressure.', 3.5);
          tone(note('A4'), 0.15, { wave: 'square', vol: 0.08 });
          tone(note('E5'), 0.3, { wave: 'square', vol: 0.08, at: 0.15 });
        }
        break;
      case 'vote': {
        for (const n of this.npcs) {
          if (n.c.alive && t >= n.voteAt && !n.bubble.text) {
            this.say(n, 'VOTED', 99);
            n.bubble.color = '#9fe8a8';
            sfx.click();
          }
        }
        if (!m.locked && this.playerAlive() && input.wasPressed('KeyE')) {
          const v = this.voteCandidate();
          if (v) {
            m.playerVote = v;
            m.locked = true;
            sfx.button();
            hud.show(v === 'skip' ? 'SKIPPED' : `YOU VOTED ${upper(v as Npc)}`, v === 'skip' ? 'Coward. (Probably wise.)' : 'No take-backs.', 1.6);
          }
        }
        const left = Math.ceil(VOTE_TIME - t);
        if (VOTE_TIME - t < 3.05 && Math.ceil(VOTE_TIME - t + dt) !== left) tone(880, 0.06, { wave: 'square', vol: 0.06 });
        if (t >= VOTE_TIME) {
          this.tally();
          this.phase = 'reveal';
          this.phaseT = 0;
          for (const n of this.npcs) {
            n.bubble.text = '';
            n.bubble.color = '#ffffff';
          }
          hud.hide();
        }
        break;
      }
      case 'reveal':
        for (const ch of m.chips) {
          if (ch.t > 0 && t >= ch.t) {
            ch.t = -1;
            sfx.pop();
          }
        }
        if (t >= REVEAL_TIME) {
          this.phase = 'eject';
          this.phaseT = 0;
          const e = m.ejected;
          if (e === 'player') m.trapdoor = { pos: [this.player.pos[0], 0, this.player.pos[2]], t: -0.3 };
          else if (e) m.trapdoor = { pos: [e.c.pos[0], 0, e.c.pos[2]], t: -0.3 };
        }
        break;
      case 'eject': {
        const e = m.ejected;
        if (m.trapdoor) {
          const before = m.trapdoor.t;
          m.trapdoor.t += dt;
          if (before < 0 && m.trapdoor.t >= 0) {
            whoosh();
            if (e === 'player') {
              // Out into space, where there's no gravity to bring you back.
              this.player.kill([rand(-0.5, 0.5), 13, rand(-0.5, 0.5)], { violence: 6 });
              const body = this.player.body;
              if (body) for (const k in body.parts) body.parts[k as keyof typeof body.parts].setGravityScale(-0.04, true);
              this.playerEjected = true;
            } else if (e) {
              e.c.eject();
              e.label.text = '';
              e.bubble.text = '';
            }
          }
        }
        if (!m.announced && t >= (e ? 1.4 : 0.3)) {
          m.announced = true;
          if (!e) hud.show('NO ONE WAS EJECTED.', m.tie ? '(Tied. Democracy is hard.)' : '(Skipped. The impostor thanks you for your patience.)', 3);
          else if (e === 'player') {
            hud.show('ORANGE WAS NOT THE IMPOSTOR.', '1 impostor remains. It voted for you too.', 3.5);
            this.die('DEFEAT', `The crew voted you out. ${this.impostor.c.color.name} was the impostor, and waved you off.`, 'Vote for someone (stand next to them and press E) or stand on SKIP. Stand around doing nothing and the crew might pick you.', null, 3.8);
          } else if (e.impostor) {
            hud.show(`${e.c.color.name} WAS THE IMPOSTOR.`, '0 impostors remain.', 3);
          } else {
            hud.show(`${e.c.color.name} WAS NOT THE IMPOSTOR.`, '1 impostor remains.', 3);
          }
        }
        if (t >= (e ? EJECT_TIME : 2.8) && this.phase === 'eject') this.afterMeeting();
        break;
      }
    }
  }

  private afterMeeting() {
    const m = this.meeting!;
    const e = m.ejected;
    this.meeting = null;
    for (const n of this.npcs) {
      n.sawVent = n.sawFake = null;
      n.bubble.text = '';
    }
    if (e && e !== 'player' && e.impostor) {
      this.win('vote');
      return;
    }
    if (e && e !== 'player' && m.playerVote === e) {
      this.startDark('wrongVote', e);
      return;
    }
    if (this.innocents().length === 0) {
      this.startDark('numbers');
      return;
    }
    this.phase = 'play';
    this.phaseT = 0;
    this.cool = rand(...AFTER_MEETING_COOLDOWN);
    this.buttonCool = BUTTON_COOLDOWN;
    for (const n of this.npcs) {
      if (!n.c.alive) continue;
      n.mode = 'idle';
      n.modeT = -rand(0.2, 1.2);
    }
  }

  private updateDark(dt: number) {
    const t = this.phaseT;
    const imp = this.impostor;
    const c = imp.c;
    const { player, camera } = this.ctx;
    for (const n of this.npcs) {
      if (n.c.alive && n !== imp) {
        n.c.vel[0] = n.c.vel[2] = 0;
        n.c.frozen = true;
      }
    }
    if (!this.darkPlaced && t > 0.9) {
      // Right in front of you, visor glowing.
      this.darkPlaced = true;
      // (A little to the right: the camera looks over your right shoulder.)
      const f: Vec3 = [-Math.sin(camera.yaw), 0, -Math.cos(camera.yaw)];
      const rt: Vec3 = [Math.cos(camera.yaw), 0, -Math.sin(camera.yaw)];
      const lim = CHAMBER_HALF - 1;
      let p: Vec3 = [clamp(player.pos[0] + f[0] * 2.8 + rt[0] * 0.8, -lim, lim), 0, clamp(player.pos[2] + f[2] * 2.8 + rt[2] * 0.8, -lim, lim)];
      if (Math.hypot(p[0], p[2]) < TABLE_RADIUS + 0.6) p = [player.pos[0] - f[0] * 1.6, 0, player.pos[2] - f[2] * 1.6];
      c.pos = p;
      c.hidden = false;
      c.frozen = false;
      c.lift = 0;
      imp.mode = 'seat';
      imp.label.text = c.color.name;
      this.vent = null;
    }
    if (this.darkPlaced) {
      c.glow = Math.min(1, c.glow + dt * 3);
      c.lookAt(player.pos, dt, 10);
      const d = flat(c.pos, player.pos);
      if (!this.lunge && t < 2.1 && d > 1.1) {
        // A slow, creepy walk toward you.
        c.vel[0] = ((player.pos[0] - c.pos[0]) / d) * 1.3;
        c.vel[2] = ((player.pos[2] - c.pos[2]) / d) * 1.3;
      } else {
        c.vel[0] = c.vel[2] = 0;
      }
      if (t >= 2.1 && !this.lunge && this.playerAlive()) this.startLunge(imp, 'player');
    }
  }

  /** The impostor got you: in the dark (a wrong vote, or it's just the two of you), or alone. */
  private playerKilled(imp: Npc) {
    const name = imp.c.color.name;
    if (this.phase === 'dark') {
      if (this.darkReason === 'wrongVote') {
        const ej = this.darkEjected ? this.darkEjected.c.color.name : 'THEY';
        this.die('DEFEAT', `${ej} was not the impostor. ${name} was.\n${name} would like to thank you for your vote.`, "Only vote when you're sure (SKIP is always an option). " + DEATH_HINT, imp, 2.4);
      } else {
        this.die('DEFEAT', pick([`Only you and ${name} were left. ${name} was the impostor. Awkward.`, `The impostor wins. ${name} ate everyone. You were dessert.`]), 'Every body left lying around makes the crew smaller: report them (E) and vote. ' + DEATH_HINT, imp, 2.4);
      }
      return;
    }
    this.die('DEFEAT', pick([
      `You were alone with ${name}. ${name} was the impostor. Rookie mistake.`,
      `${name} was the impostor. Nobody saw a thing. That was the idea.`,
      `${name} stood a bit close, then a lot closer. ${name} was the impostor.`,
    ]), 'It only kills when nobody else is close enough to see, so stick with the others. ' + DEATH_HINT, imp);
  }

  // --- Draw ------------------------------------------------------------------------------------

  draw(out: DrawItem[]) {
    this.arrival.draw(out);
    this.exit.draw(out);
    const k = this.light;
    for (const m of this.stars) out.push({ mesh: 'sphere', model: m, color: [2.2 * k + 0.4, 2.2 * k + 0.4, 2.4 * k + 0.45], pattern: Pattern.emissive, shadow: false });
    // Ship dressing: a steel deck, a dark skirting and a stripe round the walls.
    for (const d of this.decor) out.push(d);
    // The cafeteria rug under the table, and the table.
    out.push({ mesh: 'cylinder', model: mul(translation([0, 0.005, 0]), scaling([5.6, 0.008, 5.6])), color: [0.2, 0.24, 0.32], spec: 0.1, shadow: false });
    out.push({ mesh: 'cylinder', model: mul(translation([0, 0.007, 0]), scaling([5.3, 0.008, 5.3])), color: [0.27, 0.32, 0.42], spec: 0.1, shadow: false });
    const calling = this.phase === 'call';
    drawMeetingTable(out, [0, 0, 0], this.time - this.buttonPressedAt, this.buttonUsable.highlight, calling ? 0.6 + 0.4 * Math.sin(this.time * 18) : 0);
    for (const s of this.stations) s.draw(out);
    for (const v of this.vents) v.draw(out);
    // The SKIP pad (lit up while voting).
    const voting = this.phase === 'vote';
    out.push({ mesh: 'cylinder', model: mul(translation([SKIP_POS[0], 0.03, SKIP_POS[2]]), scaling([SKIP_R, 0.06, SKIP_R])), color: [0.5, 0.52, 0.56], spec: 0.3 });
    out.push({
      mesh: 'tube',
      model: mul(translation([SKIP_POS[0], 0.04, SKIP_POS[2]]), scaling([SKIP_R + 0.05, 0.07, SKIP_R + 0.05])),
      color: voting ? [1.6, 1.6, 1.7] : [0.3, 0.32, 0.35],
      pattern: voting ? Pattern.emissive : undefined,
    });
    // Crewmates right in front of the camera (someone standing much too close) go see-through.
    const cam = this.ctx.camera.pos;
    for (const n of this.npcs) {
      const c = n.c;
      const d = Math.hypot(c.pos[0] - cam[0], c.pos[1] + 0.8 - cam[1], c.pos[2] - cam[2]);
      c.opacity = c.alive ? clamp((d - 0.9) / 1.0, 0.3, 1) : 1;
      c.highlight = 0;
    }
    for (const cp of this.corpses) cp.npc.c.highlight = cp.usable.highlight;
    for (const n of this.npcs) n.c.draw(out);
    // The task bar on the north wall.
    const z = -CHAMBER_HALF;
    out.push({ mesh: 'box', model: mul(translation([0, 7.3, z + 0.06]), scaling([12.6, 1.0, 0.12])), color: [0.15, 0.16, 0.18], spec: 0.3 });
    out.push({ mesh: 'box', model: mul(translation([0, 7.3, z + 0.125]), scaling([12, 0.6, 0.02])), color: [0.06, 0.1, 0.07] });
    const fill = clamp(this.taskShown / TASKS_TOTAL, 0, 1);
    if (fill > 0.002) {
      out.push({ mesh: 'box', model: mul(translation([-6 + 6 * fill, 7.3, z + 0.14]), scaling([12 * fill, 0.6, 0.02])), color: [0.25 + 0.9 * k, 1.1 + 0.8 * k, 0.3 + 0.2 * k], pattern: Pattern.emissive });
    }
    const m = this.meeting;
    if (m) {
      // Voting: a ring under whoever you're standing by (solid once you've voted).
      if (this.phase === 'vote' && this.playerAlive()) {
        const v = m.locked ? m.playerVote : this.voteCandidate();
        if (v) {
          const at: Vec3 = v === 'skip' ? SKIP_POS : v === 'player' ? this.player.pos : v.c.pos;
          const pulse = m.locked ? 1 : 0.6 + 0.4 * Math.sin(this.time * 9);
          const r = v === 'skip' ? SKIP_R + 0.25 : 0.72;
          out.push({ mesh: 'tube', model: mul(translation([at[0], 0.05, at[2]]), scaling([r, 0.06, r])), color: m.locked ? [2.4, 1.0, 0.2] : [1.8 * pulse, 1.8 * pulse, 1.9 * pulse], pattern: Pattern.emissive, shadow: false });
        }
      }
      if (this.phase === 'reveal' || this.phase === 'eject') {
        for (const ch of m.chips) {
          if (ch.t > 0) continue;
          out.push({ mesh: 'sphere', model: mul(translation(ch.at), scaling([0.17, 0.17, 0.17])), color: ch.color, spec: 0.6, shadow: false });
        }
      }
      if (m.trapdoor && m.trapdoor.t >= 0) drawTrapdoor(out, m.trapdoor.pos, 0, m.trapdoor.t);
    }
  }

  labels(): WorldLabel[] {
    const list = this.labelList;
    list.length = 0;
    const dark = this.light < 0.5;
    for (const n of this.npcs) {
      const c = n.c;
      if (c.state === 'ejected' || c.hidden) continue;
      if (c.alive && (!dark || n === this.impostor)) {
        n.label.pos = [c.pos[0], c.pos[1] + 1.72 + c.lift, c.pos[2]];
        list.push(n.label);
        if (n.bubble.text) {
          n.bubble.pos = [c.pos[0], c.pos[1] + 2.25 + c.lift, c.pos[2]];
          list.push(n.bubble);
        }
      }
    }
    if (dark) return list;
    // Who you are, for the first few seconds (you're the tall one).
    if (this.playerAlive() && this.started && this.time - this.startedAt < 6) {
      this.youLabel.pos = [this.player.pos[0], this.player.pos[1] + 2.25, this.player.pos[2]];
      list.push(this.youLabel);
    }
    for (const l of this.stationLabels) list.push(l);
    this.buttonLabel.text = this.meetingsLeft > 0 ? 'EMERGENCY' : 'EMERGENCY (0 LEFT)';
    list.push(this.buttonLabel, this.barLabel);
    if (this.phase === 'vote') {
      this.wallLabel.text = `VOTING ENDS IN ${Math.max(0, Math.ceil(VOTE_TIME - this.phaseT))}`;
      this.wallSub.text = 'stand next to a suspect, press E';
      list.push(this.wallLabel, this.wallSub, this.skipLabel);
    } else if (this.phase === 'discuss') {
      this.wallLabel.text = 'DISCUSS!';
      this.wallSub.text = this.meeting?.kind === 'body' ? `${this.meeting.victim ? upper(this.meeting.victim) : 'SOMEONE'} IS DEAD` : 'EMERGENCY MEETING';
      list.push(this.wallLabel, this.wallSub);
    }
    return list;
  }

  trackedTargets(): TrackedTarget[] {
    const exit = this.exit.target();
    const list = this.targetList;
    list.length = 0;
    if (exit) list.push(exit);
    // Voting: a ring round whoever you'd vote for.
    const m = this.meeting;
    if (m && this.phase === 'vote' && this.playerAlive()) {
      const v = m.locked ? m.playerVote : this.voteCandidate();
      if (v && v !== 'player') {
        const t = this.voteTarget;
        t.pos = v === 'skip' ? [SKIP_POS[0], 0.4, SKIP_POS[2]] : [v.c.pos[0], 0.85, v.c.pos[2]];
        t.radius = v === 'skip' ? SKIP_R : 0.75;
        list.push(t);
      }
    }
    return list;
  }

  environment(): Environment {
    const k = this.light;
    const env = this.env;
    const amb = Math.max(k, 0.05);
    env.sunColor = [1.75 * k, 1.72 * k, 1.7 * k];
    env.skyColor = [0.035 * amb, 0.042 * amb, 0.085 * amb];
    env.groundColor = [0.3 * amb, 0.3 * amb, 0.33 * amb];
    env.fogColor = [0.02 * amb, 0.025 * amb, 0.06 * amb];
    const glow = this.impostor.c.glow;
    const pl = env.pointLight!;
    if (glow > 0.01 && this.impostor.c.alive) {
      const v = this.impostor.c.visor();
      pl.pos = [v[0], v[1] + 0.2, v[2]];
      pl.color = [3.5 * glow, 0.15 * glow, 0.1 * glow];
    } else pl.color = [0, 0, 0];
    return env;
  }

  obstacles(): Circle[] {
    let i = 0;
    for (const n of this.npcs) {
      const o = this.obstacleList[i++];
      const solid = n.c.alive && !n.c.hidden && n.c.lift > -0.5 && n.mode !== 'lunge';
      o.x = solid ? n.c.pos[0] : 1e4;
      o.z = solid ? n.c.pos[2] : 1e4;
    }
    return this.obstacleList;
  }

  cameraShot(): CameraShot | null {
    const m = this.meeting;
    if (this.phase === 'eject' && m?.ejected && m.ejected !== 'player') {
      // Watch them go: from across the table, then rising after them into space.
      const e = m.ejected.c;
      const r = Math.hypot(e.pos[0], e.pos[2]) || 1;
      const pos: Vec3 = [(-e.pos[0] / r) * 3, Math.max(1.4, e.pos[1] - 3.5), (-e.pos[2] / r) * 3];
      return { pos, target: [e.pos[0], e.pos[1] + 0.8, e.pos[2]], sharpness: 4 };
    }
    if (this.phase === 'discuss' || this.phase === 'reveal' || (this.phase === 'eject' && !m?.ejected)) {
      // Round the table: everyone in view, from over your seat.
      return { pos: [0, 4.7, SEAT_R + 4.4], target: [0, 0.9, -0.5], sharpness: 4 };
    }
    if (this.playerEjected) {
      // You, drifting off into space.
      const p = this.player.pos;
      const r = Math.hypot(p[0], p[2]) || 1;
      return { pos: [p[0] - (p[0] / r) * 3.2, Math.max(1.4, p[1] - 2.5), p[2] - (p[2] / r) * 3.2], target: [p[0], p[1] + 1, p[2]], sharpness: 4 };
    }
    const d = this.death;
    if (d?.killer && d.t > 0.25) {
      // The scene of the crime: you, and who did it.
      const kp = d.killer.c.pos, pp = this.player.pos;
      const mx = (kp[0] + pp[0]) / 2, mz = (kp[2] + pp[2]) / 2;
      let sx = -(kp[2] - pp[2]), sz = kp[0] - pp[0];
      const l = Math.hypot(sx, sz) || 1;
      sx /= l;
      sz /= l;
      if (Math.abs(mx + sx * 4) > CHAMBER_HALF - 0.5 || Math.abs(mz + sz * 4) > CHAMBER_HALF - 0.5) {
        sx = -sx;
        sz = -sz;
      }
      const lim = CHAMBER_HALF - 0.4;
      return { pos: [clamp(mx + sx * 4, -lim, lim), 2.6, clamp(mz + sz * 4, -lim, lim)], target: [mx, 0.9, mz], sharpness: 3 };
    }
    return this.arrival.cameraShot();
  }

  freezeWorld() {
    return this.phase === 'call';
  }
}
