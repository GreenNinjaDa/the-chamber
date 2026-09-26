import { noise, sfx, tone } from '../../engine/audio';
import {
  add, clamp, cross, easeInOut, fromQuat, lerp, mul, normalize, quatSlerp, rotationX, rotationY, rotationZ, scale, scaling, segment, sub,
  toQuat, transformPoint, translation,
  type Mat4, type Vec3,
} from '../../engine/math';
import { RAPIER } from '../../engine/physics';
import { Pattern, type DrawItem } from '../../engine/renderer';
import { CHAMBER_HALF } from '../../game/chamber';
import { Giant } from '../../entities/giant';
import { BLOCK_H, BLOCK_L, BLOCK_W, JengaTower, SLOT_OFFSETS, type JengaBlock } from '../../entities/jenga';
import { ExitPortal, PortalArrival } from '../../entities/portal';
import { DEFAULT_ENV, type CameraShot, type Level, type LevelContext, type LevelStatus, type TrackedTarget, type WorldLabel } from '../level';

/*
 * Jenga, and you're on top. You land on a square of wood in the floor, which turns out to be the
 * top of a giant Jenga tower that rises out of it, eight metres up. Timmy leans in over the south
 * wall and plays: he picks a block from the lower layers (it glows and wobbles while he makes up
 * his mind), slides it out, and puts it on top, Jenga rules, which is where you are (its shadow
 * shows where). The tower leans toward whatever side is missing support, and toward wherever you
 * stand: counterbalance it or it goes over (JENGA!). The lean slides you downhill, and the
 * Lean-o-meter on the north wall, the tilting horizon and the creaking all say how bad it is.
 * After nine pulls Timmy gets bored and shoves it over toward the east wall, where a ledge and the
 * exit have just slid out: jump for it before it hits.
 */

/** Bottom centre of the tower; it has LAYERS layers to start with (8 m). */
const BASE: Vec3 = [4, 0, -4];
const LAYERS = 10;
/** Blocks Timmy pulls (and stacks on top) before he gets bored. */
const PULLS = 9;
/** It topples past this lean of the top (rad). */
const PHI_MAX = 0.14;
/**
 * Timmy never pulls a block that leaves the tower leaning more than this share of the limit with
 * nobody on it: CAP_START at first, CAP_PER_PULL more each pull.
 */
const CAP_START = 0.55;
const CAP_PER_PULL = 0.1;
/** Your weight: lean (rad, before the tower's wobbliness amplifies it) per metre off-centre. */
const PLAYER_BIAS_PER_M = 0.022;
/** Landing a jump on top shoves the sway by this much (rad/s) per metre off-centre per m/s of landing speed. */
const LANDING_KICK = 0.004;
/** Standing on the leaning top slides you downhill at this speed (m/s) per radian of lean past SLIDE_FROM. */
const SLIDE_PER_RAD = 7;
const SLIDE_FROM = 0.04;
/** The camera's horizon tilts this share of the lean. */
const CAMERA_TILT = 0.6;
/** Rising out of the floor: rumble for RISE_DELAY, then rise over RISE_TIME. */
const RISE_DELAY = 0.7;
const RISE_TIME = 4.5;
/** Timmy rises over the south wall from this long after the arrival, over GIANT_RISE; the first pull after FIRST_PULL. */
const GIANT_AT = 3.5;
const GIANT_RISE = 3;
const FIRST_PULL = 8;
/** A pull's stages (s), at the start; later pulls go quicker (down to PACE_MIN of these), never the hover below HOVER_MIN. */
const AIM = 1.3;
const PULL = 1.4;
const LIFT = 1.3;
const HOVER = 1.7;
const HOVER_MIN = 1.3;
const DROP = 0.22;
const RELEASE = 0.5;
const REST = 0.9;
const PACE_MIN = 0.72;
/** The held block hovers this high above where it'll go. */
const HOVER_HEIGHT = 3;
/** The exit (east wall) and the ledge in front of it, which slide out for the finale. */
const EXIT_Z = BASE[2] + 5;
const LEDGE_Y = 6.5;
const LEDGE_DEPTH = 2;
const LEDGE_Z: [number, number] = [BASE[2] + 1.9, BASE[2] + 7.2];
/**
 * The finale (s after it starts): the ledge slides out, Timmy pushes the tower over to PUSH_TIP
 * over PUSH_TIME, then it falls on its own (angular acceleration FALL_ACCEL sin tip) and breaks
 * up into real blocks at TIP_BREAK (rad).
 */
const LEDGE_AT = 0.8;
const PUSH_AT = 1.8;
const PUSH_TIME = 1.5;
const PUSH_TIP = 0.1;
const FALL_ACCEL = 2.6;
const TIP_BREAK = 0.45;
/** Falling this far below the original top means you've fallen off. */
const FALL_DEPTH = 2.2;
const DEATH_SCREEN_DELAY = 2;
/** Collision groups for the finale's falling blocks: they don't hit the player's body (who should be on the ledge). */
const GROUPS_MISS_PLAYER = (0x0001 << 16) | (0xffff & ~0x0002 & ~0x0004);

/** The second Lean-o-meter, on the south wall, is off to the west, clear of Timmy's arm. */
const SOUTH_METER_X = -2;

const WALL = [0.86, 0.87, 0.88];
const DUST = [0.83, 0.74, 0.6];

const AIM_LINES = ['MY TURN!', 'EENY, MEENY...', 'THIS ONE.', 'SHHH...', 'EASY...', 'WATCH THIS.', 'HEHEHE.', 'STEADY...', 'THE WOBBLY ONE.'];
const PLACE_LINES = ['BEAT THAT.', 'NAILED IT.', 'PERFECT.', 'I’M SO GOOD AT THIS.', 'YOUR TURN! ...JUST KIDDING.', 'TA-DA!'];

const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

type Stage = 'aim' | 'pull' | 'lift' | 'hover' | 'drop' | 'release';

interface PullState {
  block: JengaBlock;
  stage: Stage;
  t: number;
  /** Where it came from, and where it goes. */
  fromLayer: number;
  to: { layer: number; slot: number } | null;
  /** Its world frame when it came out of the tower. */
  from: Mat4 | null;
  kicked: boolean;
}

type Cause = 'topple' | 'squash' | 'fall' | 'finale';

interface Death {
  t: number;
  big: string;
  small: string;
  cause: Cause;
}

interface Puff {
  pos: Vec3;
  vel: Vec3;
  age: number;
  life: number;
  size: number;
}

const HINTS: Record<Cause, string> = {
  topple: 'The tower leans toward the side that’s missing blocks, and toward wherever you stand. Stand on the side opposite the lean to balance it (the Lean-o-meters on the north and south walls show which way, and where it’s heading while he pulls one).',
  squash: 'Watch where he’s going to put the block down (its shadow on top), and don’t be there. You can jump up onto a block that’s already down.',
  fall: 'Stay on top. The tower slides you downhill as it leans, so walk uphill, and keep away from the edges.',
  finale: 'When he shoves it over, a ledge and the exit slide out of the east wall: run to the south-east corner of the top and jump for the ledge before the tower hits.',
};

export class JengaLevel implements Level {
  readonly number: number;
  readonly title = 'Jenga';
  status: LevelStatus = 'playing';
  private arrival: PortalArrival;
  private exit = new ExitPortal(EXIT_Z, LEDGE_Y);
  private giant = new Giant();
  private tower: JengaTower;
  /** Seconds since the arrival was done (-1 until then). */
  private t = -1;
  private pull: PullState | null = null;
  private pullsDone = 0;
  private nextPullAt = FIRST_PULL;
  /** The finale: seconds since it started (-1 before), the tip's angular speed, and the ledge (0 in the wall .. 1 out). */
  private finaleT = -1;
  private tipVel = 0;
  private ledgeOut = 0;
  private ledge: RAPIER.Collider;
  /** Invisible walls round the top while it rises (so you ride it all the way up). */
  private fence: RAPIER.Collider[] = [];
  private death: Death | null = null;
  private puffs: Puff[] = [];
  /** Timmy's hand: where it's reaching (smoothed), and a pointing finger for the finale. */
  private hand: Vec3 = [0, 30, 20];
  private finger = 0;
  /** What Timmy says, pinned across the top of the screen (he is far too tall to read it off his head). */
  private timmyLabel: WorldLabel = { pos: [0, 0, 0], text: '', size: 1, color: '#ffd166' };
  private timmyTimer = 0;
  private labelList: WorldLabel[];
  private wasGrounded = true;
  private lastVy = 0;
  private creakTimer = 0;
  private rumbleTimer = 0;
  private scrapeTimer = 0;
  /** The player's feet in the frame of the layer they're standing on, before this update (for carrying them). */
  private riding: { layer: number; local: Vec3 } | null = null;
  private escaped = false;
  /** Where the lean is heading once the block Timmy's pulling is out (shown on the meter), or null. */
  private predicted: [number, number] | null = null;
  /** The Lean-o-meter pops up (0-1) once the tower is up. */
  private meterOn = 0;
  private timmyOnly: WorldLabel[];

  constructor(private ctx: LevelContext) {
    this.number = ctx.number;
    const { hud, physics } = ctx;
    hud.setLevel(`The Chamber · Level ${this.number}`);
    hud.show(`LEVEL ${this.number}`, '', 2.5);
    hud.hint('');
    this.tower = new JengaTower(physics, BASE, LAYERS);
    // Sunk into the floor, with just its top showing: a square of wood.
    this.tower.rise = -LAYERS * BLOCK_H + 0.03;
    this.tower.update(0);
    this.arrival = new PortalArrival(ctx, [BASE[0], 0, BASE[2]], { minElevationDeg: 82 });

    // The fence round the top while it rises.
    for (let i = 0; i < 4; i++) {
      this.fence.push(physics.world.createCollider(RAPIER.ColliderDesc.cuboid(i < 2 ? 0.2 : BLOCK_L / 2 + 0.4, 2, i < 2 ? BLOCK_L / 2 + 0.4 : 0.2)));
    }
    this.placeFence();
    // The finale's ledge, tucked into the east wall until then.
    this.ledge = physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(LEDGE_DEPTH / 2, 0.2, (LEDGE_Z[1] - LEDGE_Z[0]) / 2).setTranslation(CHAMBER_HALF + LEDGE_DEPTH / 2 + 0.05, LEDGE_Y - 0.2, (LEDGE_Z[0] + LEDGE_Z[1]) / 2),
    );

    this.giant.root = [-2, -80, 27];
    this.giant.leanTarget = this.giant.lean = 0.34;
    this.giant.rightCurl = 0.4;
    this.giant.update(0, this.hand);

    this.labelList = [
      { pos: [BASE[0], 9.6, -CHAMBER_HALF + 0.3], text: 'LEAN-O-METER', size: 0.75, color: '#ffffff' },
      { pos: [BASE[0], 4.9, -CHAMBER_HALF + 0.3], text: '(red means timber)', size: 0.5, color: '#ffd166' },
      { pos: [SOUTH_METER_X, 9.6, CHAMBER_HALF - 0.3], text: 'LEAN-O-METER', size: 0.75, color: '#ffffff' },
      { pos: [SOUTH_METER_X, 4.9, CHAMBER_HALF - 0.3], text: '(still red means timber)', size: 0.5, color: '#ffd166' },
      this.timmyLabel,
    ];
    this.timmyOnly = [this.timmyLabel];

    // Dev: ?jengaSkip=N does N pulls up front (N = 9 goes straight to the finale).
    const skip = Math.min(PULLS, Number(new URLSearchParams(location.search).get('jengaSkip')) || 0);
    for (let i = 0; i < skip; i++) {
      const b = this.pickBlock(true);
      if (!b) break;
      const slot = this.pickSlot(null);
      this.tower.unlay(b);
      this.tower.lay(b, slot.layer, slot.slot);
      this.pullsDone++;
      this.tower.update(0);
    }
    this.tower.phi = [0, 0];
  }

  // --- Timmy's choices -------------------------------------------------------------------------

  /** Where the player is on top, relative to the tower's axis (x, z), or null if they aren't up there. */
  private playerOnTop(): [number, number] | null {
    const { player } = this.ctx;
    if (player.mode !== 'control' || this.death) return null;
    const top = this.tower.topLayer();
    const loc = this.tower.toLocal(top, player.pos);
    if (Math.abs(loc[0]) > BLOCK_L / 2 + 0.3 || Math.abs(loc[2]) > BLOCK_L / 2 + 0.3) return null;
    if (loc[1] < -BLOCK_H * 1.6 || loc[1] > BLOCK_H + 3) return null;
    return [loc[0], loc[2]];
  }

  /**
   * The block Timmy goes for: from the lower layers, never leaving a layer propped on one side
   * (that would just fall), rather one that tips the tower toward where you're standing, and never
   * one that leaves it leaning more than you could balance by standing on the other side.
   */
  private pickBlock(tidy = false): JengaBlock | null {
    const tower = this.tower;
    const top = tower.topLayer();
    const maxLayer = Math.min(top - 3, tower.layers.length - 1);
    const before = tower.bias();
    const me = this.playerOnTop();
    const meDir = me && Math.hypot(me[0], me[1]) > 0.4 ? normalize([me[0], 0, me[1]]) : null;
    let best: { b: JengaBlock; score: number } | null = null;
    let fallback: { b: JengaBlock; mag: number } | null = null;
    for (let k = 1; k <= maxLayer; k++) {
      const row = tower.layers[k];
      const count = row.filter((b) => b).length;
      if (count < 2) continue;
      for (let j = 0; j < 3; j++) {
        const b = row[j];
        if (!b) continue;
        // What's left mustn't be a single block on one side (or nothing).
        const left = row.map((x, i) => (i === j ? null : x));
        const n = left.filter((x) => x).length;
        if (n === 1 && !left[1]) continue;
        // Down to just the middle one: only once things have got going.
        if (n === 1 && this.pullsDone < 5) continue;
        b.out = 1;
        const after = tower.bias();
        const gamma = tower.gamma();
        b.out = 0;
        const amp = 1 / (1 - gamma);
        // How far it may lean with nobody balancing it: gentle to start with, then more than you
        // can stand in the middle and survive (from about the 4th pull), up to needing you well out
        // on the other side.
        const cap = (PHI_MAX * (CAP_START + CAP_PER_PULL * this.pullsDone)) / amp;
        const mag = Math.hypot(after[0], after[1]);
        if (!fallback || mag < fallback.mag) fallback = { b, mag };
        if (mag > cap) continue;
        const change: Vec3 = [after[0] - before[0], 0, after[1] - before[1]];
        const cl = Math.hypot(change[0], change[2]);
        const evil = meDir && cl > 1e-4 ? (change[0] * meDir[0] + change[2] * meDir[2]) / cl : 0;
        // It leans more and more (a kid never picks the safe one), spread round the layers.
        const grow = (mag - Math.hypot(before[0], before[1])) / 0.034;
        const score = tidy ? -mag : Math.random() + 0.6 * evil + 0.5 * grow - 0.25 * tower.missing(k);
        if (!best || score > best.score) best = { b, score };
      }
    }
    return best?.b ?? fallback?.b ?? null;
  }

  /** Where the pulled block goes on top: the unfinished layer's free slots, preferably the one you're in. */
  private pickSlot(me: [number, number] | null): { layer: number; slot: number } {
    const tower = this.tower;
    const top = tower.topLayer();
    const topRow = tower.layers[top];
    const full = topRow.every((b) => b);
    const layer = full ? top + 1 : top;
    const free = full ? [0, 1, 2] : [0, 1, 2].filter((j) => !topRow[j]);
    if (me) {
      // Your slot: across offset along x for even layers (blocks along z), z for odd ones.
      const across = layer % 2 === 0 ? me[0] : me[1];
      const mine = free.find((j) => Math.abs(across - SLOT_OFFSETS[j]) < BLOCK_W / 2 + 0.1);
      if (mine !== undefined && Math.random() < 0.75) return { layer, slot: mine };
    }
    return { layer, slot: pick(free) };
  }

  /** The frame a block rests in at a slot (its local z along its length). */
  private slotFrame(layer: number, slot: number): Mat4 {
    const t = this.tower;
    const f = layer < t.frames.length ? t.frames[layer] : mul(t.frames[t.frames.length - 1], translation([0, BLOCK_H, 0]));
    const off = SLOT_OFFSETS[slot];
    return layer % 2 === 1 ? mul(f, translation([0, BLOCK_H / 2, off]), rotationY(-Math.PI / 2)) : mul(f, translation([off, BLOCK_H / 2, 0]));
  }

  private pace() {
    return Math.max(PACE_MIN, 1 - 0.035 * this.pullsDone);
  }

  private say(text: string, seconds = 2.2) {
    this.timmyLabel.text = `TIMMY: ${text}`;
    this.timmyTimer = seconds;
  }

  // --- Update ----------------------------------------------------------------------------------

  update(dt: number) {
    const { player, hud, camera } = this.ctx;
    const death = this.death;
    if (death && this.status === 'playing') {
      death.t += dt;
      if (death.t > DEATH_SCREEN_DELAY) {
        this.status = 'lost';
        hud.show(death.big, `${death.small}\nPress R to try again.`);
        hud.tips([
          ['Hint', HINTS[death.cause]],
          ['Controls', 'WASD move · Shift sprint · Space jump'],
        ]);
      }
    }
    this.arrival.update(dt);
    this.exit.update(dt, player);
    if (this.exit.entered && this.status === 'playing') this.status = 'exited';
    this.giant.time += dt;
    if (this.arrival.done && this.t < 0) this.t = 0;
    if (this.t >= 0) this.t += dt;
    const t = this.t;
    const tower = this.tower;
    const alive = player.mode === 'control' && !this.death;

    // Where the player stands on the tower, to carry them along with it after it moves.
    this.riding = null;
    const me = this.playerOnTop();
    if (alive && !tower.collapsed) {
      const top = tower.topLayer();
      const loc = tower.toLocal(top, player.pos);
      const onIt = me && (player.onGround || loc[1] < BLOCK_H + 0.05);
      if (onIt) {
        const k = loc[1] > BLOCK_H * 0.5 ? top : Math.max(0, top - 1);
        this.riding = { layer: k, local: tower.toLocal(k, player.pos) };
      }
    }

    // Rising out of the floor.
    if (t >= 0) {
      const r = clamp((t - RISE_DELAY) / RISE_TIME, 0, 1);
      const was = tower.rise;
      tower.rise = lerp(-LAYERS * BLOCK_H + 0.03, 0, easeInOut(r));
      const speed = dt > 0 ? (tower.rise - was) / dt : 0;
      if (t < RISE_DELAY + RISE_TIME + 0.2) {
        camera.addShake(t < RISE_DELAY ? 0.25 : 0.15 + speed * 0.05);
        this.rumbleTimer -= dt;
        if (this.rumbleTimer <= 0) {
          this.rumbleTimer = 0.22;
          noise(0.4, { freq: 160, to: 70, vol: 0.28 });
          if (Math.random() < 0.5) this.creak(0.5);
          for (let i = 0; i < 3; i++) this.puffAtBase();
        }
      } else if (this.fence.length) {
        for (const f of this.fence) this.ctx.physics.world.removeCollider(f, false);
        this.fence.length = 0;
        tone(90, 0.5, { to: 50, wave: 'sine', vol: 0.4 });
        noise(0.4, { freq: 300, to: 80, vol: 0.3 });
      }
    }

    // Once it’s up, the Lean-o-meters pop up on the north and south walls.
    if (t > RISE_DELAY + RISE_TIME + 0.4 && this.meterOn < 1) {
      if (this.meterOn === 0) {
        tone(660, 0.12, { wave: 'square', vol: 0.08 });
        tone(990, 0.2, { wave: 'square', vol: 0.08, at: 0.1 });
      }
      this.meterOn = Math.min(1, this.meterOn + dt / 0.35);
    }
    // Timmy leans in over the south wall.
    this.giant.root[1] = lerp(-80, 0, easeInOut(clamp((t - GIANT_AT) / GIANT_RISE, 0, 1)));
    if (t >= GIANT_AT && t - dt < GIANT_AT) this.say('JENGA!!', 2.5);
    this.timmyTimer -= dt;
    if (this.timmyTimer <= 0) this.timmyLabel.text = '';

    // Your weight on top.
    if (me && alive) {
      tower.load = [me[0] * PLAYER_BIAS_PER_M, me[1] * PLAYER_BIAS_PER_M];
      if (player.onGround && !this.wasGrounded && this.lastVy < -2) {
        const hit = -this.lastVy;
        tower.kick(me[0] * LANDING_KICK * hit, me[1] * LANDING_KICK * hit);
        if (hit > 5) this.knock(0.12);
      }
    } else {
      tower.load = [tower.load[0] * 0.9, tower.load[1] * 0.9];
    }
    this.wasGrounded = player.onGround;
    this.lastVy = player.vel[1];

    // Timmy's turn.
    if (t >= this.nextPullAt && !this.pull && this.pullsDone < PULLS && !tower.collapsed && this.finaleT < 0) this.startPull();
    if (this.pull && !tower.collapsed) this.updatePull(dt);
    if (this.pullsDone >= PULLS && !this.pull && this.finaleT < 0 && t >= this.nextPullAt && !tower.collapsed) this.startFinale();
    if (this.finaleT >= 0) this.updateFinale(dt);

    tower.update(dt);
    this.updateHand(dt);

    // Carry the player along with the tower, and slide them downhill on the lean.
    const ride = this.riding as { layer: number; local: Vec3 } | null;
    if (ride && !tower.collapsed && player.mode === 'control') {
      const now = tower.point(ride.layer, ride.local);
      const moved = sub(now, player.pos);
      if (Math.hypot(moved[0], moved[1], moved[2]) < 1) player.carry(moved);
      const lean = tower.phi;
      const amount = Math.hypot(lean[0], lean[1]);
      const slide = amount > SLIDE_FROM ? ((amount - SLIDE_FROM) * SLIDE_PER_RAD) / amount : 0;
      player.platformVel = player.onGround ? [lean[0] * slide, 0, lean[1] * slide] : [0, 0, 0];
    } else {
      player.platformVel = [0, 0, 0];
    }
    // While it rises, nobody gets left behind in the floor.
    if (tower.rise < 0 && player.mode === 'control' && me) {
      const top = tower.topLayer();
      const surface = tower.topOf(top);
      if (player.pos[1] < surface) {
        player.carry([0, surface - player.pos[1], 0]);
        player.vel[1] = Math.max(player.vel[1], 0);
      }
    }
    if (this.fence.length) this.placeFence();

    // Too far: it goes over.
    if (!tower.collapsed && this.finaleT < 0 && tower.leanAmount() > PHI_MAX) this.topple();
    // Fell off.
    if (alive && !this.death) {
      const floorOfTop = LAYERS * BLOCK_H + tower.rise - FALL_DEPTH;
      if (player.pos[1] < floorOfTop && tower.rise >= 0 && !(this.ledgeOut > 0.5 && player.pos[0] > CHAMBER_HALF - LEDGE_DEPTH - 0.6 && player.pos[1] > LEDGE_Y - 0.6)) {
        player.kill([0, 0, 0], { violence: 8 });
        this.die('fall', pick(['SPLAT', 'MIND THE GAP', 'GRAVITY: 1, YOU: 0']), pick([
          'The top was the only safe bit. Emphasis on top.',
          'It’s a long way down, and you found all of it.',
          'Timmy says that counts as your turn.',
        ]));
        this.say('OOPS!');
      }
    }

    // Camera: the horizon tilts with the tower.
    camera.turnTarget = alive && me && !tower.collapsed ? mul(rotationZ(-(tower.phi[0] + tower.tip) * CAMERA_TILT), rotationX(tower.phi[1] * CAMERA_TILT)) : null;

    // Creaks, louder and more often the further it leans.
    const danger = tower.collapsed ? 0 : tower.leanAmount() / PHI_MAX;
    this.creakTimer -= dt;
    if (danger > 0.3 && this.creakTimer <= 0 && t > 0) {
      this.creak(danger);
      this.creakTimer = lerp(2.2, 0.35, clamp((danger - 0.3) / 0.6, 0, 1)) * (0.7 + Math.random() * 0.6);
      if (danger > 0.8 && Math.random() < 0.4) this.say(pick(['WHOA WHOA WHOA', 'DON’T FALL DON’T FALL', 'UH OH']), 1.4);
    }

    for (const p of this.puffs) {
      p.age += dt;
      p.pos = add(p.pos, scale(p.vel, dt));
      p.vel = scale(p.vel, 1 - dt * 1.5);
      p.vel[1] += dt * 0.3;
    }
    this.puffs = this.puffs.filter((p) => p.age < p.life);
  }

  private placeFence() {
    const top = this.tower.topLayer();
    const c = this.tower.point(top, [0, BLOCK_H + 2, 0]);
    const d = BLOCK_L / 2 + 0.2;
    const spots: Vec3[] = [[d, 0, 0], [-d, 0, 0], [0, 0, d], [0, 0, -d]];
    this.fence.forEach((f, i) => f.setTranslation({ x: c[0] + spots[i][0], y: c[1], z: c[2] + spots[i][2] }));
  }

  // --- A pull ----------------------------------------------------------------------------------

  private startPull() {
    const b = this.pickBlock();
    if (!b) {
      this.pullsDone = PULLS;
      return;
    }
    this.pull = { block: b, stage: 'aim', t: 0, fromLayer: b.layer, to: null, from: null, kicked: false };
    this.say(this.pullsDone === 0 ? 'MY TURN!' : this.pullsDone === 1 ? '...OH WAIT, YOU CAN’T. MY TURN AGAIN!' : pick(AIM_LINES), this.pullsDone === 1 ? 3 : 2.2);
  }

  /** The end of the block Timmy pulls it by (world), and the direction it slides out. */
  private pullEnd(b: JengaBlock): { end: Vec3; dir: Vec3 } {
    const m = b.frame;
    // Its local +z end for even layers (sliding out toward +z); odd layers slide toward -x, which
    // is also their local +z after the quarter turn... so the pull end is local +z either way.
    const end = transformPoint(m, [0, 0, BLOCK_L / 2]);
    const c = transformPoint(m, [0, 0, 0]);
    return { end, dir: normalize(sub(end, c)) };
  }

  private updatePull(dt: number) {
    const p = this.pull!;
    const b = p.block;
    const tower = this.tower;
    const pace = this.pace();
    p.t += dt;
    // While he's at it, the Lean-o-meter predicts where the lean is heading once it's out.
    if (p.stage === 'aim' || p.stage === 'pull') {
      const was = b.out;
      b.out = 1;
      const bias = tower.bias(), amp = 1 / (1 - tower.gamma());
      b.out = was;
      this.predicted = [amp * (bias[0] + tower.load[0]), amp * (bias[1] + tower.load[1])];
    } else {
      this.predicted = null;
    }
    switch (p.stage) {
      case 'aim': {
        const T = AIM * pace;
        b.glow = 0.5 + 0.5 * Math.sin(p.t * 14);
        // Two little taps to test it.
        const taps = [0.45, 0.8].map((x) => x * T);
        b.jiggle = 0;
        for (const at of taps) {
          const d = p.t - at;
          if (d >= 0 && d < 0.18) b.jiggle = Math.sin((d / 0.18) * Math.PI) * 0.12;
          if (d >= 0 && d - dt < 0) this.tap();
        }
        if (p.t >= T) {
          p.stage = 'pull';
          p.t = 0;
          b.jiggle = 0;
          b.collider.setEnabled(false);
          noise(PULL * pace, { freq: 900, to: 500, type: 'bandpass', q: 1.2, vol: 0.16 });
          tone(85, PULL * pace, { to: 70, wave: 'sawtooth', vol: 0.035 });
        }
        break;
      }
      case 'pull': {
        const T = PULL * pace;
        const u = easeInOut(clamp(p.t / T, 0, 1));
        b.glow = Math.max(0, b.glow - dt * 3);
        b.slide = u * (BLOCK_L + 0.4);
        b.out = clamp(b.slide / (BLOCK_L * 0.85), 0, 1);
        // Dust at the mouth of the hole.
        this.scrapeTimer -= dt;
        if (this.scrapeTimer <= 0 && u < 0.95) {
          this.scrapeTimer = 0.07;
          const hole = this.holeMouth(b);
          this.puffs.push({ pos: hole.pos, vel: add(scale(hole.dir, 0.8 + Math.random()), [(Math.random() - 0.5) * 0.6, Math.random() * 0.4, (Math.random() - 0.5) * 0.6]), age: 0, life: 1.2, size: 0.25 + Math.random() * 0.2 });
        }
        if (!p.kicked && u > 0.6) {
          p.kicked = true;
          // The tower lurches as the support goes.
          const bias = tower.bias();
          const bl = Math.hypot(bias[0], bias[1]) || 1;
          tower.kick((bias[0] / bl) * 0.05 + (Math.random() - 0.5) * 0.03, (bias[1] / bl) * 0.05 + (Math.random() - 0.5) * 0.03);
          this.creak(0.6);
        }
        if (p.t >= T) {
          p.from = b.frame;
          p.to = this.pickSlot(this.playerOnTop());
          tower.unlay(b);
          b.free = p.from;
          b.out = 1;
          p.stage = 'lift';
          p.t = 0;
        }
        break;
      }
      case 'lift': {
        const T = LIFT * pace;
        const u = easeInOut(clamp(p.t / T, 0, 1));
        const to = p.to!;
        const rest = this.slotFrame(to.layer, to.slot);
        const hover = mul(translation([0, HOVER_HEIGHT, 0]), rest);
        const from = p.from!;
        const p0: Vec3 = [from[12], from[13], from[14]];
        const p2: Vec3 = [hover[12], hover[13], hover[14]];
        const c: Vec3 = [p0[0], p2[1] + 1.2, p0[2]];
        const pos: Vec3 = [0, 0, 0];
        for (let i = 0; i < 3; i++) pos[i] = (1 - u) * (1 - u) * p0[i] + 2 * u * (1 - u) * c[i] + u * u * p2[i];
        b.free = fromQuat(quatSlerp(toQuat(from), toQuat(hover), u), pos);
        if (p.t >= T) {
          p.stage = 'hover';
          p.t = 0;
        }
        break;
      }
      case 'hover': {
        const T = Math.max(HOVER_MIN, HOVER * pace);
        const to = p.to!;
        const rest = this.slotFrame(to.layer, to.slot);
        const sway = Math.sin(p.t * 5) * 0.05;
        b.free = mul(translation([sway, HOVER_HEIGHT + Math.sin(p.t * 3.3) * 0.06, 0]), rest);
        if (p.t >= T) {
          p.stage = 'drop';
          p.t = 0;
          noise(0.2, { freq: 600, to: 2000, type: 'bandpass', q: 1, vol: 0.12 });
        }
        break;
      }
      case 'drop': {
        const T = DROP;
        const u = clamp(p.t / T, 0, 1);
        const to = p.to!;
        const rest = this.slotFrame(to.layer, to.slot);
        b.free = mul(translation([0, HOVER_HEIGHT * (1 - u * u), 0]), rest);
        if (p.t >= T) this.land(p);
        break;
      }
      case 'release': {
        if (p.t >= RELEASE + REST * pace) {
          this.pull = null;
          this.pullsDone++;
          this.nextPullAt = this.t + (this.pullsDone >= PULLS ? 1.2 : 0.2);
        }
        break;
      }
    }
  }

  /** Where the hole a block is sliding out of opens (world), and which way is out. */
  private holeMouth(b: JengaBlock): { pos: Vec3; dir: Vec3 } {
    const f = this.tower.frames[b.layer] ?? this.tower.frames[0];
    const off = SLOT_OFFSETS[b.slot];
    const local: Vec3 = b.alongX ? [-BLOCK_L / 2, BLOCK_H / 2, off] : [off, BLOCK_H / 2, BLOCK_L / 2];
    const pos = transformPoint(f, local);
    return { pos, dir: b.alongX ? [-1, 0, 0] : [0, 0, 1] };
  }

  /** The block comes down in its slot: whoever's there is flattened, anyone at the edge shoved off it. */
  private land(p: PullState) {
    const { player, camera } = this.ctx;
    const tower = this.tower;
    const to = p.to!;
    const b = p.block;
    tower.lay(b, to.layer, to.slot);
    this.knock(0.35);
    b.glow = 0;
    const rest = this.slotFrame(to.layer, to.slot);
    const centre: Vec3 = [rest[12], rest[13], rest[14]];
    // Dust out from under both ends.
    for (let i = 0; i < 10; i++) {
      const along = (i % 2 ? 1 : -1) * (BLOCK_L / 2);
      const pos = transformPoint(rest, [(Math.random() - 0.5) * BLOCK_W, -BLOCK_H / 2, along * (0.6 + Math.random() * 0.4)]);
      const out = normalize(sub(pos, centre));
      this.puffs.push({ pos, vel: [out[0] * 2, 0.3, out[2] * 2], age: 0, life: 1, size: 0.3 + Math.random() * 0.2 });
    }
    // The sway gets a shove toward the side it landed on.
    const off = SLOT_OFFSETS[to.slot];
    const kickAxis: Vec3 = to.layer % 2 === 0 ? [1, 0, 0] : [0, 0, 1];
    tower.kick(kickAxis[0] * off * 0.02 + (Math.random() - 0.5) * 0.02, kickAxis[2] * off * 0.02 + (Math.random() - 0.5) * 0.02);
    const d = Math.hypot(player.pos[0] - centre[0], player.pos[2] - centre[2]);
    camera.addShake(Math.max(0.15, 0.6 - d * 0.04));

    // Was anyone under it?
    if (player.mode === 'control' && !this.death) {
      const f = to.layer < tower.frames.length ? tower.frames[to.layer] : mul(tower.frames[tower.frames.length - 1], translation([0, BLOCK_H, 0]));
      const loc = transformInverse(f, player.pos);
      const across = to.layer % 2 === 0 ? loc[0] : loc[2];
      const along = to.layer % 2 === 0 ? loc[2] : loc[0];
      const dAcross = Math.abs(across - off);
      const inLength = Math.abs(along) < BLOCK_L / 2 + 0.3;
      const inHeight = loc[1] > -0.4 && loc[1] < BLOCK_H - 0.05;
      if (inLength && inHeight && dAcross < BLOCK_W / 2 + 0.15) {
        this.squash(b, rest);
      } else if (inLength && inHeight && dAcross < BLOCK_W / 2 + 0.6) {
        // Clipped by its edge: shoved away from it.
        const side = Math.sign(across - off) || 1;
        const push = to.layer % 2 === 0 ? [side * 4, 1.5, 0] : [0, 1.5, side * 4];
        player.knock(push as Vec3, 0.5);
      }
    }
    if (!this.death) this.say(this.pullsDone === 0 ? 'YOUR TURN!' : pick(PLACE_LINES), 1.8);
    p.stage = 'release';
    p.t = 0;
  }

  /** Flattened under a block: pinned face down across its slot, head and feet sticking out. */
  private squash(b: JengaBlock, rest: Mat4) {
    const { player, camera } = this.ctx;
    // Lying across the block (its frame's local x, whichever way the layer runs), head one side
    // and feet the other.
    const lieDir: Vec3 = normalize([rest[0], rest[1], rest[2]]);
    const feet = player.pos;
    const surface = rest[13] - BLOCK_H / 2;
    player.flightDir = Math.random() < 0.5 ? lieDir : scale(lieDir, -1);
    player.pos = [feet[0], surface + 0.14, feet[2]];
    player.vel = [0, 0, 0];
    player.mode = 'splat';
    player.collider?.setEnabled(false);
    sfx.splat();
    sfx.oof(1);
    camera.addShake(0.8);
    // The block ends up resting on them, a little higher.
    b.raise = 0.22;
    this.die('squash', pick(['SQUASHED', 'FLAT-PACKED', 'PRESSED']), pick([
      'New blocks go on top. You were on top.',
      'The shadow was a hint.',
      'Timmy wants it noted that he didn’t see you. He did.',
    ]));
    this.say('OOPS.', 3);
  }

  // --- The finale ------------------------------------------------------------------------------

  private startFinale() {
    this.finaleT = 0;
    this.say('THIS GAME IS BORING.', 2.2);
    tone(120, 0.5, { to: 80, wave: 'sawtooth', vol: 0.12 });
    tone(100, 0.6, { to: 70, wave: 'sawtooth', vol: 0.1, at: 0.5 });
  }

  private updateFinale(dt: number) {
    const { player } = this.ctx;
    const tower = this.tower;
    const f = (this.finaleT += dt);
    this.giant.headShake = f < 1.3 ? 1 - f / 1.3 : 0;
    // A ledge slides out of the east wall (the exit behind it only opens when the tower hits).
    if (f >= LEDGE_AT) {
      if (this.ledgeOut === 0) sfx.slide();
      this.ledgeOut = Math.min(1, this.ledgeOut + dt / 0.45);
      const x = CHAMBER_HALF + LEDGE_DEPTH / 2 + 0.05 - (LEDGE_DEPTH + 0.05) * easeInOut(this.ledgeOut);
      this.ledge.setTranslation({ x, y: LEDGE_Y - 0.2, z: (LEDGE_Z[0] + LEDGE_Z[1]) / 2 });
    }
    // The shove: a steady push, then it goes on its own.
    if (f >= PUSH_AT && f - dt < PUSH_AT) this.say('TIMBER!!!', 3);
    if (!tower.collapsed) {
      if (f < PUSH_AT) {
        this.tipVel = 0;
      } else if (f < PUSH_AT + PUSH_TIME) {
        const target = PUSH_TIP * easeInOut((f - PUSH_AT) / PUSH_TIME);
        this.tipVel = (target - tower.tip) / Math.max(dt, 1e-3);
        tower.tip = target;
      } else {
        this.tipVel += FALL_ACCEL * Math.sin(tower.tip + 0.03) * dt;
        tower.tip += this.tipVel * dt;
      }
      // Creak, then groan as it goes.
      if (f > PUSH_AT && Math.random() < dt * 6) this.creak(0.7 + tower.tip);
      if (tower.tip >= TIP_BREAK) this.breakUp();
    }
    // Made it to the ledge?
    if (!this.escaped && player.mode === 'control' && this.ledgeOut > 0.5 && player.pos[0] > CHAMBER_HALF - LEDGE_DEPTH - 0.4 && player.pos[1] > LEDGE_Y - 0.5) {
      this.escaped = true;
    }
  }

  /** The finale's tower hits the wall and comes apart. */
  private breakUp() {
    const { player, camera } = this.ctx;
    const tower = this.tower;
    // Still up there (not mid-jump for the ledge, or already on it)?
    const onIt = !this.escaped && this.playerOnTop() !== null;
    // It snaps as it hits: faster than it was falling, and coming apart.
    this.pull = null;
    this.predicted = null;
    tower.collapse([0, 0, -this.tipVel * 1.8], tower.pivot(), onIt ? undefined : GROUPS_MISS_PLAYER, 1.6);
    this.crash();
    camera.addShake(1);
    // The crash knocks the exit panel open.
    this.exit.openNow();
    if (onIt) {
      const r = sub(player.pos, tower.pivot());
      player.kill([r[1] * this.tipVel * 0.9, -r[0] * this.tipVel * 0.3, 0], { violence: 14 });
      this.die('finale', pick(['TIMBER!', 'JENGA!', 'WENT DOWN WITH THE SHIP']), pick([
        'When a giant yells timber, get off the tree.',
        'The exit was right there. So was the wall.',
        'Timmy says that was your turn.',
      ]));
      this.say('HAHA! YOU LOSE!', 4);
    } else if (!this.death) {
      this.say('NO FAIR!', 4);
    }
  }

  /** It leaned too far: over it goes, with you on it. */
  private topple() {
    const { player, camera } = this.ctx;
    const tower = this.tower;
    const phi = tower.phi;
    const l = Math.hypot(phi[0], phi[1]) || 1;
    const dir: Vec3 = [phi[0] / l, 0, phi[1] / l];
    const spin: Vec3 = [dir[2] * 0.9, 0, -dir[0] * 0.9];
    const about: Vec3 = add(tower.base, scale(dir, BLOCK_L / 2));
    this.pull = null;
    this.predicted = null;
    tower.collapse(spin, about, undefined, 1.2);
    this.crash();
    camera.addShake(0.8);
    if (player.mode === 'control' && !this.death) {
      const r = sub(player.pos, about);
      const v: Vec3 = [spin[1] * r[2] - spin[2] * r[1], spin[2] * r[0] - spin[0] * r[2], spin[0] * r[1] - spin[1] * r[0]];
      player.kill(add(scale(v, 0.9), [0, 1.5, 0]), { violence: 10 });
      this.die('topple', pick(['JENGA!', 'TIMBER!']), pick([
        'It fell on your turn. Timmy wins. Timmy always wins.',
        'The Lean-o-meter was not a suggestion.',
        'One test subject, fifty-something wooden blocks, one outcome.',
      ]));
    }
    this.say('HAHA! YOU LOSE!', 4);
  }

  private die(cause: Cause, big: string, small: string) {
    if (this.death) return;
    this.ctx.hud.hide();
    this.death = { t: 0, big, small, cause };
  }

  // --- Timmy's hand ----------------------------------------------------------------------------

  private updateHand(dt: number) {
    const tower = this.tower;
    const p = this.pull;
    let goal: Vec3;
    let sharp = 5;
    let curl = 0.4;
    const top = tower.topOf(tower.topLayer());
    if (p) {
      const b = p.block;
      if (p.stage === 'aim' || p.stage === 'pull') {
        const { end, dir } = this.pullEnd(b);
        goal = add(end, add(scale(dir, p.stage === 'aim' ? 0.9 : 0.35), [0, 0.2, 0]));
        curl = p.stage === 'aim' ? 0.3 : 1.0;
        sharp = p.stage === 'pull' ? 30 : 5;
      } else if (p.stage === 'release') {
        goal = [BASE[0] - 1, top + 9, BASE[2] + 9];
        sharp = 2.5;
      } else {
        const m = b.free ?? b.frame;
        goal = transformPoint(m, [0, BLOCK_H / 2 + 0.25, 0]);
        curl = 1.0;
        sharp = p.stage === 'lift' && p.t < 0.3 ? 12 : 40;
      }
    } else if (this.finaleT >= 0 && !tower.collapsed) {
      // Pointing at the west face, near the top, and pushing.
      goal = tower.point(Math.max(0, tower.topLayer() - 2), [-BLOCK_L / 2 - 2.9, 0, 0]);
      goal[1] += 1.5;
      sharp = 6;
      curl = 1.3;
    } else {
      const rest = tower.collapsed ? 19 : top + 8;
      goal = [BASE[0] - 1 + Math.sin(this.giant.time * 0.8) * 1.5, rest + Math.sin(this.giant.time * 1.3), BASE[2] + 9];
      sharp = 2;
    }
    this.hand = add(this.hand, scale(sub(goal, this.hand), 1 - Math.exp(-dt * sharp)));
    this.giant.rightCurl += (curl - this.giant.rightCurl) * (1 - Math.exp(-dt * 8));
    this.finger += ((this.finaleT >= 0 && !tower.collapsed ? 1 : 0) - this.finger) * (1 - Math.exp(-dt * 5));
    // His arm is as wide as the tower: see-through while it's down beside it, so it doesn't hide everything.
    const reaching = (p && (p.stage === 'aim' || p.stage === 'pull' || (p.stage === 'lift' && p.t < 0.7))) || (this.finaleT >= 0 && !tower.collapsed);
    this.giant.armOpacity += ((reaching ? 0.55 : 1) - this.giant.armOpacity) * (1 - Math.exp(-dt * 6));
    if (this.giant.armOpacity > 0.97) this.giant.armOpacity = 1;
    const look = p ? (p.block.free ?? p.block.frame) : null;
    this.giant.lookTarget = look ? [look[12], look[13], look[14]] : this.ctx.player.pos;
    this.giant.update(dt, this.hand);
  }

  // --- Sounds and dust -------------------------------------------------------------------------

  /** A wooden creak (0-1+: louder and lower the worse it is). */
  private creak(intensity: number) {
    const k = clamp(intensity, 0.2, 1.4);
    const n = 6 + Math.floor(Math.random() * 6 + k * 6);
    const base = 180 + Math.random() * 120 - k * 50;
    const gap = 0.02 + Math.random() * 0.012;
    for (let i = 0; i < n; i++) {
      tone(base + Math.sin(i * 0.9) * 25 + Math.random() * 15, 0.035, { wave: 'sawtooth', vol: 0.03 + 0.05 * k, at: i * gap });
    }
    noise(n * gap, { freq: 420 + Math.random() * 200, type: 'bandpass', q: 6, vol: 0.05 + 0.08 * k });
  }

  /** A block tapped with a fingertip. */
  private tap() {
    tone(760 + Math.random() * 80, 0.05, { wave: 'square', vol: 0.06 });
    noise(0.06, { freq: 2400, type: 'bandpass', q: 4, vol: 0.18 });
  }

  /** A block landing: a hollow wooden knock. */
  private knock(vol: number) {
    tone(230, 0.18, { to: 120, wave: 'triangle', vol });
    tone(520, 0.05, { wave: 'square', vol: vol * 0.2 });
    noise(0.1, { freq: 1300, type: 'bandpass', q: 2, vol: vol * 0.9 });
  }

  /** The whole thing coming down. */
  private crash() {
    sfx.explosion(0.35);
    for (let i = 0; i < 14; i++) this.knockLater(0.1 + i * 0.07 + Math.random() * 0.12);
    for (let i = 0; i < 24; i++) {
      const k = Math.floor(Math.random() * this.tower.frames.length);
      const pos = this.tower.point(k, [(Math.random() - 0.5) * 4, 0, (Math.random() - 0.5) * 4]);
      this.puffs.push({ pos, vel: [(Math.random() - 0.5) * 3, Math.random(), (Math.random() - 0.5) * 3], age: 0, life: 1.6, size: 0.35 + Math.random() * 0.4 });
    }
  }

  private knockLater(at: number) {
    const f = 180 + Math.random() * 120;
    tone(f, 0.16, { to: f * 0.5, wave: 'triangle', vol: 0.25, at });
    noise(0.08, { freq: 1100 + Math.random() * 600, type: 'bandpass', q: 2, vol: 0.25, at });
  }

  private puffAtBase() {
    const a = Math.random() * Math.PI * 2;
    const r = BLOCK_L / 2 + 0.2;
    const pos: Vec3 = [BASE[0] + Math.cos(a) * r, 0.1, BASE[2] + Math.sin(a) * r];
    this.puffs.push({ pos, vel: [Math.cos(a) * 1.2, 0.5, Math.sin(a) * 1.2], age: 0, life: 1.4, size: 0.4 + Math.random() * 0.3 });
  }

  // --- Drawing ---------------------------------------------------------------------------------

  draw(out: DrawItem[]) {
    this.arrival.draw(out);
    this.exit.draw(out);
    this.tower.draw(out);
    // Timmy (no shadows from him: he'd black out the whole chamber).
    const first = out.length;
    this.giant.draw(out);
    if (this.finger > 0.02) {
      const g = this.giant.graspPoint;
      const tip = add(g, [3.2 * this.finger, -0.6, 0]);
      out.push({ mesh: 'cylinder', model: segment(g, tip, 0.55), color: [0.86, 0.64, 0.5], pattern: Pattern.skin });
      out.push({ mesh: 'sphere', model: mul(translation(tip), scaling([0.55, 0.55, 0.55])), color: [0.86, 0.64, 0.5], pattern: Pattern.skin });
    }
    for (let i = first; i < out.length; i++) out[i].shadow = false;

    // The shadow where the held block will land.
    const p = this.pull;
    if (p && p.to && (p.stage === 'lift' || p.stage === 'hover' || p.stage === 'drop')) {
      const rest = this.slotFrame(p.to.layer, p.to.slot);
      const k = p.stage === 'lift' ? clamp(p.t / (LIFT * this.pace()), 0, 1) * 0.5 : 0.55 + 0.25 * Math.sin(p.t * 12);
      out.push({ mesh: 'box', model: mul(rest, translation([0, -BLOCK_H / 2 + 0.015, 0]), scaling([BLOCK_W * 0.98, 0.02, BLOCK_L * 0.98])), color: [0.12, 0.02, 0.01], opacity: k, shadow: false });
    }

    // The ledge by the exit.
    if (this.ledgeOut > 0) {
      const x = CHAMBER_HALF + LEDGE_DEPTH / 2 + 0.05 - (LEDGE_DEPTH + 0.05) * easeInOut(this.ledgeOut);
      out.push({ mesh: 'box', model: mul(translation([x, LEDGE_Y - 0.2, (LEDGE_Z[0] + LEDGE_Z[1]) / 2]), scaling([LEDGE_DEPTH, 0.4, LEDGE_Z[1] - LEDGE_Z[0]])), color: WALL, pattern: Pattern.panels, param: 2, spec: 0.15 });
    }

    this.drawMeter(out, -1);
    this.drawMeter(out, 1);

    for (const q of this.puffs) {
      const k = q.age / q.life;
      const s = q.size * (1 + k * 2.2);
      out.push({ mesh: 'sphere', model: mul(translation(q.pos), scaling([s, s * 0.8, s])), color: DUST, opacity: 0.45 * (1 - k) * (1 - k), shadow: false });
    }
  }

  /**
   * A Lean-o-meter: a top-down dial of the lean, green / amber / red, with a blinking ring where
   * the lean is heading while Timmy pulls a block. `side` -1: on the north wall, 1: on the south
   * wall (turned round, so up on it is always away from you).
   */
  private drawMeter(out: DrawItem[], side: 1 | -1) {
    const R = 1.9;
    if (this.meterOn <= 0) return;
    const c: Vec3 = [side === 1 ? SOUTH_METER_X : BASE[0], 7.2, side * (CHAMBER_HALF - 0.02)];
    const pop = this.meterOn < 1 ? 1 + Math.sin(this.meterOn * Math.PI) * 0.25 : 1;
    const base = mul(translation(c), rotationX(side === 1 ? Math.PI : 0), scaling([this.meterOn * pop, this.meterOn * pop, 1]));
    const face = (r: number, dz: number, color: number[], emissive = false) =>
      out.push({ mesh: 'cylinder', model: mul(base, translation([0, 0, dz]), rotationX(Math.PI / 2), scaling([r, 0.04, r])), color, pattern: emissive ? Pattern.emissive : Pattern.plain, shadow: false });
    const danger = this.tower.collapsed ? 1 : clamp(this.tower.leanAmount() / PHI_MAX, 0, 1.2);
    const flash = danger > 0.8 ? 0.6 + 0.4 * Math.sin(this.giant.time * 18) : 1;
    face(R + 0.25, 0.02, [0.12, 0.12, 0.14]);
    face(R, 0.05, [0.9 * flash, 0.12 * flash, 0.08 * flash], true);
    face(R * 0.8, 0.08, [1.0, 0.62, 0.1], true);
    face(R * 0.55, 0.11, [0.2, 0.75, 0.3], true);
    // Crosshairs.
    out.push({ mesh: 'box', model: mul(base, translation([0, 0, 0.14]), scaling([R * 2, 0.04, 0.01])), color: [0.05, 0.05, 0.05], shadow: false });
    out.push({ mesh: 'box', model: mul(base, translation([0, 0, 0.14]), scaling([0.04, R * 2, 0.01])), color: [0.05, 0.05, 0.05], shadow: false });
    // The lean: east is right, north is up.
    const phi = this.tower.phi;
    const k = R / PHI_MAX;
    let dx = (phi[0] + this.tower.tip) * k, dy = -phi[1] * k;
    const len = Math.hypot(dx, dy);
    if (len > R * 1.05) {
      dx *= (R * 1.05) / len;
      dy *= (R * 1.05) / len;
    }
    if (Math.hypot(dx, dy) > 0.02) out.push({ mesh: 'cylinder', model: mul(base, segment([0, 0, 0.16], [dx, dy, 0.16], 0.05)), color: [0.05, 0.05, 0.05], shadow: false });
    out.push({ mesh: 'sphere', model: mul(base, translation([dx, dy, 0.2]), scaling([0.24, 0.24, 0.12])), color: [1.4, 1.4, 1.4], pattern: Pattern.emissive, shadow: false });
    // The prediction while Timmy pulls a block: a blinking ring where it's heading.
    const pr = this.predicted;
    if (pr && Math.sin(this.giant.time * 16) > -0.3) {
      let px = pr[0] * k, py = -pr[1] * k;
      const pl = Math.hypot(px, py);
      if (pl > R * 1.1) {
        px *= (R * 1.1) / pl;
        py *= (R * 1.1) / pl;
      }
      out.push({ mesh: 'tube', model: mul(base, translation([px, py, 0.2]), rotationX(Math.PI / 2), scaling([0.36, 0.06, 0.36])), color: [1.6, 1.6, 1.6], pattern: Pattern.emissive, shadow: false });
    }
  }

  labels(): WorldLabel[] {
    if (this.timmyLabel.text) {
      // Pinned near the top of the screen, just in front of the camera.
      const { camera } = this.ctx;
      const D = 6;
      const p = camera.pos, tg = camera.target;
      const f = normalize(sub(tg, p));
      const r = normalize(cross(f, camera.up));
      const u = cross(r, f);
      const half = Math.tan(camera.fov / 2) * D;
      this.timmyLabel.pos = add(add(p, scale(f, D)), scale(u, half * 0.72));
      this.timmyLabel.size = 0.05 * 2 * half;
    }
    return this.meterOn > 0.6 ? this.labelList : this.timmyOnly;
  }

  trackedTargets(): TrackedTarget[] {
    const exit = this.exit.target();
    if (exit) return [exit];
    // Before the crash opens the exit: the ledge is the place to be.
    if (this.ledgeOut >= 1 && !this.death && !this.escaped) return [{ pos: [CHAMBER_HALF - LEDGE_DEPTH / 2, LEDGE_Y + 0.4, EXIT_Z], radius: 1, color: 'purple' }];
    return [];
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

/** A world point in a rigid frame's local coordinates. */
function transformInverse(f: Mat4, p: Vec3): Vec3 {
  const d = sub(p, [f[12], f[13], f[14]]);
  return [d[0] * f[0] + d[1] * f[1] + d[2] * f[2], d[0] * f[4] + d[1] * f[5] + d[2] * f[6], d[0] * f[8] + d[1] * f[9] + d[2] * f[10]];
}
