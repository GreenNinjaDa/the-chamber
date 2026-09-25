import RAPIER from '@dimforge/rapier3d-compat';
import { add, clamp, fromQuat, mul, scale, scaling, type Quat, type Vec3 } from './math';
import type { DrawItem, MeshName } from './renderer';

export { RAPIER };

let ready: Promise<void> | null = null;

/** Loads the Rapier WASM module. Await once before creating a `Physics`. */
export function initPhysics() {
  return (ready ??= RAPIER.init());
}

export const GRAVITY = 20;

/** A dynamic physics object that draws itself as one primitive. */
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

  constructor() {
    this.world = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 });
  }

  step(dt: number) {
    this.world.timestep = clamp(dt, 1 / 240, 1 / 30);
    this.world.step();
  }

  /** Static, invisible collision box (level geometry draws itself separately). */
  addStaticBox(center: Vec3, size: Vec3, rotation?: Quat): RAPIER.Collider {
    const desc = RAPIER.ColliderDesc.cuboid(size[0] / 2, size[1] / 2, size[2] / 2)
      .setTranslation(center[0], center[1], center[2]);
    if (rotation) desc.setRotation(rotation);
    return this.world.createCollider(desc);
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

  private addBody(desc: RAPIER.ColliderDesc, center: Vec3, mesh: MeshName, size: Vec3, opts: BodyOptions): Body {
    const rbDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(center[0], center[1], center[2])
      .setCcdEnabled(true);
    if (opts.rotation) rbDesc.setRotation(opts.rotation);
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

  raycast(origin: Vec3, dir: Vec3, maxDist: number, exclude?: RAPIER.Collider): RayHit | null {
    const ray = new RAPIER.Ray(
      { x: origin[0], y: origin[1], z: origin[2] },
      { x: dir[0], y: dir[1], z: dir[2] },
    );
    const hit = this.world.castRayAndGetNormal(ray, maxDist, true, undefined, undefined, exclude);
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
      const t = b.rb.translation();
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
