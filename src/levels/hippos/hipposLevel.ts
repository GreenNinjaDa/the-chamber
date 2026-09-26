import { noise, note, sfx, tone, Tune } from '../../engine/audio';
import { clamp, mul, rotationY, scaling, translation, type Vec3 } from '../../engine/math';
import { RAPIER, type Body } from '../../engine/physics';
import { Pattern, type DrawItem } from '../../engine/renderer';
import { CHAMBER_HALF } from '../../game/chamber';
import { drawHippo, type HippoPose } from '../../entities/hippo';
import { ExitPortal, PortalArrival } from '../../entities/portal';
import { DEFAULT_ENV, type CameraShot, type Level, type LevelContext, type LevelStatus, type TrackedTarget, type WorldLabel } from '../level';

/*
 * Hungry Hungry Hippos, and you're a marble. The floor bulges up into a plastic dome that slopes
 * down to four giant hippos, one poking out of each wall, and a few dozen marbles pour in. Each
 * hippo rears back with its lane lit up on the floor, then shoots its neck out and CHOMPS
 * everything in the lane: marbles, or you. When the marbles are gone the game's over, and the
 * east hippo yawns. The way out is in its mouth.
 */

/** The dome: a slice off the top of a huge sphere (2 m high in the middle, about floor level at the walls). */
const DOME_R = 40;
const DOME_Y = -38;
const domeY = (x: number, z: number) => Math.max(0, Math.sqrt(Math.max(0, DOME_R * DOME_R - x * x - z * z)) + DOME_Y);
/** How fast the slope carries you toward the edge at the walls (m/s; less further in). */
const DRIFT = 2.4;

/** Marbles poured in at the start, and a second helping later. */
const MARBLES = 26;
const SECOND_POUR = 16;
const SECOND_POUR_AT = 15;
const MARBLE_R = 0.45;
/** The chomp: how far into the room the lane reaches (m, from the wall), its half-width, and the neck's reach. */
const LANE_LENGTH = 14;
const LANE_HALF = 2.2;
/** A little narrower for catching the player (their feet), so the lit edge is honest. */
const CATCH_HALF = 2.0;
const NECK_REST = 1.6;
const NECK_REACH = 10.5;
/** Seconds: rearing back (lane lit), shooting out, holding, pulling back; and the rest between chomps. */
const WIND = 0.85;
const SNAP = 0.14;
const HOLD = 0.25;
const BACK = 0.5;
const REST: [number, number] = [1.0, 2.6];
/** How far either side of straight out a hippo can aim (rad): right round to the corners. */
const AIM_LIMIT = 1.45;
/** The game ends when the marbles are gone, or after this long anyway. */
const GAME_TIME = 75;
const DEATH_SCREEN_DELAY = 2.2;

type HippoState = 'rest' | 'wind' | 'snap' | 'hold' | 'back' | 'full';

interface Hippo {
  name: string;
  color: number[];
  css: string;
  /** Neck base at the wall, and straight out into the room. */
  base: Vec3;
  out: Vec3;
  aim: number;
  state: HippoState;
  t: number;
  rest: number;
  /** 0-1 how far the neck is out, and how open the mouth is. */
  reach: number;
  jaw: number;
  eaten: number;
  label: WorldLabel;
  pose: HippoPose;
  /** Chewing on something (you): seconds since. */
  chewing: number;
}

interface Death {
  t: number;
  big: string;
  small: string;
}

const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
const rand = (a: number, b: number) => a + Math.random() * (b - a);

// A bouncy toy-box loop. [note, beats].
const TOYBOX: [string | null, number][] = [
  ['G4', 0.5], ['C5', 0.5], ['E5', 0.5], ['C5', 0.5], ['G4', 0.5], ['C5', 0.5], ['E5', 1],
  ['F4', 0.5], ['A4', 0.5], ['D5', 0.5], ['A4', 0.5], ['G4', 0.5], ['B4', 0.5], ['D5', 1],
];

export class HipposLevel implements Level {
  readonly number: number;
  readonly title = 'Hungry Hungry Hippos';
  status: LevelStatus = 'playing';
  private arrival: PortalArrival;
  private exit = new ExitPortal(0, domeY(CHAMBER_HALF, 0));
  private hippos: Hippo[] = [];
  private marbles: Body[] = [];
  private t = -1;
  private poured = 0;
  private over = -1;
  private death: Death | null = null;
  private music = new Tune(TOYBOX, 150, { wave: 'square', vol: 0.05, bass: true });
  private labelList: WorldLabel[] = [];
  private banner: WorldLabel = { pos: [0, 8.2, -CHAMBER_HALF + 0.3], text: '', size: 1, color: '#ffffff' };

  constructor(private ctx: LevelContext) {
    this.number = ctx.number;
    const { hud, physics } = ctx;
    hud.setLevel(`The Chamber · Level ${this.number}`);
    hud.show(`LEVEL ${this.number}`, '', 2.5);
    hud.hint('');
    this.arrival = new PortalArrival(ctx, [0, domeY(0, 3), 3], { minElevationDeg: 70 });
    // The dome.
    physics.world.createCollider(RAPIER.ColliderDesc.ball(DOME_R).setTranslation(0, DOME_Y, 0).setFriction(0.4));

    const W = CHAMBER_HALF - 0.1;
    const specs: [string, number[], string, Vec3, Vec3][] = [
      ['PURPLE', [0.55, 0.28, 0.85], '#c89bff', [0, 1.3, -W], [0, 0, 1]],
      ['ORANGE', [1.0, 0.5, 0.12], '#ffb266', [-W, 1.3, 0], [1, 0, 0]],
      ['GREEN', [0.3, 0.75, 0.3], '#8fe38f', [0, 1.3, W], [0, 0, -1]],
      ['YELLOW', [1.0, 0.84, 0.18], '#ffe26b', [W, 1.3, 0], [-1, 0, 0]],
    ];
    for (const [name, color, css, base, out] of specs) {
      const label: WorldLabel = { pos: [base[0] + out[0] * 0.3, 6.2, base[2] + out[2] * 0.3], text: `${name} 0`, size: 0.55, color: css };
      this.labelList.push(label);
      const yaw = Math.atan2(out[0], out[2]);
      this.hippos.push({
        name, color, css, base, out, aim: 0, state: 'rest', t: 0, rest: rand(1.5, 3), reach: 0, jaw: 0.1, eaten: 0, label, chewing: -1,
        pose: { base, head: [base[0] + out[0] * NECK_REST, 1.3, base[2] + out[2] * NECK_REST], yaw, jaw: 0.1, sleepy: 0 },
      });
    }
    this.labelList.push(this.banner);
  }

  /** Direction a hippo is aiming (its out direction turned by `aim`). */
  private dirOf(h: Hippo): Vec3 {
    const c = Math.cos(h.aim), s = Math.sin(h.aim);
    return [h.out[0] * c + h.out[2] * s, 0, -h.out[0] * s + h.out[2] * c];
  }

  /** Whether a point is in a hippo's lane (along its aim, within `half` either side). */
  private inLane(h: Hippo, x: number, z: number, half: number) {
    const d = this.dirOf(h);
    const rx = x - h.base[0], rz = z - h.base[2];
    const along = rx * d[0] + rz * d[2];
    const across = Math.abs(rx * d[2] - rz * d[0]);
    return along > -0.5 && along < LANE_LENGTH && across < half;
  }

  /** Where to chomp next: the lane with the most marbles in it (you count too), or null. */
  private chooseAim(h: Hippo): number | null {
    const { player } = this.ctx;
    const targets: Vec3[] = this.marbles.map((m) => {
      const p = m.rb.translation();
      return [p.x, p.y, p.z];
    });
    const alive = player.mode === 'control' && !this.death && !player.inPortal;
    let best: number | null = null, bestScore = 0;
    const yawOf = (x: number, z: number) => {
      const rx = x - h.base[0], rz = z - h.base[2];
      // Angle from straight out, positive toward the hippo's left.
      return Math.atan2(h.out[0] * rz - h.out[2] * rx, h.out[0] * rx + h.out[2] * rz);
    };
    const candidates: Vec3[] = alive ? [...targets, player.pos] : targets;
    for (const c of candidates) {
      const a = -yawOf(c[0], c[2]);
      if (Math.abs(a) > AIM_LIMIT + 0.15 || Math.hypot(c[0] - h.base[0], c[2] - h.base[2]) > LANE_LENGTH - 0.5) continue;
      const saved = h.aim;
      h.aim = clamp(a, -AIM_LIMIT, AIM_LIMIT);
      let score = 0;
      for (const m of targets) if (this.inLane(h, m[0], m[2], LANE_HALF)) score += 1;
      // You're a marble too, and a tasty one (more so once the marbles run low).
      if (alive && this.inLane(h, player.pos[0], player.pos[2], CATCH_HALF)) score += 1.5 + (this.marbles.length < 10 ? 3 : 0);
      score += Math.random() * 0.8;
      if (score > bestScore) {
        bestScore = score;
        best = h.aim;
      }
      h.aim = saved;
    }
    return best;
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
          ['Hint', "When a hippo's lane lights up, get out of it, sideways. The floor slopes down toward them, so keep moving. Kick or throw marbles into their lanes to end the game sooner."],
          ['Controls', 'WASD move · Shift sprint · Space jump · Hold click carry · Right-click throw'],
        ]);
      }
    }
    this.arrival.update(dt);
    this.exit.update(dt, player);
    if (this.exit.entered && this.status === 'playing') this.status = 'exited';
    const alive = player.mode === 'control' && !this.death && !player.inPortal;

    // The slope carries you toward the edge (harder the further out you are).
    if (alive && player.onGround) {
      const r = Math.hypot(player.pos[0], player.pos[2]);
      const k = r > 0.1 ? (DRIFT * Math.min(1, r / CHAMBER_HALF)) / r : 0;
      player.platformVel = [player.pos[0] * k, 0, player.pos[2] * k];
    } else player.platformVel = [0, 0, 0];

    if (this.arrival.done && this.t < 0) this.t = 0;
    if (this.t < 0) return;
    this.t += dt;
    const t = this.t;

    // The marbles pour in.
    const total = MARBLES + (t > SECOND_POUR_AT ? SECOND_POUR : 0);
    if (t > SECOND_POUR_AT && t - dt <= SECOND_POUR_AT && this.over < 0) this.banner.text = 'MORE MARBLES!';
    if (t > SECOND_POUR_AT + 2.5 && this.banner.text === 'MORE MARBLES!') this.banner.text = '';
    while (this.poured < total && t > (this.poured < MARBLES ? 0.8 + this.poured * 0.07 : SECOND_POUR_AT + (this.poured - MARBLES) * 0.08)) {
      const a = Math.random() * Math.PI * 2, r = 2 + Math.random() * 7;
      const m = physics.addBall([Math.cos(a) * r, 11 + Math.random() * 4, Math.sin(a) * r], MARBLE_R, { mass: 25, color: [0.96, 0.96, 0.98], restitution: 0.4, friction: 0.25 });
      this.marbles.push(m);
      this.poured++;
      if (this.poured % 3 === 0) tone(1800 + Math.random() * 900, 0.05, { wave: 'triangle', vol: 0.08, at: 0.5 });
    }
    const playing = t > 3.2 && this.over < 0;
    if (playing && this.status === 'playing') this.music.start();
    else this.music.stop();
    if (playing && ((t > SECOND_POUR_AT + 2 && this.marbles.length === 0) || t > GAME_TIME)) this.gameOver();

    for (const h of this.hippos) this.updateHippo(h, dt, playing, alive);

    // Marbles that somehow leave (thrown over a wall) are out of the game.
    for (let i = this.marbles.length - 1; i >= 0; i--) {
      const p = this.marbles[i].rb.translation();
      if (Math.abs(p.x) > CHAMBER_HALF + 1 || Math.abs(p.z) > CHAMBER_HALF + 1 || p.y < -5) {
        physics.remove(this.marbles[i]);
        this.marbles.splice(i, 1);
      }
    }

    // The end: everyone's full, and the yellow one (east) yawns wide. The exit's in there.
    if (this.over >= 0) {
      const since = t - this.over;
      if (since > 2 && !this.exit.open) {
        this.exit.openNow();
        tone(note('C4'), 1.2, { to: note('G3'), wave: 'sawtooth', vol: 0.12 });
      }
    }
  }

  private updateHippo(h: Hippo, dt: number, playing: boolean, alive: boolean) {
    h.t += dt;
    const east = h.name === 'YELLOW';
    switch (h.state) {
      case 'rest': {
        h.reach += (0 - h.reach) * Math.min(1, dt * 6);
        h.jaw = 0.12 + 0.06 * Math.sin(this.t * 2 + h.base[0]);
        h.aim += (0 - h.aim) * Math.min(1, dt * 2);
        if (!playing) break;
        h.rest -= dt;
        if (h.rest <= 0) {
          const aim = this.chooseAim(h);
          if (aim === null) h.rest = 0.4;
          else {
            h.aim = aim;
            h.state = 'wind';
            h.t = 0;
            // Somebody slams the lever on its back.
            noise(0.08, { freq: 900, to: 400, vol: 0.3 });
            tone(140, 0.1, { wave: 'square', vol: 0.12 });
          }
        }
        break;
      }
      case 'wind':
        h.reach += (-0.06 - h.reach) * Math.min(1, dt * 8);
        h.jaw += (1 - h.jaw) * Math.min(1, dt * 7);
        if (h.t >= WIND) {
          h.state = 'snap';
          h.t = 0;
          noise(0.25, { freq: 400, to: 1800, type: 'bandpass', q: 1.5, vol: 0.3 });
        }
        break;
      case 'snap':
        h.reach = clamp(h.t / SNAP, 0, 1);
        if (h.t >= SNAP) {
          h.state = 'hold';
          h.t = 0;
          h.jaw = 0;
          this.chomp(h, alive);
        }
        break;
      case 'hold':
        if (h.t >= HOLD) {
          h.state = 'back';
          h.t = 0;
        }
        break;
      case 'back':
        h.reach = 1 - clamp(h.t / BACK, 0, 1);
        if (h.t >= BACK) {
          h.state = this.over >= 0 ? 'full' : 'rest';
          h.t = 0;
          h.rest = rand(REST[0], REST[1]) * (this.marbles.length < 8 ? 0.7 : 1);
        }
        break;
      case 'full': {
        h.reach += (0 - h.reach) * Math.min(1, dt * 4);
        h.aim += (0 - h.aim) * Math.min(1, dt * 2);
        const since = this.t - this.over;
        h.pose.sleepy = east ? 0 : clamp(since - 0.5, 0, 1);
        // The east one opens up (a big yawn) and stays open: that's the exit.
        h.jaw = east ? clamp((since - 1.2) / 0.8, 0, 1) : 0;
        break;
      }
    }
    // Chewing on you.
    if (h.chewing >= 0) {
      h.chewing += dt;
      h.jaw = 0.25 * Math.max(0, Math.sin(h.chewing * 9));
      if (h.chewing > 1.3 && h.chewing - dt <= 1.3) tone(90, 0.6, { to: 60, wave: 'sawtooth', vol: 0.2 }); // a burp
    }
    // Pose: the head out along the aim, riding over the dome.
    const d = this.dirOf(h);
    const len = NECK_REST + NECK_REACH * h.reach;
    let hx = h.base[0] + d[0] * len, hz = h.base[2] + d[2] * len;
    let hy = domeY(hx, hz) + 0.95;
    if (h.state === 'full' && h.name === 'YELLOW') {
      // Back into the wall, mouth round the exit portal.
      hx = h.base[0] + h.out[0] * -2.0;
      hz = h.base[2];
      hy = this.exit.centre[1] - 0.2;
      h.pose.hollow = true;
    }
    h.pose.head = [hx, hy, hz];
    h.pose.yaw = Math.atan2(d[0], d[2]);
    h.pose.jaw = h.jaw;
  }

  /** The mouth snaps shut: everything in the lane is eaten. */
  private chomp(h: Hippo, alive: boolean) {
    const { player, physics, camera } = this.ctx;
    noise(0.18, { freq: 1200, to: 200, vol: 0.5 });
    tone(110, 0.2, { to: 60, wave: 'square', vol: 0.2 });
    let ate = 0;
    for (let i = this.marbles.length - 1; i >= 0; i--) {
      const p = this.marbles[i].rb.translation();
      if (!this.inLane(h, p.x, p.z, LANE_HALF)) continue;
      physics.remove(this.marbles[i]);
      this.marbles.splice(i, 1);
      ate++;
    }
    if (ate) {
      h.eaten += ate;
      h.label.text = `${h.name} ${h.eaten}`;
      for (let k = 0; k < Math.min(ate, 5); k++) tone(300 - k * 30, 0.1, { to: 120, wave: 'sine', vol: 0.2, at: 0.12 + k * 0.1 });
    }
    const d = Math.hypot(player.pos[0] - h.pose.head[0], player.pos[2] - h.pose.head[2]);
    camera.addShake(Math.max(0.05, 0.4 - d * 0.03));
    if (alive && this.inLane(h, player.pos[0], player.pos[2], CATCH_HALF)) {
      player.hide();
      h.chewing = 0;
      this.death = {
        t: 0,
        big: 'CHOMPED',
        small: pick(['You were the marble all along.', 'Hungry hungry hippo. Slightly less hungry now.', 'Swallowed whole. It says you taste like test chamber.', 'Nom.']),
      };
    }
  }

  private gameOver() {
    this.over = this.t;
    const winner = this.hippos.reduce((a, b) => (b.eaten > a.eaten ? b : a));
    this.banner.text = `GAME OVER! ${winner.name} WINS!`;
    this.banner.color = winner.css;
    for (const h of this.hippos) if (h.state === 'rest' || h.state === 'wind') h.state = 'full';
    sfx.win();
    this.ctx.hud.show(`${winner.name} WINS`, 'The marbles are all gone. You, somehow, are not.', 3);
  }

  draw(out: DrawItem[], time: number) {
    this.arrival.draw(out);
    this.exit.draw(out);
    // The dome: shiny toy plastic.
    out.push({ mesh: 'sphere', model: mul(translation([0, DOME_Y, 0]), scaling([DOME_R, DOME_R, DOME_R])), color: [0.38, 0.62, 0.95], spec: 0.5 });
    for (const h of this.hippos) {
      // The hole in the wall it pokes out of.
      // (Just behind where an exit portal would be drawn, so the east one can show through.)
      const hole: Vec3 = [h.base[0] + h.out[0] * -0.095, 2.35, h.base[2] + h.out[2] * -0.095];
      const yaw = Math.atan2(h.out[0], h.out[2]);
      out.push({ mesh: 'box', model: mul(translation(hole), rotationY(yaw), scaling([5.2, 4.3, 0.01])), color: [0.02, 0.02, 0.03], shadow: false });
      // Its lane, lit up while it winds up (brighter as it comes).
      if (h.state === 'wind' || h.state === 'snap') {
        const k = h.state === 'snap' ? 1 : h.t / WIND;
        const d = this.dirOf(h);
        const glow = (0.45 + 0.55 * k) * (0.75 + 0.25 * Math.sin(time * 30));
        for (let s = 0; s < 7; s++) {
          const along = 1 + s * 2;
          const x = h.base[0] + d[0] * along, z = h.base[2] + d[2] * along;
          out.push({
            mesh: 'box',
            model: mul(translation([x, domeY(x, z) + 0.06, z]), rotationY(Math.atan2(d[0], d[2])), scaling([LANE_HALF * 2, 0.04, 1.9])),
            color: [h.color[0] * 2.2 * glow, h.color[1] * 2.2 * glow, h.color[2] * 2.2 * glow],
            pattern: Pattern.emissive,
            opacity: 0.6,
            shadow: false,
          });
        }
      }
      drawHippo(out, h.pose, h.color);
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
    // Swallowed: watch the hippo chew.
    const h = this.hippos.find((o) => o.chewing >= 0);
    if (h) {
      const p = h.pose.head;
      return { pos: [p[0] * 0.3, p[1] + 5, p[2] * 0.3], target: p, sharpness: 3 };
    }
    return null;
  }
}
