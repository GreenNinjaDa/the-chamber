import { add, length, mul, normalize, quatConj, rotateByQuat, rotationX, rotationY, scale, scaling, segment, sub, translation, type Vec3 } from '../../engine/math';
import type { Body } from '../../engine/physics';
import { Pattern, type DrawItem } from '../../engine/renderer';
import { junk, spawnJunk } from '../../entities/junk';
import { ExitPortal, PortalArrival } from '../../entities/portal';
import { drawTrapdoor } from '../../entities/trapdoor';
import { drawTurret } from '../../entities/turret';
import { DEFAULT_ENV, type CameraShot, type Level, type LevelContext, type LevelStatus, type TrackedTarget, type WorldLabel } from '../level';

/*
 * Dodgeball. Four sentry turrets wake up one after another and open fire: not bullets, red
 * rubber dodgeballs, aimed where you're going. Three hits and you're out (through the floor,
 * at speed). The balls end up everywhere: pick one up, aim, and throw it back to knock a turret
 * over. Knock them all down and the exit opens.
 */

const TURRETS: [number, number][] = [[-8, -8.5], [8.5, -8], [-9, 5], [7.5, 7.5]];
/** When each turret wakes (s after the arrival), or null: when this many others are down. */
const WAKE_AT: (number | { afterDown: number })[] = [1.5, 3, 9, { afterDown: 2 }];
const BALL_R = 0.28;
const BALL_MASS = 1.2;
const MAX_BALLS = 14;
const FIRE_SPEED = 15;
const CHARGE = 0.9;
const COOLDOWN: [number, number] = [2.4, 3.6];
const HITS_TO_OUT = 3;
/** A turret tipped further than this (rad) is down for good. */
const DOWN_TILT = 0.9;
const DEATH_SCREEN_DELAY = 1.8;

const HELLO = ['Hello?', 'There you are.', 'Target... acquired?', 'Hi!', 'Oh. It’s you.'];
const SEARCH = ['Are you still there?', 'Hello?', 'Searching...', 'Where did you go?'];
const DOWN = ['I don’t blame you.', 'Critical error.', 'Ow.', 'No hard feelings.', 'Why...', 'Shutting down.'];

const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
const rand = (a: number, b: number) => a + Math.random() * (b - a);

interface Turret {
  body: Body;
  state: 'asleep' | 'active' | 'down';
  wake: number;
  open: number;
  charge: number;
  cooldown: number;
  eye: number;
  /** Direction it's looking, in its own frame (yaw, rad). */
  yaw: number;
  seen: boolean;
  label: WorldLabel;
  labelT: number;
}

interface Ball {
  body: Body;
  /** Set when a turret fires it (until it's picked up); only these hurt the player. */
  hostile: boolean;
  from: Turret | null;
  age: number;
  /** Already knocked something this flight. */
  spent: boolean;
  /** Where it was last frame (hits are tested along the whole step, fast balls skip a lot). */
  prev: Vec3;
}

interface Death {
  t: number;
  big: string;
  small: string;
}

export class DodgeballLevel implements Level {
  readonly number: number;
  readonly title = 'Dodgeball';
  status: LevelStatus = 'playing';
  private arrival: PortalArrival;
  private exit = new ExitPortal(0);
  private turrets: Turret[] = [];
  private balls: Ball[] = [];
  private time = 0;
  private started = -1;
  private hits = 0;
  private hitLabel: WorldLabel = { pos: [0, 0, 0], text: '', size: 0.3, color: '#ff6b6b' };
  private labelList: WorldLabel[] = [];
  private death: Death | null = null;
  private trapdoor: { pos: Vec3; yaw: number; t: number } | null = null;
  private wasCarrying: Ball | null = null;

  constructor(private ctx: LevelContext) {
    this.number = ctx.number;
    const { physics, hud } = ctx;
    hud.setLevel(`The Chamber · Level ${this.number}`);
    hud.show(`LEVEL ${this.number}`, '', 2.5);
    hud.hint('');
    this.arrival = new PortalArrival(ctx, [0, 0, 5]);
    for (const [x, z] of TURRETS) {
      const t: Turret = {
        body: null!, state: 'asleep', wake: 0, open: 0, charge: 0, cooldown: rand(0.5, 1.5), eye: 0.1, yaw: 0, seen: false,
        label: { pos: [x, 2.1, z], text: '', size: 0.3, color: '#dfe8ff' }, labelT: 0,
      };
      t.body = physics.addCylinder([x, 0.62, z], 0.3, 1.24, {
        mass: 22,
        friction: 0.9,
        model: (out, m) => drawTurret(out, mul(m, translation([0, -0.62, 0]), rotationY(t.yaw)), t.open, t.eye),
      });
      this.turrets.push(t);
      this.labelList.push(t.label);
    }
    this.labelList.push(this.hitLabel);
    // Cover, and a few balls lying about to start with.
    const place = (name: string, x: number, z: number, yaw = 0) => {
      const def = junk(name);
      spawnJunk(physics, def, [x, def.size[1] / 2 + 0.01, z], { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) });
    };
    place('vending machine', -3.5, -3, 0.4);
    place('filing cabinet', 4, -2.5, -0.3);
    place('crate', -4.5, 3.5, 0.2);
    place('crate', -4.4, 3.5 + 0.85, 0.5);
    place('fridge', 3.5, 4, 1.2);
    place('bookcase', 0, -7, 0);
    for (const [x, z] of [[1.2, 3.2], [-1.4, 3.6], [0.2, 1.5]]) this.addBall([x, BALL_R + 0.01, z]);
  }

  private addBall(pos: Vec3): Ball {
    const { physics } = this.ctx;
    const body = physics.addBall(pos, BALL_R, {
      mass: BALL_MASS,
      restitution: 0.75,
      friction: 0.8,
      throwScale: 1.2,
      model: (out, m) => {
        out.push({ mesh: 'sphere', model: mul(m, scaling([BALL_R, BALL_R, BALL_R])), color: [0.85, 0.08, 0.06], spec: 0.5 });
        out.push({ mesh: 'cylinder', model: mul(m, rotationX(Math.PI / 2), scaling([BALL_R * 1.01, 0.05, BALL_R * 1.01])), color: [0.95, 0.9, 0.85] });
      },
    });
    const ball: Ball = { body, hostile: false, from: null, age: 0, spent: false, prev: [...pos] };
    this.balls.push(ball);
    return ball;
  }

  private turretPos(t: Turret): Vec3 {
    const p = t.body.rb.translation();
    return [p.x, p.y, p.z];
  }

  /** How far a turret is tipped over (rad). */
  private tilt(t: Turret) {
    const q = t.body.rb.rotation();
    const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
    return Math.acos(Math.max(-1, Math.min(1, upY)));
  }

  private say(t: Turret, text: string) {
    t.label.text = text;
    t.labelT = 2.2;
  }

  update(dt: number) {
    const { player, hud, physics } = this.ctx;
    const death = this.death;
    if (death && this.status === 'playing') {
      death.t += dt;
      if (death.t > DEATH_SCREEN_DELAY) {
        this.status = 'lost';
        hud.show(death.big, `${death.small}\nPress R to try again.`);
        hud.tips([
          ['Hint', 'Pick up a dodgeball (hold left click), aim at a turret and right-click to throw it: knock them all over. Get behind something when a red laser finds you.'],
          ['Controls', 'WASD move · Shift sprint · Hold left click carry · Right-click throw'],
        ]);
      }
    }
    this.arrival.update(dt);
    this.exit.update(dt, player);
    if (this.exit.entered && this.status === 'playing') this.status = 'exited';
    this.time += dt;
    if (this.trapdoor) this.trapdoor.t += dt;
    if (this.arrival.done && this.started < 0) this.started = this.time;
    const since = this.started < 0 ? -1 : this.time - this.started;
    const alive = player.mode === 'control' && !this.death;
    const chest: Vec3 = add(player.pos, [0, 1.25, 0]);

    // Turrets: wake up, find you, charge, fire; or topple and shut down.
    const down = this.turrets.filter((t) => t.state === 'down').length;
    this.turrets.forEach((t, i) => {
      const p = this.turretPos(t);
      t.label.pos = [p[0], p[1] + 1.4, p[2]];
      t.labelT -= dt;
      if (t.labelT <= 0) t.label.text = '';
      if (t.state !== 'down' && this.tilt(t) > DOWN_TILT) {
        t.state = 'down';
        this.say(t, pick(DOWN));
        if (this.turrets.every((o) => o.state === 'down')) {
          this.exit.openNow();
          hud.show('YOU WIN. DODGEBALL.', 'The turrets would like it known there are no hard feelings.', 3.5);
        }
      }
      if (t.state === 'down') {
        t.open = Math.max(0, t.open - dt * 0.8);
        t.eye = Math.max(0, t.eye - dt * 0.6);
        return;
      }
      if (t.state === 'asleep') {
        const w = WAKE_AT[i];
        const wake = typeof w === 'number' ? since >= w : down >= w.afterDown;
        if (since >= 0 && wake) {
          t.state = 'active';
          this.say(t, pick(HELLO));
        }
        return;
      }
      t.open = Math.min(1, t.open + dt * 1.5);
      // Look for the player.
      const eye = add(p, [0, 0.33, 0]);
      const to = sub(chest, eye);
      const dist = length(to);
      const blocker = physics.raycast(eye, normalize(to), dist, t.body.collider);
      const seen = alive && !blocker;
      if (seen && !t.seen) this.say(t, pick(HELLO));
      if (!seen && t.seen && Math.random() < 0.5) this.say(t, pick(SEARCH));
      t.seen = seen;
      // Turn (in its own frame) toward the player.
      const q = t.body.rb.rotation();
      const local = rotateByQuat(quatConj(q), to);
      const want = Math.atan2(-local[0], -local[2]);
      t.yaw += Math.atan2(Math.sin(want - t.yaw), Math.cos(want - t.yaw)) * Math.min(1, dt * 5);
      t.cooldown -= dt;
      if (seen && t.cooldown <= 0) {
        t.charge += dt;
        t.eye = 0.5 + 0.5 * Math.abs(Math.sin(this.time * (8 + t.charge * 20)));
        if (t.charge >= CHARGE) this.fire(t, eye, dist);
      } else {
        t.charge = Math.max(0, t.charge - dt * 2);
        t.eye = seen ? 0.6 : 0.3;
      }
    });

    // Balls: who's holding what, what hit whom.
    const carrying = this.balls.find((b) => player.carrying === b.body.collider) ?? null;
    if (carrying) {
      carrying.hostile = false;
      carrying.spent = false;
      carrying.from = null;
    }
    this.wasCarrying = carrying;
    for (const b of this.balls) {
      b.age += dt;
      const v = b.body.rb.linvel();
      const speed = Math.hypot(v.x, v.y, v.z);
      const bp = b.body.rb.translation();
      const pos: Vec3 = [bp.x, bp.y, bp.z];
      const prev = b.prev;
      b.prev = pos;
      if (speed < 4) {
        b.spent = false;
        b.hostile = false;
      }
      if (b.spent || b === carrying || (speed < 6 && !b.hostile)) continue;
      // A hostile ball hitting the player (tested along its path this frame).
      if (b.hostile && alive && !player.inPortal && speed > 3) {
        const f = player.partFrames();
        const hit = [f.head, f.chest, f.pelvis, f.thighL, f.thighR].some((m) => segDist(prev, pos, [m[12], m[13], m[14]]) < 0.45);
        if (hit) {
          b.spent = true;
          b.hostile = false;
          this.playerHit([v.x, v.y, v.z]);
          continue;
        }
      }
      // Any fast ball knocking a turret over (with a little help, so a good throw always works).
      for (const t of this.turrets) {
        if (t.state === 'down' || (b.from === t && b.age < 0.6)) continue;
        const tp = this.turretPos(t);
        const dx = pos[0] - tp[0], dz = pos[2] - tp[2];
        if (Math.hypot(dx, dz) < 0.3 + BALL_R + 0.08 && pos[1] > 0.15 && pos[1] < 1.35) {
          b.spent = true;
          const dir = normalize([v.x, 0, v.z]);
          t.body.rb.applyImpulseAtPoint({ x: dir[0] * 30, y: 0, z: dir[2] * 30 }, { x: tp[0], y: tp[1] + 0.5, z: tp[2] }, true);
          if (t.state === 'asleep') t.state = 'active';
          this.say(t, pick(['Ow!', 'Hey!', 'Whoa whoa whoa', 'Please put me down.']));
        }
      }
    }
    // The hit counter floats over your head.
    this.hitLabel.pos = add(player.pos, [0, 2.3, 0]);
    this.hitLabel.text = this.hits && alive ? '●'.repeat(this.hits) + '○'.repeat(HITS_TO_OUT - this.hits) : '';
  }

  private fire(t: Turret, eye: Vec3, dist: number) {
    const { player } = this.ctx;
    t.charge = 0;
    t.cooldown = rand(COOLDOWN[0], COOLDOWN[1]);
    // Lead the player, a bit wobbly, and lob it up enough to arrive at chest height.
    const flight = dist / FIRE_SPEED;
    const aim: Vec3 = [
      player.pos[0] + player.vel[0] * flight * 0.8 + rand(-0.3, 0.3),
      player.pos[1] + 1.2 + rand(-0.2, 0.3),
      player.pos[2] + player.vel[2] * flight * 0.8 + rand(-0.3, 0.3),
    ];
    const dir = normalize(sub(aim, eye));
    const muzzle = add(eye, scale(dir, 0.55));
    let ball = this.balls.length < MAX_BALLS ? this.addBall(muzzle) : this.oldestFreeBall();
    if (!ball) return;
    ball.body.rb.setTranslation({ x: muzzle[0], y: muzzle[1], z: muzzle[2] }, true);
    const v = scale(dir, FIRE_SPEED);
    v[1] += 0.5 * 20 * flight; // gravity
    ball.body.rb.setLinvel({ x: v[0], y: v[1], z: v[2] }, true);
    ball.body.rb.setAngvel({ x: rand(-8, 8), y: rand(-8, 8), z: rand(-8, 8) }, true);
    ball.prev = [...muzzle];
    ball.hostile = true;
    ball.from = t;
    ball.age = 0;
    ball.spent = false;
  }

  private oldestFreeBall(): Ball | null {
    let best: Ball | null = null;
    for (const b of this.balls) if (b !== this.wasCarrying && (!best || b.age > best.age)) best = b;
    return best;
  }

  private playerHit(v: Vec3) {
    const { player, camera } = this.ctx;
    this.hits++;
    camera.addShake(0.4);
    const dir = normalize([v[0], 0, v[2]]);
    if (this.hits < HITS_TO_OUT) {
      player.knock([dir[0] * 4, 2.5, dir[2] * 4], 0.6);
      return;
    }
    // Out: the floor opens under you, dodgeball-style.
    const yaw = Math.random() * Math.PI * 2;
    this.trapdoor = { pos: [player.pos[0], 0, player.pos[2]], yaw, t: 0 };
    player.kill([Math.sin(yaw) * 4 + dir[0] * 3, 22, Math.cos(yaw) * 4 + dir[2] * 3], { violence: 12 });
    camera.addShake(0.8);
    this.death = {
      t: 0,
      big: "YOU'RE OUT",
      small: pick([
        'If you can dodge a wrench, you can dodge a ball. You could not dodge a ball.',
        'Three hits. Those are the rules. The floor enforces them.',
        'The turrets would like to say: no hard feelings.',
      ]),
    };
  }

  draw(out: DrawItem[]) {
    this.arrival.draw(out);
    this.exit.draw(out);
    // Targeting lasers from each awake turret that can see you.
    const { player } = this.ctx;
    const chest: Vec3 = add(player.pos, [0, 1.25, 0]);
    for (const t of this.turrets) {
      if (t.state !== 'active' || !t.seen) continue;
      const eye = add(this.turretPos(t), [0, 0.33, 0]);
      const dir = normalize(sub(chest, eye));
      const start = add(eye, scale(dir, 0.28));
      out.push({ mesh: 'cylinder', model: segment(start, chest, 0.01 + t.charge * 0.012), color: [3.5, 0.2, 0.15], pattern: Pattern.emissive, shadow: false });
    }
    if (this.trapdoor) drawTrapdoor(out, this.trapdoor.pos, this.trapdoor.yaw, this.trapdoor.t);
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

/** Distance from point p to the segment a-b. */
function segDist(a: Vec3, b: Vec3, p: Vec3) {
  const ab = sub(b, a), ap = sub(p, a);
  const len2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
  const t = len2 > 1e-9 ? Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / len2)) : 0;
  return length(sub(p, add(a, scale(ab, t))));
}
