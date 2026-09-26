import { add, clamp, lerp, length, mul, normalize, rotationX, rotationY, rotationZ, scale, scaling, segment, sub, translation, type Mat4, type Vec3 } from '../../engine/math';
import { Pattern, type DrawItem } from '../../engine/renderer';
import { CHAMBER_HALF } from '../../game/chamber';
import { Giant } from '../../entities/giant';
import { junk, spawnJunk } from '../../entities/junk';
import { ExitPortal, PortalArrival } from '../../entities/portal';
import { DEFAULT_ENV, type CameraShot, type Level, type LevelContext, type LevelStatus, type TrackedTarget, type WorldLabel } from '../level';

/*
 * Piñata. It's Timmy's birthday (the giant from the magnifying glass), he's blindfolded, he has
 * a bat, and he swings it at whatever he hears. Walking is quiet; sprinting, landing jumps,
 * things crashing down and above all popping balloons are not (every noise shows as a ring).
 * Party balloons drift toward you and pop when they touch you. Throw things to make noise
 * somewhere else. After a minute he finally finds the actual piñata, it's cake time, and the
 * exit opens.
 */

const PARTY = 60;
const CAKE_AT = PARTY + 3.5;
/** Timmy only reacts to noises at least this loud, and swings at where he heard the loudest (recent) one. */
const HEARING = 0.8;
const NOISE_MEMORY = 1.2;
const WIND_UP = 0.5;
const SMASH = 0.16;
const RECOVER = 0.9;
/** Bat impact kills within this radius (m), pops balloons further out. */
const BAT_R = 2.0;
const BALLOON_R = 0.34;
const START_BALLOONS = 16;
const MAX_BALLOONS = 38;
const DEATH_SCREEN_DELAY = 2;

const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const COLORS = [[0.95, 0.15, 0.2], [0.2, 0.55, 0.95], [0.98, 0.8, 0.15], [0.3, 0.85, 0.35], [0.9, 0.35, 0.85], [1, 0.55, 0.15]];

interface Balloon {
  pos: Vec3;
  vel: Vec3;
  color: number[];
  bob: number;
}

interface Noise {
  pos: Vec3;
  loud: number;
  t: number;
}

interface Death {
  t: number;
  big: string;
  small: string;
}

export class PinataLevel implements Level {
  readonly number: number;
  readonly title = 'Piñata';
  status: LevelStatus = 'playing';
  private arrival: PortalArrival;
  private exit = new ExitPortal(0);
  private giant = new Giant();
  private t = -1;
  private balloons: Balloon[] = [];
  private noises: Noise[] = [];
  private bat: { state: 'rest' | 'windup' | 'smash' | 'recover'; t: number; target: Vec3; hand: Vec3 } = { state: 'rest', t: 0, target: [0, 0, 0], hand: [4, 13, 12] };
  private quiet = 0;
  private confetti: { pos: Vec3; vel: Vec3; age: number; color: number[] }[] = [];
  private pops: { pos: Vec3; age: number; color: number[] }[] = [];
  private pinataHit = false;
  private candy: { pos: Vec3; vel: Vec3; color: number[] }[] = [];
  private stepNoise = 0;
  private wasOnGround = true;
  private lastFallSpeed = 0;
  private propSpeeds = new Map<number, number>();
  private death: Death | null = null;
  private timmyLabel: WorldLabel = { pos: [0, 0, 0], text: '', size: 3, color: '#ffd166' };
  private labelList: WorldLabel[];

  constructor(private ctx: LevelContext) {
    this.number = ctx.number;
    const { hud, physics } = ctx;
    hud.setLevel(`The Chamber · Level ${this.number}`);
    hud.show(`LEVEL ${this.number}`, '', 2.5);
    hud.hint('');
    this.arrival = new PortalArrival(ctx, [-6, 0, -3]);
    this.giant.root = [0, -80, 27];
    this.giant.leanTarget = this.giant.lean = 0.25;
    this.giant.rightCurl = 1.2;
    this.giant.blindfold = true;
    this.giant.update(0, this.bat.hand);
    for (let i = 0; i < START_BALLOONS; i++) this.addBalloon([rand(-10, 10), rand(1.1, 1.6), rand(-10, 10)]);
    // Presents and party things to throw (or knock over, noisily).
    for (let i = 0; i < 6; i++) spawnJunk(physics, junk(i % 2 ? 'cardboard box' : 'small crate'), [rand(-9, 9), 0.4, rand(-9, 6)]);
    spawnJunk(physics, junk('beach ball'), [2, 0.4, -6]);
    spawnJunk(physics, junk('rubber duck'), [-3, 0.3, 5]);
    this.labelList = [
      { pos: [0, 7.6, -CHAMBER_HALF + 0.3], text: 'HAPPY 8TH BIRTHDAY TIMMY', size: 1.1, color: '#ff7ad9' },
      { pos: [0, 6.7, -CHAMBER_HALF + 0.3], text: '(please do not make any noise)', size: 0.45, color: '#ffffff' },
      this.timmyLabel,
    ];
  }

  private addBalloon(pos: Vec3) {
    this.balloons.push({ pos, vel: [0, 0, 0], color: pick(COLORS), bob: Math.random() * 6 });
  }

  private noise(pos: Vec3, loud: number) {
    this.noises.push({ pos: [pos[0], 0, pos[2]], loud, t: 0 });
  }

  private pop(i: number) {
    const b = this.balloons[i];
    this.pops.push({ pos: [...b.pos], age: 0, color: b.color });
    this.noise(b.pos, 3);
    this.balloons.splice(i, 1);
  }

  update(dt: number) {
    const { player, hud, physics, camera } = this.ctx;
    const death = this.death;
    if (death && this.status === 'playing') {
      death.t += dt;
      if (death.t > DEATH_SCREEN_DELAY) {
        this.status = 'lost';
        hud.show(death.big, `${death.small}\nPress R to try again.`);
        hud.tips([
          ['Hint', 'He swings at noise: walk, don’t run, and don’t let the balloons touch you. After a noise, get away from it. Throw things to make noise somewhere else.'],
          ['Controls', 'WASD move (quietly) · Hold left click carry · Right-click throw'],
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
    const alive = player.mode === 'control' && !this.death;

    // Timmy rises into view, and at the end is called away for cake.
    const rise = clamp((t - 0.2) / 3, 0, 1);
    const leave = clamp((t - CAKE_AT - 1.5) / 3, 0, 1);
    this.giant.root[1] = lerp(-80, 0, 1 - (1 - rise) * (1 - rise)) - 80 * leave * leave;
    this.timmyLabel.pos = add(this.giant.headCenter(), [0, 14, 0]);
    if (t > PARTY && !this.pinataHit && this.bat.state === 'rest') {
      this.swing([0, 3.6, -4]);
      this.timmyLabel.text = 'FOUND IT!';
    }
    if (t >= CAKE_AT && t - dt < CAKE_AT && !this.death) {
      hud.show('TIMMY! CAKE TIME!', '', 2.2);
      this.timmyLabel.text = 'CAKE!!';
      this.exit.openNow();
    }

    // Noises: yours, the balloons', and things landing hard.
    if (alive) {
      const hs = Math.hypot(player.vel[0], player.vel[2]);
      this.stepNoise -= dt;
      if (hs > 6 && player.onGround && this.stepNoise <= 0) {
        this.noise(player.pos, 1.1);
        this.stepNoise = 0.3;
      }
      if (!this.wasOnGround && player.onGround && this.lastFallSpeed > 5) this.noise(player.pos, 1.3);
      this.lastFallSpeed = player.onGround ? 0 : Math.max(this.lastFallSpeed, -player.vel[1]);
      this.wasOnGround = player.onGround;
    }
    for (const b of physics.bodies) {
      const v = b.rb.linvel();
      const speed = Math.hypot(v.x, v.y, v.z);
      const before = this.propSpeeds.get(b.collider.handle) ?? 0;
      // A sudden stop from speed: it hit something.
      if (before > 4 && speed < before * 0.45 && b.collider.handle !== player.carrying?.handle) {
        const p = b.rb.translation();
        this.noise([p.x, p.y, p.z], 1.3);
      }
      this.propSpeeds.set(b.collider.handle, speed);
    }
    for (const n of this.noises) n.t += dt;
    this.noises = this.noises.filter((n) => n.t < 1.6);

    // Balloons drift toward you (the air in here is weird), bob, and pop if they touch you.
    if (t > 0 && this.balloons.length < MAX_BALLOONS && Math.random() < dt / 2.8) this.addBalloon([rand(-10, 10), 1.3, 11]);
    const chest: Vec3 = add(player.pos, [0, 1.3, 0]);
    for (let i = this.balloons.length - 1; i >= 0; i--) {
      const b = this.balloons[i];
      b.bob += dt;
      const to = sub(chest, b.pos);
      const d = Math.hypot(to[0], to[2]);
      const drift = t > 0 && alive ? 0.55 + 0.25 * Math.sin(b.bob * 0.7) : 0.1;
      const want: Vec3 = d > 0.01 ? [(to[0] / d) * drift + Math.sin(b.bob * 1.3) * 0.2, 0, (to[2] / d) * drift + Math.cos(b.bob) * 0.2] : [0, 0, 0];
      b.vel = add(b.vel, scale(sub(want, b.vel), Math.min(1, dt * 1.5)));
      b.pos = add(b.pos, scale(b.vel, dt));
      b.pos[1] = 1.3 + Math.sin(b.bob * 2) * 0.15;
      b.pos[0] = clamp(b.pos[0], -CHAMBER_HALF + 0.5, CHAMBER_HALF - 0.5);
      b.pos[2] = clamp(b.pos[2], -CHAMBER_HALF + 0.5, CHAMBER_HALF - 0.5);
      if (alive && length(sub(chest, b.pos)) < BALLOON_R + 0.35) this.pop(i);
      else {
        // Anything flying through it pops it too.
        for (const body of physics.bodies) {
          const p = body.rb.translation(), v = body.rb.linvel();
          if (Math.hypot(v.x, v.y, v.z) > 3 && Math.hypot(p.x - b.pos[0], p.y - b.pos[1], p.z - b.pos[2]) < BALLOON_R + 0.35) {
            this.pop(i);
            break;
          }
        }
      }
    }

    // Timmy listens, winds up, and SMASH.
    this.quiet += dt;
    const bat = this.bat;
    bat.t += dt;
    if (bat.state === 'rest' && t > 3.5 && alive && t < PARTY) {
      let best: Noise | null = null;
      for (const n of this.noises) if (n.t < NOISE_MEMORY && n.loud >= HEARING && (!best || n.loud - n.t > best.loud - best.t)) best = n;
      if (best) this.swing(best.pos);
      else if (this.quiet > 7) this.swing([rand(-10, 10), 0, rand(-10, 10)]); // bored: a wild swing
    }
    if (bat.state === 'windup' && bat.t >= WIND_UP) {
      bat.state = 'smash';
      bat.t = 0;
    }
    if (bat.state === 'smash' && bat.t >= SMASH) {
      bat.state = 'recover';
      bat.t = 0;
      this.impact(bat.target, camera);
    }
    if (bat.state === 'recover' && bat.t >= RECOVER) {
      bat.state = 'rest';
      bat.t = 0;
    }
    // Where his hand is: up high at rest, raised further on the windup, down at the target on the smash.
    const tgt = bat.target;
    const dirIn = normalize([tgt[0] - 0, 0, tgt[2] - 20]);
    const handAtHit = add(tgt, add(scale(dirIn, -5.5), [0, 3.2, 0]));
    const handUp = add(tgt, add(scale(dirIn, -8), [0, 14, 0]));
    let hand: Vec3;
    if (bat.state === 'windup') hand = lerp3(bat.hand, handUp, clamp(bat.t / WIND_UP, 0, 1));
    else if (bat.state === 'smash') hand = lerp3(handUp, handAtHit, clamp(bat.t / SMASH, 0, 1));
    else if (bat.state === 'recover') hand = lerp3(handAtHit, [3, 13, 12], clamp(bat.t / RECOVER, 0, 1));
    else hand = [3 + Math.sin(this.giant.time * 0.9) * 1.5, 13, 12];
    bat.hand = hand;
    this.giant.lookTarget = bat.state === 'rest' ? [0, 0, 0] : tgt;
    this.giant.update(dt, hand);

    for (const c of this.confetti) {
      c.age += dt;
      c.vel[1] -= 4 * dt;
      c.pos = add(c.pos, scale(c.vel, dt));
    }
    this.confetti = this.confetti.filter((c) => c.age < 2.5 && c.pos[1] > 0);
    for (const p of this.pops) p.age += dt;
    this.pops = this.pops.filter((p) => p.age < 0.4);
    for (const c of this.candy) {
      c.vel[1] -= 20 * dt;
      c.pos = add(c.pos, scale(c.vel, dt));
      if (c.pos[1] < 0.05) {
        c.pos[1] = 0.05;
        c.vel = [c.vel[0] * 0.5, Math.abs(c.vel[1]) * 0.3, c.vel[2] * 0.5];
      }
    }
  }

  private swing(target: Vec3) {
    this.bat = { state: 'windup', t: 0, target: [target[0], 0, target[2]], hand: this.bat.hand };
    this.quiet = 0;
    this.noises = [];
  }

  private impact(p: Vec3, camera: LevelContext['camera']) {
    const { player, physics } = this.ctx;
    camera.addShake(Math.max(0.2, 1.2 - length(sub(p, player.pos)) * 0.08));
    for (let k = 0; k < 20; k++) this.confetti.push({ pos: add(p, [rand(-1, 1), 0.3, rand(-1, 1)]), vel: [rand(-4, 4), rand(3, 8), rand(-4, 4)], age: 0, color: pick(COLORS) });
    // The piñata, at last.
    if (this.t > PARTY && !this.pinataHit) {
      this.pinataHit = true;
      for (let k = 0; k < 60; k++) this.candy.push({ pos: [rand(-0.5, 0.5), 3.6, -4 + rand(-0.5, 0.5)], vel: [rand(-6, 6), rand(2, 8), rand(-6, 6)], color: pick(COLORS) });
      return;
    }
    // Balloons nearby pop (more noise), loose things get batted.
    for (let i = this.balloons.length - 1; i >= 0; i--) if (Math.hypot(this.balloons[i].pos[0] - p[0], this.balloons[i].pos[2] - p[2]) < BAT_R + 0.6) this.pop(i);
    for (const b of physics.bodies) {
      const q = b.rb.translation();
      const d = Math.hypot(q.x - p[0], q.z - p[2]);
      if (d < BAT_R + 1) b.rb.applyImpulse({ x: (q.x - p[0]) * 3, y: 6 * b.rb.mass(), z: (q.z - p[2]) * 3 }, true);
    }
    if (player.mode === 'control' && !this.death && Math.hypot(player.pos[0] - p[0], player.pos[2] - p[2]) < BAT_R) {
      const away = normalize([player.pos[0] - p[0] + 0.01, 0, player.pos[2] - p[2]]);
      player.kill([away[0] * 6, -4, away[2] * 6], { violence: 20, origin: add(player.pos, [0, 1.6, 0]) });
      this.death = {
        t: 0,
        big: 'SMASHED',
        small: pick([
          'Swing and a hit. Candy did not come out. Everyone was very disappointed.',
          'Timmy is blind, not deaf.',
          'Happy birthday, Timmy.',
        ]),
      };
    }
  }

  // --- Drawing ------------------------------------------------------------------------------------

  draw(out: DrawItem[]) {
    this.arrival.draw(out);
    this.exit.draw(out);
    // Timmy (no shadow: he's outside, really) and his bat.
    const first = out.length;
    this.giant.draw(out);
    const grip = this.giant.graspPoint;
    const tgt = this.bat.target;
    const dirIn = this.bat.state === 'rest' ? normalize([0.3, -0.5, -1]) : normalize(sub([tgt[0], 0.4, tgt[2]], grip));
    const tip = add(grip, scale(dirIn, 7));
    out.push({ mesh: 'cylinder', model: segment(grip, add(grip, scale(dirIn, 1.8)), 0.25), color: [0.25, 0.15, 0.08] });
    out.push({ mesh: 'cylinder', model: segment(add(grip, scale(dirIn, 1.8)), tip, 0.55), color: [0.72, 0.5, 0.26], spec: 0.3 });
    for (let i = first; i < out.length; i++) out[i].shadow = false;
    // Where he's about to swing: a shadow on the floor during the windup.
    if (this.bat.state === 'windup' || this.bat.state === 'smash') {
      const k = this.bat.state === 'smash' ? 1 : this.bat.t / WIND_UP;
      out.push({ mesh: 'cylinder', model: mul(translation([tgt[0], 0.015, tgt[2]]), scaling([BAT_R * k, 0.01, BAT_R * k])), color: [0, 0, 0], pattern: Pattern.blob, param: 0.55, shadow: false });
    }
    // Noise rings.
    for (const n of this.noises) {
      if (n.loud < 0.5) continue;
      const r = 0.4 + n.t * (1.5 + n.loud);
      const a = 1 - n.t / 1.6;
      out.push({ mesh: 'tube', model: mul(translation([n.pos[0], 0.03, n.pos[2]]), scaling([r, 0.02, r])), color: n.loud >= HEARING ? [2.2, 2.0, 1.2] : [0.8, 0.8, 0.8], pattern: Pattern.emissive, opacity: 0.8 * a, shadow: false });
    }
    // Balloons, pops, confetti, candy.
    for (const b of this.balloons) {
      out.push({ mesh: 'sphere', model: mul(translation(b.pos), scaling([BALLOON_R, BALLOON_R * 1.18, BALLOON_R])), color: b.color, spec: 0.9 });
      out.push({ mesh: 'cone', model: mul(translation(add(b.pos, [0, -BALLOON_R * 1.2, 0])), rotationX(Math.PI), scaling([0.06, 0.08, 0.06])), color: b.color });
      out.push({ mesh: 'cylinder', model: segment(add(b.pos, [0, -BALLOON_R * 1.25, 0]), add(b.pos, [Math.sin(b.bob) * 0.1, -1.2, 0]), 0.006), color: [0.9, 0.9, 0.9], shadow: false });
    }
    for (const p of this.pops) {
      const s = 0.3 + p.age * 3;
      out.push({ mesh: 'sphere', model: mul(translation(p.pos), scaling([s, s, s])), color: p.color.map((c) => c * 2), pattern: Pattern.emissive, opacity: 1 - p.age / 0.4, shadow: false });
    }
    for (const c of this.confetti) out.push({ mesh: 'box', model: mul(translation(c.pos), rotationY(c.age * 11), rotationZ(c.age * 7), scaling([0.12, 0.01, 0.07])), color: c.color, shadow: false });
    for (const c of this.candy) out.push({ mesh: 'sphere', model: mul(translation(c.pos), scaling([0.09, 0.07, 0.09])), color: c.color, spec: 0.8 });
    // The piñata itself, hanging in the middle (until he finds it).
    if (!this.pinataHit) this.drawPinata(out, mul(translation([0, 3.6, -4]), rotationY(Math.sin(this.giant.time * 0.7) * 0.4)));
    out.push({ mesh: 'cylinder', model: segment([0, 4.3, -4], [0, 11, -4], 0.02), color: [0.85, 0.8, 0.7] });
    // Party flags strung across the room.
    for (let k = 0; k < 18; k++) {
      const x = -11 + k * 1.3, y = 8.5 - Math.sin((k / 17) * Math.PI) * 1.2;
      out.push({ mesh: 'cone', model: mul(translation([x, y, -6]), rotationX(Math.PI), scaling([0.35, 0.6, 0.05])), color: COLORS[k % COLORS.length], shadow: false });
    }
  }

  private drawPinata(out: DrawItem[], m: Mat4) {
    // A papier-mâché donkey, in stripes.
    const stripes = [COLORS[0], COLORS[2], COLORS[1], COLORS[4], COLORS[3]];
    for (let k = 0; k < 5; k++) out.push({ mesh: 'box', model: mul(m, translation([-0.6 + k * 0.3, 0, 0]), scaling([0.3, 0.6, 0.5])), color: stripes[k] });
    out.push({ mesh: 'box', model: mul(m, translation([0.85, 0.45, 0]), scaling([0.35, 0.8, 0.4])), color: COLORS[5] });
    out.push({ mesh: 'box', model: mul(m, translation([1.1, 0.75, 0]), scaling([0.5, 0.3, 0.35])), color: COLORS[1] });
    for (const z of [-0.1, 0.1]) out.push({ mesh: 'cone', model: mul(m, translation([0.8, 1.05, z]), scaling([0.08, 0.35, 0.06])), color: COLORS[2] });
    for (const [x, z] of [[-0.5, -0.18], [-0.5, 0.18], [0.5, -0.18], [0.5, 0.18]]) out.push({ mesh: 'box', model: mul(m, translation([x, -0.5, z]), scaling([0.14, 0.45, 0.14])), color: COLORS[4] });
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
    return this.arrival.cameraShot();
  }
}

function lerp3(a: Vec3, b: Vec3, k: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}
