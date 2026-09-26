import { add, mul, rotationY, scaling, translation, type Mat4, type Vec3 } from '../../engine/math';
import { Pattern, type DrawItem, type Environment } from '../../engine/renderer';
import { CHAMBER_HALF } from '../../game/chamber';
import { Contestant, type ContestantLook } from '../../entities/contestant';
import { ExitPortal, PortalArrival } from '../../entities/portal';
import { drawTrapdoor } from '../../entities/trapdoor';
import { DEFAULT_ENV, type CameraShot, type Level, type LevelContext, type LevelStatus, type TrackedTarget, type WorldLabel } from '../level';

/*
 * Musical Chairs. A disco, a ring of folding chairs, four other test subjects, and a jukebox.
 * While the music plays (lights, notes, a spinning mirror ball) everyone walks round the
 * chairs, and so must you: loiter and the floor flings you out for camping. When the music
 * stops, everyone dives for a chair; whoever's left standing goes out through a trapdoor. One
 * chair fewer each round, until there's one chair and one winner.
 */

const CHAIR_R = 2.3;
/** Everyone circles at about this radius while the music plays; you must stay in the band. */
const WALK_R = 4.6;
const BAND: [number, number] = [3.0, 7.8];
const CIRCLE_SPEED = 0.55; // rad/s
/** You claim a free chair by getting this close to its seat. */
const CLAIM = 0.75;
const MUSIC: number[] = [9, 7.5, 7, 6.5];
/** Loitering (not going round) this long gets a shout; this long in all gets you flung. */
const LOITER_WARN = 1.0;
const LOITER_OUT = 3.2;
const DEATH_SCREEN_DELAY = 1.8;
const EXIT_Z = 0;

interface Racer {
  c: Contestant;
  label: WorldLabel;
  /** Reaction time range (s) when the music stops, and running speed. */
  react: [number, number];
  speed: number;
  angle: number;
  delay: number;
  target: Chair | null;
  seat: Chair | null;
  out: boolean;
}

interface Chair {
  angle: number;
  /** Where it's sliding to (chairs re-space after one is taken away). */
  goal: number;
  /** 0 = standing, 1 = sunk into the floor. */
  sink: number;
  removed: boolean;
  by: Racer | 'player' | null;
}

type Phase = 'intro' | 'music' | 'scramble' | 'out' | 'reset' | 'won';

interface Death {
  t: number;
  big: string;
  small: string;
}

const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
const rand = (a: number, b: number) => a + Math.random() * (b - a);

const CAST: { look: ContestantLook; react: [number, number]; speed: number }[] = [
  { look: { number: '067', hair: [0.1, 0.07, 0.05] }, react: [0.25, 0.45], speed: 5.6 },
  { look: { number: '218', hair: [0.35, 0.2, 0.1] }, react: [0.3, 0.65], speed: 5.4 },
  { look: { number: '324', hair: [0.8, 0.65, 0.3], girth: 1.3 }, react: [0.45, 1.1], speed: 4.6 },
  { look: { number: '101', hair: [0.05, 0.05, 0.05] }, react: [0.3, 0.8], speed: 5.8 },
];

export class ChairsLevel implements Level {
  readonly number: number;
  readonly title = 'Musical Chairs';
  status: LevelStatus = 'playing';
  private arrival: PortalArrival;
  private exit = new ExitPortal(EXIT_Z);
  private racers: Racer[] = [];
  private chairs: Chair[] = [];
  private phase: Phase = 'intro';
  private phaseT = 0;
  private round = 0;
  private musicFor = 0;
  private time = 0;
  private death: Death | null = null;
  private playerSeat: Chair | null = null;
  private loiter = 0;
  private lastAngle = 0;
  private trapdoors: { pos: Vec3; yaw: number; t: number }[] = [];
  private notes: (WorldLabel & { ttl: number; vx: number })[] = [];
  private shout: WorldLabel = { pos: [0, 5.2, -CHAMBER_HALF + 1.2], text: '', size: 0.8, color: '#ff5c8a' };
  private labelList: WorldLabel[] = [];
  private env: Environment = { ...DEFAULT_ENV, sunColor: [0.55, 0.45, 0.65], skyColor: [0.1, 0.05, 0.16], fogColor: [0.12, 0.07, 0.16], pointLight: { pos: [0, 7, 0], color: [0, 0, 0], range: 20 } };

  constructor(private ctx: LevelContext) {
    this.number = ctx.number;
    const { hud } = ctx;
    hud.setLevel(`The Chamber · Level ${this.number}`);
    hud.show(`LEVEL ${this.number}`, '', 2.5);
    hud.hint('');
    this.arrival = new PortalArrival(ctx, [0, 0, 7]);
    for (let i = 0; i < CAST.length; i++) {
      const a = (i / CAST.length) * Math.PI * 2 + Math.PI / 4;
      const pos: Vec3 = [Math.cos(a) * WALK_R, 0, Math.sin(a) * WALK_R];
      const c = new Contestant(CAST[i].look, pos, Math.atan2(-Math.cos(a), -Math.sin(a)));
      const label: WorldLabel = { pos: [0, 0, 0], text: CAST[i].look.number, size: 0.3, color: '#ffffff' };
      this.racers.push({ c, label, react: CAST[i].react, speed: CAST[i].speed, angle: a, delay: 0, target: null, seat: null, out: false });
      this.labelList.push(label);
    }
    for (let i = 0; i < CAST.length; i++) {
      const a = (i / CAST.length) * Math.PI * 2;
      this.chairs.push({ angle: a, goal: a, sink: 0, removed: false, by: null });
    }
    this.labelList.push(this.shout);
  }

  private seatPos(ch: Chair): Vec3 {
    return [Math.cos(ch.angle) * CHAIR_R, 0, Math.sin(ch.angle) * CHAIR_R];
  }

  /** Facing out from the ring (the player's / contestants' facing convention). */
  private outward(angle: number) {
    return Math.atan2(-Math.cos(angle), -Math.sin(angle));
  }

  private liveChairs() {
    return this.chairs.filter((c) => !c.removed);
  }

  private setPhase(p: Phase) {
    this.phase = p;
    this.phaseT = 0;
  }

  private startMusic() {
    this.setPhase('music');
    this.musicFor = MUSIC[Math.min(this.round, MUSIC.length - 1)] + rand(-1.5, 1.5);
    this.loiter = 0;
    this.lastAngle = Math.atan2(this.ctx.player.pos[2], this.ctx.player.pos[0]);
  }

  update(dt: number) {
    const { player, hud } = this.ctx;
    const death = this.death;
    if (death && this.status === 'playing') {
      death.t += dt;
      if (death.t > DEATH_SCREEN_DELAY) {
        this.status = 'lost';
        hud.show(death.big, `${death.small}\nPress R to try again.`);
        hud.tips([
          ['Hint', 'Keep walking round the chairs while the music plays. When it stops (the lights go out), get to a free chair before the others do: just reach it.'],
          ['Controls', 'WASD move · Shift sprint'],
        ]);
      }
    }
    this.arrival.update(dt);
    this.exit.update(dt, player);
    if (this.exit.entered && this.status === 'playing') this.status = 'exited';
    this.time += dt;
    this.phaseT += dt;
    for (const d of this.trapdoors) d.t += dt;
    for (const ch of this.chairs) {
      ch.angle += (ch.goal - ch.angle) * (1 - Math.exp(-dt * 3));
      if (ch.removed) ch.sink = Math.min(1, ch.sink + dt);
    }
    for (const n of this.notes) {
      n.ttl -= dt;
      n.pos = add(n.pos, [n.vx * dt, dt * 1.4, 0]);
    }
    this.notes = this.notes.filter((n) => n.ttl > 0);

    const alive = player.mode === 'control' && !this.death;
    // Seated: stay put on the chair.
    if (this.playerSeat && alive) {
      const s = this.seatPos(this.playerSeat);
      player.pos = [s[0], 0, s[2]];
      player.vel = [0, 0, 0];
      player.facing = this.outward(this.playerSeat.angle);
      player.sitting = true;
    } else {
      player.sitting = false;
    }

    switch (this.phase) {
      case 'intro':
        if (this.arrival.done && this.phaseT > 1.5) this.startMusic();
        break;
      case 'music':
        this.updateMusic(dt);
        break;
      case 'scramble':
        this.updateScramble(dt);
        break;
      case 'out':
        if (this.phaseT > 2) {
          this.setPhase('reset');
          // Everyone gets up, one chair sinks away and the rest spread out again.
          for (const r of this.racers) {
            if (r.seat) r.c.action = 'none';
            r.seat = null;
            r.target = null;
          }
          this.playerSeat = null;
          const live = this.liveChairs();
          const gone = pick(live);
          gone.removed = true;
          const rest = live.filter((c) => c !== gone);
          const base = rest[0].angle;
          rest.forEach((c, i) => (c.goal = base + (i / rest.length) * Math.PI * 2));
          for (const c of this.chairs) c.by = null;
          this.round++;
        }
        break;
      case 'reset':
        if (this.phaseT > 2) this.startMusic();
        break;
      case 'won':
        if (this.phaseT > 1.5) this.playerSeat = null;
        break;
    }

    // The others: circling while the music plays, racing for chairs after, flung when out.
    for (const r of this.racers) {
      r.c.update(dt);
      r.label.pos = r.c.state === 'alive' ? [r.c.pos[0], 2.15, r.c.pos[2]] : [r.c.pos[0], 1.2, r.c.pos[2]];
      if (r.out) continue;
      if (r.seat) {
        const s = this.seatPos(r.seat);
        r.c.pos = [s[0], 0, s[2]];
        r.c.vel = [0, 0, 0];
        r.c.facing = this.outward(r.seat.angle);
        continue;
      }
      if (this.phase === 'music' || this.phase === 'reset' || this.phase === 'intro') {
        if (this.phase !== 'intro') r.angle += CIRCLE_SPEED * dt;
        const goal: Vec3 = [Math.cos(r.angle) * WALK_R, 0, Math.sin(r.angle) * WALK_R];
        const to: Vec3 = [goal[0] - r.c.pos[0], 0, goal[2] - r.c.pos[2]];
        const d = Math.hypot(to[0], to[2]);
        const v = Math.min(3.2, d * 3);
        r.c.vel = d > 0.02 ? [(to[0] / d) * v, 0, (to[2] / d) * v] : [0, 0, 0];
        if (this.phase === 'intro') r.c.vel = [0, 0, 0];
      }
    }
  }

  private updateMusic(dt: number) {
    const { player } = this.ctx;
    // Notes float up out of the jukebox.
    if (Math.random() < dt * 5) {
      this.notes.push({ pos: [rand(-1, 1), 3.2, -CHAMBER_HALF + 1.1], text: pick(['♪', '♫', '♬']), size: rand(0.5, 0.9), color: pick(['#ff7ad9', '#7af0ff', '#ffe066', '#9dff7a']), ttl: 2.2, vx: rand(-0.5, 0.5) });
    }
    // You have to keep going round, like everyone else.
    const alive = player.mode === 'control' && !this.death;
    if (alive && !(this.round === 0 && this.phaseT < 2.5)) {
      const a = Math.atan2(player.pos[2], player.pos[0]);
      const da = Math.atan2(Math.sin(a - this.lastAngle), Math.cos(a - this.lastAngle));
      this.lastAngle = a;
      const r = Math.hypot(player.pos[0], player.pos[2]);
      const going = Math.abs(da / Math.max(dt, 1e-4)) > 0.18 && r > BAND[0] && r < BAND[1];
      this.loiter = going ? Math.max(0, this.loiter - dt * 2) : this.loiter + dt;
      if (this.loiter <= LOITER_WARN) this.shout.text = '';
      else if (!this.shout.text) this.shout.text = pick(['KEEP WALKING!', 'NO CAMPING!', 'ROUND AND ROUND!']);
      if (this.loiter > LOITER_OUT) {
        this.shout.text = '';
        this.flingPlayer('NO CAMPING', pick([
          'Walk round the chairs while the music plays. Those are the rules. The rules have a trapdoor.',
          'Loitering near the chairs is frowned upon. Then catapulted.',
        ]));
        return;
      }
    } else {
      this.lastAngle = Math.atan2(player.pos[2], player.pos[0]);
    }
    if (this.phaseT >= this.musicFor) {
      // The music stops.
      this.setPhase('scramble');
      this.shout.text = 'SKRRRT!';
      for (const r of this.racers) if (!r.out) r.delay = rand(r.react[0], r.react[1]);
    }
  }

  private updateScramble(dt: number) {
    const { player } = this.ctx;
    if (this.phaseT > 0.8) this.shout.text = '';
    const free = () => this.liveChairs().filter((c) => !c.by);
    // The player grabs a chair just by getting to it.
    if (!this.playerSeat && player.mode === 'control' && !this.death) {
      for (const ch of free()) {
        const s = this.seatPos(ch);
        if (Math.hypot(player.pos[0] - s[0], player.pos[2] - s[2]) < CLAIM) {
          ch.by = 'player';
          this.playerSeat = ch;
          break;
        }
      }
    }
    for (const r of this.racers) {
      if (r.out || r.seat) continue;
      r.delay -= dt;
      if (r.delay > 0) {
        r.c.vel = [r.c.vel[0] * 0.9, 0, r.c.vel[2] * 0.9];
        continue;
      }
      if (!r.target || r.target.by) {
        let best: Chair | null = null, bestD = Infinity;
        for (const ch of free()) {
          const s = this.seatPos(ch);
          const d = Math.hypot(r.c.pos[0] - s[0], r.c.pos[2] - s[2]);
          if (d < bestD) { bestD = d; best = ch; }
        }
        r.target = best;
      }
      if (!r.target) {
        r.c.vel = [0, 0, 0];
        continue;
      }
      const s = this.seatPos(r.target);
      const to: Vec3 = [s[0] - r.c.pos[0], 0, s[2] - r.c.pos[2]];
      const d = Math.hypot(to[0], to[2]);
      if (d < 0.3) {
        r.target.by = r;
        r.seat = r.target;
        r.c.action = 'sit';
        r.c.actionT = 0;
        continue;
      }
      r.c.vel = [(to[0] / d) * r.speed, 0, (to[2] / d) * r.speed];
    }
    // All chairs taken: whoever's standing is out.
    if (free().length === 0 || this.phaseT > 6) {
      const standing = this.racers.filter((r) => !r.out && !r.seat);
      for (const r of standing) this.flingRacer(r);
      if (!this.playerSeat) {
        this.flingPlayer("YOU'RE OUT", pick([
          'Everybody else found a chair. You found a trapdoor.',
          'The music stopped. So did your career in competitive sitting.',
          'It is called musical CHAIRS. The chairs were the important part.',
        ]));
        return;
      }
      if (this.liveChairs().length === 1) {
        this.setPhase('won');
        this.exit.openNow();
        this.ctx.hud.show('CHAIRMAN OF THE BOARD', 'You win a chair. Please leave it here.', 3.5);
        return;
      }
      this.setPhase('out');
    }
  }

  private flingRacer(r: Racer) {
    r.out = true;
    r.label.text = 'OUT!';
    r.label.color = '#ff5c5c';
    this.trapdoors.push({ pos: [r.c.pos[0], 0, r.c.pos[2]], yaw: Math.random() * Math.PI * 2, t: 0 });
    const a = Math.random() * Math.PI * 2;
    r.c.kill([Math.cos(a), 0, Math.sin(a)], 3, 15, 1, 4);
  }

  private flingPlayer(big: string, small: string) {
    const { player, camera } = this.ctx;
    if (this.death || player.mode !== 'control') return;
    const yaw = Math.random() * Math.PI * 2;
    this.trapdoors.push({ pos: [player.pos[0], 0, player.pos[2]], yaw, t: 0 });
    player.kill([Math.sin(yaw) * 4, 22, Math.cos(yaw) * 4], { violence: 12 });
    camera.addShake(0.7);
    this.death = { t: 0, big, small };
    this.shout.text = '';
  }

  // --- Drawing ------------------------------------------------------------------------------------

  draw(out: DrawItem[]) {
    this.arrival.draw(out);
    this.exit.draw(out);
    const t = this.time;
    const party = this.phase === 'music' || this.phase === 'reset' || this.phase === 'won';

    // The dance floor: tiles light up in time while the music plays.
    const beat = 0.6 + 0.4 * Math.abs(Math.sin(t * Math.PI * 2));
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 6; j++) {
        const x = -5 + i * 2, z = -5 + j * 2;
        const on = party && ((i + j + Math.floor(t * 2)) % 3 === 0);
        const hue = (i * 0.17 + j * 0.23 + t * 0.2) % 1;
        const c = hsv(hue, 0.85, on ? 1.6 * beat : 0.18);
        out.push({ mesh: 'box', model: mul(translation([x, 0.005, z]), scaling([1.94, 0.012, 1.94])), color: c, pattern: on ? Pattern.emissive : Pattern.plain, spec: 0.8, shadow: false });
      }
    }

    // Chairs.
    for (const ch of this.chairs) {
      if (ch.sink >= 1) continue;
      const s = this.seatPos(ch);
      drawChair(out, mul(translation([s[0], -ch.sink * 1.2, s[2]]), rotationY(this.outward(ch.angle))));
    }
    for (const r of this.racers) r.c.draw(out);
    for (const d of this.trapdoors) drawTrapdoor(out, d.pos, d.yaw, d.t);

    // The jukebox against the north wall, and a mirror ball over the floor.
    this.drawJukebox(out, [0, 0, -CHAMBER_HALF + 0.6], party);
    const ball: Vec3 = [0, 7.2, 0];
    out.push({ mesh: 'cylinder', model: mul(translation([0, 9.2, 0]), scaling([0.02, 3.4, 0.02])), color: [0.2, 0.2, 0.2] });
    out.push({ mesh: 'sphere', model: mul(translation(ball), rotationY(t * 0.8), scaling([0.6, 0.6, 0.6])), color: [0.8, 0.82, 0.86], spec: 1 });
    for (let k = 0; k < 14; k++) {
      const a = k * 2.4 + t * 0.8, e = Math.sin(k * 1.7) * 0.9;
      const p: Vec3 = [ball[0] + Math.cos(a) * Math.cos(e) * 0.6, ball[1] + Math.sin(e) * 0.6, ball[2] + Math.sin(a) * Math.cos(e) * 0.6];
      out.push({ mesh: 'box', model: mul(translation(p), scaling([0.1, 0.1, 0.1])), color: party ? [2.4, 2.4, 2.6] : [0.6, 0.6, 0.65], pattern: party ? Pattern.emissive : Pattern.plain, shadow: false });
    }
  }

  private drawJukebox(out: DrawItem[], p: Vec3, on: boolean) {
    const m = mul(translation(p), rotationY(Math.PI));
    const wood = [0.42, 0.18, 0.08];
    out.push({ mesh: 'bevelbox', model: mul(m, translation([0, 1.0, 0]), scaling([1.6, 2.0, 0.9])), color: wood, spec: 0.5 });
    out.push({ mesh: 'cylinder', model: mul(m, translation([0, 2.0, 0]), rotationY(0), scaling([0.8, 0.9, 0.45])), color: wood, spec: 0.5 });
    // Glowing tubes up the sides and over the top, cycling colours while it plays.
    for (let k = 0; k < 7; k++) {
      const a = Math.PI * (k / 6);
      const tp: Vec3 = [Math.cos(a) * 0.72, 2.0 + Math.sin(a) * 0.72, -0.47];
      const c = on ? hsv((k * 0.14 + this.time * 0.5) % 1, 0.9, 2.2) : [0.2, 0.15, 0.1];
      out.push({ mesh: 'sphere', model: mul(m, translation(tp), scaling([0.12, 0.12, 0.12])), color: c, pattern: on ? Pattern.emissive : Pattern.plain, shadow: false });
    }
    out.push({ mesh: 'box', model: mul(m, translation([0, 1.3, -0.46]), scaling([1.1, 0.6, 0.02])), color: on ? [1.2, 0.9, 0.5] : [0.2, 0.18, 0.15], pattern: on ? Pattern.emissive : Pattern.plain });
    out.push({ mesh: 'box', model: mul(m, translation([0, 0.55, -0.46]), scaling([1.2, 0.5, 0.02])), color: [0.12, 0.1, 0.1] });
  }

  labels(): WorldLabel[] {
    const list = this.labelList.slice();
    for (const n of this.notes) list.push(n);
    return list;
  }

  trackedTargets(): TrackedTarget[] {
    const exit = this.exit.target();
    return exit ? [exit] : [];
  }

  environment() {
    const party = this.phase === 'music' || this.phase === 'reset' || this.phase === 'won';
    const light = this.env.pointLight!;
    light.color = party ? hsv((this.time * 0.15) % 1, 0.7, 1.4) as Vec3 : [0, 0, 0];
    return this.env;
  }

  obstacles() {
    return [];
  }

  cameraShot(): CameraShot | null {
    return this.arrival.cameraShot();
  }
}

/** A folding chair, its seat at the origin's height 0.46 m, facing -z. */
function drawChair(out: DrawItem[], m: Mat4) {
  const metal = [0.55, 0.56, 0.6], seat = [0.7, 0.08, 0.12];
  out.push({ mesh: 'bevelbox', model: mul(m, translation([0, 0.45, 0]), scaling([0.46, 0.05, 0.44])), color: seat, spec: 0.5 });
  out.push({ mesh: 'bevelbox', model: mul(m, translation([0, 0.78, 0.22]), scaling([0.44, 0.34, 0.04])), color: seat, spec: 0.5 });
  for (const x of [-0.2, 0.2]) {
    for (const z of [-0.18, 0.2]) out.push({ mesh: 'cylinder', model: mul(m, translation([x, 0.22, z]), scaling([0.018, 0.45, 0.018])), color: metal, spec: 0.7 });
    out.push({ mesh: 'cylinder', model: mul(m, translation([x, 0.8, 0.22]), scaling([0.018, 0.45, 0.018])), color: metal, spec: 0.7 });
  }
}

function hsv(h: number, s: number, v: number): number[] {
  const f = (n: number) => {
    const k = (n + h * 6) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5), f(3), f(1)];
}

