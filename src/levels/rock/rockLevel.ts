import { noise, note, sfx, tone } from '../../engine/audio';
import { clamp, mul, rotationX, rotationZ, scaling, translation, type Vec3 } from '../../engine/math';
import { Pattern, type DrawItem } from '../../engine/renderer';
import { drawBody, poseFrames, standingRoot, type BodyColors, type Pose } from '../../game/body';
import { CHAMBER_HALF } from '../../game/chamber';
import { drawTrapdoor } from '../../entities/trapdoor';
import { ExitPortal, PortalArrival } from '../../entities/portal';
import { DEFAULT_ENV, type CameraShot, type Level, type LevelContext, type LevelStatus, type TrackedTarget, type WorldLabel } from '../level';

/*
 * Rock Star (a Guitar Hero parody). The floor turns into a five-lane note highway and coloured gems
 * come sliding down it toward the strike line in front of you: be standing in a gem's lane as it
 * crosses the line and the note plays (miss it and it doesn't, and the crowd notices). Two gems at
 * once is a chord: stand on the line between their lanes. The rock meter on the wall goes down with
 * every miss; empty it and you're booed off (tomatoes, then the stage throws you out). Get to the end
 * of the song and the crowd wants an encore; the exit will have to do.
 */

const LANES = 5;
const LANE_W = 3.6;
const laneX = (l: number) => (l - (LANES - 1) / 2) * LANE_W;
const laneOf = (x: number) => clamp(Math.round(x / LANE_W + (LANES - 1) / 2), 0, LANES - 1);
/** Where gems start, where they cross the strike line, and how fast they come (m/s). */
const START_Z = -10.5;
const STRIKE_Z = 5.2;
const GEM_SPEED = 8;
const TRAVEL = (STRIKE_Z - START_Z) / GEM_SPEED;
/** Beat length (s, 120 bpm), and a count-in before the first gem crosses. */
const BEAT = 0.5;
const LEAD_IN = 4;
/** A chord counts if you're this close (m) to the line between its two lanes. */
const CHORD_REACH = 1.0;
const DEATH_SCREEN_DELAY = 2.2;

const LANE_COLORS = [[0.2, 0.9, 0.25], [0.95, 0.15, 0.15], [1.0, 0.85, 0.1], [0.2, 0.45, 1.0], [1.0, 0.5, 0.1]];
/** The lead line: each lane's note. */
const LANE_NOTES = ['E4', 'G4', 'A4', 'B4', 'D5'];

/** [beat, lanes, sustain (beats)] */
type ChartNote = [number, number[], number?];
const CHART: ChartNote[] = [
  // Warming up: one lane at a time.
  [0, [2]], [1, [2]], [2, [2]], [4, [1]], [5, [1]], [6, [1]], [8, [2]], [9, [2]], [10, [2]], [12, [3]], [13, [3]], [14, [3], 2],
  // Getting about.
  [16, [2]], [17, [2]], [18, [3], 2], [20, [4]], [21, [4]], [22, [3]], [24, [2]], [25, [1]], [26, [0], 2], [28, [1]], [29, [2]], [30, [2]],
  // Chords.
  [32, [1, 2]], [34, [1, 2]], [36, [2, 3]], [38, [2, 3]], [40, [3, 4]], [41, [3, 4]], [42, [2, 3]], [44, [1, 2]], [46, [0, 1], 2],
  // The solo: all the way across and back.
  [48, [0]], [49, [1]], [50, [2]], [51, [3]], [52, [4]], [54, [4]], [55, [3]], [56, [2]], [57, [1]], [58, [0]],
  // The big finish.
  [60, [2], 4],
];
const SONG_END = 66;

const CROWD_COLORS: BodyColors[] = [
  { suit: [0.1, 0.1, 0.12], pants: [0.15, 0.2, 0.4], skin: [0.85, 0.64, 0.5], hair: [0.1, 0.06, 0.04], pack: [0.1, 0.1, 0.1], boot: [0.05, 0.05, 0.05] },
  { suit: [0.6, 0.1, 0.15], pants: [0.1, 0.1, 0.12], skin: [0.55, 0.38, 0.28], hair: [0.05, 0.04, 0.03], pack: [0.1, 0.1, 0.1], boot: [0.05, 0.05, 0.05] },
  { suit: [0.2, 0.2, 0.22], pants: [0.2, 0.25, 0.45], skin: [0.95, 0.78, 0.66], hair: [0.8, 0.6, 0.2], pack: [0.1, 0.1, 0.1], boot: [0.05, 0.05, 0.05] },
];

interface Gem {
  beat: number;
  lanes: number[];
  sustain: number;
  /** null until it reaches the line; then hit or missed. */
  result: 'hit' | 'miss' | null;
}

interface Fan {
  pos: Vec3;
  facing: number;
  colors: BodyColors;
  phase: number;
  label: WorldLabel;
}

interface Death {
  t: number;
  big: string;
  small: string;
}

const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

export class RockLevel implements Level {
  readonly number: number;
  readonly title = 'Rock Star';
  status: LevelStatus = 'playing';
  private arrival: PortalArrival;
  private exit = new ExitPortal(8.5);
  private gems: Gem[] = CHART.map(([beat, lanes, sustain]) => ({ beat, lanes, sustain: sustain ?? 0, result: null }));
  /** Song time (s; negative during the count-in; NaN until the arrival's done). */
  private songT = NaN;
  private lastBeat = -99;
  private meter = 0.6;
  private streak = 0;
  private hits = 0;
  private over = false;
  private failed = -1;
  private death: Death | null = null;
  private fans: Fan[] = [];
  private tomatoes: { pos: Vec3; vel: Vec3; age: number; splat: number }[] = [];
  private trapdoor: { pos: Vec3; t: number } | null = null;
  private meterLabel: WorldLabel = { pos: [0, 8.9, -CHAMBER_HALF + 0.3], text: 'ROCK METER', size: 0.5, color: '#ffffff' };
  private streakLabel: WorldLabel = { pos: [0, 5.6, -CHAMBER_HALF + 0.3], text: '', size: 0.7, color: '#ffd166' };
  private labelList: WorldLabel[] = [this.meterLabel, this.streakLabel];

  constructor(private ctx: LevelContext) {
    this.number = ctx.number;
    const { hud } = ctx;
    hud.setLevel(`The Chamber · Level ${this.number}`);
    hud.show(`LEVEL ${this.number}`, '', 2.5);
    hud.hint('');
    this.arrival = new PortalArrival(ctx, [0, 0, 7.5], { minElevationDeg: 75 });
    // The crowd, down both sides of the highway.
    for (let i = 0; i < 14; i++) {
      const side = i % 2 ? 1 : -1;
      const z = -9 + Math.floor(i / 2) * 2.4;
      const pos: Vec3 = [side * (10.2 + (i % 3) * 0.5), 0, z];
      const label: WorldLabel = { pos: [pos[0], 2.4, z], text: '', size: 0.4, color: '#ff8080' };
      this.fans.push({ pos, facing: side > 0 ? Math.PI / 2 : -Math.PI / 2, colors: CROWD_COLORS[i % CROWD_COLORS.length], phase: Math.random() * 6, label });
      this.labelList.push(label);
    }
  }

  /** Song time a gem crosses the strike line. */
  private crossAt(g: Gem) {
    return g.beat * BEAT;
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
          ['Hint', 'Stand in a gem’s lane as it crosses the line by your feet. Two gems at once is a chord: stand on the line between their lanes. Too many misses and the crowd turns on you.'],
          ['Controls', 'A / D move between lanes · Shift sprint'],
        ]);
      }
    }
    this.arrival.update(dt);
    this.exit.update(dt, player);
    if (this.exit.entered && this.status === 'playing') this.status = 'exited';
    if (this.trapdoor) this.trapdoor.t += dt;
    const alive = player.mode === 'control' && !this.death && !player.inPortal;

    if (this.arrival.done && Number.isNaN(this.songT)) this.songT = -LEAD_IN;
    if (!Number.isNaN(this.songT) && !this.over) {
      this.songT += dt;
      // Facing down the highway: A / D always move across the lanes.
      camera.yaw = 0;
      this.playBeat();
      if (alive && this.failed < 0) this.judge();
      if (this.songT > SONG_END * BEAT && this.failed < 0 && alive) this.finish();
    }
    this.updateCrowd(dt);
    if (this.failed >= 0) this.updateFail(dt);
  }

  /** The drums and bass, on the beat (in song time, so they keep in step with the gems). */
  private playBeat() {
    const b = Math.floor(this.songT / (BEAT / 2));
    if (b === this.lastBeat) return;
    this.lastBeat = b;
    if (this.failed >= 0) return;
    const half = ((b % 8) + 8) % 8;
    if (this.songT < 0) {
      // Count-in: sticks.
      if (half % 2 === 0) tone(2200, 0.04, { wave: 'square', vol: 0.1 });
      return;
    }
    if (half % 4 === 0) tone(90, 0.18, { to: 45, wave: 'sine', vol: 0.35 }); // kick
    if (half % 4 === 2) noise(0.14, { freq: 1800, to: 900, type: 'bandpass', q: 0.8, vol: 0.3 }); // snare
    noise(0.03, { freq: 7000, type: 'highpass', vol: 0.06 }); // hat
    if (half % 2 === 0) tone(note(half < 4 ? 'E2' : 'G2'), BEAT * 0.9, { wave: 'sawtooth', vol: 0.08 });
  }

  /** Gems crossing the line: are you in their lane? */
  private judge() {
    const { player } = this.ctx;
    const x = player.pos[0];
    for (const g of this.gems) {
      if (g.result || this.songT < this.crossAt(g)) continue;
      let hit: boolean;
      if (g.lanes.length === 1) hit = laneOf(x) === g.lanes[0];
      else hit = Math.abs(x - (laneX(g.lanes[0]) + laneX(g.lanes[1])) / 2) < CHORD_REACH;
      g.result = hit ? 'hit' : 'miss';
      if (hit) {
        this.hits++;
        this.streak++;
        this.meter = Math.min(1, this.meter + 0.05);
        const len = Math.max(0.3, g.sustain * BEAT);
        for (const l of g.lanes) {
          tone(note(LANE_NOTES[l]), len, { wave: 'sawtooth', vol: 0.09 });
          tone(note(LANE_NOTES[l]) * 1.005, len, { wave: 'square', vol: 0.05 });
        }
        if (this.streak % 10 === 0) this.streakLabel.text = `${this.streak} NOTE STREAK!`;
      } else {
        this.streak = 0;
        this.streakLabel.text = '';
        this.meter -= 0.13;
        // The Guitar Hero clunk.
        noise(0.2, { freq: 600, to: 200, type: 'bandpass', q: 3, vol: 0.4 });
        tone(110, 0.2, { to: 98, wave: 'sawtooth', vol: 0.12 });
        if (this.meter <= 0) this.fail();
      }
    }
    this.meterLabel.text = this.meter > 0.66 ? 'ROCK METER: ROCKING' : this.meter > 0.33 ? 'ROCK METER' : 'ROCK METER: UH OH';
  }

  private finish() {
    this.over = true;
    this.exit.openNow();
    this.streakLabel.text = 'ENCORE! ENCORE!';
    this.ctx.hud.show('YOU ROCK!', `${this.hits} of ${this.gems.length} notes. The crowd demands an encore. Use the exit.`, 3.5);
    sfx.win();
  }

  private fail() {
    if (this.failed >= 0) return;
    this.failed = 0;
    this.streakLabel.text = 'BOOOOO!';
    this.ctx.hud.show('YOU FAILED', '', 1.5);
  }

  /** Booed off: a hail of tomatoes, then the stage throws you out. */
  private updateFail(dt: number) {
    const { player, camera } = this.ctx;
    const before = this.failed;
    this.failed += dt;
    if (before < 1.4 && Math.random() < dt * 14) {
      const f = pick(this.fans);
      const to: Vec3 = [player.pos[0] + (Math.random() - 0.5) * 2, 1 + Math.random(), player.pos[2] + (Math.random() - 0.5) * 2];
      const from: Vec3 = [f.pos[0], 2, f.pos[2]];
      const time = 0.7;
      this.tomatoes.push({ pos: from, vel: [(to[0] - from[0]) / time, (to[1] - from[1]) / time + 10 * time / 2, (to[2] - from[2]) / time], age: 0, splat: -1 });
    }
    if (before < 1.6 && this.failed >= 1.6 && player.mode === 'control' && !this.death) {
      this.trapdoor = { pos: [player.pos[0], 0, player.pos[2]], t: 0 };
      const yaw = Math.random() * Math.PI * 2;
      player.kill([Math.sin(yaw) * 4, 22, Math.cos(yaw) * 4], { violence: 12 });
      camera.addShake(0.6);
      this.death = {
        t: 0,
        big: 'BOOED OFF',
        small: pick(['The crowd wanted Free Bird. You gave them that.', 'Rock and roll will never die. You, on the other hand...', 'Music critics describe the performance as "brief".', 'You were more of a groupie, really.']),
      };
    }
  }

  private updateCrowd(dt: number) {
    const mood = this.failed >= 0 ? 0 : this.meter;
    for (const f of this.fans) {
      f.phase += dt * (mood > 0.66 ? 9 : 5);
      f.label.text = mood < 0.3 && Math.sin(f.phase * 0.3) > 0.6 ? 'BOO!' : this.over && Math.sin(f.phase * 0.4) > 0.7 ? 'ENCORE!' : '';
    }
    for (const t of this.tomatoes) {
      t.age += dt;
      if (t.splat >= 0) {
        t.splat += dt;
        continue;
      }
      t.vel[1] -= 10 * dt;
      t.pos = [t.pos[0] + t.vel[0] * dt, t.pos[1] + t.vel[1] * dt, t.pos[2] + t.vel[2] * dt];
      if (t.age > 0.7 || t.pos[1] < 0.1) {
        t.splat = 0;
        noise(0.08, { freq: 900, to: 200, vol: 0.2 });
      }
    }
    if (this.tomatoes.length > 60) this.tomatoes.splice(0, this.tomatoes.length - 60);
  }

  draw(out: DrawItem[]) {
    this.arrival.draw(out);
    this.exit.draw(out);
    const started = !Number.isNaN(this.songT);
    // The highway: dark, with lane dividers, frets sliding toward you, and the strike line.
    const len = STRIKE_Z - START_Z + 3;
    const midZ = (START_Z + STRIKE_Z + 3) / 2;
    out.push({ mesh: 'box', model: mul(translation([0, 0.02, midZ]), scaling([LANES * LANE_W + 0.4, 0.04, len])), color: [0.03, 0.03, 0.05], spec: 0.8 });
    for (let l = 0; l <= LANES; l++) {
      const x = (l - LANES / 2) * LANE_W;
      out.push({ mesh: 'box', model: mul(translation([x, 0.045, midZ]), scaling([0.08, 0.01, len])), color: [0.5, 0.5, 0.55], shadow: false });
    }
    if (started) {
      const offset = (((this.songT * GEM_SPEED) % (GEM_SPEED * BEAT)) + GEM_SPEED * BEAT) % (GEM_SPEED * BEAT);
      for (let z = START_Z + offset; z < STRIKE_Z + 3; z += GEM_SPEED * BEAT) {
        out.push({ mesh: 'box', model: mul(translation([0, 0.045, z]), scaling([LANES * LANE_W, 0.01, 0.06])), color: [0.35, 0.35, 0.4], shadow: false });
      }
    }
    for (let l = 0; l < LANES; l++) {
      const c = LANE_COLORS[l];
      const under = this.ctx.player.mode === 'control' && laneOf(this.ctx.player.pos[0]) === l;
      const k = under ? 1.6 : 0.7;
      out.push({ mesh: 'cylinder', model: mul(translation([laneX(l), 0.06, STRIKE_Z]), scaling([1.1, 0.04, 1.1])), color: [c[0] * k, c[1] * k, c[2] * k], pattern: Pattern.emissive, shadow: false });
      out.push({ mesh: 'cylinder', model: mul(translation([laneX(l), 0.07, STRIKE_Z]), scaling([0.8, 0.04, 0.8])), color: [0.05, 0.05, 0.06], shadow: false });
    }
    // The gems (and their sustain tails).
    if (started) {
      for (const g of this.gems) {
        const z = STRIKE_Z - (this.crossAt(g) - this.songT) * GEM_SPEED;
        if (z < START_Z - 0.5 || z > STRIKE_Z + 2.5) continue;
        if (g.result === 'hit' && z > STRIKE_Z + 0.3 && g.sustain === 0) continue;
        for (const l of g.lanes) {
          const c = LANE_COLORS[l];
          const dim = g.result === 'miss' ? 0.35 : 1;
          if (g.sustain > 0) {
            const tail = g.sustain * BEAT * GEM_SPEED;
            const z0 = Math.min(z, STRIKE_Z), z1 = z - tail;
            if (z0 > z1) out.push({ mesh: 'box', model: mul(translation([laneX(l), 0.08, (z0 + z1) / 2]), scaling([0.3, 0.05, z0 - z1])), color: [c[0] * 1.4 * dim, c[1] * 1.4 * dim, c[2] * 1.4 * dim], pattern: Pattern.emissive, shadow: false });
          }
          if (g.result === 'hit' && z > STRIKE_Z + 0.3) continue;
          out.push({ mesh: 'cylinder', model: mul(translation([laneX(l), 0.2, z]), scaling([0.95, 0.22, 0.95])), color: [c[0] * dim, c[1] * dim, c[2] * dim], spec: 1 });
          out.push({ mesh: 'cylinder', model: mul(translation([laneX(l), 0.33, z]), scaling([0.55, 0.06, 0.55])), color: [0.95 * dim, 0.95 * dim, 0.95 * dim], spec: 1 });
        }
      }
    }
    // The rock meter on the wall: red, yellow, green, and a needle.
    const wz = -CHAMBER_HALF + 0.2;
    const segs: [number, number[]][] = [[-2.5, [1.6, 0.2, 0.15]], [0, [1.6, 1.3, 0.2]], [2.5, [0.3, 1.5, 0.3]]];
    for (const [x, c] of segs) out.push({ mesh: 'box', model: mul(translation([x, 7.8, wz]), scaling([2.4, 0.9, 0.1])), color: c, pattern: Pattern.emissive, shadow: false });
    const nx = -3.7 + 7.4 * clamp(this.meter, 0, 1);
    out.push({ mesh: 'box', model: mul(translation([nx, 7.8, wz + 0.1]), scaling([0.18, 1.4, 0.1])), color: [0.95, 0.95, 0.95], shadow: false });
    // The crowd.
    const mood = this.failed >= 0 ? 0 : this.meter;
    for (const f of this.fans) {
      const s = Math.sin(f.phase), bounce = mood > 0.66 ? Math.abs(s) * 0.35 : mood > 0.33 ? Math.abs(s) * 0.1 : 0;
      const arms = mood > 0.66 ? 2.6 + s * 0.3 : mood > 0.33 ? 0.4 + s * 0.3 : -0.2;
      const pose: Pose = {
        lean: mood < 0.33 ? 0.1 : -0.05, headPitch: mood > 0.66 ? -0.3 : 0.1, shoulderL: arms, shoulderR: mood < 0.33 ? -0.2 : arms, armOut: 0.3,
        elbowL: mood < 0.33 ? 1.8 : 0.2, elbowR: mood < 0.33 ? 1.8 : 0.2, hipL: 0, hipR: 0, kneeL: -0.2 - bounce, kneeR: -0.2 - bounce,
      };
      drawBody(out, poseFrames(standingRoot([f.pos[0], f.pos[1] + bounce * 0.5, f.pos[2]], f.facing), pose), 1, f.colors);
    }
    // Tomatoes.
    for (const t of this.tomatoes) {
      if (t.splat >= 0) out.push({ mesh: 'sphere', model: mul(translation(t.pos), scaling([0.3, 0.06, 0.3])), color: [0.8, 0.08, 0.05], shadow: false });
      else out.push({ mesh: 'sphere', model: mul(translation(t.pos), scaling([0.16, 0.15, 0.16])), color: [0.85, 0.1, 0.05], spec: 0.8 });
    }
    if (this.trapdoor) drawTrapdoor(out, this.trapdoor.pos, 0.3, this.trapdoor.t);
    // Your guitar, slung across your chest.
    const { player } = this.ctx;
    if (player.mode === 'control' && started) {
      const chest = player.partFrames().chest;
      const g = mul(chest, translation([0.05, -0.2, -0.22]), rotationZ(0.9));
      out.push({ mesh: 'sphere', model: mul(g, translation([0, -0.12, 0]), scaling([0.24, 0.3, 0.07])), color: [0.8, 0.08, 0.1], spec: 1 });
      out.push({ mesh: 'box', model: mul(g, translation([0, 0.4, 0]), scaling([0.06, 0.7, 0.04])), color: [0.35, 0.2, 0.08] });
      out.push({ mesh: 'box', model: mul(g, translation([0, 0.8, 0]), rotationX(0.2), scaling([0.1, 0.14, 0.04])), color: [0.1, 0.1, 0.1] });
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
    // Down the highway from behind you, like the game (until it's over).
    if (!Number.isNaN(this.songT) && !this.over && !this.death) {
      const x = this.ctx.player.pos[0] * 0.6;
      return { pos: [x, 5.2, CHAMBER_HALF - 0.8], target: [x * 0.8, 0, -2], sharpness: 5 };
    }
    return null;
  }
}
