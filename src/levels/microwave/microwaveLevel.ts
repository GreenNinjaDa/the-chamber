import { add, mul, normalize, rotationY, scale, scaling, segment, sub, translation, type Mat4, type Vec3 } from '../../engine/math';
import type { Body } from '../../engine/physics';
import { Pattern, type DrawItem, type Environment } from '../../engine/renderer';
import { CHAMBER_HALF } from '../../game/chamber';
import { ExitPortal, PortalArrival } from '../../entities/portal';
import { DEFAULT_ENV, type CameraShot, type Level, type LevelContext, type LevelStatus, type TrackedTarget, type WorldLabel } from '../level';

/*
 * Microwave. Surprise: the chamber is the inside of one. The floor becomes a glass turntable
 * that carries you round, the air hums, and the microwaves' standing waves make hot spots that
 * stay put while the plate turns under them: loiter in one and you cook. Halfway through, the
 * popcorn starts popping (and knocking you about), and somebody left a fork in: it arcs at
 * anything that comes near. Last 45 seconds, then DING, and the door opens.
 */

const COOK_TIME = 45;
const START_AFTER = 2.5;
/** The turntable's spin (rad/s) and radius. */
const SPIN = 0.16;
const PLATE_R = 11.3;
/** Hot spots don't turn with the plate. Radius grows on HIGH power. */
const HOT_SPOTS: [number, number][] = hexGrid(5.2, PLATE_R - 0.8);
const HOT_R_LOW = 1.4;
const HOT_R_HIGH = 2.1;
const HIGH_AT = 20;
/** Seconds in a hot spot that cook you (heat drains slower than it builds). */
const COOKED = 1.4;
const POP_FROM = 12;
const POP_TO = 34;
const KERNELS = 28;
/** The fork starts sparking at this time, arcs every so often, and zaps anyone this close to its tines. */
const FORK_AT = 20;
const FORK_REACH = 4.2;
const DEATH_SCREEN_DELAY = 1.9;

const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
const rand = (a: number, b: number) => a + Math.random() * (b - a);

interface Kernel {
  body: Body;
  popAt: number;
  popped: boolean;
}

interface Arc {
  from: Vec3;
  to: Vec3;
  t: number;
  seed: number;
}

interface Death {
  t: number;
  big: string;
  small: string;
}

export class MicrowaveLevel implements Level {
  readonly number: number;
  readonly title = 'Microwave';
  status: LevelStatus = 'playing';
  private arrival: PortalArrival;
  private exit = new ExitPortal(0);
  private t = -1;
  private angle = 0;
  private heat = 0;
  private kernels: Kernel[] = [];
  private forkAngle = 0.8;
  private forkR = 5;
  private arcs: Arc[] = [];
  private nextArc = 0;
  private death: Death | null = null;
  private done = false;
  private clock: WorldLabel = { pos: [0, 7.4, -CHAMBER_HALF + 0.35], text: '', size: 1.8, color: '#5dff8a' };
  private mode: WorldLabel = { pos: [0, 6.1, -CHAMBER_HALF + 0.35], text: '', size: 0.45, color: '#5dff8a' };
  private labelList: WorldLabel[];
  private env: Environment = { ...DEFAULT_ENV };
  private puffs: { pos: Vec3; age: number }[] = [];

  constructor(private ctx: LevelContext) {
    this.number = ctx.number;
    const { hud, physics } = ctx;
    hud.setLevel(`The Chamber · Level ${this.number}`);
    hud.show(`LEVEL ${this.number}`, '', 2.5);
    hud.hint('');
    this.arrival = new PortalArrival(ctx, [0, 0, 8]);
    this.labelList = [
      this.clock,
      this.mode,
      { pos: [-CHAMBER_HALF + 0.3, 3.2, -4], text: 'DO NOT MICROWAVE TEST SUBJECTS', size: 0.4, color: '#ffd166' },
      { pos: [CHAMBER_HALF - 0.3, 5.2, 0], text: 'CAUTION: CONTENTS MAY BE HOT', size: 0.35, color: '#ffd166' },
    ];
    // Popcorn kernels scattered over the plate.
    for (let i = 0; i < KERNELS; i++) {
      const a = rand(0, Math.PI * 2), r = rand(2, 10.5);
      const body = physics.addBall([Math.cos(a) * r, 0.12, Math.sin(a) * r], 0.12, {
        mass: 0.3,
        restitution: 0.4,
        model: (out, m) => out.push({ mesh: 'sphere', model: mul(m, scaling([0.12, 0.09, 0.12])), color: [0.85, 0.65, 0.2], spec: 0.6 }),
      });
      this.kernels.push({ body, popAt: rand(POP_FROM, POP_TO), popped: false });
    }
  }

  private cooking() {
    return this.t >= 0 && this.t < COOK_TIME && !this.done;
  }

  private hotR() {
    return this.t >= HIGH_AT ? HOT_R_HIGH : HOT_R_LOW;
  }

  private forkTips(): Vec3 {
    const a = this.forkAngle + this.angle;
    return [Math.cos(a) * (this.forkR + 1.4), 0.3, Math.sin(a) * (this.forkR + 1.4)];
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
          ['Hint', "The hot spots don't turn with the plate: walk against the spin to stay out of them. Keep clear of the fork once it sparks."],
          ['Controls', 'WASD move · Shift sprint · Space jump'],
        ]);
      }
    }
    this.arrival.update(dt);
    this.exit.update(dt, player);
    if (this.exit.entered && this.status === 'playing') this.status = 'exited';
    if (this.arrival.done && this.t < 0) this.t = -START_AFTER;
    if (this.t > -10) this.t += dt;
    const t = this.t;
    const cooking = this.cooking();
    const alive = player.mode === 'control' && !this.death;

    // The display.
    if (t < 0 && t > -10) {
      this.clock.text = '0:45';
      this.mode.text = 'POPCORN · HIGH · START';
    } else if (cooking) {
      const left = Math.ceil(COOK_TIME - t);
      this.clock.text = `0:${String(left).padStart(2, '0')}`;
      this.mode.text = t >= HIGH_AT ? 'POWER: HIGH (SORRY)' : 'POWER: LOW';
    }
    if (t >= COOK_TIME && !this.done) {
      this.done = true;
      this.clock.text = 'DING!';
      this.mode.text = 'ENJOY YOUR MEAL';
      this.exit.openNow();
      if (!this.death) hud.show('DING!', 'Your test subject is ready. Careful: contents may be hot.', 3.5);
    }

    // The plate turns (and carries you round), while it's cooking.
    const spin = cooking ? SPIN : 0;
    this.angle += spin * dt;
    const onPlate = Math.hypot(player.pos[0], player.pos[2]) < PLATE_R;
    player.platformVel = alive && onPlate && player.onGround ? [-spin * player.pos[2], 0, spin * player.pos[0]] : [0, 0, 0];
    // Loose things ride the plate too (friction, near enough).
    for (const b of physics.bodies) {
      const p = b.rb.translation();
      if (p.y > 0.8 || Math.hypot(p.x, p.z) > PLATE_R) continue;
      const v = b.rb.linvel();
      const want = [-spin * p.z, spin * p.x];
      const k = Math.min(1, dt * 3);
      b.rb.setLinvel({ x: v.x + (want[0] - v.x) * k, y: v.y, z: v.z + (want[1] - v.z) * k }, true);
    }

    // Hot spots.
    if (alive && cooking && t > 0) {
      const r = this.hotR();
      const inSpot = HOT_SPOTS.some(([x, z]) => Math.hypot(player.pos[0] - x, player.pos[2] - z) < r);
      this.heat = inSpot ? this.heat + dt : Math.max(0, this.heat - dt * 0.6);
      player.char = Math.min(0.6, this.heat / COOKED * 0.6);
      if (inSpot && Math.random() < dt * 10) this.puffs.push({ pos: add(player.pos, [rand(-0.3, 0.3), 1.2, rand(-0.3, 0.3)]), age: 0 });
      if (this.heat >= COOKED) {
        player.kill([rand(-1, 1), 3, rand(-1, 1)], { violence: 4 });
        player.char = 1;
        camera.addShake(0.3);
        this.death = { t: 0, big: 'COOKED', small: pick(['Nuked. Crispy on the outside, still frozen in the middle.', 'Stand for two minutes before serving.', 'You were supposed to take the wrapper off first.']) };
      }
    }

    // Popcorn.
    for (const k of this.kernels) {
      if (k.popped || !cooking || t < k.popAt) continue;
      k.popped = true;
      const p = k.body.rb.translation();
      const pos: Vec3 = [p.x, p.y, p.z];
      physics.remove(k.body);
      const corn = physics.addBall([pos[0], 0.35, pos[2]], 0.3, {
        mass: 0.5,
        restitution: 0.5,
        model: (out, m) => drawPopcorn(out, m),
      });
      corn.rb.setLinvel({ x: rand(-3, 3), y: rand(6, 10), z: rand(-3, 3) }, true);
      corn.rb.setAngvel({ x: rand(-10, 10), y: rand(-10, 10), z: rand(-10, 10) }, true);
      this.puffs.push({ pos, age: 0 });
      if (alive && Math.hypot(player.pos[0] - pos[0], player.pos[2] - pos[2]) < 1.1 && !player.gettingUp) {
        const d = normalize([player.pos[0] - pos[0], 0, player.pos[2] - pos[2]]);
        player.knock([d[0] * 4, 3.5, d[2] * 4], 0.5);
      }
    }

    // The fork: sparks, then arcs, now and then; anyone near its tines gets it.
    if (cooking && t > FORK_AT) {
      this.nextArc -= dt;
      if (this.nextArc <= 0) {
        this.nextArc = rand(1.1, 2.4);
        const tips = this.forkTips();
        const near = alive && Math.hypot(player.pos[0] - tips[0], player.pos[2] - tips[2]) < FORK_REACH;
        const a = rand(0, Math.PI * 2), r = rand(1.5, FORK_REACH);
        const to: Vec3 = near ? add(player.pos, [0, 1.1, 0]) : [tips[0] + Math.cos(a) * r, 0.05, tips[2] + Math.sin(a) * r];
        this.arcs.push({ from: tips, to, t: 0, seed: Math.random() * 100 });
        if (near) {
          player.kill([rand(-2, 2), 6, rand(-2, 2)], { violence: 14 });
          player.char = 0.7;
          camera.addShake(0.9);
          this.death = { t: 0, big: 'ZAPPED', small: pick(['Never put metal in a microwave. Or yourself, frankly.', 'Somebody left a fork in. It was you, in a way.']) };
        }
      }
    }
    for (const arc of this.arcs) arc.t += dt;
    this.arcs = this.arcs.filter((a) => a.t < 0.25);
    for (const p of this.puffs) p.age += dt;
    this.puffs = this.puffs.filter((p) => p.age < 1.2);
  }

  draw(out: DrawItem[]) {
    this.arrival.draw(out);
    this.exit.draw(out);
    const t = this.t;
    const cooking = this.cooking();

    // The turntable: a big glass plate with a few marks so you can see it turn.
    out.push({ mesh: 'cylinder', model: mul(translation([0, 0.012, 0]), scaling([PLATE_R, 0.02, PLATE_R])), color: [0.62, 0.72, 0.78], spec: 1, shadow: false });
    out.push({ mesh: 'cylinder', model: mul(translation([0, 0.006, 0]), scaling([PLATE_R + 0.2, 0.012, PLATE_R + 0.2])), color: [0.42, 0.48, 0.54], spec: 1, shadow: false });
    for (let k = 0; k < 6; k++) {
      const a = this.angle + (k * Math.PI) / 3;
      out.push({ mesh: 'box', model: mul(translation([0, 0.028, 0]), rotationY(-a), translation([PLATE_R * 0.55, 0, 0]), scaling([PLATE_R * 0.9, 0.006, 0.08])), color: [0.8, 0.88, 0.92], shadow: false });
    }
    // The hot spots, glowing, pulsing (they stay put).
    if (cooking && t > 0) {
      const r = this.hotR();
      for (const [x, z] of HOT_SPOTS) {
        const pulse = 0.75 + 0.25 * Math.sin(this.t * 6 + x);
        out.push({ mesh: 'cylinder', model: mul(translation([x, 0.035, z]), scaling([r * pulse, 0.01, r * pulse])), color: [3.2, 0.55, 0.06], pattern: Pattern.emissive, opacity: 0.72, shadow: false });
        out.push({ mesh: 'cylinder', model: mul(translation([x, 0.034, z]), scaling([r, 0.008, r])), color: [1.6, 0.22, 0.03], pattern: Pattern.emissive, opacity: 0.45, shadow: false });
      }
    }
    // The fork, lying on the plate, turning with it.
    const fa = this.forkAngle + this.angle;
    const fm = mul(translation([Math.cos(fa) * this.forkR, 0.1, Math.sin(fa) * this.forkR]), rotationY(-fa));
    const steel = [0.75, 0.77, 0.8];
    out.push({ mesh: 'bevelbox', model: mul(fm, translation([-1.2, 0, 0]), scaling([2.6, 0.12, 0.36])), color: steel, spec: 1 });
    out.push({ mesh: 'bevelbox', model: mul(fm, translation([0.35, 0, 0]), scaling([0.7, 0.12, 0.9])), color: steel, spec: 1 });
    for (const z of [-0.33, -0.11, 0.11, 0.33]) out.push({ mesh: 'box', model: mul(fm, translation([1.1, 0, z]), scaling([0.9, 0.08, 0.08])), color: steel, spec: 1 });
    if (cooking && t > FORK_AT - 2) {
      // Little sparks at the tines, warning you.
      const tips = this.forkTips();
      for (let k = 0; k < 3; k++) {
        const s = add(tips, [rand(-0.4, 0.4), rand(0, 0.5), rand(-0.4, 0.4)]);
        out.push({ mesh: 'sphere', model: mul(translation(s), scaling([0.05, 0.05, 0.05])), color: [3, 3.5, 6], pattern: Pattern.emissive, shadow: false });
      }
    }
    for (const arc of this.arcs) drawBolt(out, arc.from, arc.to, arc.seed + arc.t * 40);
    for (const p of this.puffs) {
      const s = 0.1 + p.age * 0.4;
      out.push({ mesh: 'sphere', model: mul(translation(add(p.pos, [0, p.age * 1.2, 0])), scaling([s, s, s])), color: [0.8, 0.8, 0.78], opacity: 0.6 * (1 - p.age / 1.2), shadow: false });
    }
    // The control panel on the north wall around the display.
    const wz = -CHAMBER_HALF + 0.15;
    out.push({ mesh: 'box', model: mul(translation([0, 6.9, wz]), scaling([7, 3.4, 0.2])), color: [0.06, 0.07, 0.08], spec: 0.8 });
    for (let k = 0; k < 9; k++) {
      const x = -1.2 + (k % 3) * 1.2, y = 4.8 - Math.floor(k / 3) * 0.9;
      out.push({ mesh: 'roundbox', model: mul(translation([x + 5.5, y + 2, wz + 0.1]), scaling([0.9, 0.6, 0.12])), color: [0.8, 0.8, 0.82] });
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
    // Inside a microwave: a warm yellow light while it's on.
    const on = this.cooking() && this.t > -1;
    const e = this.env;
    e.sunColor = on ? [2.0, 1.75, 1.2] : DEFAULT_ENV.sunColor;
    e.skyColor = on ? [0.35, 0.3, 0.18] : DEFAULT_ENV.skyColor;
    e.fogColor = on ? [0.75, 0.68, 0.45] : DEFAULT_ENV.fogColor;
    return e;
  }

  obstacles() {
    return [];
  }

  cameraShot(): CameraShot | null {
    return this.arrival.cameraShot();
  }
}

/** A fluffy piece of popcorn: a cluster of white puffs with a golden hull or two. */
function drawPopcorn(out: DrawItem[], m: Mat4) {
  const puffs: [number, number, number, number][] = [[0, 0, 0, 0.22], [0.14, 0.08, 0.05, 0.16], [-0.12, 0.1, -0.06, 0.17], [0.03, -0.1, 0.13, 0.15], [-0.05, 0.14, 0.12, 0.13]];
  for (const [x, y, z, r] of puffs) out.push({ mesh: 'sphere', model: mul(m, translation([x, y, z]), scaling([r, r * 0.9, r])), color: [0.98, 0.95, 0.85], spec: 0.2 });
  out.push({ mesh: 'sphere', model: mul(m, translation([0.02, -0.14, -0.1]), scaling([0.08, 0.05, 0.08])), color: [0.8, 0.55, 0.15] });
}

/** A jagged lightning bolt from `a` to `b`. */
function drawBolt(out: DrawItem[], a: Vec3, b: Vec3, seed: number) {
  const n = 7;
  const d = sub(b, a);
  const side = normalize([-d[2], 0, d[0]]);
  let prev = a;
  for (let i = 1; i <= n; i++) {
    const k = i / n;
    const j = i === n ? 0 : Math.sin(seed * 12.9898 + i * 78.233) * 0.5;
    const p = add(add(a, scale(d, k)), add(scale(side, j), [0, Math.cos(seed * 4.1 + i * 7.7) * 0.3 * (i === n ? 0 : 1), 0]));
    out.push({ mesh: 'cylinder', model: segment(prev, p, 0.035), color: [4, 5, 9], pattern: Pattern.emissive, shadow: false });
    prev = p;
  }
}

/** Points on a hexagonal grid (this spacing) within radius r of the centre: the standing-wave pattern. */
function hexGrid(spacing: number, r: number): [number, number][] {
  const out: [number, number][] = [];
  const dz = spacing * Math.sin(Math.PI / 3);
  for (let row = -4; row <= 4; row++) {
    for (let col = -4; col <= 4; col++) {
      const x = (col + (row % 2 ? 0.5 : 0)) * spacing, z = row * dz;
      if (Math.hypot(x, z) <= r) out.push([x, z]);
    }
  }
  return out;
}
