import {
  add, clamp, distXZ, easeInOut, lerp, lerp3, mul, normalize, rotationX, scale, scaling, sub, translation,
  type Vec3,
} from '../../engine/math';
import { Pattern, type DrawItem } from '../../engine/renderer';
import { CHAMBER_HALF } from '../../game/chamber';
import {
  DEFAULT_ENV, type CameraShot, type Level, type LevelContext, type LevelStatus,
} from '../level';
import { DART_GRIP, dartMatrix, drawDart } from './dart';
import { Giant } from './giant';

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
const HAND_START = { hover: 2.6, follow: 1.2, slam: 0.4 };
const HAND_STEP = { hover: 0.3, follow: 0.45, slam: 0.04 };
const HAND_MIN = { hover: 1.0, slam: 0.22 };

type Phase = 'intro' | 'rise' | 'drop' | 'hunt' | 'sink' | 'over';
type HandState = 'rest' | 'hover' | 'slam' | 'close' | 'lift' | 'carry' | 'windup' | 'throw' | 'recover';

interface Dart {
  tip: Vec3;
  dir: Vec3;
  vel: Vec3;
  state: 'falling' | 'stuck' | 'held' | 'flying' | 'board';
  color: number[];
  landDir: Vec3;
}

export class DartsLevel implements Level {
  readonly number = 1;
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
  private held: Dart | 'player' | null = null;
  private thrown = 0;

  private flightVel: Vec3 = [0, 0, 0];
  private passedBoard = false;
  private boardDrop = BOARD_HIDDEN_DROP;

  constructor(private ctx: LevelContext) {
    ctx.hud.setLevel(`The Chamber · Level ${this.number}`);
    ctx.hud.show(`LEVEL ${this.number}`, "", 2.5); // no hint of the theme up front
    ctx.hud.hint('');
    // Pose the giant once so he starts hidden below ground rather than at the origin.
    this.giant.update(0, [0, 0, 0]);
    this.grasp = this.restPoint();
  }

  update(dt: number) {
    const { player, camera, hud } = this.ctx;
    this.phaseT += dt;
    this.giant.time += dt;

    switch (this.phase) {
      case 'intro':
        if (this.phaseT > 1.5) this.setPhase('rise');
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
          hud.hint('Survive: bait the hand onto all 5 darts.');
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
        if (this.phaseT > 4.2) this.finish('won', 'SURVIVED', 'He threw all five darts and lost interest.');
        break;
      }
    }
    if (this.handState === 'rest') this.grasp = this.restPoint();

    const g = this.giant;
    const throwing = this.handState === 'carry' || this.handState === 'windup' || this.handState === 'throw';
    g.leanTarget = throwing || this.handState === 'rest'
      ? 0.06
      : clamp(0.12 + ((14 - this.grasp[2]) / 26) * 0.5, 0.1, 0.62);
    g.lookTarget = player.mode === 'control' || player.mode === 'held'
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
  }

  private startHover() {
    this.handXZ = [this.grasp[0], this.grasp[2]];
    this.setHand('hover');
  }

  private restPoint(): Vec3 {
    return add(this.giant.shoulder(1), [8, -30, -12]);
  }

  private updateHand(dt: number) {
    const { player, camera, hud } = this.ctx;
    const g = this.giant;
    this.handT += dt;

    switch (this.handState) {
      case 'hover': {
        if (player.mode === 'control') {
          const k = 1 - Math.exp(-dt * this.follow);
          this.handXZ[0] += (player.pos[0] - this.handXZ[0]) * k;
          this.handXZ[1] += (player.pos[2] - this.handXZ[1]) * k;
        }
        this.handXZ[0] = clamp(this.handXZ[0], -HAND_LIMIT, HAND_LIMIT);
        this.handXZ[1] = clamp(this.handXZ[1], -HAND_LIMIT, HAND_LIMIT);
        this.grasp = [this.handXZ[0], HOVER_Y + Math.sin(this.handT * 3) * 0.5, this.handXZ[1]];
        g.rightCurl = Math.max(0, g.rightCurl - dt * 2);
        if (this.handT >= this.hoverTime) {
          this.from = [...this.grasp];
          this.to = [this.handXZ[0], 0.9, this.handXZ[1]];
          this.setHand('slam');
        }
        break;
      }
      case 'slam': {
        const u = Math.min(1, this.handT / this.slamTime);
        this.grasp = lerp3(this.from, this.to, u * u);
        if (u >= 1) {
          camera.addShake(0.8);
          const target = this.pickGrabTarget();
          this.held = target;
          if (target === 'player') {
            player.mode = 'held';
            hud.hint('');
          } else if (target) {
            target.state = 'held';
          }
          this.setHand(target ? 'close' : 'lift');
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
      case 'lift': {
        const u = easeInOut(Math.min(1, this.handT / 0.8));
        this.grasp = lerp3(this.to, [this.to[0], HOVER_Y, this.to[2]], u);
        if (u >= 1) this.startHover();
        break;
      }
      case 'carry': {
        const u = easeInOut(Math.min(1, this.handT / 1.1));
        this.grasp = lerp3(this.from, this.windupPoint(), u);
        if (u >= 1) this.setHand('windup');
        break;
      }
      case 'windup': {
        const u = Math.min(1, this.handT / 0.4);
        this.grasp = add(this.windupPoint(), scale([0, 1, 3], easeInOut(u)));
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
            this.setHand('rest');
            this.setPhase('sink');
            this.ctx.hud.hint('');
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

  private windupPoint(): Vec3 {
    return add(this.giant.shoulder(1), [4, 14, 12]);
  }

  private releasePoint(): Vec3 {
    return add(this.giant.shoulder(1), [-2, 8, -18]);
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

  /** Each grab makes the hand hover less, track tighter and slam quicker. */
  private speedUp() {
    this.hoverTime = Math.max(HAND_MIN.hover, this.hoverTime - HAND_STEP.hover);
    this.follow += HAND_STEP.follow;
    this.slamTime = Math.max(HAND_MIN.slam, this.slamTime - HAND_STEP.slam);
  }

  private release() {
    const { player, hud } = this.ctx;
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
      this.flightVel = ballistic(start, aimAt(3 + Math.random() * 3), FLIGHT_TIME, FLIGHT_G);
      this.passedBoard = false;
      hud.hint('Steer with WASD — hit the bullseye!');
    } else if (this.held) {
      const dart = this.held;
      dart.state = 'flying';
      dart.vel = ballistic(dart.tip, aimAt(Math.random() * 4), 1.7, G);
      this.thrown++;
      this.speedUp();
      const left = DART_COUNT - this.thrown;
      hud.hint(left > 0 ? `${left} dart${left === 1 ? '' : 's'} left. The hand is getting faster.` : '');
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
        }
      } else if (d.state === 'flying') {
        d.vel[1] -= G * dt;
        d.tip = add(d.tip, scale(d.vel, dt));
        d.dir = normalize(d.vel);
        if (d.tip[2] <= BOARD_FACE_Z) {
          d.tip[2] = BOARD_FACE_Z - 0.35;
          d.state = 'board';
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
      this.finish('lost', 'MISSED', 'You sailed clean past the board.');
    }
  }

  private boardResult(r: number) {
    if (r <= BULLSEYE_R) {
      this.finish('won', 'BULLSEYE!', 'The giant is impressed. You survived.');
      return;
    }
    const mm = (r / SCORING_R) * 170;
    const ring =
      mm < 99 ? 'single' :
      mm < 107 ? 'treble ring' :
      mm < 162 ? 'single' :
      mm <= 170 ? 'double ring' : 'black rim';
    this.finish('lost', 'SPLAT', `You hit the ${ring}. Only the bullseye saves you.`);
  }

  private finish(status: LevelStatus, big: string, small: string) {
    this.status = status;
    this.phase = 'over';
    this.ctx.hud.show(big, `${small}\nPress R to ${status === 'won' ? 'play again' : 'try again'}`);
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

    for (const d of this.darts) drawDart(out, dartMatrix(d.tip, d.dir), d.color);

    // Contact shadow under the hunting hand so the player can read where it will land.
    if (this.handState === 'hover' || this.handState === 'slam') {
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

  cameraShot(): CameraShot | null {
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

function ballistic(start: Vec3, target: Vec3, time: number, gravity: number): Vec3 {
  const v = scale(sub(target, start), 1 / time);
  v[1] += 0.5 * gravity * time;
  return v;
}
