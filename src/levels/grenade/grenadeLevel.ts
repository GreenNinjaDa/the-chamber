import {
  add, basis, cross, distXZ, fromQuat, length, lerp, mul, normalize, rotateByQuat, rotationZ, scale, scaling,
  segment, sub, translation,
  type Mat4, type Quat, type Vec3,
} from '../../engine/math';
import { GROUPS_QUERY_WITH_PLAYER, GROUPS_QUERY_WORLD, RAPIER, type Body } from '../../engine/physics';
import { Pattern, type DrawItem } from '../../engine/renderer';
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
const JUNK_START = 1.5;
const JUNK_INTERVAL = 0.22;
const FIRST_GRENADE_AT = 5;
/** Seconds after surviving the first blast before the second grenade drops. */
const SECOND_GRENADE_DELAY = 3.5;
/** The hole in the north wall (centre height and radius, m). The grenades' radii are 0.16 and 0.24. */
const HOLE = { x: 0, y: 5, radius: 0.36 };
/** The chamber floor's diagonal (m), for distances like "80% of the way across". */
const CHAMBER_DIAGONAL = CHAMBER_HALF * 2 * Math.SQRT2;
/** Damage at or above this (but below 1) knocks you flat instead of killing you. */
const KNOCKDOWN_DAMAGE = 0.35;
/** Fraction of the blast a chamber wall lets through (the grenade went out through the hole). */
const WALL_PASS = 0.05;
/** Fraction of the blast a loose object without its own value lets through. */
const DEFAULT_PASS = 0.8;
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
  color: number[];
}

const GRENADES: GrenadeSpec[] = [
  {
    // Behind a fridge (lets 30% through) you live from about 6.6 m away.
    radius: 0.16, mass: 0.6, throwScale: 1, fuse: 10, safeDistance: 12, falloff: 2, shrapnel: 300,
    push: 900, maxSpeed: 18, pushRange: 14, color: [0.13, 0.16, 0.06],
  },
  {
    // 1.5x the size and much heavier. Behind any one object you live only from 80% of the way
    // across the chamber (safeDistance), and the steep falloff makes closer cover hopeless.
    radius: 0.24, mass: 2.5, throwScale: 0.85, fuse: 10, safeDistance: CHAMBER_DIAGONAL * 0.8, falloff: 3, shrapnel: 450,
    push: 2200, maxSpeed: 24, pushRange: 30, color: [0.09, 0.1, 0.05],
  },
];

interface JunkDef {
  size: Vec3;
  mass: number;
  color: number[];
  /** Fraction of the blast that gets through this object. */
  pass: number;
  shape?: 'box' | 'cylinder';
}

const JUNK: JunkDef[] = [
  { size: [0.9, 1.9, 0.8], mass: 120, color: [0.93, 0.94, 0.95], pass: 0.3 }, // fridge
  { size: [0.7, 0.9, 0.7], mass: 70, color: [0.85, 0.87, 0.9], pass: 0.4 }, // washing machine
  { size: [1.7, 0.6, 0.8], mass: 90, color: [0.95, 0.95, 0.97], pass: 0.35 }, // bathtub
  { size: [0.5, 1.3, 0.6], mass: 55, color: [0.45, 0.47, 0.5], pass: 0.45 }, // filing cabinet
  { size: [1.0, 2.0, 0.35], mass: 45, color: [0.5, 0.33, 0.18], pass: 0.55 }, // bookcase
  { size: [2.2, 0.8, 0.9], mass: 60, color: [0.45, 0.28, 0.18], pass: 0.6 }, // couch
  { size: [2.0, 0.25, 1.4], mass: 20, color: [0.75, 0.8, 0.9], pass: 0.7 }, // mattress
  { size: [0.8, 0.8, 0.8], mass: 20, color: [0.62, 0.45, 0.26], pass: 0.75 }, // crate
  { size: [0.8, 0.8, 0.8], mass: 20, color: [0.62, 0.45, 0.26], pass: 0.75 }, // crate
  { size: [0.6, 0.6, 0.6], mass: 12, color: [0.62, 0.45, 0.26], pass: 0.8 }, // small crate
  { size: [0.4, 0.25, 0.4], mass: 10, color: [0.08, 0.08, 0.09], pass: 0.85, shape: 'cylinder' }, // tire
  { size: [0.4, 0.25, 0.4], mass: 10, color: [0.08, 0.08, 0.09], pass: 0.85, shape: 'cylinder' }, // tire
  { size: [0.15, 0.5, 0.15], mass: 5, color: [0.8, 0.15, 0.1], pass: 0.95, shape: 'cylinder' }, // gnome
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
  /** Fraction of the blast each junk collider lets through, by collider handle. */
  private pass = new Map<number, number>();
  /** Index of the next grenade to drop, and when. */
  private nextGrenade = 0;
  private nextGrenadeAt = FIRST_GRENADE_AT;
  private grenade: LiveGrenade | null = null;
  private lastBlast: { at: number; pos: Vec3; thrownOut: boolean; byShrapnel: boolean } | null = null;
  private fragments: Fragment[] = [];
  private tracers: Tracer[] = [];

  constructor(private ctx: LevelContext) {
    ctx.hud.setLevel(`The Chamber · Level ${this.number}`);
    ctx.hud.show(`LEVEL ${this.number}`, '', 2.5);
    ctx.hud.hint('');
  }

  update(dt: number) {
    this.t += dt;
    const { player } = this.ctx;

    while (this.spawned < JUNK.length && this.t >= JUNK_START + this.spawned * JUNK_INTERVAL) {
      this.spawnJunk(JUNK[this.spawned]);
      this.spawned++;
    }
    if (!this.grenade && this.nextGrenade < GRENADES.length && this.t >= this.nextGrenadeAt && this.status === 'playing') {
      this.dropGrenade(GRENADES[this.nextGrenade]);
      this.nextGrenade++;
      this.nextGrenadeAt = Infinity;
    }
    if (this.grenade) {
      this.grenade.fuseLeft -= dt;
      if (this.grenade.fuseLeft <= 0) this.explode(this.grenade);
    }

    // Shortly after each blast, decide what happens next.
    const blast = this.lastBlast;
    if (blast && !this.grenade && this.status === 'playing' && this.t - blast.at > 1.4) {
      if (player.mode === 'ragdoll') {
        this.finish('lost', 'BOOM', pick(blast.byShrapnel ? QUIPS.shrapnel : QUIPS.died));
      } else if (this.nextGrenade >= GRENADES.length) {
        this.finish('won', 'SURVIVED', pick(blast.thrownOut ? QUIPS.thrownOut : QUIPS.survived));
      } else if (this.nextGrenadeAt === Infinity) {
        this.nextGrenadeAt = blast.at + 1.4 + SECOND_GRENADE_DELAY;
      }
    }
    if (this.tracers.length && blast && this.t - blast.at > 0.12) this.tracers = [];
  }

  private spawnJunk(def: JunkDef) {
    const { physics } = this.ctx;
    const pos: Vec3 = [(Math.random() * 2 - 1) * 9, 14 + Math.random() * 8, (Math.random() * 2 - 1) * 9];
    const opts = { mass: def.mass, color: def.color, rotation: randomRotation() };
    const body = def.shape === 'cylinder'
      ? physics.addCylinder(pos, def.size[0], def.size[1], opts)
      : physics.addBox(pos, def.size, opts);
    this.pass.set(body.collider.handle, def.pass);
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

    // Shove loose objects away from the blast.
    for (const b of physics.bodies) {
      const p = b.rb.translation();
      const d = length(sub([p.x, p.y, p.z], pos));
      if (d > spec.pushRange) continue;
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
    const inSight = exposures[1] >= 0.999;
    const exposure = exposures.reduce((sum, e) => sum + e, 0) / exposures.length;
    const damage = inSight ? Infinity : Math.pow(spec.safeDistance / Math.max(d, 0.5), spec.falloff) * exposure;
    const away = normalize(add(sub(chest, pos), [0, 0.5, 0]));

    // Shrapnel flies before anyone gets launched, so it hits where you were standing.
    const hitBy = this.fireShrapnel(pos, spec.shrapnel);
    let byShrapnel = false;
    if (alive && damage >= 1) {
      player.kill(scale(away, Math.min(28, 9 * damage)));
    } else if (alive && hitBy) {
      byShrapnel = true;
      player.kill(add(scale(hitBy, 10), scale(away, 3)));
    } else if (alive && damage >= KNOCKDOWN_DAMAGE) {
      player.knock(scale(away, 9 * damage), 0.6 + 1.4 * damage);
    }
    this.lastBlast = { at: this.t, pos, thrownOut, byShrapnel };
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
        });
      } else {
        this.fragments.push({ rb: null, pos: hit.point, normal: hit.normal, spin: Math.random() * Math.PI });
      }
    }
    return hitPlayer;
  }

  /** Fraction of the blast that reaches `point` after passing through everything in the way. */
  private exposure(from0: Vec3, point: Vec3): number {
    const { physics } = this.ctx;
    const from = add(from0, [0, 0.15, 0]);
    const delta = sub(point, from);
    const dist = length(delta);
    if (dist < 1e-3) return 1;
    const dir = scale(delta, 1 / dist);
    const ray = new RAPIER.Ray({ x: from[0], y: from[1], z: from[2] }, { x: dir[0], y: dir[1], z: dir[2] });
    let pass = 1;
    const seen = new Set<number>();
    physics.world.intersectionsWithRay(ray, dist, true, (hit) => {
      const c = hit.collider;
      if (seen.has(c.handle)) return true;
      seen.add(c.handle);
      const known = this.pass.get(c.handle);
      if (known !== undefined) pass *= known;
      else if (c.parent()?.isDynamic()) pass *= DEFAULT_PASS;
      else pass *= WALL_PASS;
      return true;
    }, undefined, GROUPS_QUERY_WORLD);
    return pass;
  }

  private finish(status: LevelStatus, big: string, small: string) {
    this.status = status;
    this.ctx.hud.show(big, `${small}\n${pick(status === 'won' ? QUIPS.againWon : QUIPS.againLost)}`);
  }

  draw(out: DrawItem[]) {
    const g = this.grenade;
    if (g) {
      const t = g.body.rb.translation();
      const elapsed = g.spec.fuse - g.fuseLeft;
      const period = lerp(0.9, 0.08, Math.min(1, elapsed / g.spec.fuse));
      const lightOn = (elapsed % period) < period * 0.45;
      drawPineapple(out, fromQuat(g.body.rb.rotation(), [t.x, t.y, t.z]), g.spec.radius / 0.16, g.spec.color, lightOn);
    }

    for (const f of this.fragments) drawFragment(out, f);

    const blast = this.lastBlast;
    if (!blast) return;
    const e = this.t - blast.at;
    for (const tr of this.tracers) {
      out.push({ mesh: 'cylinder', model: segment(tr.from, tr.to, 0.012), color: [5, 2.6, 0.8], pattern: Pattern.emissive, shadow: false });
    }
    // Scorch mark, then a quick fireball that swells and collapses.
    out.push({
      mesh: 'cylinder',
      model: mul(translation([blast.pos[0], 0.02, blast.pos[2]]), scaling([2.6, 0.02, 2.6])),
      color: [0.02, 0.02, 0.02],
      pattern: Pattern.blob,
      param: 0.85,
      shadow: false,
    });
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
    return null;
  }

  trackedTargets(): TrackedTarget[] {
    const g = this.grenade;
    if (!g) return [];
    const t = g.body.rb.translation();
    return [{ pos: [t.x, t.y, t.z], radius: g.spec.radius * 1.3 }];
  }
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
  // A jagged metal chunk half-buried in the surface, inside a dark impact mark.
  out.push({
    mesh: 'roundbox',
    model: basis(scale(x, 0.1), scale(normal, 0.07), scale(z, 0.055), pos),
    color: [0.16, 0.15, 0.13],
    spec: 0.7,
    shadow: false,
  });
  out.push({
    mesh: 'cylinder',
    model: basis(scale(x, 0.16), scale(normal, 0.004), scale(z, 0.16), add(pos, scale(normal, 0.004))),
    color: [0.02, 0.02, 0.02],
    pattern: Pattern.blob,
    param: 0.75,
    shadow: false,
  });
}
