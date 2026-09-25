import { add, fromQuat, rotateByQuat, type Mat4, type Quat, type Vec3 } from '../engine/math';
import { RAPIER, type Physics } from '../engine/physics';

export type PartName = 'torso' | 'head' | 'armL' | 'armR' | 'legL' | 'legR';

interface PartDef {
  name: PartName;
  /** Centre in the standing player's local space (feet at origin, facing -z). */
  center: Vec3;
  collider: () => RAPIER.ColliderDesc;
  mass: number;
}

const PARTS: PartDef[] = [
  { name: 'torso', center: [0, 1.2, 0], collider: () => RAPIER.ColliderDesc.cuboid(0.28, 0.36, 0.15), mass: 35 },
  { name: 'head', center: [0, 1.74, 0], collider: () => RAPIER.ColliderDesc.ball(0.22), mass: 6 },
  { name: 'armL', center: [-0.37, 1.17, 0], collider: () => RAPIER.ColliderDesc.capsule(0.25, 0.08), mass: 4 },
  { name: 'armR', center: [0.37, 1.17, 0], collider: () => RAPIER.ColliderDesc.capsule(0.25, 0.08), mass: 4 },
  { name: 'legL', center: [-0.14, 0.43, 0], collider: () => RAPIER.ColliderDesc.capsule(0.32, 0.11), mass: 10 },
  { name: 'legR', center: [0.14, 0.43, 0], collider: () => RAPIER.ColliderDesc.capsule(0.32, 0.11), mass: 10 },
];

// Ball joints: [child, anchor on torso, anchor on child] in each body's local space.
const JOINTS: [PartName, Vec3, Vec3][] = [
  ['head', [0, 0.42, 0], [0, -0.12, 0]],
  ['armL', [-0.37, 0.3, 0], [0, 0.33, 0]],
  ['armR', [0.37, 0.3, 0], [0, 0.33, 0]],
  ['legL', [-0.14, -0.34, 0], [0, 0.43, 0]],
  ['legR', [0.14, -0.34, 0], [0, 0.43, 0]],
];

/** Passive (limp) ragdoll: six rigid bodies joined with ball joints. */
export class Ragdoll {
  private parts = new Map<PartName, RAPIER.RigidBody>();

  constructor(physics: Physics, feet: Vec3, facing: number, velocity: Vec3) {
    const world = physics.world;
    const q: Quat = { x: 0, y: Math.sin(facing / 2), z: 0, w: Math.cos(facing / 2) };
    for (const def of PARTS) {
      const c = add(feet, rotateByQuat(q, def.center));
      const rb = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(c[0], c[1], c[2])
          .setRotation(q)
          .setLinvel(velocity[0], velocity[1], velocity[2])
          .setAngularDamping(0.6)
          .setLinearDamping(0.05)
          .setCcdEnabled(true),
      );
      world.createCollider(def.collider().setMass(def.mass).setFriction(0.8).setRestitution(0.15), rb);
      this.parts.set(def.name, rb);
    }
    const torso = this.parts.get('torso')!;
    for (const [child, a1, a2] of JOINTS) {
      const joint = world.createImpulseJoint(
        RAPIER.JointData.spherical({ x: a1[0], y: a1[1], z: a1[2] }, { x: a2[0], y: a2[1], z: a2[2] }),
        torso,
        this.parts.get(child)!,
        true,
      );
      joint.setContactsEnabled(false);
    }
    // A little tumble so deaths don't all look the same.
    torso.setAngvel({ x: (Math.random() - 0.5) * 6, y: (Math.random() - 0.5) * 4, z: (Math.random() - 0.5) * 6 }, true);
  }

  /** Adds an impulse (kg·m/s) to one body part, e.g. to punt the head. */
  applyImpulse(part: PartName, impulse: Vec3) {
    this.parts.get(part)!.applyImpulse({ x: impulse[0], y: impulse[1], z: impulse[2] }, true);
  }

  position(part: PartName): Vec3 {
    const t = this.parts.get(part)!.translation();
    return [t.x, t.y, t.z];
  }

  /** World transform of a part's centre. */
  transform(part: PartName): Mat4 {
    const rb = this.parts.get(part)!;
    const t = rb.translation();
    return fromQuat(rb.rotation(), [t.x, t.y, t.z]);
  }
}
