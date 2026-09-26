import { noise, tone } from '../../engine/audio';
import { clamp, mul, rotationX, scaling, translation, type Vec3 } from '../../engine/math';
import type { DrawItem } from '../../engine/renderer';
import { CHAMBER_HALF } from '../../game/chamber';
import type { Pose } from '../../game/body';
import { ExitPortal, PortalArrival } from '../../entities/portal';
import { DEFAULT_ENV, type CameraShot, type Level, type LevelContext, type LevelStatus, type TrackedTarget, type WorldLabel } from '../level';

/*
 * Flappy. After the arrival the camera swings round to a side view, the wall says FLAP, and Space
 * flaps you up into the air (you're a person, flapping, which is the joke). Green pipes slide out
 * of the east wall with a gap in each; the floor is the ground, and the ground is death, as is any
 * pipe. Ten pipes and it's over: you drop to the floor and walk out.
 */

/** Where you hover (x), and the lane the pipes run along (z). */
const BIRD_X = -4;
const LANE_Z = 0;
/** Flap: upward speed (m/s); gravity is the usual times this. */
const FLAP = 8;
const GRAVITY_SCALE = 1.25;
/** The top of the world (m): you can't fly out over the walls. */
const CEILING = 10.5;
/** Pipes: speed (m/s, westward), spacing (s), radius, gap height, and how many to get through. */
const PIPE_SPEED = 4.5;
const PIPE_EVERY = 2.1;
const PIPE_R = 1.0;
const GAP = 5.0;
const PIPES = 10;
/** Your body, for hitting pipes: half its width along the lane, and height (feet to head). */
const BODY_HALF = 0.32;
const BODY_H = 1.8;
const DEATH_SCREEN_DELAY = 1.8;

const PIPE_GREEN = [0.33, 0.72, 0.18];
const PIPE_DARK = [0.22, 0.5, 0.12];

interface Pipe {
  x: number;
  /** Bottom and top of the gap. */
  gapLo: number;
  passed: boolean;
}

interface Death {
  t: number;
  big: string;
  small: string;
}

const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

export class FlappyLevel implements Level {
  readonly number: number;
  readonly title = 'Flappy';
  status: LevelStatus = 'playing';
  private arrival: PortalArrival;
  private exit = new ExitPortal(LANE_Z);
  private t = 0;
  /** 'ready' (standing about until the first flap), 'flying', 'landing' (done), 'walk'. */
  private phase: 'intro' | 'ready' | 'flying' | 'landing' | 'walk' = 'intro';
  private pipes: Pipe[] = [];
  private spawned = 0;
  private spawnT = 0;
  private score = 0;
  private flapT = 9;
  private readyT = 0;
  private death: Death | null = null;
  private scoreLabel: WorldLabel = { pos: [0, 8.6, -CHAMBER_HALF + 0.3], text: '', size: 2, color: '#ffffff' };
  private wallLabel: WorldLabel = { pos: [0, 6.4, -CHAMBER_HALF + 0.3], text: '', size: 1.2, color: '#ffd166' };
  private labelList: WorldLabel[] = [this.scoreLabel, this.wallLabel];
  private pose: Pose = { lean: 0, headPitch: 0, shoulderL: 0, shoulderR: 0, armOut: 1.4, elbowL: 0, elbowR: 0, hipL: 0, hipR: 0, kneeL: -0.2, kneeR: -0.2 };

  constructor(private ctx: LevelContext) {
    this.number = ctx.number;
    const { hud } = ctx;
    hud.setLevel(`The Chamber · Level ${this.number}`);
    hud.show(`LEVEL ${this.number}`, '', 2.5);
    hud.hint('');
    this.arrival = new PortalArrival(ctx, [BIRD_X, 0, LANE_Z], { minElevationDeg: 80 });
  }

  update(dt: number) {
    const { player, hud, input, camera } = this.ctx;
    this.t += dt;
    const death = this.death;
    if (death && this.status === 'playing') {
      death.t += dt;
      if (death.t > DEATH_SCREEN_DELAY) {
        this.status = 'lost';
        hud.show(death.big, `${death.small}\nPress R to try again.`);
        hud.tips([
          ['Hint', 'Space flaps. Little taps, not panic: aim for the middle of each gap, and never touch the floor.'],
          ['Controls', 'Space flap'],
        ]);
      }
    }
    this.arrival.update(dt);
    this.exit.update(dt, player);
    if (this.exit.entered && this.status === 'playing') this.status = 'exited';
    const alive = player.mode === 'control' && !this.death && !player.inPortal;

    switch (this.phase) {
      case 'intro':
        // (Once you're back on your feet from the portal.)
        if (this.arrival.done && !this.ctx.player.gettingUp) {
          this.phase = 'ready';
          this.wallLabel.text = 'FLAP.';
          this.scoreLabel.text = '0';
        }
        break;
      case 'ready':
        // Standing on the floor, facing along the lane, until the first flap.
        this.pin();
        camera.yaw = -Math.PI / 2;
        this.readyT += dt;
        if (this.readyT > 6 && this.wallLabel.text === 'FLAP.') this.wallLabel.text = 'FLAP, BIRDBRAIN.';
        if (alive && input.wasPressed('Space')) {
          this.phase = 'flying';
          this.wallLabel.text = '';
          player.gravityScale = GRAVITY_SCALE;
          player.airControl = 0;
          this.flap();
        }
        break;
      case 'flying': {
        this.pin();
        camera.yaw = -Math.PI / 2;
        if (!alive) break;
        if (input.wasPressed('Space')) this.flap();
        // The ceiling (no flying out over the walls).
        if (player.pos[1] + BODY_H > CEILING) {
          player.pos[1] = CEILING - BODY_H;
          player.vel[1] = Math.min(0, player.vel[1]);
          player.syncCollider();
        }
        // Pipes: out of the east wall every so often, sliding west.
        this.spawnT -= dt;
        if (this.spawned < PIPES && this.spawnT <= 0) {
          this.spawnT = PIPE_EVERY;
          const prev = this.pipes.length ? this.pipes[this.pipes.length - 1].gapLo : 2.5;
          const lo = clamp(prev + (Math.random() - 0.5) * 5, 0.8, CEILING - GAP - 0.6);
          this.pipes.push({ x: CHAMBER_HALF + PIPE_R + 0.5, gapLo: lo, passed: false });
          this.spawned++;
        }
        for (const p of this.pipes) {
          p.x -= PIPE_SPEED * dt;
          if (!p.passed && p.x < BIRD_X - PIPE_R - BODY_HALF) {
            p.passed = true;
            this.score++;
            this.scoreLabel.text = String(this.score);
            tone(1400, 0.08, { wave: 'square', vol: 0.1 });
            tone(1900, 0.18, { wave: 'square', vol: 0.1, at: 0.08 });
          }
          // Hit it?
          const feet = player.pos[1], head = feet + BODY_H;
          if (Math.abs(p.x - BIRD_X) < PIPE_R + BODY_HALF && (feet < p.gapLo || head > p.gapLo + GAP)) {
            this.crash(feet < p.gapLo ? 'low' : 'high');
            break;
          }
        }
        if (this.pipes.length && this.pipes[0].x < -CHAMBER_HALF - PIPE_R - 1) this.pipes.shift();
        // The ground.
        if (!this.death && player.onGround && this.t - this.flapT > 0.2) this.crash('ground');
        // Through them all.
        if (!this.death && this.score >= PIPES) {
          this.phase = 'landing';
          this.wallLabel.text = 'NEW HIGH SCORE';
          player.gravityScale = 1;
          hud.show('10', 'Ten pipes. Which is nine more than anyone expected.', 3);
          tone(784, 0.15, { wave: 'square', vol: 0.12 });
          tone(1047, 0.35, { wave: 'square', vol: 0.12, at: 0.15 });
        }
        break;
      }
      case 'landing':
        this.pin();
        for (const p of this.pipes) p.x -= PIPE_SPEED * dt;
        if (player.onGround && alive) {
          this.phase = 'walk';
          player.airControl = 1;
          player.poseOverride = null;
          this.exit.openNow();
        }
        break;
      case 'walk':
        for (const p of this.pipes) p.x -= PIPE_SPEED * dt;
        break;
    }

    // The pose: arms flapping, fast just after a flap, gliding otherwise.
    if (player.mode === 'control' && (this.phase === 'flying' || this.phase === 'landing') && !this.death) {
      const since = this.t - this.flapT;
      const beat = since < 0.35 ? Math.cos((since / 0.35) * Math.PI * 2) : 0.2 + 0.1 * Math.sin(this.t * 3);
      const pose = this.pose;
      pose.armOut = 1.2 + 1.0 * beat;
      pose.shoulderL = pose.shoulderR = 0.1;
      pose.elbowL = pose.elbowR = 0.15 + 0.2 * (1 - beat);
      pose.kneeL = -0.3 - 0.2 * Math.sin(this.t * 9);
      pose.kneeR = -0.3 + 0.2 * Math.sin(this.t * 9);
      pose.headPitch = clamp(-player.vel[1] * 0.04, -0.4, 0.4);
      player.poseOverride = pose;
    }
  }

  /** Keeps you on the lane (only up and down while flying). */
  private pin() {
    const { player } = this.ctx;
    if (player.mode !== 'control') return;
    player.pos[0] = BIRD_X;
    player.pos[2] = LANE_Z;
    player.vel[0] = 0;
    player.vel[2] = 0;
    player.facing = -Math.PI / 2;
    player.syncCollider();
  }

  private flap() {
    const { player } = this.ctx;
    player.vel[1] = FLAP;
    player.onGround = false;
    this.flapT = this.t;
    noise(0.18, { freq: 500, to: 1600, type: 'bandpass', q: 1.2, vol: 0.25 });
  }

  private crash(how: 'low' | 'high' | 'ground') {
    const { player, camera } = this.ctx;
    player.poseOverride = null;
    player.gravityScale = 1;
    player.airControl = 1;
    player.kill([-3, how === 'high' ? -2 : 2, 0], { violence: 6, origin: [BIRD_X + 0.5, player.pos[1] + 1, LANE_Z] });
    camera.addShake(0.5);
    tone(200, 0.12, { to: 90, wave: 'square', vol: 0.2 });
    tone(900, 0.8, { to: 200, wave: 'sine', vol: 0.12, at: 0.15 }); // the fall
    this.death = {
      t: 0,
      big: how === 'ground' ? 'GROUNDED' : 'PIPE DREAM',
      small: how === 'ground'
        ? pick(['The floor was the ground. The ground was lava. Well, it was death.', 'You forgot to flap. It happens to birds too, briefly.'])
        : pick(['You flew into a pipe, like everyone who ever played this.', `Score: ${this.score}. Your friends will not be impressed.`, 'Rest in pipes.']),
    };
  }

  draw(out: DrawItem[]) {
    this.arrival.draw(out);
    this.exit.draw(out);
    for (const p of this.pipes) {
      const top = p.gapLo + GAP;
      // Bottom pipe, top pipe (up past the walls), and their lips.
      out.push({ mesh: 'cylinder', model: mul(translation([p.x, p.gapLo / 2, LANE_Z]), scaling([PIPE_R, p.gapLo, PIPE_R])), color: PIPE_GREEN, spec: 0.6 });
      out.push({ mesh: 'cylinder', model: mul(translation([p.x, (top + 14) / 2, LANE_Z]), scaling([PIPE_R, 14 - top, PIPE_R])), color: PIPE_GREEN, spec: 0.6 });
      out.push({ mesh: 'cylinder', model: mul(translation([p.x, p.gapLo - 0.3, LANE_Z]), scaling([PIPE_R + 0.2, 0.6, PIPE_R + 0.2])), color: PIPE_DARK, spec: 0.6 });
      out.push({ mesh: 'cylinder', model: mul(translation([p.x, top + 0.3, LANE_Z]), scaling([PIPE_R + 0.2, 0.6, PIPE_R + 0.2])), color: PIPE_DARK, spec: 0.6 });
      // A highlight stripe down the side facing the camera.
      out.push({ mesh: 'box', model: mul(translation([p.x - 0.35, p.gapLo / 2, LANE_Z + PIPE_R * 0.92]), scaling([0.18, p.gapLo, 0.05])), color: [0.6, 0.95, 0.4], shadow: false });
    }
    // A beak, obviously.
    const { player } = this.ctx;
    if (player.mode === 'control' && this.phase !== 'intro') {
      const head = player.partFrames().head;
      out.push({ mesh: 'cone', model: mul(head, translation([0, 0.02, -0.26]), rotationX(-Math.PI / 2), scaling([0.08, 0.2, 0.06])), color: [1.0, 0.6, 0.1], spec: 0.5 });
    }
  }

  labels(): WorldLabel[] {
    return this.labelList;
  }

  trackedTargets(): TrackedTarget[] {
    const exit = this.exit.target();
    return exit ? [exit] : [];
  }

  environment() {
    return DEFAULT_ENV;
  }

  obstacles() {
    return [];
  }

  cameraShot(): CameraShot | null {
    const shot = this.arrival.cameraShot();
    if (shot) return shot;
    // Side on, like the real thing, from inside the south wall looking north across the lane.
    if (this.phase === 'ready' || this.phase === 'flying' || this.phase === 'landing') {
      const y = this.phase === 'ready' ? 3.5 : 5;
      const target: Vec3 = [BIRD_X + 4, y, LANE_Z];
      return { pos: [BIRD_X + 4, y + 0.4, LANE_Z + 9.5], target, sharpness: 4 };
    }
    return null;
  }
}
