import RAPIER from '@dimforge/rapier3d-compat';
import { add, fromQuat, mul, scale, scaling, type Mat4, type Quat, type Vec3 } from './math';
import type { DrawItem, MeshName } from './renderer';

export { RAPIER };

let ready: Promise<void> | null = null;

/** Loads the Rapier WASM module. Await once before creating a `Physics`. */
export function initPhysics() {
  return (ready ??= RAPIER.init());
}

export const GRAVITY = 20;
/** Physics runs at a fixed 120 Hz, independent of frame rate, for stable joints and motors. */
export const FIXED_STEP = 1 / 120;
const MAX_SUBSTEPS = 8;
/** Rapier has no rolling resistance, so balls and barrels get spin damping to stop rolling. */
const ROLLING_DAMPING = 1.2;

// Collision groups: (membership << 16) | filter. Everything else uses the default (all/all).
const BODY_BIT = 0x0002; // the player's physical body parts
const CAPSULE_BIT = 0x0004; // the player's movement capsule
const BRIDGE_BIT = 0x0008; // invisible floors only boulders use (e.g. over pits the player must jump)
const BOULDER_BIT = 0x0010; // rolling boulders
/** An invisible surface that only boulders touch. */
export const GROUPS_BOULDER_BRIDGE = (BRIDGE_BIT << 16) | BOULDER_BIT;
/** A boulder: hits everything, including boulder bridges. */
export const GROUPS_BOULDER = (BOULDER_BIT << 16) | 0xffff;
/** Player body parts while animated: collide with the world and props, but not each other. */
export const GROUPS_PLAYER_BODY = (BODY_BIT << 16) | (0xffff & ~BODY_BIT & ~CAPSULE_BIT & ~BRIDGE_BIT);
/** Player body parts while limp: also collide with each other (jointed pairs have contacts off). */
export const GROUPS_PLAYER_BODY_LIMP = (BODY_BIT << 16) | (0xffff & ~CAPSULE_BIT & ~BRIDGE_BIT);
/** Movement capsule: takes part in no contacts at all; only the character controller queries use it. */
export const GROUPS_PLAYER_CAPSULE = CAPSULE_BIT << 16;
/** For queries that should also hit the player's body parts (but not the movement capsule). */
export const GROUPS_QUERY_WITH_PLAYER = (0xffff << 16) | (0xffff & ~CAPSULE_BIT & ~BRIDGE_BIT);
/** For queries that should see the world and props but not the player. */
export const GROUPS_QUERY_WORLD = (0xffff << 16) | (0xffff & ~BODY_BIT & ~CAPSULE_BIT & ~BRIDGE_BIT);



/** A dynamic physics object that draws itself as one primitive. */
/** Draws a body's custom model; `m` is the body's world transform (origin at its centre). */
export type BodyModel = (out: DrawItem[], m: Mat4) => void;

export interface Body {
  rb: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  mesh: MeshName;
  /** Scale applied to the unit mesh (box: full extents, sphere: radius, cylinder: radius/height/radius). */
  size: Vec3;
  color: number[];
  pattern?: number;
  param?: number;
  grabbable: boolean;
  /** Set each frame by the interaction system when targeted. */
  highlight: number;
  /** Resting angular damping (gives rounded things a little rolling resistance). */
  angularDamping: number;
  /** Skip the default primitive drawing (the owner draws a custom model). */
  hidden: boolean;
  /** Custom model drawn in the body's frame (origin at its centre) instead of the plain primitive. */
  model?: BodyModel;
  /** Multiplies the player's throw speed for this object. */
  throwScale: number;
}

/** Anything the player can press E on (levers, buttons...). */
export interface Usable {
  use(): void;
  highlight: number;
}

export interface Drawable {
  draw(out: DrawItem[], time: number): void;
}

export interface BodyOptions {
  color?: number[];
  /** Mass in kg. Anything much above ~40 kg is too heavy to lift and can only be dragged. */
  mass?: number;
  grabbable?: boolean;
  rotation?: Quat;
  friction?: number;
  restitution?: number;
  pattern?: number;
  param?: number;
  hidden?: boolean;
  model?: BodyModel;
  throwScale?: number;
}

export interface RayHit {
  collider: RAPIER.Collider;
  point: Vec3;
  normal: Vec3;
  distance: number;
}

/** One Rapier world per level attempt, plus the bookkeeping to draw and interact with it. */
export class Physics {
  readonly world: RAPIER.World;
  readonly bodies: Body[] = [];
  private byCollider = new Map<number, Body>();
  private usables = new Map<number, Usable>();
  private drawables: Drawable[] = [];
  private accumulator = 0;
  /** Called before every fixed physics step with the step length (for motors, active ragdolls...). */
  readonly substepHooks: ((h: number) => void)[] = [];
  /** Called after every fixed physics step (for reacting to contacts). */
  readonly postStepHooks: (() => void)[] = [];

  constructor() {
    this.world = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 });
    this.world.timestep = FIXED_STEP;
  }

  /** Advances the simulation by `dt` in fixed steps. */
  step(dt: number) {
    this.accumulator = Math.min(this.accumulator + dt, FIXED_STEP * MAX_SUBSTEPS);
    while (this.accumulator >= FIXED_STEP) {
      this.accumulator -= FIXED_STEP;
      for (const hook of this.substepHooks) hook(FIXED_STEP);
      this.world.step();
      for (const hook of this.postStepHooks) hook();
    }
  }

  /** Points gravity along `down` (a unit vector), at the usual strength. */
  setGravityDirection(down: Vec3) {
    this.world.gravity = { x: down[0] * GRAVITY, y: down[1] * GRAVITY, z: down[2] * GRAVITY };
  }

  /** Static, invisible collision box (level geometry draws itself separately). */
  addStaticBox(center: Vec3, size: Vec3, rotation?: Quat): RAPIER.Collider {
    const desc = RAPIER.ColliderDesc.cuboid(size[0] / 2, size[1] / 2, size[2] / 2)
      .setTranslation(center[0], center[1], center[2]);
    if (rotation) desc.setRotation(rotation);
    return this.world.createCollider(desc);
  }

  /** Static, invisible upright cylinder; returns the collider so it can be moved (e.g. a plate that sinks). */
  addStaticCylinder(center: Vec3, radius: number, height: number): RAPIER.Collider {
    return this.world.createCollider(
      RAPIER.ColliderDesc.cylinder(height / 2, radius).setTranslation(center[0], center[1], center[2]),
    );
  }

  addBox(center: Vec3, size: Vec3, opts: BodyOptions = {}): Body {
    const desc = RAPIER.ColliderDesc.cuboid(size[0] / 2, size[1] / 2, size[2] / 2);
    return this.addBody(desc, center, 'box', size, opts);
  }

  addBall(center: Vec3, radius: number, opts: BodyOptions = {}): Body {
    return this.addBody(RAPIER.ColliderDesc.ball(radius), center, 'sphere', [radius, radius, radius], opts);
  }

  addCylinder(center: Vec3, radius: number, height: number, opts: BodyOptions = {}): Body {
    const desc = RAPIER.ColliderDesc.cylinder(height / 2, radius);
    return this.addBody(desc, center, 'cylinder', [radius, height, radius], opts);
  }

  /** Cone along y: base (radius) at the bottom, apex at the top, centred on its mid-height. */
  addCone(center: Vec3, radius: number, height: number, opts: BodyOptions = {}): Body {
    const desc = RAPIER.ColliderDesc.cone(height / 2, radius);
    return this.addBody(desc, center, 'cone', [radius, height, radius], opts);
  }

  /**
   * Capsule along y (`length` is the straight part). There's no capsule mesh, so give it a
   * `model`; its size is [radius, full length, radius].
   */
  addCapsule(center: Vec3, radius: number, length: number, opts: BodyOptions = {}): Body {
    const desc = RAPIER.ColliderDesc.capsule(length / 2, radius);
    return this.addBody(desc, center, 'cylinder', [radius, length + radius * 2, radius], opts);
  }

  private addBody(desc: RAPIER.ColliderDesc, center: Vec3, mesh: MeshName, size: Vec3, opts: BodyOptions): Body {
    const rbDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(center[0], center[1], center[2])
      .setCcdEnabled(true);
    if (opts.rotation) rbDesc.setRotation(opts.rotation);
    const angularDamping = mesh === 'sphere' || mesh === 'cylinder' || mesh === 'cone' ? ROLLING_DAMPING : 0;
    rbDesc.setAngularDamping(angularDamping);
    const rb = this.world.createRigidBody(rbDesc);
    desc.setMass(opts.mass ?? 20)
      .setFriction(opts.friction ?? 0.7)
      .setRestitution(opts.restitution ?? 0.1);
    const collider = this.world.createCollider(desc, rb);
    const body: Body = {
      rb,
      collider,
      mesh,
      size,
      color: opts.color ?? [0.7, 0.55, 0.35],
      pattern: opts.pattern,
      param: opts.param,
      grabbable: opts.grabbable ?? true,
      highlight: 0,
      angularDamping,
      hidden: opts.hidden ?? false,
      model: opts.model,
      throwScale: opts.throwScale ?? 1,
    };
    this.bodies.push(body);
    this.byCollider.set(collider.handle, body);
    return body;
  }

  remove(body: Body) {
    const i = this.bodies.indexOf(body);
    if (i < 0) return;
    this.bodies.splice(i, 1);
    this.byCollider.delete(body.collider.handle);
    this.world.removeRigidBody(body.rb);
  }

  registerUsable(collider: RAPIER.Collider, usable: Usable) {
    this.usables.set(collider.handle, usable);
  }

  addDrawable(d: Drawable) {
    this.drawables.push(d);
  }

  bodyFor(collider: RAPIER.Collider) {
    return this.byCollider.get(collider.handle);
  }

  usableFor(collider: RAPIER.Collider) {
    return this.usables.get(collider.handle);
  }

  raycast(origin: Vec3, dir: Vec3, maxDist: number, exclude?: RAPIER.Collider, groups = GROUPS_QUERY_WORLD): RayHit | null {
    const ray = new RAPIER.Ray(
      { x: origin[0], y: origin[1], z: origin[2] },
      { x: dir[0], y: dir[1], z: dir[2] },
    );
    const hit = this.world.castRayAndGetNormal(ray, maxDist, true, undefined, groups, exclude);
    if (!hit) return null;
    return {
      collider: hit.collider,
      point: add(origin, scale(dir, hit.timeOfImpact)),
      normal: [hit.normal.x, hit.normal.y, hit.normal.z],
      distance: hit.timeOfImpact,
    };
  }

  draw(out: DrawItem[], time: number) {
    for (const b of this.bodies) {
      if (b.hidden) continue;
      const t = b.rb.translation();
      if (b.model) {
        const first = out.length;
        b.model(out, fromQuat(b.rb.rotation(), [t.x, t.y, t.z]));
        if (b.highlight) for (let i = first; i < out.length; i++) out[i].highlight = b.highlight;
        continue;
      }
      out.push({
        mesh: b.mesh,
        model: mul(fromQuat(b.rb.rotation(), [t.x, t.y, t.z]), scaling(b.size)),
        color: b.color,
        pattern: b.pattern,
        param: b.param,
        highlight: b.highlight,
      });
    }
    for (const d of this.drawables) d.draw(out, time);
  }

  dispose() {
    this.world.free();
  }
}

export function vec(v: { x: number; y: number; z: number }): Vec3 {
  return [v.x, v.y, v.z];
}
