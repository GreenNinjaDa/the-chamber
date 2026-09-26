import { add, clamp, cross, lerp, mul, normalize, rotationX, rotationY, scale, scaling, sub, translation, type Vec3 } from '../../engine/math';
import type { Body } from '../../engine/physics';
import { Pattern, type DrawItem } from '../../engine/renderer';
import { CHAMBER_HALF } from '../../game/chamber';
import { Giant } from '../../entities/giant';
import { ExitPortal, PortalArrival } from '../../entities/portal';
import { DEFAULT_ENV, type CameraShot, type Level, type LevelContext, type LevelStatus, type TrackedTarget, type WorldLabel } from '../level';

/*
 * Dominoes. A long line of giant dominoes snakes across the chamber, and the giant's finger is
 * about to flick the first one. There's a gap in the line, marked by a chalk outline exactly
 * your size: you are the missing domino. Stand in the gap and get knocked flat, and the chain
 * carries on through you to the end, where the last domino hits the button that opens the
 * exit. Anywhere else in its path, you're flattened. Not in the gap at all, and the chain
 * stops, and the giant does it himself. To you.
 */

const THICK = 0.34;
const TALL = 2.6;
const WIDE = 1.3;
const SPACING = 1.55;
const MASS = 60;
const FLICK_AT = 7;
const DEATH_SCREEN_DELAY = 2;

const IVORY = [0.94, 0.92, 0.86];
const PIP = [0.06, 0.06, 0.07];

const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

interface Domino {
  body: Body;
  /** Where it stands and which way it falls (along the path). */
  pos: Vec3;
  dir: Vec3;
  pips: [number, number];
}

interface Death {
  t: number;
  big: string;
  small: string;
}

/** The dominoes' path: an S across the room, from the north-west to the south-east. */
function path(u: number): Vec3 {
  const x = -9.5 + 19 * u;
  const z = -7 * Math.cos(u * Math.PI * 2.2) + (u - 0.5) * 4;
  return [x, 0, z];
}

export class DominoesLevel implements Level {
  readonly number: number;
  readonly title = 'Dominoes';
  status: LevelStatus = 'playing';
  private arrival: PortalArrival;
  private exit = new ExitPortal(8);
  private giant = new Giant();
  private dominoes: Domino[] = [];
  /** Index where the missing domino should be. */
  private gap = 0;
  private gapPos: Vec3 = [0, 0, 0];
  private gapDir: Vec3 = [1, 0, 0];
  private t = -1;
  private flicked = false;
  private carried = false;
  private stuckFor = 0;
  private lastFall = FLICK_AT;
  private buttonPressed = false;
  private finger: Vec3 = [0, 30, 20];
  private fingerTarget: Vec3 | null = null;
  private death: Death | null = null;
  private dust: { pos: Vec3; age: number }[] = [];
  private fell: boolean[] = [];
  private labelList: WorldLabel[] = [];
  private buttonPos: Vec3 = [CHAMBER_HALF - 0.3, 1.2, 8];

  constructor(private ctx: LevelContext) {
    this.number = ctx.number;
    const { hud, physics } = ctx;
    hud.setLevel(`The Chamber · Level ${this.number}`);
    hud.show(`LEVEL ${this.number}`, '', 2.5);
    hud.hint('');
    // Lay out the dominoes along the path, evenly spaced.
    const samples: Vec3[] = [];
    for (let i = 0; i <= 400; i++) samples.push(path(i / 400));
    const spots: { pos: Vec3; dir: Vec3 }[] = [];
    let acc = 0;
    let last = samples[0];
    spots.push({ pos: last, dir: normalize(sub(samples[1], samples[0])) });
    for (let i = 1; i < samples.length; i++) {
      acc += Math.hypot(samples[i][0] - last[0], samples[i][2] - last[2]);
      last = samples[i];
      if (acc >= SPACING) {
        acc = 0;
        const next = samples[Math.min(samples.length - 1, i + 1)];
        spots.push({ pos: samples[i], dir: normalize(sub(next, samples[i - 1])) });
      }
    }
    this.gap = Math.floor(spots.length * 0.55);
    spots.forEach((s, i) => {
      if (i === this.gap) {
        this.gapPos = s.pos;
        this.gapDir = s.dir;
        return;
      }
      const yaw = Math.atan2(s.dir[0], s.dir[2]);
      const q = { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
      const pips: [number, number] = [Math.floor(Math.random() * 7), Math.floor(Math.random() * 7)];
      const body = physics.addBox(add(s.pos, [0, TALL / 2 + 0.01, 0]), [WIDE, TALL, THICK], {
        mass: MASS,
        rotation: q,
        friction: 0.6,
        restitution: 0.05,
        grabbable: false,
        model: (out, m) => drawDomino(out, m, pips),
      });
      body.rb.sleep();
      this.dominoes.push({ body, pos: s.pos, dir: s.dir, pips });
      this.fell.push(false);
    });
    // Arrive to one side of the line, near its middle.
    const mid = spots[Math.floor(spots.length * 0.3)];
    const side = normalize(cross(mid.dir, [0, 1, 0]));
    this.arrival = new PortalArrival(ctx, add(mid.pos, scale(side, 3.2)));
    this.giant.root = [0, -80, 27];
    this.giant.leanTarget = this.giant.lean = 0.35;
    this.giant.rightCurl = 0.4;
    this.giant.update(0, [0, 30, 20]);
    this.labelList.push({ pos: [0, 7.5, -CHAMBER_HALF + 0.3], text: 'WORLD RECORD ATTEMPT', size: 1, color: '#ffd166' });
    this.labelList.push({ pos: [0, 6.6, -CHAMBER_HALF + 0.3], text: `${this.dominoes.length + 1} DOMINOES (ONE MISSING)`, size: 0.5, color: '#ffffff' });
  }

  /** How far a domino has fallen over (rad). */
  private tilt(d: Domino) {
    const q = d.body.rb.rotation();
    const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
    return Math.acos(clamp(upY, -1, 1));
  }

  private push(d: Domino, strength = 1) {
    const top = add(d.body.rb.translation() as unknown as Vec3, [0, 0, 0]);
    const p = d.body.rb.translation();
    d.body.rb.wakeUp();
    d.body.rb.applyImpulseAtPoint({ x: d.dir[0] * 40 * strength, y: 0, z: d.dir[2] * 40 * strength }, { x: p.x, y: p.y + TALL * 0.4, z: p.z }, true);
    void top;
  }

  update(dt: number) {
    const { player, hud, camera } = this.ctx;
    const death = this.death;
    if (death && this.status === 'playing') {
      death.t += dt;
      if (death.t > DEATH_SCREEN_DELAY) {
        this.status = 'lost';
        hud.show(death.big, `${death.small}\nPress R to try again.`);
        hud.tips([
          ['Hint', 'One domino is missing, and the chalk outline in the gap is exactly your size. Be the domino. Just don’t stand anywhere else in their way.'],
          ['Controls', 'WASD move · Shift sprint'],
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

    // The giant leans in over the wall; his finger reaches for the first domino, or for you.
    this.giant.root[1] = lerp(-80, 0, clamp((t - 0.5) / 3, 0, 1));
    const first = this.dominoes[0];
    const fingerGoal: Vec3 = this.fingerTarget ?? (t < FLICK_AT - 1.5 ? [first.pos[0] + 6, 14, first.pos[2] + 10] : t < FLICK_AT + 1 ? add(sub(first.pos, scale(first.dir, 1.2)), [0, 2.3, 0]) : [first.pos[0] + 6, 16, first.pos[2] + 12]);
    this.finger = add(this.finger, scale(sub(fingerGoal, this.finger), 1 - Math.exp(-dt * 5)));
    this.giant.lookTarget = this.finger;
    this.giant.update(dt, this.finger);
    if (!this.flicked && t >= FLICK_AT) {
      this.flicked = true;
      this.push(first, 1.3);
    }

    // Watch the chain: dust where each one lands, and flatten anyone underneath.
    this.dominoes.forEach((d, i) => {
      const tilt = this.tilt(d);
      if (!this.fell[i] && tilt > 1.2) {
        this.fell[i] = true;
        this.lastFall = t;
        const p = d.body.rb.translation();
        this.dust.push({ pos: add([p.x, 0, p.z], scale(d.dir, TALL * 0.6)), age: 0 });
        camera.addShake(Math.max(0, 0.35 - Math.hypot(p.x - player.pos[0], p.z - player.pos[2]) * 0.03));
      }
      // Falling onto the player (outside the gap): anything between its base and its landing spot.
      if (alive && tilt > 0.22 && tilt < 1.35 && i !== this.gap - 1) {
        const rel = sub(player.pos, d.pos);
        const along = rel[0] * d.dir[0] + rel[2] * d.dir[2];
        const across = Math.abs(rel[0] * d.dir[2] - rel[2] * d.dir[0]);
        if (along > 0.2 && along < TALL * 0.9 && across < WIDE / 2 + 0.25) this.flatten();
      }
    });
    for (const p of this.dust) p.age += dt;
    this.dust = this.dust.filter((p) => p.age < 1.5);

    // The gap: the domino before it tips onto whoever's standing there, and on it goes.
    const before = this.dominoes[this.gap - 1];
    const after = this.dominoes[this.gap];
    if (!this.carried && before && this.tilt(before) > 0.45) {
      const inGap = alive && Math.hypot(player.pos[0] - this.gapPos[0], player.pos[2] - this.gapPos[2]) < 0.9;
      if (inGap) {
        this.carried = true;
        player.knock([this.gapDir[0] * 5, 1, this.gapDir[2] * 5], 2.2);
        this.push(after, 1.4);
        hud.show('YOU ARE THE DOMINO', '', 2);
      } else if (this.tilt(before) > 1.2) {
        // It fell into an empty gap: the chain has stopped.
        this.stuckFor += dt;
        if (this.stuckFor > 2.5 && !this.fingerTarget && alive) {
          hud.show("IF YOU WANT SOMETHING DONE RIGHT...", '', 2.5);
          this.fingerTarget = add(player.pos, [0, 1, 0]);
        }
      }
    }
    // The finger comes for you: a flick across the room.
    if (this.fingerTarget && alive) {
      this.fingerTarget = add(player.pos, [0, 1, 0]);
      if (Math.hypot(this.finger[0] - player.pos[0], this.finger[2] - player.pos[2]) < 1.6 && this.finger[1] < 4) {
        const away = normalize(sub(player.pos, [0, 0, 20]));
        player.kill([away[0] * 22, 12, away[2] * 22], { violence: 24 });
        camera.addShake(0.8);
        this.death = { t: 0, big: 'FLICKED', small: pick(['The chain broke. So did you.', 'You had one job: be the domino.', 'Nobody ruins Timmy’s world record.']) };
      }
    }
    // A domino stopped by something (a player in the way, say): after a while, the giant nudges it on.
    if (this.flicked && !this.buttonPressed && !this.fingerTarget && t - this.lastFall > 3.5) {
      const k = this.fell.findIndex((f) => !f);
      if (k >= 0 && k !== this.gap) {
        this.lastFall = t;
        this.push(this.dominoes[k], 1.3);
      }
    }
    // The last one falls on the button.
    const lastD = this.dominoes[this.dominoes.length - 1];
    if (!this.buttonPressed && this.tilt(lastD) > 0.9) {
      this.buttonPressed = true;
      this.exit.openNow();
      hud.show('NEW WORLD RECORD!', 'Timmy would like to thank the domino. You know who you are.', 3.5);
    }
  }

  private flatten() {
    const { player, camera } = this.ctx;
    if (this.death) return;
    player.kill([0, -3, 0], { violence: 14, origin: add(player.pos, [0, 1.5, 0]) });
    camera.addShake(0.8);
    this.death = { t: 0, big: 'FLATTENED', small: pick(['You were in the wrong gap.', 'Dominoes: 1. You: 0.', 'Tip: dominoes fall over. It is their whole thing.']) };
  }

  draw(out: DrawItem[]) {
    this.arrival.draw(out);
    this.exit.draw(out);
    const first = out.length;
    this.giant.draw(out);
    // His pointing finger, sticking out of the hand.
    const f = this.finger;
    out.push({ mesh: 'cylinder', model: mul(translation(add(f, [0, 0.8, 0])), rotationX(0.3), scaling([0.45, 2.2, 0.45])), color: [0.86, 0.64, 0.5], pattern: Pattern.skin });
    for (let i = first; i < out.length; i++) out[i].shadow = false;
    // The chalk outline in the gap: a domino-shaped (you-shaped) dotted rectangle.
    const yaw = Math.atan2(this.gapDir[0], this.gapDir[2]);
    const base = mul(translation(add(this.gapPos, [0, 0.012, 0])), rotationY(yaw));
    for (let k = 0; k < 12; k++) {
      const a = k / 12;
      const edge: Vec3 = a < 0.25 ? [-0.65 + a * 4 * 1.3, 0, -0.2] : a < 0.5 ? [0.65, 0, -0.2 + (a - 0.25) * 4 * 0.4] : a < 0.75 ? [0.65 - (a - 0.5) * 4 * 1.3, 0, 0.2] : [-0.65, 0, 0.2 - (a - 0.75) * 4 * 0.4];
      out.push({ mesh: 'box', model: mul(base, translation(edge), scaling([0.12, 0.01, 0.12])), color: [0.95, 0.95, 0.95], shadow: false });
    }
    // The button the last domino will fall on (on the east wall by the exit).
    out.push({ mesh: 'cylinder', model: mul(translation(this.buttonPos), rotationX(Math.PI / 2), rotationY(0), scaling([0.4, 0.25, 0.4])), color: this.buttonPressed ? [0.2, 1.6, 0.3] : [0.9, 0.1, 0.08], pattern: this.buttonPressed ? Pattern.emissive : Pattern.plain });
    for (const p of this.dust) {
      const s = 0.4 + p.age * 1.2;
      out.push({ mesh: 'sphere', model: mul(translation(add(p.pos, [0, 0.2 + p.age * 0.4, 0])), scaling([s, s * 0.5, s])), color: [0.8, 0.78, 0.72], opacity: 0.6 * (1 - p.age / 1.5), shadow: false });
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
    return this.arrival.cameraShot();
  }
}

/** An ivory domino with a line across the middle and the pips of its two numbers on both faces. */
function drawDomino(out: DrawItem[], m: ReturnType<typeof translation>, pips: [number, number]) {
  out.push({ mesh: 'bevelbox', model: mul(m, scaling([WIDE, TALL, THICK])), color: IVORY, spec: 0.7 });
  for (const side of [-1, 1]) {
    out.push({ mesh: 'box', model: mul(m, translation([0, 0, side * (THICK / 2 + 0.003)]), scaling([WIDE * 0.8, 0.05, 0.01])), color: PIP });
    pips.forEach((n, half) => {
      const cy = (half ? -1 : 1) * TALL / 4;
      for (const [px, py] of PIP_LAYOUT[n]) {
        out.push({ mesh: 'cylinder', model: mul(m, translation([px * WIDE * 0.28, cy + py * TALL * 0.14, side * (THICK / 2 + 0.004)]), rotationX(Math.PI / 2), scaling([0.1, 0.01, 0.1])), color: PIP });
      }
    });
  }
}

/** Where the pips go for 0-6 (in units of a half-face, x and y from -1 to 1). */
const PIP_LAYOUT: [number, number][][] = [
  [],
  [[0, 0]],
  [[-1, -1], [1, 1]],
  [[-1, -1], [0, 0], [1, 1]],
  [[-1, -1], [1, -1], [-1, 1], [1, 1]],
  [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]],
  [[-1, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [1, 1]],
];
