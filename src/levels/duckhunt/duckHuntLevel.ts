import { noise, sfx } from '../../engine/audio';
import { add, clamp, mul, normalize, rotationX, rotationY, rotationZ, scaling, sub, translation, type Mat4, type Vec3 } from '../../engine/math';
import type { RAPIER } from '../../engine/physics';
import { Pattern, type DrawItem, type Environment } from '../../engine/renderer';
import { CHAMBER_HALF } from '../../game/chamber';
import { ExitPortal, PortalArrival } from '../../entities/portal';
import { DEFAULT_ENV, type CameraShot, type Level, type LevelContext, type LevelStatus, type TrackedTarget, type WorldLabel } from '../level';

/*
 * Duck Hunt, and you're the duck. The hunter is out past the south wall (the fourth wall, as it
 * were): a big white crosshair chases you with a bit of lag, and when it settles on you, BANG:
 * the whole screen flashes white, light-gun style. Every miss, the dog pops up out of the grass
 * and laughs at the hunter. Bushes and the tree stop a shot each (and get shredded doing it).
 * Three rounds of three shells, then the hunter gives up and the exit opens.
 */

const ROUNDS = 3;
const SHELLS = 3;
/** The crosshair's speed (m/s) per round, and how long it has to sit on you before the shot. */
const AIM_SPEED = [4.2, 5.2, 6.2];
const SETTLE = [0.8, 0.65, 0.5];
/** It fires anyway after this long, wherever it is. */
const IMPATIENT = 3.2;
/** Within this far (m) of your chest when the gun goes off: hit. */
const HIT_R = 0.75;
/** The shot comes from out there. */
const GUN_Z = 45;
const DEATH_SCREEN_DELAY = 2.2;

const GRASS = [0.3, 0.55, 0.18];
const BUSH = [0.15, 0.42, 0.12];
const DOG_BROWN = [0.62, 0.4, 0.2];
const DOG_LIGHT = [0.88, 0.75, 0.55];

const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

interface Bush {
  pos: Vec3;
  r: number;
  collider: RAPIER.Collider | null;
  /** Shredded (by a shot it stopped): leaves flying, then gone. */
  shredT: number;
}

interface Death {
  t: number;
  big: string;
  small: string;
}

export class DuckHuntLevel implements Level {
  readonly number: number;
  readonly title = 'Duck Hunt';
  status: LevelStatus = 'playing';
  private arrival: PortalArrival;
  private exit = new ExitPortal(-6);
  private bushes: Bush[] = [];
  private aim: Vec3 = [0, 1.2, 8];
  private aimVel: Vec3 = [0, 0, 0];
  private round = 0;
  private shells = SHELLS;
  private settle = 0;
  private tracking = 0;
  private flash = 0;
  private started = false;
  private pause = 2;
  /** The dog: 0 = hidden, rising, laughing, holding (you), shrug. */
  private dog: { mode: 'hidden' | 'laugh' | 'hold' | 'shrug'; t: number; x: number } = { mode: 'hidden', t: 0, x: 0 };
  private done = false;
  private death: Death | null = null;
  private dogLabel: WorldLabel = { pos: [0, 0, 0], text: '', size: 0.5, color: '#ffffff' };
  private roundLabel: WorldLabel = { pos: [0, 6.5, -CHAMBER_HALF + 0.3], text: '', size: 1.1, color: '#ffffff' };
  private shellLabel: WorldLabel = { pos: [0, 5.2, -CHAMBER_HALF + 0.3], text: '', size: 0.6, color: '#ffd166' };
  private labelList: WorldLabel[];
  private env: Environment = { ...DEFAULT_ENV };
  private leaves: { pos: Vec3; vel: Vec3; age: number }[] = [];

  constructor(private ctx: LevelContext) {
    this.number = ctx.number;
    const { hud, physics } = ctx;
    hud.setLevel(`The Chamber · Level ${this.number}`);
    hud.show(`LEVEL ${this.number}`, '', 2.5);
    hud.hint('');
    this.arrival = new PortalArrival(ctx, [0, 0, 2]);
    const spots: [number, number, number][] = [[-6, 5, 1.1], [5.5, 3, 1.2], [-2, -3, 1.0], [7, -6, 1.1], [-8, -7, 1.2]];
    for (const [x, z, r] of spots) {
      this.bushes.push({ pos: [x, 0, z], r, collider: physics.addStaticCylinder([x, r * 0.6, z], r, r * 1.2), shredT: -1 });
    }
    // The tree: a trunk and a big blob of leaves (counts as a bush for stopping shots).
    this.bushes.push({ pos: [-9, 0, 9], r: 1.6, collider: physics.addStaticCylinder([-9, 1.5, 9], 0.35, 3), shredT: -1 });
    this.labelList = [this.dogLabel, this.roundLabel, this.shellLabel];
  }

  private chest(): Vec3 {
    const p = this.ctx.player.pos;
    return [p[0], p[1] + 1.15, p[2]];
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
          ['Hint', 'Keep changing direction: the crosshair lags behind you. A bush or the tree stops one shot, then it’s gone.'],
          ['Controls', 'WASD move · Shift sprint · Space jump'],
        ]);
      }
    }
    this.arrival.update(dt);
    this.exit.update(dt, player);
    if (this.exit.entered && this.status === 'playing') this.status = 'exited';
    this.flash = Math.max(0, this.flash - dt);
    this.dog.t += dt;
    for (const b of this.bushes) if (b.shredT >= 0) b.shredT += dt;
    for (const l of this.leaves) {
      l.age += dt;
      l.vel[1] -= 6 * dt;
      l.pos = add(l.pos, [l.vel[0] * dt, l.vel[1] * dt, l.vel[2] * dt]);
    }
    this.leaves = this.leaves.filter((l) => l.age < 1.8);
    if (!this.arrival.done) return;
    const alive = player.mode === 'control' && !this.death;

    // The dog's labels.
    const dogTop: Vec3 = [this.dog.x, this.dogHeight() + 1.9, 10.5];
    this.dogLabel.pos = dogTop;
    this.dogLabel.text = this.dog.mode === 'laugh' && this.dog.t < 1.8 ? (Math.floor(this.dog.t * 6) % 2 ? 'HEH HEH' : 'HEH HEH HEH') : this.dog.mode === 'shrug' ? '¯\\_(ツ)_/¯' : this.dog.mode === 'hold' ? 'GOT ONE!' : '';
    this.shellLabel.text = this.done ? '' : `SHOT ${'▮'.repeat(this.shells)}${'▯'.repeat(SHELLS - this.shells)}`;
    if (this.done) return;

    if (this.pause > 0) {
      this.pause -= dt;
      this.roundLabel.text = this.round < ROUNDS ? `ROUND ${this.round + 1}` : '';
      return;
    }
    this.roundLabel.text = '';
    if (!alive) return;

    // The crosshair chases you (at chest height), laggy and a bit shaky.
    const speed = AIM_SPEED[this.round];
    const target = this.chest();
    const to = sub(target, this.aim);
    const d = Math.hypot(to[0], to[2]);
    const want: Vec3 = d > 1e-3 ? [(to[0] / d) * Math.min(speed, d * 3), 0, (to[2] / d) * Math.min(speed, d * 3)] : [0, 0, 0];
    this.aimVel = add(this.aimVel, [(want[0] - this.aimVel[0]) * Math.min(1, dt * 2.8), 0, (want[2] - this.aimVel[2]) * Math.min(1, dt * 2.8)]);
    const shake = 0.25;
    this.aim = [this.aim[0] + this.aimVel[0] * dt + (Math.random() - 0.5) * shake * dt * 6, target[1], this.aim[2] + this.aimVel[2] * dt + (Math.random() - 0.5) * shake * dt * 6];
    this.settle = d < HIT_R * 0.8 ? this.settle + dt : Math.max(0, this.settle - dt * 0.5);
    this.tracking += dt;

    if (this.settle >= SETTLE[this.round] || this.tracking > IMPATIENT) this.fire(physics, camera);
  }

  private dogHeight() {
    const t = this.dog.t;
    if (this.dog.mode === 'hidden') return -2.2;
    const up = clamp(t / 0.3, 0, 1), down = clamp((t - 1.8) / 0.4, 0, 1);
    if (this.dog.mode === 'shrug' || this.dog.mode === 'hold') return -2.2 + 2.2 * up;
    return -2.2 + 2.2 * up - 2.2 * down;
  }

  private fire(physics: LevelContext['physics'], camera: LevelContext['camera']) {
    const { player } = this.ctx;
    this.flash = 0.09;
    camera.addShake(0.25);
    sfx.shot();
    this.settle = 0;
    this.tracking = 0;
    this.shells--;
    // In from the "screen": does anything stop it before it gets to the crosshair?
    // (Traced from just inside the south wall: the wall itself doesn't count.)
    const from: Vec3 = [this.aim[0], this.aim[1] + 0.4 * ((CHAMBER_HALF - 0.1 - this.aim[2]) / (GUN_Z - this.aim[2])), CHAMBER_HALF - 0.1];
    const dir = normalize(sub(this.aim, from));
    const dist = Math.hypot(this.aim[0] - from[0], this.aim[1] - from[1], this.aim[2] - from[2]);
    const hit = physics.raycast(from, dir, dist, player.collider ?? undefined);
    const bush = hit ? this.bushes.find((b) => b.shredT < 0 && b.collider && b.collider.handle === hit.collider.handle) : undefined;
    const chest = this.chest();
    const onYou = Math.hypot(this.aim[0] - chest[0], this.aim[2] - chest[2]) < HIT_R;
    if (bush) {
      // The bush takes it, and is shredded.
      this.shred(bush);
      this.miss();
    } else if (onYou) {
      player.kill([dir[0] * 3, 9, dir[2] * 3], { violence: 10 });
      this.dog = { mode: 'hold', t: 0, x: Math.max(-8, Math.min(8, player.pos[0])) };
      this.death = { t: 0, big: 'BAGGED', small: pick(['You were a sitting duck. Literally.', 'The dog would like to thank you for your contribution to dinner.', 'Quack.']) };
    } else {
      this.miss();
    }
    if (this.shells <= 0 && !this.death) {
      this.round++;
      this.shells = SHELLS;
      this.pause = 2.5;
      if (this.round >= ROUNDS) {
        this.done = true;
        this.exit.openNow();
        this.dog = { mode: 'shrug', t: 0, x: 0 };
        this.ctx.hud.show('THE HUNTER GIVES UP', 'The dog is embarrassed for everyone involved.', 3.5);
      }
    }
  }

  private miss() {
    sfx.laugh(0.35);
    this.dog = { mode: 'laugh', t: 0, x: Math.max(-8, Math.min(8, this.ctx.player.pos[0] + (Math.random() - 0.5) * 6)) };
  }

  private shred(b: Bush) {
    noise(0.5, { freq: 3000, to: 800, type: 'bandpass', q: 1, vol: 0.35 });
    b.shredT = 0;
    // (The tree keeps its trunk to bump into; it just won't stop another shot.)
    if (b.collider && b.r < 1.5) {
      this.ctx.physics.world.removeCollider(b.collider, true);
      b.collider = null;
    }
    for (let i = 0; i < 26; i++) {
      this.leaves.push({ pos: add(b.pos, [(Math.random() - 0.5) * b.r, b.r * (0.4 + Math.random()), (Math.random() - 0.5) * b.r]), vel: [(Math.random() - 0.5) * 5, 2 + Math.random() * 4, (Math.random() - 0.5) * 5], age: 0 });
    }
  }

  draw(out: DrawItem[]) {
    this.arrival.draw(out);
    this.exit.draw(out);
    const t = this.dog.t;
    // Grass over the floor, bushes, the tree.
    out.push({ mesh: 'box', model: mul(translation([0, 0.01, 0]), scaling([CHAMBER_HALF * 2, 0.02, CHAMBER_HALF * 2])), color: GRASS, spec: 0.05 });
    for (const b of this.bushes) {
      const gone = b.shredT >= 0;
      if (gone && b.shredT > 0.15) {
        if (b.r < 1.5) continue;
      }
      if (b.r >= 1.5) {
        // The tree: the trunk stays, the leaves go.
        out.push({ mesh: 'cylinder', model: mul(translation(add(b.pos, [0, 1.6, 0])), scaling([0.35, 3.2, 0.35])), color: [0.4, 0.26, 0.14] });
        if (!gone) for (const [x, y, z, r] of [[0, 4, 0, 1.8], [1, 3.6, 0.5, 1.2], [-0.9, 3.7, -0.4, 1.3], [0.2, 4.8, -0.3, 1.1]]) out.push({ mesh: 'sphere', model: mul(translation(add(b.pos, [x, y, z])), scaling([r, r * 0.85, r])), color: BUSH });
        continue;
      }
      for (const [x, y, z, k] of [[0, 0.55, 0, 1], [0.5, 0.45, 0.3, 0.7], [-0.45, 0.5, -0.25, 0.75], [0.1, 0.9, -0.1, 0.6]]) {
        const r = b.r * k;
        out.push({ mesh: 'sphere', model: mul(translation(add(b.pos, [x * b.r, y * b.r, z * b.r])), scaling([r, r * 0.8, r])), color: BUSH });
      }
    }
    for (const l of this.leaves) out.push({ mesh: 'box', model: mul(translation(l.pos), rotationY(l.age * 9), rotationX(l.age * 7), scaling([0.12, 0.02, 0.08])), color: BUSH, shadow: false });

    // The crosshair: a big white ring with a cross, floating where the hunter's aiming.
    if (!this.done && this.pause <= 0 && !this.death) {
      const m = mul(translation(this.aim), rotationX(Math.PI / 2));
      const pulse = 1 - Math.min(1, this.settle / SETTLE[this.round]) * 0.35;
      const red = this.settle > SETTLE[this.round] * 0.5;
      const c = red ? [3, 0.4, 0.3] : [2.4, 2.4, 2.4];
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        out.push({ mesh: 'box', model: mul(m, rotationY(-a), translation([0.62 * pulse, 0, 0]), scaling([0.05, 0.03, 0.26 * pulse])), color: c, pattern: Pattern.emissive, shadow: false });
      }
      for (const a of [0, Math.PI / 2]) out.push({ mesh: 'box', model: mul(m, rotationY(a), scaling([1.8 * pulse, 0.03, 0.04])), color: c, pattern: Pattern.emissive, shadow: false });
    }
    // The dog, popping up out of the grass by the south wall.
    if (this.dog.mode !== 'hidden') this.drawDog(out, translation([this.dog.x, this.dogHeight(), 10.5]), t);
  }

  private drawDog(out: DrawItem[], m: Mat4, t: number) {
    const laugh = this.dog.mode === 'laugh' ? Math.sin(t * 22) * 0.12 : 0;
    const body = mul(m, translation([0, 0.9, 0]));
    out.push({ mesh: 'sphere', model: mul(body, scaling([0.55, 0.7, 0.45])), color: DOG_BROWN });
    out.push({ mesh: 'sphere', model: mul(body, translation([0, 0.1, -0.3]), scaling([0.35, 0.45, 0.2])), color: DOG_LIGHT });
    const head = mul(m, translation([0, 1.85 + laugh, 0]), rotationX(-0.15 + laugh));
    out.push({ mesh: 'sphere', model: mul(head, scaling([0.42, 0.4, 0.42])), color: DOG_BROWN });
    out.push({ mesh: 'sphere', model: mul(head, translation([0, -0.12, -0.35]), scaling([0.24, 0.18, 0.28])), color: DOG_LIGHT });
    out.push({ mesh: 'sphere', model: mul(head, translation([0, -0.02, -0.6]), scaling([0.09, 0.07, 0.07])), color: [0.05, 0.03, 0.03] });
    for (const s of [-1, 1]) {
      out.push({ mesh: 'sphere', model: mul(head, translation([s * 0.16, 0.12, -0.34]), scaling([0.07, 0.08, 0.05])), color: [0.05, 0.04, 0.04] });
      out.push({ mesh: 'sphere', model: mul(head, translation([s * 0.4, -0.05, 0]), rotationZ(s * 0.3), scaling([0.13, 0.35, 0.1])), color: [0.35, 0.2, 0.1] });
      // Paws on the grass (or up, shrugging).
      const up = this.dog.mode === 'shrug' ? 1 : 0;
      out.push({ mesh: 'sphere', model: mul(m, translation([s * 0.5, 1.5 + up * 0.5, -0.25]), scaling([0.14, 0.14, 0.14])), color: DOG_LIGHT });
    }
    // The grin: a big laughing mouth.
    if (this.dog.mode === 'laugh') out.push({ mesh: 'sphere', model: mul(head, translation([0, -0.25, -0.42]), scaling([0.16, 0.08 + Math.abs(laugh), 0.06])), color: [0.5, 0.05, 0.08] });
  }

  labels(): WorldLabel[] {
    return this.labelList;
  }

  trackedTargets(): TrackedTarget[] {
    const exit = this.exit.target();
    return exit ? [exit] : [];
  }

  environment() {
    // The light-gun flash: for a moment the whole screen goes white.
    const e = this.env;
    if (this.flash > 0) {
      e.fogColor = [4, 4, 4];
      e.fogDensity = 3;
    } else {
      e.fogColor = DEFAULT_ENV.fogColor;
      e.fogDensity = DEFAULT_ENV.fogDensity;
    }
    return e;
  }

  obstacles() {
    return [];
  }

  cameraShot(): CameraShot | null {
    return this.arrival.cameraShot();
  }
}
