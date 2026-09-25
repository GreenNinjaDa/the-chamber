import {
  add, distXZ, fromQuat, length, lerp, mul, normalize, scale, scaling, sub, translation,
  type Quat, type Vec3,
} from '../../engine/math';
import { GROUPS_QUERY_WORLD, RAPIER, type Body } from '../../engine/physics';
import { Pattern, type DrawItem } from '../../engine/renderer';
import { CHAMBER_HALF } from '../../game/chamber';
import { DEFAULT_ENV, type CameraShot, type Level, type LevelContext, type LevelStatus } from '../level';

/*
 * Level 2 — Grenade.
 * A pile of junk crashes into the chamber, then a grenade drops in with a blinking fuse. When it
 * goes off, the damage depends on distance and on how much stuff is between it and you: every
 * object the blast has to pass through soaks some of it (heavier things soak more). Drag junk
 * into a wall, hide behind the fridge, get far away — or carry the grenade and throw it out.
 */

// --- Tuning -----------------------------------------------------------------------------------
/** Seconds from the grenade appearing to the explosion. */
const FUSE = 10;
/** When the junk starts falling, how far apart each piece drops, and when the grenade drops (s). */
const JUNK_START = 1.5;
const JUNK_INTERVAL = 0.22;
const GRENADE_DROP = 5;
/** Unshielded blast damage at distance d (m): BLAST_POWER / (d + 4) ^ BLAST_FALLOFF. 1 = dead. */
const BLAST_POWER = 100;
const BLAST_FALLOFF = 1.4;
/** Damage at or above this (but below 1) knocks you flat instead of killing you. */
const KNOCKDOWN_DAMAGE = 0.35;
/** Fraction of the blast a chamber wall lets through (the grenade was thrown outside). */
const WALL_PASS = 0.05;
/** Fraction of the blast a loose object without its own value lets through. */
const DEFAULT_PASS = 0.8;
/** Push on loose objects: impulse ≈ BLAST_PUSH / (d + 1), speed capped at BLAST_MAX_SPEED. */
const BLAST_PUSH = 900;
const BLAST_MAX_SPEED = 18;
const BLAST_PUSH_RANGE = 14;

interface JunkDef {
  name: string;
  size: Vec3;
  mass: number;
  color: number[];
  /** Fraction of the blast that gets through this object. */
  pass: number;
  shape?: 'box' | 'cylinder';
}

const JUNK: JunkDef[] = [
  { name: 'fridge', size: [0.9, 1.9, 0.8], mass: 120, color: [0.93, 0.94, 0.95], pass: 0.3 },
  { name: 'washing machine', size: [0.7, 0.9, 0.7], mass: 70, color: [0.85, 0.87, 0.9], pass: 0.4 },
  { name: 'bathtub', size: [1.7, 0.6, 0.8], mass: 90, color: [0.95, 0.95, 0.97], pass: 0.35 },
  { name: 'filing cabinet', size: [0.5, 1.3, 0.6], mass: 55, color: [0.45, 0.47, 0.5], pass: 0.45 },
  { name: 'bookcase', size: [1.0, 2.0, 0.35], mass: 45, color: [0.5, 0.33, 0.18], pass: 0.55 },
  { name: 'couch', size: [2.2, 0.8, 0.9], mass: 60, color: [0.45, 0.28, 0.18], pass: 0.6 },
  { name: 'mattress', size: [2.0, 0.25, 1.4], mass: 20, color: [0.75, 0.8, 0.9], pass: 0.7 },
  { name: 'crate', size: [0.8, 0.8, 0.8], mass: 20, color: [0.62, 0.45, 0.26], pass: 0.75 },
  { name: 'crate', size: [0.8, 0.8, 0.8], mass: 20, color: [0.62, 0.45, 0.26], pass: 0.75 },
  { name: 'crate', size: [0.6, 0.6, 0.6], mass: 12, color: [0.62, 0.45, 0.26], pass: 0.8 },
  { name: 'tire', size: [0.4, 0.25, 0.4], mass: 10, color: [0.08, 0.08, 0.09], pass: 0.85, shape: 'cylinder' },
  { name: 'tire', size: [0.4, 0.25, 0.4], mass: 10, color: [0.08, 0.08, 0.09], pass: 0.85, shape: 'cylinder' },
  { name: 'garden gnome', size: [0.15, 0.5, 0.15], mass: 5, color: [0.8, 0.15, 0.1], pass: 0.95, shape: 'cylinder' },
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
  ],
  died: [
    'Turns out running away has a maximum range.',
    'The garden gnome saw everything.',
    'You have been evenly redistributed.',
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

export class GrenadeLevel implements Level {
  readonly number = 2;
  readonly title = 'Grenade';
  status: LevelStatus = 'playing';

  private t = 0;
  private spawned = 0;
  /** Fraction of the blast each junk collider lets through, by collider handle. */
  private pass = new Map<number, number>();
  private grenade: Body | null = null;
  private fuseLeft = FUSE;
  private exploded = false;
  private explodedAt = 0;
  private blastPos: Vec3 = [0, 0, 0];
  private thrownOut = false;

  constructor(private ctx: LevelContext) {
    ctx.hud.setLevel(`The Chamber · Level ${this.number}`);
    ctx.hud.show(`LEVEL ${this.number}`, '', 2.5);
    ctx.hud.hint('');
  }

  update(dt: number) {
    this.t += dt;

    while (this.spawned < JUNK.length && this.t >= JUNK_START + this.spawned * JUNK_INTERVAL) {
      this.spawnJunk(JUNK[this.spawned]);
      this.spawned++;
    }
    if (!this.grenade && this.t >= GRENADE_DROP) this.dropGrenade();

    if (this.grenade && !this.exploded) {
      this.fuseLeft -= dt;
      if (this.fuseLeft <= 0) this.explode();
    }

    if (this.exploded && this.status === 'playing' && this.t - this.explodedAt > 1.4) {
      if (this.ctx.player.mode === 'ragdoll') this.finish('lost', 'BOOM', pick(QUIPS.died));
      else this.finish('won', 'SURVIVED', pick(this.thrownOut ? QUIPS.thrownOut : QUIPS.survived));
    }
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

  private dropGrenade() {
    const { physics, player } = this.ctx;
    let pos: Vec3 = [0, 12, 0];
    for (let tries = 0; tries < 50; tries++) {
      pos = [(Math.random() * 2 - 1) * 8, 12, (Math.random() * 2 - 1) * 8];
      if (distXZ(pos, player.pos) > 3) break;
    }
    this.grenade = physics.addBall(pos, 0.16, { mass: 0.6, color: [0.22, 0.3, 0.14], restitution: 0.3 });
  }

  private explode() {
    const { physics, player, camera } = this.ctx;
    const g = this.grenade!;
    const t = g.rb.translation();
    this.blastPos = [t.x, t.y, t.z];
    this.exploded = true;
    this.explodedAt = this.t;
    this.thrownOut = Math.abs(t.x) > CHAMBER_HALF || Math.abs(t.z) > CHAMBER_HALF;
    physics.remove(g);
    camera.addShake(1.2);

    // Shove loose objects away from the blast.
    for (const b of physics.bodies) {
      const p = b.rb.translation();
      const d = length(sub([p.x, p.y, p.z], this.blastPos));
      if (d > BLAST_PUSH_RANGE) continue;
      const dir = normalize(add(sub([p.x, p.y, p.z], this.blastPos), [0, 0.6, 0]));
      const mass = b.rb.mass();
      const speed = Math.min(BLAST_MAX_SPEED, BLAST_PUSH / (d + 1) / mass);
      b.rb.applyImpulse({ x: dir[0] * speed * mass, y: dir[1] * speed * mass, z: dir[2] * speed * mass }, true);
    }

    // Damage: distance falloff times how much of the blast reaches the head, chest and pelvis.
    const body = player.body;
    const targets: Vec3[] = body && body.isEnabled
      ? [body.position('head'), body.position('chest'), body.position('pelvis')]
      : [add(player.pos, [0, 1.7, 0]), add(player.pos, [0, 1.3, 0]), add(player.pos, [0, 1.0, 0])];
    const chest = targets[1];
    const d = length(sub(chest, this.blastPos));
    const exposure = targets.reduce((sum, p) => sum + this.exposure(p), 0) / targets.length;
    const damage = (BLAST_POWER / Math.pow(d + 4, BLAST_FALLOFF)) * exposure;
    const away = normalize(add(sub(chest, this.blastPos), [0, 0.5, 0]));
    if (damage >= 1) {
      player.kill(scale(away, Math.min(28, 9 * damage)));
    } else if (damage >= KNOCKDOWN_DAMAGE) {
      player.knock(scale(away, 9 * damage), 0.6 + 1.4 * damage);
    }
  }

  /** Fraction of the blast that reaches `point` after passing through everything in the way. */
  private exposure(point: Vec3): number {
    const { physics } = this.ctx;
    const from = add(this.blastPos, [0, 0.15, 0]);
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
    if (g && !this.exploded) {
      const t = g.rb.translation();
      const m = fromQuat(g.rb.rotation(), [t.x, t.y, t.z]);
      const metal = [0.35, 0.36, 0.34];
      out.push({ mesh: 'cylinder', model: mul(m, translation([0, 0.17, 0]), scaling([0.06, 0.1, 0.06])), color: metal, spec: 0.5 });
      out.push({ mesh: 'box', model: mul(m, translation([0.07, 0.08, 0]), scaling([0.03, 0.2, 0.05])), color: metal, spec: 0.5 });
      // Blinks faster as the fuse runs down.
      const elapsed = FUSE - this.fuseLeft;
      const period = lerp(0.9, 0.08, Math.min(1, elapsed / FUSE));
      const on = (elapsed % period) < period * 0.45;
      out.push({
        mesh: 'sphere',
        model: mul(m, translation([0, 0.24, 0]), scaling([0.04, 0.04, 0.04])),
        color: on ? [8, 0.4, 0.2] : [0.25, 0.03, 0.03],
        pattern: Pattern.emissive,
        shadow: false,
      });
    }

    if (this.exploded) {
      const e = this.t - this.explodedAt;
      // Scorch mark, then a quick fireball that swells and collapses.
      out.push({
        mesh: 'cylinder',
        model: mul(translation([this.blastPos[0], 0.02, this.blastPos[2]]), scaling([2.6, 0.02, 2.6])),
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
          model: mul(translation(this.blastPos), scaling([r, r, r])),
          color: [4 * heat + 0.8, 1.1 * heat + 0.15, 0.15 * heat],
          pattern: Pattern.emissive,
          shadow: false,
        });
      }
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
}
