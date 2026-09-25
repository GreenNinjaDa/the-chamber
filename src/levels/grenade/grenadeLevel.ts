import {
  add, basis, cross, distXZ, dot, fromQuat, length, lerp, mul, normalize, rotateByQuat, rotationZ, scale, scaling,
  segment, sub, translation,
  type Mat4, type Quat, type Vec3,
} from '../../engine/math';
import { GROUPS_QUERY_WITH_PLAYER, GROUPS_QUERY_WORLD, RAPIER, type Body } from '../../engine/physics';
import { Pattern, type DrawItem } from '../../engine/renderer';
import { PART_NAMES } from '../../game/body';
import { ExitPortal, PortalArrival } from '../../game/portal';
import { JUNK, type JunkDef } from './junk';
import { CHAMBER_HALF, type ChamberOptions } from '../../game/chamber';
import { DEFAULT_ENV, type CameraShot, type Level, type LevelContext, type LevelStatus, type TrackedTarget } from '../level';

/*
 * Level 2 — Grenade.
 * Junk crashes into the chamber, then a pineapple grenade drops in with a blinking fuse. The
 * blast hurts by distance and by how much stuff is between it and you (heavier things soak up
 * more), and it throws shrapnel that sticks in whatever it hits — one piece in you is fatal.
 * A small red-rimmed hole high in the north wall is just big enough to throw the grenade out.
 * Survive that, and a bigger, heavier grenade arrives: it barely fits the hole and its blast
 * reaches the whole chamber, so distance alone won't save you.
 */

// --- Tuning -----------------------------------------------------------------------------------
/** When the junk starts falling, how far apart each piece drops, and when the first grenade drops (s). */
const JUNK_START = 3;
const JUNK_INTERVAL = 0.13;
const FIRST_GRENADE_AT = 6.5;
/** The exit panel opens this long (s) after the last (comically huge) grenade drops. */
const EXIT_OPENS_AFTER_LAST_DROP = 5;
/** Seconds after the first blast (if you survived it) before the second grenade drops. */
const SECOND_GRENADE_DELAY = 1;
/** Seconds after the last blast before the result screen appears. */
const RESULT_DELAY = 1.4;
/** The hole in the north wall (centre height and radius, m). The grenades' radii are 0.16 and 0.24. */
// High enough that you can't just carry a grenade up to it (you have to throw).
const HOLE = { x: 0, y: 6.75, radius: 0.36 };
/** The chamber floor's diagonal (m), for distances like "80% of the way across". */
const CHAMBER_DIAGONAL = CHAMBER_HALF * 2 * Math.SQRT2;
/** Damage at or above this (but below 1) knocks you flat instead of killing you. */
const KNOCKDOWN_DAMAGE = 0.35;
/**
 * Cover: an object between you and the blast lets through 1 / (1 + mass / COVER_MASS) of it,
 * so heavier things protect more (1 kg ≈ 98%, 20 kg ≈ 67%, 120 kg ≈ 25%, 200 kg ≈ 17%).
 */
const COVER_MASS = 40;
const coverPass = (mass: number) => 1 / (1 + mass / COVER_MASS);
/** Shrapnel: how far fragments fly (m), and the impulse each gives what it hits (kg·m/s). */
const SHRAPNEL_RANGE = 40;
const SHRAPNEL_PUSH = 14;

interface GrenadeSpec {
  radius: number;
  mass: number;
  /** Multiplies the player's throw speed (heavier grenades don't fly as far). */
  throwScale: number;
  fuse: number;
  /**
   * Blast damage. In direct line of sight (nothing between the grenade and your chest) it is
   * always fatal. Behind cover: (safeDistance / d) ^ falloff × the fraction of the blast that
   * gets through to your head, chest and pelvis (averaged). 1 = dead.
   */
  safeDistance: number;
  falloff: number;
  shrapnel: number;
  /** Loose objects get impulse push / (d + 1), speed capped at maxSpeed, within pushRange. */
  push: number;
  maxSpeed: number;
  pushRange: number;
  /** Floors and walls within this distance (m) get scorched; a surface right at the blast gets a mark this big (radius, m). */
  scorchRange: number;
  scorchSize: number;
  color: number[];
}

const GRENADES: GrenadeSpec[] = [
  {
    // Across the room almost anything saves you; at 10 m you want 18+ kg in the way; at 5 m, a piano.
    radius: 0.16, mass: 0.3, throwScale: 1, fuse: 10, safeDistance: 12, falloff: 2, shrapnel: 300, scorchRange: 3.5, scorchSize: 2.6,
    push: 900, maxSpeed: 18, pushRange: 14, color: [0.13, 0.16, 0.06],
  },
  {
    // 1.5x the size and much heavier. Behind any object you live from 80% of the way across the
    // chamber (safeDistance); closer in, the steep falloff needs a lot of weight in the way.
    radius: 0.24, mass: 0.6, throwScale: 0.93, fuse: 10, safeDistance: CHAMBER_DIAGONAL * 0.8, falloff: 3, shrapnel: 450, scorchRange: 5.5, scorchSize: 3.8,
    push: 2200, maxSpeed: 24, pushRange: 30, color: [0.09, 0.1, 0.05],
  },
  {
    // Comically huge: 5x the first. Nothing in the room saves you; the exit opens 5 s after it
    // lands, so run.
    radius: 0.8, mass: 12, throwScale: 0.5, fuse: 10, safeDistance: 400, falloff: 1, shrapnel: 700, scorchRange: 8, scorchSize: 6,
    push: 9000, maxSpeed: 30, pushRange: 40, color: [0.13, 0.16, 0.06],
  },
];

const QUIPS = {
  survived: [
    'Cover-based gameplay, but make it furniture.',
    'Kaboom. You, however: not kaboom.',
    'Your eardrums would like a word.',
  ],
  thrownOut: [
    "Problem solved. It's someone else's problem now.",
    'Yeet first, ask questions never.',
    'Nothing but net.',
  ],
  died: [
    'Turns out running away has a maximum range.',
    'The garden gnome saw everything.',
    'You have been evenly redistributed.',
  ],
  shrapnel: [
    'You are now 4% grenade.',
    'Shrapnel: 1. You: several holes.',
    'You caught something. Several somethings.',
  ],
  againWon: ['Press R to do it again, but worse', 'Press R. The fridge misses you.'],
  againLost: ['Press R to respawn. Cheaper than therapy.', 'Press R. Maybe hide behind something heavier.'],
};

const pick = <T>(options: T[]): T => options[Math.floor(Math.random() * options.length)];

/** Death-screen hints for how the last blast got you, plus the controls that matter here. */
function deathTips(blast: { byShrapnel: boolean; inSight: boolean; big: boolean }): [string, string][] {
  let hint: string;
  if (blast.byShrapnel) {
    hint = pick([
      'Shrapnel flies in straight lines. Keep ALL of you behind something; heads poke out.',
      "One fragment is all it takes. If you can see the grenade, the grenade's shrapnel can see you.",
    ]);
  } else if (blast.inSight) {
    hint = pick([
      'It saw you, so you are now a fine mist. Put anything between you and it; the heavier the better.',
      'Distance alone does not cut it. Get something solid between you and the grenade.',
    ]);
  } else if (blast.big) {
    hint = 'The big one reaches the whole room. Get to the far side AND behind something heavy.';
  } else {
    hint = pick([
      'Cover helps. Distance helps. Both help more. The heavier the thing you hide behind, the better.',
      'That was not enough cover. Stack more between you, or drag the fridge over.',
    ]);
  }
  const tips: [string, string][] = [['Hint', hint]];
  if (Math.random() < 0.5) tips.push(['Also', "That red-rimmed hole in the wall isn't decorative. Grenades fit through it."]);
  tips.push(['Controls', 'Hold left click to grab and drag junk (or the grenade). Right-click to throw; aim above the hole, it arcs.']);
  return tips;
}

function randomRotation(): Quat {
  const yaw = Math.random() * Math.PI * 2;
  const tiltAxis = normalize([Math.random() - 0.5, 0, Math.random() - 0.5]);
  const tilt = (Math.random() - 0.5) * 1.2;
  const qy: Quat = { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
  const s = Math.sin(tilt / 2);
  const qt: Quat = { x: tiltAxis[0] * s, y: 0, z: tiltAxis[2] * s, w: Math.cos(tilt / 2) };
  return {
    w: qt.w * qy.w - qt.x * qy.x - qt.y * qy.y - qt.z * qy.z,
    x: qt.w * qy.x + qt.x * qy.w + qt.y * qy.z - qt.z * qy.y,
    y: qt.w * qy.y - qt.x * qy.z + qt.y * qy.w + qt.z * qy.x,
    z: qt.w * qy.z + qt.x * qy.y - qt.y * qy.x + qt.z * qy.w,
  };
}

function randomDirection(): Vec3 {
  for (;;) {
    const v: Vec3 = [Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1];
    const l = length(v);
    if (l > 0.05 && l <= 1) return scale(v, 1 / l);
  }
}

/** A shrapnel fragment stuck in something. Fragments in loose objects move with them. */
interface Fragment {
  rb: RAPIER.RigidBody | null;
  /** Position and outward normal: world space, or the body's local space when attached. */
  pos: Vec3;
  normal: Vec3;
  spin: number;
  /**
   * Impact mark around the fragment, clipped to the face it's in. Only on walls and floors big
   * enough to hold one; fragments in loose objects (and the body) have no mark.
   */
  mark: { min: Vec3; max: Vec3 } | null;
}

/** A burn mark on a floor or wall. */
interface Scorch {
  pos: Vec3;
  normal: Vec3;
  radius: number;
  /** Small per-mark lift off the surface so overlapping marks don't flicker. */
  lift: number;
  /** The surface's face as a world-space box; the mark is clipped to it. */
  clip: { min: Vec3; max: Vec3 };
}

interface Tracer {
  from: Vec3;
  to: Vec3;
}

interface LiveGrenade {
  spec: GrenadeSpec;
  body: Body;
  fuseLeft: number;
}

export class GrenadeLevel implements Level {
  readonly number = 2;
  readonly title = 'Grenade';
  readonly chamber: ChamberOptions = { hole: HOLE };
  status: LevelStatus = 'playing';

  private t = 0;
  private spawned = 0;

  /** Index of the next grenade to drop, and when. */
  private nextGrenade = 0;
  private nextGrenadeAt = FIRST_GRENADE_AT;
  private grenade: LiveGrenade | null = null;
  private lastBlast: { at: number; pos: Vec3; thrownOut: boolean; byShrapnel: boolean; inSight: boolean; big: boolean } | null = null;
  private fragments: Fragment[] = [];
  private tracers: Tracer[] = [];
  private scorches: Scorch[] = [];

  private arrival: PortalArrival;
  private exit = new ExitPortal(3);
  private exitOpensAt = Infinity;

  constructor(private ctx: LevelContext) {
    ctx.hud.setLevel(`The Chamber · Level ${this.number}`);
    ctx.hud.show(`LEVEL ${this.number}`, '', 2.5);
    ctx.hud.hint('');
    this.arrival = new PortalArrival(ctx, [0, 0, 6]);
  }

  update(dt: number) {
    this.t += dt;
    const { player } = this.ctx;
    this.arrival.update(dt);
    if (this.t >= this.exitOpensAt) this.exit.openNow();
    this.exit.update(dt, player);
    if (this.exit.entered && this.status === 'playing') this.status = 'exited';

    while (this.spawned < JUNK.length && this.t >= JUNK_START + this.spawned * JUNK_INTERVAL) {
      this.spawnJunk(JUNK[this.spawned]);
      this.spawned++;
    }
    if (!this.grenade && this.nextGrenade < GRENADES.length && this.t >= this.nextGrenadeAt && this.status === 'playing') {
      this.dropGrenade(GRENADES[this.nextGrenade]);
      this.nextGrenade++;
      if (this.nextGrenade === GRENADES.length) this.exitOpensAt = this.t + EXIT_OPENS_AFTER_LAST_DROP;
      this.nextGrenadeAt = Infinity;
    }
    if (this.grenade) {
      this.grenade.fuseLeft -= dt;
      if (this.grenade.fuseLeft <= 0) this.explode(this.grenade);
    }

    // After each blast, decide what happens next.
    const blast = this.lastBlast;
    if (blast && !this.grenade && this.status === 'playing') {
      const since = this.t - blast.at;
      if (player.mode === 'ragdoll') {
        if (since > RESULT_DELAY) this.finish('lost', 'BOOM', pick(blast.byShrapnel ? QUIPS.shrapnel : QUIPS.died), deathTips(blast));
      } else if (this.nextGrenade >= GRENADES.length) {
        if (since > RESULT_DELAY) this.finish('won', 'SURVIVED', pick(blast.thrownOut ? QUIPS.thrownOut : QUIPS.survived));
      } else if (this.nextGrenadeAt === Infinity) {
        this.nextGrenadeAt = blast.at + SECOND_GRENADE_DELAY;
      }
    }
    if (this.tracers.length && blast && this.t - blast.at > 0.12) this.tracers = [];
  }

  private spawnJunk(def: JunkDef) {
    const { physics } = this.ctx;
    const pos: Vec3 = [(Math.random() * 2 - 1) * 9, 14 + Math.random() * 8, (Math.random() * 2 - 1) * 9];
    const opts = { mass: def.mass, rotation: randomRotation(), model: def.model };
    const body = def.shape === 'cylinder'
      ? physics.addCylinder(pos, def.size[0], def.size[1], opts)
      : def.shape === 'ball'
        ? physics.addBall(pos, def.size[0], { ...opts, restitution: 0.5 })
        : physics.addBox(pos, def.size, opts);
  }

  private dropGrenade(spec: GrenadeSpec) {
    const { physics, player } = this.ctx;
    let pos: Vec3 = [0, 12, 0];
    for (let tries = 0; tries < 50; tries++) {
      pos = [(Math.random() * 2 - 1) * 8, 12, (Math.random() * 2 - 1) * 8];
      if (distXZ(pos, player.pos) > 3) break;
    }
    const body = physics.addBall(pos, spec.radius, {
      mass: spec.mass, color: spec.color, restitution: 0.3, hidden: true, throwScale: spec.throwScale,
    });
    this.grenade = { spec, body, fuseLeft: spec.fuse };
  }

  private explode(g: LiveGrenade) {
    const { physics, player, camera } = this.ctx;
    const t = g.body.rb.translation();
    const pos: Vec3 = [t.x, t.y, t.z];
    const spec = g.spec;
    const thrownOut = Math.abs(t.x) > CHAMBER_HALF || Math.abs(t.z) > CHAMBER_HALF;
    physics.remove(g.body);
    this.grenade = null;
    camera.addShake(spec === GRENADES[0] ? 1.2 : 1.6);

    // Shove loose objects away from the blast, unless a wall hides them from it completely.
    for (const b of physics.bodies) {
      const p = b.rb.translation();
      const d = length(sub([p.x, p.y, p.z], pos));
      if (d > spec.pushRange) continue;
      const reach = Math.max(b.size[0], b.size[1], b.size[2]) * 0.45;
      const samples: Vec3[] = [[0, 0, 0], [reach, 0, 0], [-reach, 0, 0], [0, reach, 0], [0, -reach, 0], [0, 0, reach], [0, 0, -reach]]
        .map((o) => add([p.x, p.y, p.z], o as Vec3));
      if (!samples.some((q) => this.clearOfWalls(pos, q))) continue;
      const dir = normalize(add(sub([p.x, p.y, p.z], pos), [0, 0.6, 0]));
      const mass = b.rb.mass();
      const speed = Math.min(spec.maxSpeed, spec.push / (d + 1) / mass);
      b.rb.applyImpulse({ x: dir[0] * speed * mass, y: dir[1] * speed * mass, z: dir[2] * speed * mass }, true);
    }

    // Blast damage: fatal in line of sight; otherwise distance falloff times how much of it
    // gets through to the head, chest and pelvis.
    const alive = player.mode !== 'ragdoll';
    const body = player.body;
    const targets: Vec3[] = body && body.isEnabled
      ? [body.position('head'), body.position('chest'), body.position('pelvis')]
      : [add(player.pos, [0, 1.7, 0]), add(player.pos, [0, 1.3, 0]), add(player.pos, [0, 1.0, 0])];
    const chest = targets[1];
    const d = length(sub(chest, pos));
    const exposures = targets.map((p) => this.exposure(pos, p));
    const inSight = !exposures[1].covered;
    const exposure = exposures.reduce((sum, e) => sum + e.pass, 0) / exposures.length;
    const damage = inSight ? Infinity : Math.pow(spec.safeDistance / Math.max(d, 0.5), spec.falloff) * exposure;
    const away = normalize(add(sub(chest, pos), [0, 0.5, 0]));

    // Shrapnel flies before anyone gets launched, so it hits where you were standing.
    this.scorch(pos, spec);
    const hitBy = this.fireShrapnel(pos, spec.shrapnel);
    let byShrapnel = false;
    // How violent the death is: close and in plain sight tears you apart; far or behind cover doesn't.
    const violence = inSight ? Math.max(0, 44 - d) : Math.min(40, 9 * damage);
    if (alive && damage >= 1) {
      player.kill(scale(away, Math.min(28, 9 * damage)), { violence, origin: pos });
    } else if (alive && hitBy) {
      byShrapnel = true;
      player.kill(add(scale(hitBy, 10), scale(away, 3)), { violence: Math.max(violence, 16), origin: pos });
    } else if (alive && damage >= KNOCKDOWN_DAMAGE) {
      player.knock(scale(away, 9 * damage), 0.6 + 1.4 * damage);
    } else if (!alive && body && damage > 0) {
      // A body already lying around gets thrown about, and can come apart.
      for (const part of PART_NAMES) {
        const p = body.position(part);
        const push = Math.min(20, (9 * damage) / (1 + length(sub(p, pos)) / 4));
        body.parts[part].applyImpulse({ x: away[0] * push * 4, y: (away[1] + 0.4) * push * 4, z: away[2] * push * 4 }, true);
      }
      player.tearApart(violence, pos);
    }
    this.lastBlast = { at: this.t, pos, thrownOut, byShrapnel, inSight, big: spec !== GRENADES[0] };
  }

  /**
   * Fires straight-line fragments in random directions. Each one sticks where it lands and
   * shoves loose objects. Returns the direction of a fragment that hit the player, if any.
   */
  private fireShrapnel(origin: Vec3, count: number): Vec3 | null {
    const { physics, player } = this.ctx;
    let hitPlayer: Vec3 | null = null;
    for (let i = 0; i < count; i++) {
      const dir = randomDirection();
      const from = add(origin, scale(dir, 0.22));
      const hit = physics.raycast(from, dir, SHRAPNEL_RANGE, player.collider ?? undefined, GROUPS_QUERY_WITH_PLAYER);
      this.tracers.push({ from, to: hit ? hit.point : add(from, scale(dir, SHRAPNEL_RANGE)) });
      if (!hit) continue;
      const rb = hit.collider.parent();
      if (player.body?.owns(hit.collider)) hitPlayer = dir;
      if (rb && rb.isDynamic()) {
        rb.applyImpulseAtPoint(
          { x: dir[0] * SHRAPNEL_PUSH, y: dir[1] * SHRAPNEL_PUSH, z: dir[2] * SHRAPNEL_PUSH },
          { x: hit.point[0], y: hit.point[1], z: hit.point[2] },
          true,
        );
        const t = rb.translation(), q = rb.rotation();
        const inv = { x: -q.x, y: -q.y, z: -q.z, w: q.w };
        this.fragments.push({
          rb,
          pos: rotateByQuat(inv, sub(hit.point, [t.x, t.y, t.z])),
          normal: rotateByQuat(inv, hit.normal),
          spin: Math.random() * Math.PI,
          mark: null,
        });
      } else {
        this.fragments.push({
          rb: null, pos: hit.point, normal: hit.normal, spin: Math.random() * Math.PI, mark: faceBox(hit.collider, hit.normal),
        });
      }
    }
    return hitPlayer;
  }

  /**
   * Burns every floor or wall surface near the blast. Rays go out in all directions; the hits
   * are grouped by plane (so a wall built from several pieces, like the one with the hole, gets
   * one continuous mark), centred on the plane's closest hit and sized by how close it was. The
   * mark is drawn on each piece of that plane, clipped to the piece so it never overhangs an
   * edge. Loose objects and tiny faces aren't scorched.
   */
  private scorch(origin: Vec3, spec: GrenadeSpec) {
    const { physics } = this.ctx;
    const rays = 96;
    const planes = new Map<string, { point: Vec3; normal: Vec3; dist: number; colliders: Map<number, RAPIER.Collider> }>();
    for (let i = 0; i < rays; i++) {
      // Evenly spread directions (Fibonacci sphere).
      const y = 1 - (2 * (i + 0.5)) / rays;
      const r = Math.sqrt(1 - y * y);
      const a = i * Math.PI * (3 - Math.sqrt(5));
      const dir: Vec3 = [Math.cos(a) * r, y, Math.sin(a) * r];
      const hit = physics.raycast(origin, dir, spec.scorchRange);
      if (!hit || hit.collider.parent()?.isDynamic()) continue;
      const n = hit.normal;
      const key = `${Math.round(n[0])},${Math.round(n[1])},${Math.round(n[2])}|${Math.round(dot(n, hit.point) * 10)}`;
      let plane = planes.get(key);
      if (!plane) planes.set(key, (plane = { point: hit.point, normal: n, dist: hit.distance, colliders: new Map() }));
      if (hit.distance < plane.dist) Object.assign(plane, { point: hit.point, normal: n, dist: hit.distance });
      plane.colliders.set(hit.collider.handle, hit.collider);
    }
    for (const plane of planes.values()) {
      const radius = spec.scorchSize * (1 - plane.dist / spec.scorchRange);
      if (radius < 0.25) continue;
      const lift = 0.004 + this.scorches.length * 0.0015;
      for (const collider of plane.colliders.values()) {
        const face = faceBox(collider, plane.normal);
        if (!face) continue; // too small to bother (e.g. the blocks forming the hole's rim)
        this.scorches.push({ pos: plane.point, normal: plane.normal, radius, lift, clip: face });
      }
    }
  }

  /** True if no wall or other static geometry blocks the straight line from `from` to `to`. */
  private clearOfWalls(from: Vec3, to: Vec3): boolean {
    const delta = sub(to, from);
    const dist = length(delta);
    if (dist < 1e-3) return true;
    const dir = scale(delta, 1 / dist);
    const ray = new RAPIER.Ray({ x: from[0], y: from[1], z: from[2] }, { x: dir[0], y: dir[1], z: dir[2] });
    const hit = this.ctx.physics.world.castRay(ray, dist, true, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC, GROUPS_QUERY_WORLD);
    return hit === null;
  }

  /**
   * How much of the blast reaches `point`: `pass` is the fraction left after everything in the
   * way (each loose object soaks up more the heavier it is; a wall blocks it completely), and
   * `covered` says whether anything at all is in the way.
   */
  private exposure(from0: Vec3, point: Vec3): { pass: number; covered: boolean } {
    const { physics } = this.ctx;
    const from = add(from0, [0, 0.15, 0]);
    const delta = sub(point, from);
    const dist = length(delta);
    if (dist < 1e-3) return { pass: 1, covered: false };
    const dir = scale(delta, 1 / dist);
    const ray = new RAPIER.Ray({ x: from[0], y: from[1], z: from[2] }, { x: dir[0], y: dir[1], z: dir[2] });
    let pass = 1, covered = false;
    const seen = new Set<number>();
    physics.world.intersectionsWithRay(ray, dist, true, (hit) => {
      const c = hit.collider;
      if (seen.has(c.handle)) return true;
      seen.add(c.handle);
      if (!c.parent()?.isDynamic()) {
        pass = 0;
        covered = true;
        return false; // a wall: nothing gets through
      }
      pass *= coverPass(c.parent()!.mass());
      covered = true;
      return true;
    }, undefined, GROUPS_QUERY_WORLD);
    return { pass, covered };
  }

  private finish(status: LevelStatus, big: string, small: string, tips: [string, string][] = []) {
    this.status = status;
    this.ctx.hud.show(big, `${small}\n${pick(status === 'won' ? QUIPS.againWon : QUIPS.againLost)}`);
    this.ctx.hud.tips(tips);
  }

  draw(out: DrawItem[]) {
    this.arrival.draw(out);
    this.exit.draw(out);
    const g = this.grenade;
    if (g) {
      const t = g.body.rb.translation();
      const elapsed = g.spec.fuse - g.fuseLeft;
      const period = lerp(0.9, 0.08, Math.min(1, elapsed / g.spec.fuse));
      const lightOn = (elapsed % period) < period * 0.45;
      drawPineapple(out, fromQuat(g.body.rb.rotation(), [t.x, t.y, t.z]), g.spec.radius / 0.16, g.spec.color, lightOn);
    }

    for (const s of this.scorches) {
      const helper: Vec3 = Math.abs(s.normal[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      const x = normalize(cross(helper, s.normal));
      const z = cross(x, s.normal);
      out.push({
        mesh: 'cylinder',
        model: basis(scale(x, s.radius), scale(s.normal, 0.002), scale(z, s.radius), add(s.pos, scale(s.normal, s.lift))),
        color: [0.02, 0.02, 0.02],
        pattern: Pattern.blob,
        param: 0.85,
        shadow: false,
        clip: s.clip,
      });
    }
    for (const f of this.fragments) drawFragment(out, f);

    const blast = this.lastBlast;
    if (!blast) return;
    const e = this.t - blast.at;
    for (const tr of this.tracers) {
      out.push({ mesh: 'cylinder', model: segment(tr.from, tr.to, 0.012), color: [5, 2.6, 0.8], pattern: Pattern.emissive, shadow: false });
    }
    // A quick fireball that swells and collapses.
    if (e < 0.6) {
      const r = e < 0.12 ? lerp(0.3, 4.5, e / 0.12) : lerp(4.5, 0, (e - 0.12) / 0.48);
      const heat = 1 - e / 0.6;
      out.push({
        mesh: 'sphere',
        model: mul(translation(blast.pos), scaling([r, r, r])),
        color: [4 * heat + 0.8, 1.1 * heat + 0.15, 0.15 * heat],
        pattern: Pattern.emissive,
        shadow: false,
      });
    }
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

  trackedTargets(): TrackedTarget[] {
    const targets: TrackedTarget[] = [];
    const g = this.grenade;
    if (g) {
      const t = g.body.rb.translation();
      targets.push({ pos: [t.x, t.y, t.z], radius: g.spec.radius * 1.3 });
    }
    const exit = this.exit.target();
    if (exit) targets.push(exit);
    return targets;
  }
}

/** Faces smaller than this (m²) don't get scorch marks. */
const MIN_SCORCH_FACE = 0.6;

/**
 * The face of a box collider that points along `normal`, as a world-space box (slightly padded
 * so a decal lifted off the surface still fits). Null for non-boxes and tiny faces.
 */
function faceBox(collider: RAPIER.Collider, normal: Vec3): { min: Vec3; max: Vec3 } | null {
  const he = collider.halfExtents();
  if (!he) return null;
  const q = collider.rotation(), t = collider.translation();
  const axes = [rotateByQuat(q, [1, 0, 0]), rotateByQuat(q, [0, 1, 0]), rotateByQuat(q, [0, 0, 1])];
  const half = [he.x, he.y, he.z];
  let k = 0;
  for (let i = 1; i < 3; i++) if (Math.abs(dot(axes[i], normal)) > Math.abs(dot(axes[k], normal))) k = i;
  const [i, j] = [0, 1, 2].filter((a) => a !== k);
  if (4 * half[i] * half[j] < MIN_SCORCH_FACE) return null;
  const center = add([t.x, t.y, t.z], scale(axes[k], Math.sign(dot(axes[k], normal)) * half[k]));
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const si of [-1, 1]) for (const sj of [-1, 1]) {
    const c = add(center, add(scale(axes[i], si * half[i]), scale(axes[j], sj * half[j])));
    for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], c[a]); max[a] = Math.max(max[a], c[a]); }
  }
  // Room along the normal for the decal's lift; barely any sideways, so it can't overhang an edge.
  const pad = [0, 1, 2].map((ax) => 0.01 + Math.abs(normal[ax]) * 0.06);
  return { min: [min[0] - pad[0], min[1] - pad[1], min[2] - pad[2]], max: [max[0] + pad[0], max[1] + pad[1], max[2] + pad[2]] };
}

/** A "pineapple" frag grenade: segmented olive body, fuse cap, spoon lever and a blinking light. */
function drawPineapple(out: DrawItem[], m: Mat4, s: number, color: number[], lightOn: boolean) {
  const metal = [0.34, 0.35, 0.33];
  const dark = color.map((c) => c * 0.55);
  out.push({ mesh: 'sphere', model: mul(m, scaling([0.12 * s, 0.145 * s, 0.12 * s])), color: dark });
  // Rows of raised segments over an egg-shaped body.
  const rx = 0.128 * s, ry = 0.155 * s;
  for (let row = 0; row < 6; row++) {
    const lat = lerp(-1.05, 1.05, row / 5);
    for (let col = 0; col < 8; col++) {
      const lon = ((col + (row % 2) * 0.5) / 8) * Math.PI * 2;
      const n = normalize([Math.cos(lat) * Math.cos(lon) / rx, Math.sin(lat) / ry, Math.cos(lat) * Math.sin(lon) / rx]);
      const p: Vec3 = [Math.cos(lat) * Math.cos(lon) * rx, Math.sin(lat) * ry, Math.cos(lat) * Math.sin(lon) * rx];
      const east = normalize(cross([0, 1, 0], n));
      const north = cross(n, east);
      const size = 0.062 * s * (0.75 + 0.25 * Math.cos(lat));
      out.push({
        mesh: 'roundbox',
        model: mul(m, basis(scale(east, size), scale(north, 0.07 * s), scale(n, 0.035 * s), p)),
        color,
        spec: 0.25,
      });
    }
  }
  // Fuse assembly, spoon lever and the fuse light.
  out.push({ mesh: 'cylinder', model: mul(m, translation([0, 0.165 * s, 0]), scaling([0.045 * s, 0.06 * s, 0.045 * s])), color: metal, spec: 0.6 });
  out.push({ mesh: 'cylinder', model: mul(m, translation([0, 0.2 * s, 0]), scaling([0.032 * s, 0.03 * s, 0.032 * s])), color: metal, spec: 0.6 });
  out.push({
    mesh: 'box',
    model: mul(m, translation([0.075 * s, 0.1 * s, 0]), rotationZ(-0.22), scaling([0.022 * s, 0.19 * s, 0.05 * s])),
    color: metal,
    spec: 0.6,
  });
  out.push({
    mesh: 'sphere',
    model: mul(m, translation([0, 0.225 * s, 0]), scaling([0.028 * s, 0.028 * s, 0.028 * s])),
    color: lightOn ? [8, 0.4, 0.2] : [0.25, 0.03, 0.03],
    pattern: Pattern.emissive,
    shadow: false,
  });
}

function drawFragment(out: DrawItem[], f: Fragment) {
  let pos = f.pos, normal = f.normal;
  if (f.rb) {
    if (!f.rb.isValid()) return;
    const t = f.rb.translation(), q = f.rb.rotation();
    pos = add([t.x, t.y, t.z], rotateByQuat(q, f.pos));
    normal = rotateByQuat(q, f.normal);
  }
  const helper: Vec3 = Math.abs(normal[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const a = normalize(cross(helper, normal));
  const b = cross(normal, a);
  const c = Math.cos(f.spin), s = Math.sin(f.spin);
  const x = add(scale(a, c), scale(b, s)), z = add(scale(a, -s), scale(b, c));
  // A jagged metal chunk half-buried in the surface...
  out.push({
    mesh: 'roundbox',
    model: basis(scale(x, 0.1), scale(normal, 0.07), scale(z, 0.055), pos),
    color: [0.16, 0.15, 0.13],
    spec: 0.7,
    shadow: false,
  });
  // ...inside a dark impact mark that stops at the edge of its surface.
  if (!f.mark) return;
  out.push({
    mesh: 'cylinder',
    model: basis(scale(x, 0.16), scale(normal, 0.004), scale(z, 0.16), add(pos, scale(normal, 0.004))),
    color: [0.02, 0.02, 0.02],
    pattern: Pattern.blob,
    param: 0.75,
    shadow: false,
    clip: f.mark,
  });
}
