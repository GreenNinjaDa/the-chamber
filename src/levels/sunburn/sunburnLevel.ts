import {
  add, basis, clamp, cross, dot, length, lerp, mul, normalize, scale, scaling, segment, sub, translation,
  type Mat4, type Vec3,
} from '../../engine/math';
import { GROUPS_QUERY_WITH_PLAYER, type Body, type RAPIER } from '../../engine/physics';
import { Pattern, type DrawItem, type Environment } from '../../engine/renderer';
import { CHAMBER_HALF } from '../../game/chamber';
import { Giant } from '../../entities/giant';
import { junk, spawnJunk } from '../../entities/junk';
import { ExitPortal, PortalArrival } from '../../entities/portal';
import { DEFAULT_ENV, type CameraShot, type Level, type LevelContext, type LevelStatus, type TrackedTarget, type WorldLabel } from '../level';

/*
 * Magnifying Glass. The giant is back, with a magnifying glass, and you are the ant. A whole day
 * passes in a minute and a half: the sun rises in the east, crosses overhead and sets in the
 * west, and the shade moves with it. The burning spot is real sunlight: wherever the ray from the
 * lens is blocked (walls, junk, an umbrella, a mattress held overhead) you're safe, until the
 * thing shading you catches fire. At dusk his mum calls him in for dinner and the exit opens.
 */

/** Seconds after the arrival when the day starts (the giant is up), and how long it lasts. */
const DAWN_AT = 4;
const DAY = 64;
const DINNER_AT = DAWN_AT + DAY + 1;
const EXIT_AT = DINNER_AT + 4;
/** The sun rises and sets this far above the horizon, and lingers overhead at noon (higher = longer). */
const HORIZON = (14 * Math.PI) / 180;
const LINGER = 1.6;

/**
 * The burning spot chases the player at this speed (m/s), by time of day: around noon faster than
 * a sprint, but it turns sluggishly (SPOT_TURN), so you dodge it like a bull. It aims up to
 * SPOT_LEAD seconds ahead of where you're going, less when it's close.
 */
const SPOT_SPEED_MORNING = 5;
const SPOT_SPEED_NOON = 9.5;
const SPOT_TURN = 2.4;
const SPOT_LEAD = 0.45;
/** While the player hides, he alternates: burning something out in the sun, then lurking at the edge of their shade. */
const PRACTICE_TIME = 4.5;
const LURK_TIME = 3.5;
/** Seconds of focused sunlight that set the player on fire; heat drains this much slower than it builds. */
const IGNITE = 1.0;
const COOL_RATE = 0.7;
/** Radius of the spot's glow, and of the lens. */
const SPOT_R = 0.32;
const LENS_R = 2.2;
/** The lens hovers this high over the floor (along the sun's direction from the spot). */
const LENS_HEIGHT = 13;
const DEATH_SCREEN_DELAY = 2.2;

const NOON_SUN: Vec3 = [2.0, 1.9, 1.75];
const DAWN_SUN: Vec3 = [1.9, 1.0, 0.55];
const NIGHT_SUN: Vec3 = [0.25, 0.3, 0.5];
const NOON_SKY: Vec3 = [0.22, 0.36, 0.62];
const DAWN_SKY: Vec3 = [0.36, 0.25, 0.33];
const NIGHT_SKY: Vec3 = [0.03, 0.04, 0.1];
const NOON_FOG: Vec3 = [0.72, 0.82, 0.92];
const DAWN_FOG: Vec3 = [0.88, 0.6, 0.48];
const NIGHT_FOG: Vec3 = [0.09, 0.1, 0.18];

const JOKES = [
  'Well done. Medium-well, actually.',
  'SPF 5000 would not have helped.',
  'You were a little too sunny side up.',
  'Timmy is going to be insufferable about this.',
];
const HINT = 'Stay in the shade, and mind that it moves with the sun: along the east wall in the morning, the west wall in ' +
  'the afternoon. Around noon the walls stop helping: get under an umbrella (they burn, eventually) or keep running.';

const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

/** Something the spot can set on fire. */
interface Burnable {
  colliders: RAPIER.Collider[];
  heat: number;
  /** Seconds in the spot before it burns up. */
  burnAt: number;
  burnt: boolean;
  centre(): Vec3;
  burn(): void;
}

interface Umbrella {
  pos: Vec3;
  color: number[];
  burnable: Burnable;
}

interface Puff {
  pos: Vec3;
  vel: Vec3;
  age: number;
  life: number;
  size: number;
  dark: number;
}

interface Death {
  t: number;
  big: string;
  small: string;
}

export class SunburnLevel implements Level {
  readonly number = 7;
  readonly title = 'Magnifying Glass';
  status: LevelStatus = 'playing';
  private arrival: PortalArrival;
  private exit = new ExitPortal(0);
  private giant = new Giant();
  private death: Death | null = null;
  /** Seconds since the arrival finished. */
  private t = 0;
  private env: Environment = { ...DEFAULT_ENV, sunDir: [1, 0.25, 0] };
  private sunDir: Vec3 = [1, 0.25, 0];

  /** Where the giant is aiming (on the floor) and how fast that's moving. */
  private aim: Vec3 = [-8, 0, -8];
  private aimVel: Vec3 = [0, 0, 0];
  /** The lens: where it's drawn (it trails its ideal spot a little). */
  private lens: Vec3 = [4, 16, 14];
  /** Where the focused light lands this frame (null: blocked or off). */
  private spot: { pos: Vec3; normal: Vec3 } | null = null;
  private heat = 0;
  private burning = -1;

  private burnables: Burnable[] = [];
  private byCollider = new Map<number, Burnable>();
  private umbrellas: Umbrella[] = [];
  /** Scorch marks where things burnt away: position and size. */
  private ash: { pos: Vec3; size: Vec3 }[] = [];
  private puffs: Puff[] = [];
  private tags: (WorldLabel & { ttl: number })[] = [];
  private giantLabel: WorldLabel = { pos: [0, 0, 0], text: '', size: 3, color: '#ffd166' };
  private labelList: WorldLabel[] = [];

  constructor(private ctx: LevelContext) {
    const { physics, hud } = ctx;
    hud.setLevel(`The Chamber · Level ${this.number}`);
    hud.show(`LEVEL ${this.number}`, '', 2.5);
    hud.hint('');
    this.arrival = new PortalArrival(ctx, [0, 0, 6]);
    this.giant.root = [0, -80, 27];
    this.giant.leanTarget = this.giant.lean = 0.22;
    this.giant.rightCurl = 1.1;
    this.giant.update(0, [4, 12, 12]);

    // Tall things to hide behind in the morning and afternoon...
    const place = (name: string, x: number, z: number, yaw = 0) => {
      const def = junk(name);
      const body = spawnJunk(physics, def, [x, def.size[1] / 2 + 0.01, z], { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) });
      const top = () => add(this.bodyCentre(body), [0, def.size[1] / 2, 0]);
      this.things.push(() => (physics.bodies.includes(body) ? top() : [0, -50, 0]));
      if (name === 'rubber duck') this.duckCentre = this.things[this.things.length - 1];
      return body;
    };
    place('fridge', -5, -4.5, 0.3);
    place('vending machine', 5.5, -6, -0.4);
    place('bookcase', -7.5, 4.5, 1.2);
    place('filing cabinet', 7, 3.5, 0.2);
    place('couch', 0.5, -8.5, 0.1);
    place('bathtub', -3.5, 9.5, -0.2);
    place('piano', 8.5, -1.5, 1.57);
    place('washing machine', -9.5, -2, 0.5);
    place('crate', 3.5, -2.5, 0.4);
    place('crate', -1.5, 3, 0.9);
    // ...and things that burn.
    const mattress = place('mattress', 6, 8.5, 0.3);
    this.addBurnable([mattress.collider], 4, () => this.bodyCentre(mattress), () => this.burnAway(mattress, [2.0, 0.02, 1.4]));
    for (const [x, z] of [[2, -4], [-8, -8.5]]) {
      const box = place('cardboard box', x, z, x);
      this.addBurnable([box.collider], 1.8, () => this.bodyCentre(box), () => this.burnAway(box, [0.6, 0.02, 0.45]));
    }
    const duck = place('rubber duck', -1, -2, 2);
    this.addBurnable([duck.collider], 1.2, () => this.bodyCentre(duck), () => {
      // Melts into a sad yellow puddle.
      const model = duck.model!;
      duck.model = (out, m) => model(out, mul(m, translation([0, -0.18, 0]), scaling([1.5, 0.3, 1.5])));
      this.tag(this.bodyCentre(duck), 'RIP');
    });
    const ball = place('beach ball', 9, -9);
    this.addBurnable([ball.collider], 0.5, () => this.bodyCentre(ball), () => {
      this.puff(this.bodyCentre(ball), 8, 0.2);
      this.tag(this.bodyCentre(ball), 'POP');
      physics.remove(ball);
    });
    // Two beach umbrellas: shade from overhead, while they last.
    const umbrellas: [Vec3, number[]][] = [[[3, 0, 1.5], [0.85, 0.15, 0.12]], [[-4, 0, -0.5], [0.1, 0.55, 0.6]]];
    for (const [pos, color] of umbrellas) {
      physics.addStaticCylinder(add(pos, [0, 1.25, 0]), 0.05, 2.5);
      const canopy = physics.addStaticCylinder(add(pos, [0, 2.5, 0]), 1.35, 0.12);
      const u: Umbrella = { pos, color, burnable: null! };
      u.burnable = this.addBurnable([canopy], 3.5, () => add(pos, [0, 2.6, 0]), () => {
        physics.world.removeCollider(canopy, true);
        this.puff(add(pos, [0, 2.6, 0]), 10, 0.5);
      });
      this.umbrellas.push(u);
    }

    this.updateSun(0);
  }

  private addBurnable(colliders: RAPIER.Collider[], burnAt: number, centre: () => Vec3, burn: () => void): Burnable {
    const b: Burnable = { colliders, heat: 0, burnAt, burnt: false, centre, burn };
    this.burnables.push(b);
    for (const c of colliders) this.byCollider.set(c.handle, b);
    return b;
  }

  private bodyCentre(body: Body): Vec3 {
    const p = body.rb.translation();
    return [p.x, p.y, p.z];
  }

  /** Burns a loose object away, leaving a scorch mark. */
  private burnAway(body: Body, size: Vec3) {
    const c = this.bodyCentre(body);
    this.ash.push({ pos: [c[0], 0.012, c[2]], size });
    this.puff(c, 10, 0.5);
    this.ctx.physics.remove(body);
  }

  private tag(pos: Vec3, text: string) {
    this.tags.push({ pos: add(pos, [0, 0.9, 0]), text, size: 0.45, color: '#ffd166', ttl: 3 });
  }

  private puff(pos: Vec3, n: number, dark: number) {
    for (let i = 0; i < n; i++) {
      if (this.puffs.length > 140) this.puffs.shift();
      this.puffs.push({
        pos: add(pos, [(Math.random() - 0.5) * 0.4, 0, (Math.random() - 0.5) * 0.4]),
        vel: [(Math.random() - 0.5) * 0.8, 1 + Math.random() * 1.2, (Math.random() - 0.5) * 0.8],
        age: 0,
        life: 1.2 + Math.random() * 1.2,
        size: 0.05 + Math.random() * 0.07,
        dark,
      });
    }
  }

  // --- The sun ----------------------------------------------------------------------------------

  /** Moves the sun along its arc for this moment of the day, and colours the light to match. */
  private updateSun(dayT: number) {
    const u = clamp((dayT / DAY) * 2 - 1, -1, 1);
    const angle = Math.PI / 2 + (Math.PI / 2 - HORIZON) * Math.sign(u) * Math.abs(u) ** LINGER;
    this.sunDir = [Math.cos(angle), Math.sin(angle), 0.02];
    // Warm near the horizon, white overhead; night falls after dinner.
    const warm = 1 - clamp((Math.sin(angle) - 0.25) / 0.55, 0, 1);
    const night = clamp((this.t - DINNER_AT) / 5, 0, 1);
    const mix3 = (noon: Vec3, dawn: Vec3, dark: Vec3): Vec3 => {
      const day: Vec3 = [lerp(noon[0], dawn[0], warm), lerp(noon[1], dawn[1], warm), lerp(noon[2], dawn[2], warm)];
      return [lerp(day[0], dark[0], night), lerp(day[1], dark[1], night), lerp(day[2], dark[2], night)];
    };
    this.env.sunDir = this.sunDir;
    this.env.sunColor = mix3(NOON_SUN, DAWN_SUN, NIGHT_SUN);
    this.env.skyColor = mix3(NOON_SKY, DAWN_SKY, NIGHT_SKY);
    this.env.fogColor = mix3(NOON_FOG, DAWN_FOG, NIGHT_FOG);
  }

  /** The spot is live from shortly after dawn until Timmy is called in. */
  private get focusing() {
    return this.t > DAWN_AT + 1.5 && this.t < DINNER_AT + 0.5 && this.status === 'playing';
  }

  // --- Update -------------------------------------------------------------------------------------

  update(dt: number) {
    const { player, hud } = this.ctx;
    const death = this.death;
    if (death && this.status === 'playing') {
      death.t += dt;
      if (death.t > DEATH_SCREEN_DELAY) {
        this.status = 'lost';
        hud.show(death.big, `${death.small}\nPress R to try again.`);
        hud.tips([
          ['Hint', HINT],
          ['Controls', 'WASD move · Shift sprint · Hold left click to carry (look up to hold it overhead) · Right-click throw'],
        ]);
      }
    }
    this.arrival.update(dt);
    this.exit.update(dt, player);
    if (this.exit.entered && this.status === 'playing') this.status = 'exited';
    this.giant.time += dt;
    if (this.arrival.done) this.t += dt;
    const t = this.t;
    this.updateSun(t - DAWN_AT);

    // The giant rises over the south wall at dawn and sinks away when he's called in for dinner.
    const rise = clamp((t - 0.3) / 3.2, 0, 1);
    const sink = clamp((t - DINNER_AT - 1.8) / 3, 0, 1);
    this.giant.root[1] = lerp(-80, 0, easeOut(rise)) - 80 * sink * sink;
    if (t > DINNER_AT && t < DINNER_AT + 1.8) {
      this.giant.lookTarget = [40, 60, 80]; // over his shoulder: "Aww, Mum!"
      this.giantLabel.text = t > DINNER_AT + 0.6 ? 'AWW, MUM!' : '';
    } else {
      this.giantLabel.text = '';
      this.giant.lookTarget = this.spot ? this.spot.pos : this.aim;
    }
    if (t >= DINNER_AT && t - dt < DINNER_AT && !this.death) hud.show("TIMMY! DINNER'S READY!", '', 2.2);
    if (t >= EXIT_AT && t - dt < EXIT_AT && !this.death) this.exit.openNow();

    this.updateAim(dt);
    this.updateSpot(dt);

    // The lens hovers along the sun's direction above the spot (and follows the hand at the ends of the day).
    const lensGoal = this.focusing || this.spot ? this.idealLens() : add(this.giant.shoulder(1), [-10, -26, -22]);
    this.lens = add(this.lens, scale(sub(lensGoal, this.lens), 1 - Math.exp(-dt * 5)));
    this.giant.update(dt, this.handle().grip);
    this.giantLabel.pos = add(this.giant.headCenter(), [0, 13, 0]);

    // Player heat.
    const alive = player.mode === 'control' && !this.death;
    const onPlayer = this.spot !== null && this.spotOnPlayer;
    if (alive) {
      this.heat = onPlayer ? this.heat + dt : Math.max(0, this.heat - dt * COOL_RATE);
      if (onPlayer && Math.random() < dt * 8) this.puff(this.spot!.pos, 1, 0.25);
      if (this.heat >= IGNITE) this.ignite();
    }
    if (this.burning >= 0) {
      this.burning += dt;
      player.char = Math.min(1, this.burning / 0.6);
      if (this.burning < 4 && Math.random() < dt * 20) {
        const f = player.partFrames();
        const part = pick([f.chest, f.head, f.pelvis, f.thighL, f.thighR]);
        this.puff([part[12], part[13], part[14]], 1, 0.08);
      }
    }

    // Burnables in the spot heat up (and smoke), and eventually burn.
    for (const b of this.burnables) {
      if (b.burnt) continue;
      const hit = this.spot !== null && this.spotTarget === b;
      b.heat = hit ? b.heat + dt : Math.max(0, b.heat - dt * 0.3);
      if (hit && Math.random() < dt * (6 + 20 * (b.heat / b.burnAt))) this.puff(this.spot!.pos, 1, 0.3 + 0.5 * (b.heat / b.burnAt));
      if (b.heat >= b.burnAt) {
        b.burnt = true;
        b.burn();
      }
    }
    // Anything else in the spot smokes a little, so you can see where it is.
    if (this.spot && !this.spotOnPlayer && !this.spotTarget && Math.random() < dt * 5) this.puff(this.spot.pos, 1, 0.15);

    for (const p of this.puffs) {
      p.age += dt;
      p.pos = add(p.pos, scale(p.vel, dt));
      p.vel[1] += dt * 0.4;
    }
    while (this.puffs.length && this.puffs[0].age > this.puffs[0].life) this.puffs.shift();
    for (const tag of this.tags) {
      tag.ttl -= dt;
      tag.pos = add(tag.pos, [0, dt * 0.3, 0]);
    }
    this.tags = this.tags.filter((g) => g.ttl > 0);
  }

  /**
   * The giant aims at the player's chest (where they're heading), a little clumsily. While they
   * hide in the shade he practises on things out in the sun instead: the duck first.
   */
  private updateAim(dt: number) {
    const { player } = this.ctx;
    const noon = 1 - Math.abs(clamp((this.t - DAWN_AT) / DAY, 0, 1) * 2 - 1);
    const speed = lerp(SPOT_SPEED_MORNING, SPOT_SPEED_NOON, Math.min(1, noon * 1.6));
    const near = Math.hypot(player.pos[0] - this.aim[0], player.pos[2] - this.aim[2]);
    const lead = Math.min(SPOT_LEAD, (near / speed) * 0.8);
    const chest: Vec3 = [player.pos[0] + player.vel[0] * lead, player.pos[1] + 1.2, player.pos[2] + player.vel[2] * lead];
    const lit = this.focusing && this.isLit(chest);
    this.shadedFor = lit ? 0 : this.shadedFor + dt;
    let target = chest;
    if (!lit && this.focusing && this.shadedFor > 1.2) {
      const phase = (this.shadedFor - 1.2) % (PRACTICE_TIME + LURK_TIME);
      if (phase < PRACTICE_TIME) {
        if (!this.practice || !this.isLit(this.practice())) {
          const things = this.things.filter((th) => this.isLit(th()));
          this.practice = things.includes(this.duckCentre) ? this.duckCentre : things.length ? pick(things) : null;
        }
      } else {
        this.practice = null;
      }
      target = this.practice ? this.practice() : this.lurk(chest) ?? chest;
    } else {
      this.practice = null;
    }
    const to = sub(target, this.aim);
    const dist = length(to);
    const want = dist > 1e-3 ? scale(to, Math.min(speed, dist * 3) / dist) : [0, 0, 0] as Vec3;
    this.aimVel = add(this.aimVel, scale(sub(want, this.aimVel), 1 - Math.exp(-dt * SPOT_TURN)));
    this.aim = add(this.aim, scale(this.aimVel, dt));
    this.aim[0] = clamp(this.aim[0], -CHAMBER_HALF, CHAMBER_HALF);
    this.aim[2] = clamp(this.aim[2], -CHAMBER_HALF, CHAMBER_HALF);
  }

  /** The nearest sunlit point on the floor next to the player's shade, if there's one close by. */
  private lurk(chest: Vec3): Vec3 | null {
    const away = normalize([-this.sunDir[0] || 0.001, 0, -this.sunDir[2]]);
    for (let d = 0.5; d < 10; d += 0.5) {
      const q: Vec3 = [chest[0] + away[0] * d, 0.3, chest[2] + away[2] * d];
      if (Math.abs(q[0]) > CHAMBER_HALF - 0.3 || Math.abs(q[2]) > CHAMBER_HALF - 0.3) return null;
      if (this.isLit(q)) return add(q, scale(away, 0.4));
    }
    return null;
  }

  /** Whether the sun reaches this point (nothing solid between it and the sky; players don't count). */
  private isLit(p: Vec3) {
    if (this.sunDir[1] < 0.2) return false;
    const s = normalize(this.sunDir);
    return this.ctx.physics.raycast(add(p, scale(s, 0.6)), s, 40) === null;
  }

  private shadedFor = 0;
  /** A thing he's burning while the player hides (its centre), and for how long. */
  private practice: (() => Vec3) | null = null;
  private things: (() => Vec3)[] = [];
  private duckCentre: () => Vec3 = () => [0, 0, 0];
  private spotOnPlayer = false;
  private spotTarget: Burnable | null = null;

  /** Where the focused light lands: the first thing in its way, going down the sun's direction to the aim point. */
  private updateSpot(_dt: number) {
    const { physics, player } = this.ctx;
    this.spot = null;
    this.spotOnPlayer = false;
    this.spotTarget = null;
    if (!this.focusing || this.sunDir[1] < 0.2) return;
    const wobble: Vec3 = [Math.sin(this.giant.time * 1.7) * 0.12, 0, Math.cos(this.giant.time * 2.3) * 0.12];
    const aim = add(this.aim, wobble);
    const from = this.idealLens(aim);
    const down = scale(normalize(this.sunDir), -1);
    const hit = physics.raycast(from, down, length(sub(aim, from)) + 4, undefined, GROUPS_QUERY_WITH_PLAYER);
    if (!hit) return;
    const p = hit.point;
    // Blocked by a wall (or landing on its top or outside): no spot in the room.
    const inside = Math.abs(p[0]) < CHAMBER_HALF - 0.01 && Math.abs(p[2]) < CHAMBER_HALF - 0.01 && p[1] < 9.5;
    if (!inside) return;
    this.spot = { pos: p, normal: hit.normal };
    this.spotOnPlayer = player.body?.colliders.includes(hit.collider) ?? false;
    this.spotTarget = this.byCollider.get(hit.collider.handle) ?? null;
  }

  /** The lens position for an aim point: up the sun's direction, LENS_HEIGHT over the floor (or far off when the sun is low). */
  private idealLens(aim: Vec3 = this.aim): Vec3 {
    const s = normalize(this.sunDir);
    const dist = clamp(LENS_HEIGHT / Math.max(s[1], 0.05), LENS_HEIGHT, 36);
    return add(aim, scale(s, dist));
  }

  /** The lens's handle: from its rim toward the giant's hand. */
  private handle() {
    const n = normalize(this.sunDir);
    const toGiant = sub(this.giant.shoulder(1), this.lens);
    let d = sub(toGiant, scale(n, dot(toGiant, n)));
    d = length(d) > 1e-3 ? normalize(d) : [0, 0, 1];
    const rim = add(this.lens, scale(d, LENS_R + 0.1));
    return { rim, grip: add(rim, scale(d, 3.2)), dir: d };
  }

  private ignite() {
    const { player, camera } = this.ctx;
    this.burning = 0;
    player.kill([(Math.random() - 0.5) * 2, 3.5, (Math.random() - 0.5) * 2], { violence: 4 });
    camera.addShake(0.3);
    this.puff(add(player.pos, [0, 1.2, 0]), 14, 0.1);
    this.death = { t: 0, big: 'ROASTED', small: pick(JOKES) };
  }

  // --- Drawing ------------------------------------------------------------------------------------

  draw(out: DrawItem[]) {
    this.arrival.draw(out);
    this.exit.draw(out);

    // The giant and his lens cast no shadows (the sun is behind the lens, so to speak).
    const first = out.length;
    this.giant.draw(out);
    this.drawLens(out);
    for (let i = first; i < out.length; i++) out[i].shadow = false;

    for (const u of this.umbrellas) this.drawUmbrella(out, u);
    for (const a of this.ash) {
      out.push({ mesh: 'box', model: mul(translation(a.pos), scaling(a.size)), color: [0.03, 0.03, 0.03], shadow: false });
    }

    const spot = this.spot;
    if (spot) {
      // A blinding little sun where the light lands, and the rays converging on it.
      const n = spot.normal;
      const m = alignY(add(spot.pos, scale(n, 0.012)), n);
      const flicker = 1 + Math.sin(this.giant.time * 40) * 0.08;
      out.push({ mesh: 'cylinder', model: mul(m, scaling([SPOT_R * flicker, 0.01, SPOT_R * flicker])), color: [9, 8, 5], pattern: Pattern.emissive, shadow: false });
      out.push({ mesh: 'cylinder', model: mul(m, translation([0, -0.003, 0]), scaling([SPOT_R * 2.2, 0.008, SPOT_R * 2.2])), color: [1.6, 1.1, 0.5], pattern: Pattern.emissive, shadow: false });
      const s = normalize(this.sunDir);
      const a = normalize(cross(s, Math.abs(s[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0]));
      const b = cross(s, a);
      for (let i = 0; i < 8; i++) {
        const ang = (i / 8) * Math.PI * 2;
        const rim = add(this.lens, add(scale(a, Math.cos(ang) * LENS_R * 0.85), scale(b, Math.sin(ang) * LENS_R * 0.85)));
        out.push({ mesh: 'cylinder', model: segment(rim, spot.pos, 0.012), color: [1.8, 1.6, 1.0], pattern: Pattern.emissive, shadow: false });
      }
    }

    // Flames on the burning player.
    if (this.burning >= 0 && this.burning < 4) {
      const f = this.ctx.player.partFrames();
      const k = 1 - clamp((this.burning - 2.5) / 1.5, 0, 1);
      for (const part of [f.chest, f.head, f.pelvis, f.thighL, f.thighR, f.upperArmL, f.upperArmR]) {
        const h = (0.25 + 0.15 * Math.sin(this.giant.time * 23 + part[12] * 7)) * k;
        if (h <= 0.01) continue;
        out.push({ mesh: 'cone', model: mul(translation([part[12], part[13] + h * 0.5, part[14]]), scaling([0.12 * k, h, 0.12 * k])), color: [6, 2.4, 0.4], pattern: Pattern.emissive, shadow: false });
      }
    }

    for (const p of this.puffs) {
      const k = p.age / p.life;
      const size = p.size * (1 + k * 2.5);
      const g = 0.45 - p.dark * 0.4;
      out.push({ mesh: 'sphere', model: mul(translation(p.pos), scaling([size, size, size])), color: [g, g, g], opacity: 0.55 * (1 - k), shadow: false });
    }
  }

  private drawLens(out: DrawItem[]) {
    const n = normalize(this.sunDir);
    const a = normalize(cross(n, Math.abs(n[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0]));
    const b = cross(n, a);
    // Glass (see-through), a brass rim of short segments, and the handle.
    out.push({ mesh: 'cylinder', model: basis(scale(b, LENS_R), scale(n, 0.1), scale(a, LENS_R), this.lens), color: [0.75, 0.9, 1], spec: 1, opacity: 0.3 });
    const segs = 20;
    for (let i = 0; i < segs; i++) {
      const p0 = (i / segs) * Math.PI * 2, p1 = ((i + 1) / segs) * Math.PI * 2;
      const q0 = add(this.lens, add(scale(a, Math.cos(p0) * LENS_R), scale(b, Math.sin(p0) * LENS_R)));
      const q1 = add(this.lens, add(scale(a, Math.cos(p1) * LENS_R), scale(b, Math.sin(p1) * LENS_R)));
      out.push({ mesh: 'cylinder', model: segment(q0, q1, 0.16), color: [0.72, 0.55, 0.2], spec: 0.8 });
    }
    const h = this.handle();
    out.push({ mesh: 'cylinder', model: segment(h.rim, add(h.grip, scale(h.dir, 1.5)), 0.32), color: [0.12, 0.07, 0.04], spec: 0.3 });
  }

  private drawUmbrella(out: DrawItem[], u: Umbrella) {
    const p = u.pos;
    out.push({ mesh: 'cylinder', model: mul(translation(add(p, [0, 0.08, 0])), scaling([0.3, 0.16, 0.3])), color: [0.3, 0.3, 0.32] });
    out.push({ mesh: 'cylinder', model: mul(translation(add(p, [0, 1.35, 0])), scaling([0.035, 2.7, 0.035])), color: [0.85, 0.85, 0.82], spec: 0.5 });
    const b = u.burnable;
    if (!b.burnt) {
      // The canopy scorches as it heats up.
      const k = clamp(b.heat / b.burnAt, 0, 1) * 0.8;
      const c = [lerp(u.color[0], 0.05, k), lerp(u.color[1], 0.04, k), lerp(u.color[2], 0.03, k)];
      out.push({ mesh: 'cone', model: mul(translation(add(p, [0, 2.62, 0])), scaling([1.4, 0.45, 1.4])), color: c, spec: 0.2 });
      out.push({ mesh: 'cylinder', model: mul(translation(add(p, [0, 2.4, 0])), scaling([1.4, 0.04, 1.4])), color: [0.95, 0.95, 0.9] });
      if (b.heat > b.burnAt * 0.6) {
        const fk = (b.heat / b.burnAt - 0.6) / 0.4;
        for (let i = 0; i < 4; i++) {
          const ang = i * 1.7 + this.giant.time;
          const fp = add(p, [Math.cos(ang) * 0.6, 2.9, Math.sin(ang) * 0.6]);
          out.push({ mesh: 'cone', model: mul(translation(fp), scaling([0.12, 0.35 * fk * (1 + 0.3 * Math.sin(this.giant.time * 20 + i)), 0.12])), color: [6, 2.4, 0.4], pattern: Pattern.emissive, shadow: false });
        }
      }
    } else {
      // Just the charred ribs left.
      for (let i = 0; i < 6; i++) {
        const ang = (i / 6) * Math.PI * 2;
        out.push({ mesh: 'cylinder', model: segment(add(p, [0, 2.85, 0]), add(p, [Math.cos(ang) * 1.3, 2.4, Math.sin(ang) * 1.3]), 0.025), color: [0.05, 0.05, 0.05] });
      }
    }
  }

  labels(): WorldLabel[] {
    this.labelList.length = 0;
    this.labelList.push(this.giantLabel, ...this.tags);
    return this.labelList;
  }

  trackedTargets(): TrackedTarget[] {
    const exit = this.exit.target();
    return exit ? [exit] : [];
  }

  environment() {
    return this.env;
  }

  obstacles() {
    return [];
  }

  cameraShot(): CameraShot | null {
    return this.arrival.cameraShot();
  }
}

const easeOut = (x: number) => 1 - (1 - x) * (1 - x);

/** A frame at `pos` whose y axis points along `n`. */
function alignY(pos: Vec3, n: Vec3): Mat4 {
  const y = normalize(n);
  const x = normalize(cross(y, Math.abs(y[0]) > 0.9 ? [0, 0, 1] : [1, 0, 0]));
  const z = cross(x, y);
  return basis(x, y, z, pos);
}
