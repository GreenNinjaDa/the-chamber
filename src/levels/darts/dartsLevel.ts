import { noise, sfx, tone } from '../../engine/audio';
import {
  add, clamp, distXZ, easeInOut, lerp, lerp3, mul, normalize, rotationX, scale, scaling, sub, translation,
  type Vec3,
} from '../../engine/math';
import { Pattern, type DrawItem } from '../../engine/renderer';
import { CHAMBER_HALF } from '../../game/chamber';
import {
  DEFAULT_ENV, type CameraShot, type Level, type LevelContext, type LevelStatus, type TrackedTarget,
} from '../level';
import { drawPortal, ExitPortal, PORTAL_SQUEEZE_TIME, PortalArrival } from '../../entities/portal';
import { DART_GRIP, dartMatrix, drawDart } from '../../entities/dart';
import { Giant } from '../../entities/giant';

/*
 * Level 1 — Darts.
 * A giant rises over the south wall and blots out the sun. Five player-sized darts fall
 * into the chamber, then his hand hunts the player. Survive by baiting the hand onto
 * darts until he has thrown all five; each grab makes the hand faster. If he catches
 * you, you're thrown at the board — steer mid-air and hit the bullseye to survive.
 */

const G = 20;
/** Weaker gravity while the player is thrown, for a flatter flight with time to steer. */
const FLIGHT_G = 6;
const FLIGHT_TIME = 4.2;
const DART_COUNT = 5;
const BOARD_CENTER: Vec3 = [0, 34, -75];
/** How far below its final height the board waits, hidden, until the giant rises. */
const BOARD_HIDDEN_DROP = 45;
const BOARD_R = 9;
const BOARD_FACE_Z = BOARD_CENTER[2] + 0.5;
const SCORING_R = BOARD_R * 0.8;
/** Player centre must land this close to the centre to count as a bullseye. */
const BULLSEYE_R = 1.1;
/** After the last dart, the chance the giant has one more go at you (while the exit opens). */
const FINAL_REACH_CHANCE = 0.5;
/** That last grab hovers this long (s): just about enough time to run for the exit. */
const FINAL_HOVER = 2.2;
const GRAB_R = 2.8;
const HOVER_Y = 18;
const HAND_LIMIT = CHAMBER_HALF - 1;
const STEER_ACCEL = 5;
const DART_COLORS = [
  [0.9, 0.1, 0.1],
  [0.1, 0.35, 0.9],
  [0.95, 0.8, 0.1],
  [0.1, 0.75, 0.3],
  [0.6, 0.2, 0.85],
];

// Hand speed at the first grab, and how much each grab speeds it up.
const HAND_START = { hover: 2.6, follow: 1.2, slam: 0.4, sweep: 12 };
const HAND_STEP = { hover: 0.3, follow: 0.45, slam: 0.04, sweep: 1.5 };
const HAND_MIN = { hover: 1.0, slam: 0.22 };
/** Share of the hover time the hand would spend lowering at normal speed. */
const REACH_SHARE = 0.55;
/** The descent runs this many times faster; the hover gets the saved time, so pacing is unchanged. */
const REACH_SPEEDUP = 2;
/** During the reach the hand keeps tracking the player for this fraction, then locks its landing spot. */
const REACH_TRACK = 0.5;
/** A sweeping hand grabs a dart within this distance, and the player within the smaller one. */
const SWEEP_DART_R = 2.2;
const SWEEP_PLAYER_R = 1.6;
const SWEEP_PAUSE = 0.15;
const SWEEP_MAX_TIME = 3;

type Phase = 'intro' | 'rise' | 'drop' | 'hunt' | 'sink' | 'gone' | 'over';
type HandState = 'rest' | 'hover' | 'reach' | 'sweep' | 'close' | 'carry' | 'windup' | 'throw' | 'recover';

interface Dart {
  tip: Vec3;
  dir: Vec3;
  vel: Vec3;
  state: 'falling' | 'stuck' | 'held' | 'flying' | 'board';
  color: number[];
  landDir: Vec3;
}

export class DartsLevel implements Level {
  readonly number: number;
  readonly title = 'Darts';
  status: LevelStatus = 'playing';

  private phase: Phase = 'intro';
  private phaseT = 0;
  private giant = new Giant();
  private darts: Dart[] = [];

  private handState: HandState = 'rest';
  private handT = 0;
  private handXZ: [number, number] = [0, 4];
  private grasp: Vec3 = [0, 0, 0];
  private from: Vec3 = [0, 0, 0];
  private to: Vec3 = [0, 0, 0];
  private hoverTime = HAND_START.hover;
  private follow = HAND_START.follow;
  private slamTime = HAND_START.slam;
  private sweepSpeed = HAND_START.sweep;
  private held: Dart | 'player' | null = null;
  private thrown = 0;

  private flightVel: Vec3 = [0, 0, 0];
  private passedBoard = false;
  private boardDrop = BOARD_HIDDEN_DROP;
  private arrival: PortalArrival;
  private exit = new ExitPortal(-2);
  /** Set once all the darts are gone and the exit has opened. */
  private endgame = false;
  /** Counts down while the player is being sucked into the bullseye portal (-1: not). */
  private bullseyeExit = -1;

  constructor(private ctx: LevelContext) {
    this.number = ctx.number;
    ctx.hud.setLevel(`The Chamber · Level ${this.number}`);
    ctx.hud.show(`LEVEL ${this.number}`, "", 2.5); // no hint of the theme up front
    ctx.hud.hint('');
    // Pose the giant once so he starts hidden below ground rather than at the origin.
    this.giant.update(0, [0, 0, 0]);
    this.grasp = this.restPoint();
    this.arrival = new PortalArrival(ctx, [0, 0, 6]);
  }

  update(dt: number) {
    const { player, camera } = this.ctx;
    this.phaseT += dt;
    this.giant.time += dt;
    this.arrival.update(dt);
    this.exit.update(dt, player);
    if (this.exit.entered) this.status = 'exited';
    if (this.bullseyeExit >= 0) {
      this.bullseyeExit -= dt;
      if (this.bullseyeExit < 0) this.status = 'exited';
    }

    switch (this.phase) {
      case 'intro':
        if (this.arrival.done) this.setPhase('rise');
        break;
      case 'rise': {
        const k = easeInOut(Math.min(1, this.phaseT / 4.5));
        this.giant.root[1] = lerp(-80, 0, k);
        this.boardDrop = lerp(BOARD_HIDDEN_DROP, 0, k);
        if (this.phaseT < 4.5) camera.addShake(0.3);
        if (this.phaseT > 5) {
          this.spawnDarts();
          this.setPhase('drop');
        }
        break;
      }
      case 'drop':
        if (this.phaseT > 2 && this.darts.every((d) => d.state !== 'falling')) {
          this.setPhase('hunt');
          this.startHover();
        }
        break;
      case 'hunt':
        this.updateHand(dt);
        break;
      case 'sink': {
        const k = easeInOut(Math.min(1, this.phaseT / 4));
        this.giant.root[1] = lerp(0, -80, k);
        this.giant.headShake = 1 - k;
        camera.addShake(0.2);
        if (this.phaseT > 4.2) this.setPhase('gone'); // off he goes; the exit is open
        break;
      }
    }
    if (this.handState === 'rest') this.grasp = this.restPoint();

    const g = this.giant;
    const throwing = this.handState === 'carry' || this.handState === 'windup' || this.handState === 'throw';
    g.leanTarget = throwing || this.handState === 'rest'
      ? 0.06
      : clamp(0.12 + ((14 - this.grasp[2]) / 26) * 0.5, 0.1, 0.62);
    // From the moment he grabs something until shortly after he throws it, he stares at the
    // board like a man concentrating on his shot; otherwise he watches the player.
    const focusing = this.held !== null || (this.handState === 'recover' && this.handT < 0.5);
    g.lookTarget = !focusing && player.mode === 'control'
      ? add(player.pos, [0, 1, 0])
      : BOARD_CENTER;
    g.update(dt, this.grasp);

    // Attach whatever the hand is holding.
    if (this.held === 'player') {
      player.pos = sub(g.graspPoint, [0, 0.9, 0]);
    } else if (this.held) {
      const dir = normalize(sub(BOARD_CENTER, g.graspPoint));
      this.held.tip = add(g.graspPoint, scale(dir, DART_GRIP));
      this.held.dir = dir;
    }

    this.updateDarts(dt);
    if (player.mode === 'flying') this.updateFlight(dt);
  }

  private setPhase(p: Phase) {
    this.phase = p;
    this.phaseT = 0;
  }

  private setHand(s: HandState) {
    this.handState = s;
    this.handT = 0;
    if (s === 'sweep') noise(0.7, { freq: 300, to: 1200, type: 'bandpass', q: 1.2, vol: 0.35 });
  }

  private startHover() {
    this.handXZ = [this.grasp[0], this.grasp[2]];
    this.setHand('hover');
  }

  private restPoint(): Vec3 {
    return add(this.giant.shoulder(1), [8, -30, -12]);
  }

  private updateHand(dt: number) {
    const { player, camera } = this.ctx;
    const g = this.giant;
    this.handT += dt;

    switch (this.handState) {
      // The time from the start of the hover to the hand touching the floor is always
      // hoverTime + slamTime; the hand spends the last part of it lowering gradually.
      case 'hover': {
        this.trackPlayer(dt, 1);
        this.grasp = [this.handXZ[0], HOVER_Y + Math.sin(this.handT * 3) * 0.5, this.handXZ[1]];
        g.rightCurl = Math.max(0, g.rightCurl - dt * 2);
        if (this.handT >= this.hoverTime + this.slamTime - this.reachTime()) {
          this.from = [...this.grasp];
          this.setHand('reach');
        }
        break;
      }
      case 'reach': {
        const u = Math.min(1, this.handT / this.reachTime());
        // Keep tracking early in the reach, then commit to a landing spot the player can read.
        this.trackPlayer(dt, clamp(1 - u / REACH_TRACK, 0, 1));
        const y = lerp(this.from[1], 0.9, u * u * (3 - 2 * u));
        this.grasp = [this.handXZ[0], y, this.handXZ[1]];
        g.rightCurl = u * 0.25;
        if (u >= 1) {
          this.to = [...this.grasp];
          camera.addShake(0.5);
          sfx.thud(0.8);
          const target = this.pickGrabTarget();
          if (target) this.grab(target);
          else this.setHand('sweep');
        }
        break;
      }
      case 'sweep': {
        // Missed: sweep along the floor straight at the player. A dart in the way is grabbed
        // instead; otherwise the hand catches the player.
        if (this.handT > SWEEP_PAUSE && player.mode === 'control') {
          const dx = player.pos[0] - this.grasp[0], dz = player.pos[2] - this.grasp[2];
          const d = Math.hypot(dx, dz);
          const step = Math.min(d, this.sweepSpeed * dt);
          if (d > 1e-4) {
            this.grasp = [this.grasp[0] + (dx / d) * step, 0.9, this.grasp[2] + (dz / d) * step];
          }
        }
        const dart = this.darts.find((x) => x.state === 'stuck' && distXZ(x.tip, this.grasp) < SWEEP_DART_R);
        if (dart) {
          this.grab(dart);
        } else if (player.mode === 'control' &&
          (distXZ(player.pos, this.grasp) < SWEEP_PLAYER_R || this.handT > SWEEP_MAX_TIME)) {
          this.grab('player');
        } else if (player.mode !== 'control') {
          this.setHand('recover');
          this.from = [...this.grasp];
        }
        break;
      }
      case 'close':
        g.rightCurl = Math.min(1, this.handT / 0.25);
        if (this.handT >= 0.3) {
          this.from = [...this.grasp];
          this.setHand('carry');
        }
        break;
      case 'carry': {
        const u = easeInOut(Math.min(1, this.handT / 1.1));
        this.grasp = lerp3(this.from, this.windupPoint(), u);
        if (u >= 1) this.setHand('windup');
        break;
      }
      case 'windup': {
        const u = Math.min(1, this.handT / 0.4);
        this.grasp = add(this.windupPoint(), scale([0, 0.5, 2.5], easeInOut(u))); // small draw back toward the face
        if (this.handT >= 0.45) {
          this.from = [...this.grasp];
          this.setHand('throw');
        }
        break;
      }
      case 'throw': {
        const u = Math.min(1, this.handT / 0.22);
        this.grasp = lerp3(this.from, this.releasePoint(), u * u);
        if (u >= 1) {
          this.release();
          this.from = [...this.grasp];
          this.setHand('recover');
        }
        break;
      }
      case 'recover': {
        const u = easeInOut(Math.min(1, this.handT / 1.2));
        this.grasp = lerp3(this.from, [0, HOVER_Y, 2], u);
        g.rightCurl = Math.max(0, g.rightCurl - dt * 2);
        if (u >= 1) {
          if (this.thrown >= DART_COUNT) {
            // Out of darts: the exit opens, and half the time he has one last go at you.
            const lastGo = !this.endgame && player.mode === 'control' && Math.random() < FINAL_REACH_CHANCE;
            this.endgame = true;
            this.exit.openNow();
            if (lastGo) {
              this.hoverTime = FINAL_HOVER;
              this.startHover();
            } else {
              this.setHand('rest');
              this.setPhase('sink');
            }
          } else if (player.mode === 'control') {
            this.startHover();
          } else {
            this.setHand('rest');
          }
        }
        break;
      }
    }
  }

  /** How long the hand takes to lower from hover height to the floor. */
  private reachTime() {
    return (this.hoverTime * REACH_SHARE + this.slamTime) / REACH_SPEEDUP;
  }

  /** Eases the hand's floor position toward the player; `strength` 0 freezes it. */
  private trackPlayer(dt: number, strength: number) {
    const { player } = this.ctx;
    if (player.mode === 'control' && strength > 0) {
      const k = 1 - Math.exp(-dt * this.follow * strength);
      this.handXZ[0] += (player.pos[0] - this.handXZ[0]) * k;
      this.handXZ[1] += (player.pos[2] - this.handXZ[1]) * k;
    }
    this.handXZ[0] = clamp(this.handXZ[0], -HAND_LIMIT, HAND_LIMIT);
    this.handXZ[1] = clamp(this.handXZ[1], -HAND_LIMIT, HAND_LIMIT);
  }

  private grab(target: Dart | 'player') {
    this.held = target;
    if (target === 'player') {
      this.ctx.player.mode = 'held';
      this.ctx.hud.hint('');
    } else {
      target.state = 'held';
    }
    this.ctx.camera.addShake(0.4);
    this.setHand('close');
  }

  /** Aiming position: held up in front of his right eye, so he lines the shot up by eye. */
  private windupPoint(): Vec3 {
    return add(this.giant.headCenter(), [4, 0.5, -13]);
  }

  /** Where the throwing motion ends and the dart (or player) leaves his hand. */
  private releasePoint(): Vec3 {
    return add(this.giant.headCenter(), [1.5, -3, -26]);
  }

  private pickGrabTarget(): Dart | 'player' | null {
    const { player } = this.ctx;
    let best: Dart | 'player' | null = null;
    let bestD = GRAB_R;
    if (player.mode === 'control' && player.pos[1] < 2.5) {
      const d = distXZ(player.pos, this.to);
      if (d < bestD) { best = 'player'; bestD = d; }
    }
    for (const dart of this.darts) {
      if (dart.state !== 'stuck') continue;
      const d = distXZ(dart.tip, this.to);
      if (d < bestD) { best = dart; bestD = d; }
    }
    return best;
  }

  /** Each grab makes the hand hover less, track tighter and reach quicker and sweep faster. */
  private speedUp() {
    this.hoverTime = Math.max(HAND_MIN.hover, this.hoverTime - HAND_STEP.hover);
    this.follow += HAND_STEP.follow;
    this.slamTime = Math.max(HAND_MIN.slam, this.slamTime - HAND_STEP.slam);
    this.sweepSpeed += HAND_STEP.sweep;
  }

  private release() {
    const { player } = this.ctx;
    const start = [...this.giant.graspPoint] as Vec3;
    const aimAt = (radius: number) => {
      const a = Math.random() * Math.PI * 2;
      return [
        BOARD_CENTER[0] + Math.cos(a) * radius,
        BOARD_CENTER[1] + Math.sin(a) * radius,
        BOARD_FACE_Z,
      ] as Vec3;
    };
    if (this.held === 'player') {
      player.mode = 'flying';
      player.pos = start;
      player.facing = 0;
      player.flightDir = normalize(this.flightVel);
      this.flightVel = ballistic(start, aimAt(3 + Math.random() * 3), FLIGHT_TIME, FLIGHT_G);
      this.passedBoard = false;
    } else if (this.held) {
      const dart = this.held;
      dart.state = 'flying';
      noise(1.2, { freq: 600, to: 2400, type: 'bandpass', q: 2, vol: 0.25 });
      // Aim around the bullseye, not into it (that's the portal).
      dart.vel = ballistic(dart.tip, aimAt(1.6 + Math.random() * 2.6), 1.7, G);
      this.thrown++;
      this.speedUp();
    }
    this.held = null;
  }

  private spawnDarts() {
    const { player } = this.ctx;
    const spots: Vec3[] = [];
    for (let tries = 0; spots.length < DART_COUNT && tries < 500; tries++) {
      const p: Vec3 = [(Math.random() * 2 - 1) * 9, 0, (Math.random() * 2 - 1) * 9];
      if (distXZ(p, player.pos) < 3) continue;
      if (spots.some((s) => distXZ(s, p) < 3.5)) continue;
      spots.push(p);
    }
    this.darts = spots.map((p, i) => ({
      tip: [p[0], 32 + i * 5, p[2]],
      dir: [0, -1, 0],
      vel: [0, 0, 0],
      state: 'falling',
      color: DART_COLORS[i % DART_COLORS.length],
      landDir: normalize([(Math.random() - 0.5) * 0.35, -1, (Math.random() - 0.5) * 0.35]),
    }));
  }

  private updateDarts(dt: number) {
    const { camera } = this.ctx;
    for (const d of this.darts) {
      if (d.state === 'falling') {
        d.vel[1] -= G * dt;
        d.tip = add(d.tip, scale(d.vel, dt));
        d.dir = d.landDir;
        if (d.tip[1] <= -0.3) {
          d.tip[1] = -0.3;
          d.state = 'stuck';
          camera.addShake(0.3);
          sfx.thud(0.6);
        }
      } else if (d.state === 'flying') {
        d.vel[1] -= G * dt;
        d.tip = add(d.tip, scale(d.vel, dt));
        d.dir = normalize(d.vel);
        if (d.tip[2] <= BOARD_FACE_Z) {
          d.tip[2] = BOARD_FACE_Z - 0.35;
          d.state = 'board';
          sfx.thud(0.7);
          tone(95, 0.35, { to: 70, wave: 'triangle', vol: 0.3 });
        }
      }
    }
  }

  private updateFlight(dt: number) {
    const { player, input, camera } = this.ctx;
    const v = this.flightVel;
    if (input.isDown('KeyA')) v[0] -= STEER_ACCEL * dt;
    if (input.isDown('KeyD')) v[0] += STEER_ACCEL * dt;
    if (input.isDown('KeyW')) v[1] += STEER_ACCEL * dt;
    if (input.isDown('KeyS')) v[1] -= STEER_ACCEL * dt;
    v[1] -= FLIGHT_G * dt;
    player.pos = add(player.pos, scale(v, dt));
    player.flightDir = normalize(v);

    if (!this.passedBoard && player.pos[2] <= BOARD_FACE_Z + 0.5) {
      const r = Math.hypot(player.pos[0] - BOARD_CENTER[0], player.pos[1] - BOARD_CENTER[1]);
      if (r <= BOARD_R) {
        player.pos[2] = BOARD_FACE_Z + 0.5;
        player.mode = 'stuck';
        camera.addShake(0.7);
        this.boardResult(r);
        return;
      }
      this.passedBoard = true;
    }
    if (player.pos[1] <= 0.3) {
      player.pos[1] = 0.3;
      player.mode = 'splat';
      camera.addShake(0.6);
      this.finish('lost', 'MISSED', pick(QUIPS.missedBoard), [
        ['Hint', pick([...TIPS.missedBoard, TIPS.dodge])],
        ['Controls', TIPS.controls],
      ]);
    }
  }

  private boardResult(r: number) {
    if (r <= BULLSEYE_R) {
      // The bullseye is a portal: sucked straight through to the next chamber.
      this.phase = 'over';
      const [bx, by, bz] = BOARD_CENTER;
      this.ctx.player.shrinkInto([bx, by - this.boardDrop, bz + 0.52], PORTAL_SQUEEZE_TIME);
      this.bullseyeExit = PORTAL_SQUEEZE_TIME;
      return;
    }
    const mm = (r / SCORING_R) * 170;
    const ring =
      mm < 99 ? 'single' :
      mm < 107 ? 'treble ring' :
      mm < 162 ? 'single' :
      mm <= 170 ? 'double ring' : 'black rim';
    this.finish('lost', 'SPLAT', pick(QUIPS.wrongRing)(ring), [
      ['Hint', pick([...TIPS.wrongRing, TIPS.dodge])],
      ['Controls', TIPS.controls],
    ]);
  }

  private finish(status: LevelStatus, big: string, small: string, tips: [string, string][] = []) {
    this.status = status;
    this.phase = 'over';
    this.ctx.hud.show(big, `${small}\n${pick(status === 'won' ? QUIPS.againWon : QUIPS.againLost)}`);
    this.ctx.hud.tips(tips);
    this.ctx.hud.hint('');
  }

  draw(out: DrawItem[]) {
    this.giant.draw(out);

    // Dartboard on a backing wall past the north side of the chamber. It stays hidden below
    // ground until the giant rises, so nothing gives the level's theme away up front.
    const wood = [0.16, 0.1, 0.06];
    const [bx, by, bz] = BOARD_CENTER;
    const drop = this.boardDrop;
    out.push({ mesh: 'box', model: mul(translation([bx, by - drop, bz - 1.2]), scaling([22, 22, 1.4])), color: wood });
    for (const x of [-7, 7]) {
      out.push({ mesh: 'box', model: mul(translation([bx + x, by / 2 - drop, bz - 2.4]), scaling([1.5, by, 1.5])), color: wood });
    }
    out.push({
      mesh: 'cylinder',
      model: mul(translation([bx, by - drop, bz]), rotationX(Math.PI / 2), scaling([BOARD_R, 1, BOARD_R])),
      color: [1, 1, 1],
      pattern: Pattern.dartboard,
      spec: 0.02,
    });
    drawPortal(out, [bx, by - drop, bz + 0.52], [0, 0, 1], BULLSEYE_R, false);
    this.arrival.draw(out);
    this.exit.draw(out);

    for (const d of this.darts) drawDart(out, dartMatrix(d.tip, d.dir), d.color);

    // Contact shadow under the hunting hand so the player can read where it will land.
    if (this.handState === 'hover' || this.handState === 'reach' || this.handState === 'sweep') {
      const s = this.giant.graspPoint;
      const nearness = 1 - clamp(s[1] / HOVER_Y, 0, 1);
      const radius = GRAB_R * (1.2 - nearness * 0.2);
      out.push({
        mesh: 'cylinder',
        model: mul(translation([s[0], 0.02, s[2]]), scaling([radius, 0.02, radius])),
        color: [0.01, 0.01, 0.015],
        pattern: Pattern.blob,
        param: 0.35 + nearness * 0.5,
        shadow: false,
      });
    }
  }

  environment() {
    return DEFAULT_ENV;
  }

  obstacles() {
    return this.darts
      .filter((d) => d.state === 'stuck')
      .map((d) => ({ x: d.tip[0], z: d.tip[2], r: 0.25 }));
  }

  trackedTargets(): TrackedTarget[] {
    const t = this.exit.target();
    return t ? [t] : [];
  }

  cameraShot(): CameraShot | null {
    const arriving = this.arrival.cameraShot();
    if (arriving) return arriving;
    const p = this.ctx.player.pos;
    switch (this.ctx.player.mode) {
      case 'held': {
        const target = add(p, [0, 1, 0]);
        return { pos: add(target, [-10, 3, -8]), target, sharpness: 3 };
      }
      case 'flying':
        return { pos: add(p, [0, 1.3, 5]), target: add(p, [0, 0, -12]), sharpness: 12 };
      case 'stuck':
        return { pos: add(p, [4, 2, 13]), target: p, sharpness: 2 };
      case 'splat':
        return { pos: add(p, [6, 6, 6]), target: p, sharpness: 2 };
      default:
        return null;
    }
  }
}

// End-screen lines. The game is about surprise and humour, so keep any text dry and joking.
const QUIPS = {
  missedBoard: [
    'Houston, we have a problem.',
    'To infinity and... the floor.',
    'Physics: 1. You: 0.',
  ],
  wrongRing: [
    (ring: string) => `The ${ring}. Close, but no cigar. Actually, not that close.`,
    (ring: string) => `The ${ring}. Great for the scoreboard, terrible for your spine.`,
    (ring: string) => `The ${ring}. He only keeps bullseyes. You are going in the bin.`,
  ],
  againWon: ['Press R to tempt fate again', 'Press R. You know you want to.'],
  againLost: ['Press R to respawn. Cheaper than therapy.', 'Press R. Try being a better dart.'],
};

function pick<T>(options: T[]): T {
  return options[Math.floor(Math.random() * options.length)];
}

/** Death-screen hints: how you died, and what might work instead. */
const TIPS = {
  wrongRing: [
    'Only the bullseye counts. You can steer mid-flight: you are more aerodynamic than you look.',
    'Close is not good enough. Keep adjusting all the way in; the board gets big fast.',
  ],
  missedBoard: [
    'The board is the big round thing. Steer toward it while you fly.',
    "You can steer in the air. Try pointing yourself at the board next time. It helps.",
  ],
  dodge: "Better yet, don't get caught: stand by a dart, then dodge as the hand comes down. It grabs whatever's closest.",
  controls: 'In the air: W/S up and down, A/D left and right. On the ground: Shift to sprint.',
};

function ballistic(start: Vec3, target: Vec3, time: number, gravity: number): Vec3 {
  const v = scale(sub(target, start), 1 / time);
  v[1] += 0.5 * gravity * time;
  return v;
}
