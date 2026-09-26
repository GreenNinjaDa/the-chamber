import { clamp, lerp, mul, scaling, translation, type Vec3 } from '../../engine/math';
import { Pattern, type DrawItem, type Environment } from '../../engine/renderer';
import {
  BodySlicer, drawBeam, drawBeamDot, drawFloorGlow, LaserPylon, MAST_RADIUS, PYLON_RADIUS,
} from '../../entities/laser';
import { ExitPortal, PortalArrival } from '../../entities/portal';
import { CHAMBER_HALF } from '../../game/chamber';
import type { Circle } from '../../game/player';
import { DEFAULT_ENV, type CameraShot, type Level, type LevelContext, type LevelStatus, type TrackedTarget, type WorldLabel } from '../level';

/*
 * Laser Show (Fall Guys' Jump Club meets the Resident Evil laser hallway). The lights go down and
 * an emitter pylon rises out of the floor. A low beam sweeps round the room, faster and faster:
 * jump it. Then a high one joins, turning the other way: duck it (stand still, look down). Then
 * walls of beams sweep across the chamber with a gap to stand in, and finally a full grid with no
 * gap at all comes across from the west while the exit opens in the east wall.
 */

// --- Tuning ------------------------------------------------------------------------------------
const H = CHAMBER_HALF;
const SPAWN: Vec3 = [0, 0, 7];
/** Beam heights (m): the low one to jump, the high one to duck (hits a standing head, clears a ducking one). */
const LOW_HEIGHT = 0.35;
const HIGH_HEIGHT = 1.6;

// Timeline, in seconds after the arrival is over.
const DIM_TIME = 1.5;
const NOTICE_AT = 0.8;
const RISE_AT = 2.2;
const RISE_TIME = 2.0;
/** A beam grows out of its emitter (or back in) over this long. */
const EXTEND_TIME = 0.5;
/** It waits this long once out, then spins up to speed over SPIN_UP. */
const SPIN_DELAY = 0.4;
const SPIN_UP = 1.2;
const LOW_ON = RISE_AT + RISE_TIME + 0.6;
/** Jump Club: the low beam alone, speeding up from one turn per LOW_PERIOD[0] s to LOW_PERIOD[1] s over JUMP_TIME. */
const LOW_PERIOD: [number, number] = [5, 2.5];
const JUMP_TIME = 17;
/** Then the mast rises (the low beam eases off meanwhile) and the high beam comes out. */
const MAST_AT = LOW_ON + EXTEND_TIME + SPIN_DELAY + JUMP_TIME;
const MAST_TIME = 1.2;
const EASE_TIME = 2;
const HIGH_ON = MAST_AT + MAST_TIME + 0.5;
/** Both beams, turning opposite ways: periods (s per turn) over DUO_TIME. */
const DUO_LOW_PERIOD: [number, number] = [4.2, 3.2];
const DUO_HIGH_PERIOD: [number, number] = [5, 3.9];
const DUO_TIME = 15;
const RETRACT_AT = HIGH_ON + EXTEND_TIME + SPIN_DELAY + DUO_TIME;
const SINK_AT = RETRACT_AT + EXTEND_TIME + 0.3;
const SINK_TIME = 1.6;
const WALLS_AT = SINK_AT + SINK_TIME + 0.8;
/** Pause between one wall finishing and the next appearing (s). */
const WALL_PAUSE = 0.8;
/** Debugging: `?laserSkip=N` starts the show N seconds in (e.g. 45 for the walls, 70 for the finale). */
const SKIP = Number(new URLSearchParams(location.search).get('laserSkip')) || 0;

/** Hit tests step beams along at most this far (m) at a time, so nothing thin slips between ticks. */
const HIT_STEP = 0.04;
/** The body never reaches further than this from the player's feet position (m), sideways. */
const BODY_REACH = 1.5;
/** A slicing death: how violent (tears joints, more near the cut) and how hard the beam shoves. */
const SLICE_VIOLENCE = 30;
const GRID_VIOLENCE = 42;
const SLICE_PUSH = 2.5;
const DEATH_SCREEN_DELAY = 1.6;

type DeathKind = 'beam' | 'wall' | 'grid';

interface SweepSpec {
  /** A wall across the chamber moving along z (spanning x), or along x (spanning z). */
  axis: 'x' | 'z';
  /**
   * Starts at the chamber's negative (-1) or positive (+1) side and sweeps to the other; 0: from
   * whichever side is further from the player (so there's always time to find the gap).
   */
  from: -1 | 0 | 1;
  speed: number;
  /** Width of the full-height gap (0: none). */
  gap: number;
  /** A low beam across the gap as well, to jump as it passes. */
  jumpInGap?: boolean;
  /** The gap is in the west half (so you end up far from the exit for the finale). */
  gapWest?: boolean;
  /** Heights of the horizontal beams; the top one is the grid's top. */
  rows: number[];
  /** Spacing of the vertical beams. */
  colSpacing: number;
  /** Seconds it flickers on at its starting wall before it moves. */
  warmup: number;
  kind: DeathKind;
}

const WALL_ROWS = [0.25, 0.7, 1.15, 1.6, 2.05, 2.5, 2.95, 3.4, 3.85];
const GRID_ROWS = [0.2, 0.55, 0.9, 1.25, 1.6, 1.95, 2.3, 2.65, 3.0, 3.35, 3.7, 4.05];
const WALLS: SweepSpec[] = [
  { axis: 'z', from: 0, speed: 3, gap: 2.4, rows: WALL_ROWS, colSpacing: 1.5, warmup: 1.6, kind: 'wall' },
  { axis: 'z', from: 0, speed: 4.2, gap: 2.0, rows: WALL_ROWS, colSpacing: 1.5, warmup: 1.3, kind: 'wall' },
  { axis: 'z', from: 0, speed: 4.6, gap: 2.0, jumpInGap: true, gapWest: true, rows: WALL_ROWS, colSpacing: 1.5, warmup: 1.5, kind: 'wall' },
];
/** The gap is at least this far (m) sideways from where you stand when a wall appears: you have to move. */
const GAP_MIN_MOVE = 3;
/** ...and no further than you can walk (at WALK_SPEED, after REACTION seconds) before it reaches you. */
const WALK_SPEED = 5;
const REACTION = 1.2;
/** The finale: a full grid with no gap, from the west wall to the east, at about walking pace. */
const GRID: SweepSpec = { axis: 'x', from: -1, speed: 4.2, gap: 0, rows: GRID_ROWS, colSpacing: 0.75, warmup: 2.2, kind: 'grid' };

// --- Looks -------------------------------------------------------------------------------------
const DARK_ENV: Environment = {
  ...DEFAULT_ENV,
  sunColor: [0.07, 0.045, 0.05],
  skyColor: [0.03, 0.008, 0.01],
  groundColor: [0.025, 0.01, 0.01],
  fogColor: [0.02, 0.003, 0.004],
  fogDensity: 0.006,
};
const RED_LIGHT: Vec3 = [2.4, 0.12, 0.08];

// --- Words -------------------------------------------------------------------------------------
const JOKES = [
  'You have been portioned.',
  'Sliced, diced, and deeply disappointed.',
  'Some assembly required.',
  'Now available in convenient bite-sized pieces.',
  'Resident Evil called. It wants its hallway back.',
  'Your Jump Club membership has been revoked.',
];
const HINTS: Record<DeathKind, string> = {
  beam: 'Jump the low beams. Duck the high ones: stand still and look down. Where the two cross, be somewhere else.',
  wall: 'Find the gap in the walls and stand in it. Some gaps come with a low beam to jump as well.',
  grid: 'The last grid has no gap. Get to the exit before it gets to you.',
};
const CONTROLS = 'Space jump · Stand still and look down to duck · Shift sprint';

const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
const NO_OBSTACLES: Circle[] = [];
/** 0 up to x = 0, 1 from x = 1, smooth in between. */
const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/** Distance from the chamber's centre to its walls along the direction at angle `a` (in the xz plane). */
function wallDistance(a: number) {
  const c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
  return Math.min(c > 1e-6 ? H / c : Infinity, s > 1e-6 ? H / s : Infinity);
}

/** Smallest difference between two angles (0 to pi). */
function angleGap(a: number, b: number) {
  const d = Math.abs(((a - b) % (Math.PI * 2) + Math.PI * 3) % (Math.PI * 2) - Math.PI);
  return d;
}

/** A beam turning around the pylon at a fixed height. */
class Spinner {
  angle = 0;
  /** Angle at the previous tick (for sweeping hit tests). */
  prev = 0;
  /** Current angular speed (rad/s, unsigned). */
  omega = 0;
  /** How far it has grown out to the walls (0-1). */
  ext = 0;
  /** It comes out opposite the player, turned by up to this much either way (random). */
  readonly offset: number;
  /** Aimed (it only aims while it isn't out yet). */
  placed = false;
  constructor(readonly dir: 1 | -1, spread: number) {
    this.offset = (Math.random() * 2 - 1) * spread;
  }
}

interface HLine { v: number; u0: number; u1: number }
interface VLine { u: number; v0: number; v1: number }

/** A wall (or grid) of beams sweeping across the chamber. Works in (u along it, v up, w across). */
class Sweep {
  t = 0;
  w: number;
  prevW: number;
  readonly hLines: HLine[] = [];
  readonly vLines: VLine[] = [];
  readonly end: number;

  /** `from`: the side it starts from (-1 or +1); `gapCentre`: where the gap is along it. */
  constructor(readonly spec: SweepSpec, readonly from: number, readonly gapCentre: number) {
    this.w = this.prevW = from * (H - 0.12);
    this.end = -from * (H - 0.02);
    const top = spec.rows[spec.rows.length - 1];
    const g0 = gapCentre - spec.gap / 2, g1 = gapCentre + spec.gap / 2;
    for (const v of spec.rows) {
      if (spec.gap > 0) {
        this.hLines.push({ v, u0: -H, u1: g0 }, { v, u0: g1, u1: H });
      } else {
        this.hLines.push({ v, u0: -H, u1: H });
      }
    }
    if (spec.jumpInGap) this.hLines.push({ v: LOW_HEIGHT, u0: g0, u1: g1 });
    for (let u = -H + spec.colSpacing / 2; u < H; u += spec.colSpacing) {
      if (spec.gap > 0 && u > g0 - 0.35 && u < g1 + 0.35) continue;
      this.vLines.push({ u, v0: 0, v1: top });
    }
    if (spec.gap > 0) this.vLines.push({ u: g0, v0: 0, v1: top }, { u: g1, v0: 0, v1: top });
  }

  get moving() {
    return this.t >= this.spec.warmup && !this.done;
  }

  get done() {
    return this.w === this.end;
  }

  /** 0-1 flicker while it powers up at its starting wall, then 1. */
  get intensity() {
    const k = this.t / this.spec.warmup;
    if (k >= 1) return 1;
    const flicker = Math.sin(this.t * 53) * Math.sin(this.t * 31) > 0.1 ? 1 : 0.25;
    return k < 0.6 ? flicker * (0.3 + k) : 1;
  }

  update(dt: number) {
    this.t += dt;
    this.prevW = this.w;
    if (this.t < this.spec.warmup || this.done) return;
    const dir = -this.from;
    const w = this.w + dir * this.spec.speed * dt;
    this.w = dir > 0 ? Math.min(w, this.end) : Math.max(w, this.end);
  }

  /** World position of (u, v) on the wall when it's at `w`. */
  point(u: number, v: number, w: number): Vec3 {
    return this.spec.axis === 'z' ? [u, v, w] : [w, v, u];
  }
}

export class LaserLevel implements Level {
  readonly number: number;
  readonly title = 'Laser Show';
  status: LevelStatus = 'playing';
  private arrival: PortalArrival;
  private exit = new ExitPortal(0);
  private pylon: LaserPylon;
  private slicer = new BodySlicer();
  private low = new Spinner(1, 0.3);
  private high = new Spinner(-1, 1);
  /** Seconds since the arrival finished (-1: still arriving). */
  private t = -1;
  private noticeShown = false;
  private sweep: Sweep | null = null;
  private wallIndex = 0;
  /** Seconds until the next wall appears (after the last one finished). */
  private wallWait = 0;
  private finale = false;
  private death: { t: number; kind: DeathKind; small: string } | null = null;
  /** Sparks where the beam cut: position, then one velocity per spark. */
  private sparks: { pos: Vec3; t: number; vel: Vec3[] } | null = null;
  private env: Environment = {
    ...DEFAULT_ENV,
    sunColor: [...DEFAULT_ENV.sunColor],
    skyColor: [...DEFAULT_ENV.skyColor],
    groundColor: [...DEFAULT_ENV.groundColor],
    fogColor: [...DEFAULT_ENV.fogColor],
    pointLight: { pos: [0, 0.6, 0], color: [0, 0, 0], range: 13 },
  };
  private sign: WorldLabel = { pos: [0, 6.2, -H + 0.05], text: 'DO NOT LOOK INTO LASER WITH REMAINING EYE', size: 0.6, color: '#ff4a3a' };
  private labelList: WorldLabel[] = [];
  private pylonObstacle: Circle[] = [{ x: 0, z: 0, r: PYLON_RADIUS }];

  constructor(private ctx: LevelContext) {
    this.number = ctx.number;
    const { physics, hud } = ctx;
    hud.setLevel(`The Chamber · Level ${this.number}`);
    hud.show(`LEVEL ${this.number}`, '', 2.5);
    hud.hint('');
    this.arrival = new PortalArrival(ctx, SPAWN);
    this.pylon = new LaserPylon(physics, [0, 0, 0], LOW_HEIGHT, HIGH_HEIGHT);
  }

  // --- Update ----------------------------------------------------------------------------------

  update(dt: number) {
    const { player } = this.ctx;
    const death = this.death;
    if (death && this.status === 'playing') {
      death.t += dt;
      if (death.t > DEATH_SCREEN_DELAY) {
        this.status = 'lost';
        this.ctx.hud.show('SLICED', `${death.small}\nPress R to try again.`);
        this.ctx.hud.tips([['Hint', HINTS[death.kind]], ['Controls', CONTROLS]]);
      }
    }
    if (this.sparks) this.sparks.t += dt;
    this.arrival.update(dt);
    this.exit.update(dt, player);
    if (this.exit.entered && this.status === 'playing') this.status = 'exited';

    if (this.t < 0) {
      if (!this.arrival.done) return;
      this.t = SKIP;
    }
    this.t += dt;
    const t = this.t;

    if (!this.noticeShown && t >= NOTICE_AT) {
      this.noticeShown = true;
      this.labelList.push(this.sign);
      if (!this.death) this.ctx.hud.show('SAFETY NOTICE', 'Please keep all limbs inside your body at all times.', 3.5);
    }

    this.updatePylon(t);
    this.updateSpinner(this.low, dt, t, LOW_ON, RETRACT_AT, (k) => this.lowSpeed(k));
    this.updateSpinner(this.high, dt, t, HIGH_ON, RETRACT_AT, (k) => this.highSpeed(k));
    this.updateSweeps(dt, t);
    this.checkHits();
  }

  /** Target angular speed (rad/s) of the low beam at level time `t`. */
  private lowSpeed(t: number) {
    const start = LOW_ON + EXTEND_TIME + SPIN_DELAY;
    let period: number;
    if (t < MAST_AT) {
      period = lerp(LOW_PERIOD[0], LOW_PERIOD[1], smooth((t - start) / JUMP_TIME));
    } else if (t < HIGH_ON + EXTEND_TIME + SPIN_DELAY) {
      // Eases off while the mast rises: something's changing.
      period = lerp(LOW_PERIOD[1], DUO_LOW_PERIOD[0], smooth((t - MAST_AT) / EASE_TIME));
    } else {
      period = lerp(DUO_LOW_PERIOD[0], DUO_LOW_PERIOD[1], smooth((t - HIGH_ON - EXTEND_TIME - SPIN_DELAY) / DUO_TIME));
    }
    return (Math.PI * 2) / period;
  }

  private highSpeed(t: number) {
    const start = HIGH_ON + EXTEND_TIME + SPIN_DELAY;
    const period = lerp(DUO_HIGH_PERIOD[0], DUO_HIGH_PERIOD[1], smooth((t - start) / DUO_TIME));
    return (Math.PI * 2) / period;
  }

  private updatePylon(t: number) {
    const p = this.pylon;
    const up = smooth((t - RISE_AT) / RISE_TIME);
    const down = smooth((t - SINK_AT) / SINK_TIME);
    const rise = up * (1 - down);
    // Rumble while it moves.
    if (rise > 0.02 && rise < 0.98) this.ctx.camera.addShake(0.08);
    p.rise = rise;
    const mastUp = smooth((t - MAST_AT) / MAST_TIME);
    const mastDown = smooth((t - RETRACT_AT - EXTEND_TIME) / 0.5);
    p.mast = mastUp * (1 - mastDown);
    p.ringGlow = clamp((t - LOW_ON + 0.8) / 0.8, 0, 1) * (1 - clamp((t - RETRACT_AT - EXTEND_TIME) / 0.4, 0, 1));
    p.mastGlow = clamp((t - HIGH_ON + 0.5) / 0.5, 0, 1) * (1 - clamp((t - RETRACT_AT - EXTEND_TIME) / 0.4, 0, 1));
    p.sync();
  }

  private updateSpinner(s: Spinner, dt: number, t: number, onAt: number, offAt: number, speed: (t: number) => number) {
    s.prev = s.angle;
    if (t < onAt || !s.placed) {
      // Not out yet: point it away from the player (give or take), so it grows out on the far side.
      const pos = this.ctx.player.pos;
      s.angle = s.prev = Math.atan2(pos[2], pos[0]) + Math.PI + s.offset;
      s.ext = 0;
      s.placed = t >= onAt;
      if (t < onAt) return;
    }
    s.ext = clamp((t - onAt) / EXTEND_TIME, 0, 1) * (1 - clamp((t - offAt) / EXTEND_TIME, 0, 1));
    const spin = smooth((t - onAt - EXTEND_TIME - SPIN_DELAY) / SPIN_UP);
    s.omega = speed(t) * spin;
    s.angle += s.dir * s.omega * dt;
  }

  private updateSweeps(dt: number, t: number) {
    if (t < WALLS_AT) return;
    if (this.sweep) {
      this.sweep.update(dt);
      if (!this.sweep.done) return;
      if (this.finale) return;
      this.sweep = null;
      this.wallWait = WALL_PAUSE;
    }
    this.wallWait -= dt;
    if (this.wallWait > 0) return;
    if (this.wallIndex < WALLS.length) {
      const spec = WALLS[this.wallIndex];
      // It comes from the far side, and the gap is somewhere else from where you're standing (you'll
      // have to move), but not so far that you can't walk there in time.
      const pos = this.ctx.player.pos;
      const from = spec.from || (pos[2] > 0 ? -1 : 1);
      const time = spec.warmup + (H + Math.abs(pos[2])) / spec.speed - REACTION;
      const reach = Math.max(GAP_MIN_MOVE + 1, time * WALK_SPEED);
      const room = H - 1.5 - spec.gap / 2;
      const hi = spec.gapWest ? -2 : room;
      let gap = 0;
      for (let tries = 0; tries < 60; tries++) {
        gap = -room + Math.random() * (hi + room);
        const move = Math.abs(gap - pos[0]);
        if (move >= GAP_MIN_MOVE && move <= reach) break;
      }
      this.sweep = new Sweep(spec, from, gap);
      if (this.wallIndex === 0 && !this.death) this.ctx.hud.show('AND NOW', 'for something completely different.', 2.5);
      this.wallIndex++;
      return;
    }
    // The finale: no gap, and the exit opens.
    this.finale = true;
    this.sweep = new Sweep(GRID, GRID.from, 0);
    this.exit.openNow();
    if (!this.death) this.ctx.hud.show('BUDGET CUTS', 'We could no longer afford the gap. Thank you for your understanding.', 3.5);
  }

  // --- Hit tests -------------------------------------------------------------------------------

  private checkHits() {
    const { player } = this.ctx;
    if (this.death || player.mode !== 'control' || player.inPortal) return;
    this.slicer.load(player.partFrames());
    const p = this.pylon;
    if (this.spinnerHits(this.low, p.ringY, PYLON_RADIUS + 0.015)) return this.slice('beam', this.spinnerPush(this.low));
    if (this.spinnerHits(this.high, p.mastRingY, MAST_RADIUS + 0.015)) return this.slice('beam', this.spinnerPush(this.high));
    // (The beam straight up out of the pylon's top is out of reach: nobody can stand up there.)
    const s = this.sweep;
    if (s && s.moving && this.sweepHits(s)) {
      const dir = -s.from * SLICE_PUSH;
      return this.slice(s.spec.kind, s.spec.axis === 'z' ? [0, 1, dir] : [dir, 1, 0]);
    }
  }

  private get skyBeamOn() {
    return this.low.ext >= 1 || this.high.ext >= 1;
  }

  /** Did the spinner's beam cross the body since the last tick? Steps it through the swept angle. */
  private spinnerHits(s: Spinner, height: number, r0: number): boolean {
    if (s.ext <= 0) return false;
    const pos = this.ctx.player.pos;
    const rho = Math.hypot(pos[0], pos[2]);
    const phi = Math.atan2(pos[2], pos[0]);
    const swept = s.angle - s.prev;
    const margin = rho > BODY_REACH + 0.05 ? Math.asin(BODY_REACH / rho) + 0.02 : Math.PI;
    if (angleGap(phi, s.prev + swept / 2) > Math.abs(swept) / 2 + margin) return false;
    const n = clamp(Math.ceil((Math.abs(swept) * (rho + BODY_REACH)) / HIT_STEP), 1, 64);
    for (let i = 1; i <= n; i++) {
      const a = s.prev + (swept * i) / n;
      const c = Math.cos(a), sn = Math.sin(a);
      const len = r0 + (wallDistance(a) - r0) * s.ext;
      if (this.slicer.test(c * r0, height, sn * r0, c * len, height, sn * len)) return true;
    }
    return false;
  }

  /** Which way a spinner's beam shoves what it cuts: along its motion. */
  private spinnerPush(s: Spinner): Vec3 {
    const a = s.angle;
    return [-Math.sin(a) * s.dir * SLICE_PUSH, 1, Math.cos(a) * s.dir * SLICE_PUSH];
  }

  /** Did the wall of beams pass through the body since the last tick? */
  private sweepHits(s: Sweep): boolean {
    const pos = this.ctx.player.pos;
    const here = s.spec.axis === 'z' ? pos[2] : pos[0];
    const lo = Math.min(s.prevW, s.w), hi = Math.max(s.prevW, s.w);
    if (here < lo - BODY_REACH || here > hi + BODY_REACH) return false;
    const n = clamp(Math.ceil((hi - lo) / HIT_STEP), 1, 32);
    const slicer = this.slicer, alongZ = s.spec.axis === 'z';
    // A beam from (u0, v0) to (u1, v1) on the wall at w, in world space.
    const test = (u0: number, v0: number, u1: number, v1: number, w: number) =>
      alongZ ? slicer.test(u0, v0, w, u1, v1, w) : slicer.test(w, v0, u0, w, v1, u1);
    for (let i = 1; i <= n; i++) {
      const w = s.prevW + ((s.w - s.prevW) * i) / n;
      if (Math.abs(w - here) > BODY_REACH) continue;
      for (const l of s.hLines) if (test(l.u0, l.v, l.u1, l.v, w)) return true;
      for (const l of s.vLines) if (test(l.u, l.v0, l.u, l.v1, w)) return true;
    }
    return false;
  }

  private slice(kind: DeathKind, push: Vec3) {
    const { player, camera, hud } = this.ctx;
    const origin: Vec3 = [...this.slicer.hit];
    const airborne = !player.onGround;
    player.kill(push, { violence: kind === 'grid' ? GRID_VIOLENCE : SLICE_VIOLENCE, origin });
    camera.addShake(0.45);
    hud.hide();
    const vel: Vec3[] = [];
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2, up = Math.random();
      const sp = 2 + Math.random() * 4;
      vel.push([Math.cos(a) * sp * (1 - up * 0.5), 1 + up * 4, Math.sin(a) * sp * (1 - up * 0.5)]);
    }
    this.sparks = { pos: origin, t: 0, vel };
    let small = pick(JOKES);
    if (kind === 'beam' && airborne && this.slicer.hit[1] > 1.2) small = 'You jumped into the high one. Bold. Wrong, but bold.';
    this.death = { t: 0, kind, small };
  }

  // --- Drawing ---------------------------------------------------------------------------------

  draw(out: DrawItem[], time: number) {
    this.arrival.draw(out);
    this.exit.draw(out);
    this.pylon.draw(out, time);
    const p = this.pylon;
    this.drawSpinner(out, this.low, p.ringY, PYLON_RADIUS + 0.015, 1);
    this.drawSpinner(out, this.high, p.mastRingY, MAST_RADIUS + 0.015, 0.3);
    if (this.skyBeamOn && p.rise > 0.5) drawBeam(out, [0, p.mastTop, 0], [0, 60, 0]);
    if (this.sweep) this.drawSweep(out, this.sweep);
    this.drawSparks(out);
  }

  private drawSpinner(out: DrawItem[], s: Spinner, height: number, r0: number, floorGlow: number) {
    if (s.ext <= 0) return;
    const c = Math.cos(s.angle), sn = Math.sin(s.angle);
    const wall = wallDistance(s.angle);
    const len = r0 + (wall - r0) * s.ext;
    const a: Vec3 = [c * r0, height, sn * r0];
    const b: Vec3 = [c * len, height, sn * len];
    drawBeam(out, a, b);
    // Its glow on the floor underneath (fainter and wider the higher it is), and the spot on the wall.
    drawFloorGlow(out, [c * (r0 + 0.1), 0, sn * (r0 + 0.1)], [c * len, 0, sn * len], 0.45 + height * 0.3, floorGlow);
    if (s.ext >= 1) drawBeamDot(out, [c * (wall - 0.01), height, sn * (wall - 0.01)]);
  }

  private drawSweep(out: DrawItem[], s: Sweep) {
    if (s.done) return;
    const k = s.intensity;
    const w = s.w;
    for (const l of s.hLines) {
      drawBeam(out, s.point(l.u0, l.v, w), s.point(l.u1, l.v, w), k);
      if (l.u0 <= -H) drawBeamDot(out, s.point(-H + 0.01, l.v, w), k, 0.8);
      if (l.u1 >= H) drawBeamDot(out, s.point(H - 0.01, l.v, w), k, 0.8);
    }
    for (const l of s.vLines) {
      drawBeam(out, s.point(l.u, l.v0, w), s.point(l.u, l.v1, w), k);
      drawBeamDot(out, s.point(l.u, 0.01, w), k, 0.7);
    }
    // Its glow on the floor along its foot.
    const a = s.point(-H, 0, w), b = s.point(H, 0, w);
    drawFloorGlow(out, a, b, 0.5, 0.6 * k);
  }

  private drawSparks(out: DrawItem[]) {
    const sp = this.sparks;
    if (!sp || sp.t > 0.8) return;
    const t = sp.t;
    if (t < 0.14) {
      const r = 0.05 + t * 1.4;
      const heat = 1 - t / 0.14;
      out.push({ mesh: 'sphere', model: mul(translation(sp.pos), scaling([r, r, r])), color: [8 * heat, 1.4 * heat, 0.7 * heat], pattern: Pattern.emissive, shadow: false, opacity: 0.6 });
    }
    const fade = 1 - t / 0.8;
    for (const v of sp.vel) {
      const q: Vec3 = [sp.pos[0] + v[0] * t, sp.pos[1] + v[1] * t - 5 * t * t, sp.pos[2] + v[2] * t];
      if (q[1] < 0.02) continue;
      const r = 0.025;
      out.push({ mesh: 'sphere', model: mul(translation(q), scaling([r, r, r])), color: [6 * fade, 1.6 * fade, 0.4 * fade], pattern: Pattern.emissive, shadow: false });
    }
  }

  // --- The rest of the Level interface ---------------------------------------------------------

  environment(): Environment {
    const e = this.env;
    const k = smooth(this.t / DIM_TIME);
    for (let i = 0; i < 3; i++) {
      e.sunColor[i] = lerp(DEFAULT_ENV.sunColor[i], DARK_ENV.sunColor[i], k);
      e.skyColor[i] = lerp(DEFAULT_ENV.skyColor[i], DARK_ENV.skyColor[i], k);
      e.groundColor[i] = lerp(DEFAULT_ENV.groundColor[i], DARK_ENV.groundColor[i], k);
      e.fogColor[i] = lerp(DEFAULT_ENV.fogColor[i], DARK_ENV.fogColor[i], k);
    }
    e.fogDensity = lerp(DEFAULT_ENV.fogDensity, DARK_ENV.fogDensity, k);
    // One red light: at the pylon while it's working, then riding along with the walls.
    const light = e.pointLight!;
    const s = this.sweep;
    if (s && !s.done) {
      const q = s.point(s.spec.gap > 0 ? s.gapCentre : 0, 2, s.w);
      light.pos[0] = q[0];
      light.pos[1] = q[1];
      light.pos[2] = q[2];
      light.range = 14;
      const glow = s.intensity;
      for (let i = 0; i < 3; i++) light.color[i] = RED_LIGHT[i] * glow;
    } else {
      const p = this.pylon;
      light.pos[0] = 0;
      light.pos[1] = Math.max(0.3, p.ringY + 0.3);
      light.pos[2] = 0;
      light.range = 13;
      const glow = Math.max(p.ringGlow, p.mastGlow) * p.rise;
      for (let i = 0; i < 3; i++) light.color[i] = RED_LIGHT[i] * glow;
    }
    return e;
  }

  labels(): WorldLabel[] {
    return this.labelList;
  }

  trackedTargets(): TrackedTarget[] {
    const exit = this.exit.target();
    return exit ? [exit] : [];
  }

  obstacles() {
    // Also shoves anyone standing on the hatch aside as it comes up.
    return this.pylon.rise > 0.01 ? this.pylonObstacle : NO_OBSTACLES;
  }

  cameraShot(): CameraShot | null {
    return this.arrival.cameraShot();
  }
}
