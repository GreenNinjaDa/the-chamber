import type { Input } from '../engine/input';
import {
  approachAngle, basis, cross, dot, length, mul, normalize, scale, sub, translation,
  type Mat4, type Vec3,
} from '../engine/math';
import { GROUPS_PLAYER_CAPSULE, GROUPS_QUERY_WORLD, RAPIER, type Body, type Physics } from '../engine/physics';
import type { DrawItem } from '../engine/renderer';
import { drawBody, PhysBody, poseFrames, REST_POSE, standingRoot, type Pose } from './body';

/**
 * control: walking around under player control (pos = feet); the physical body follows the
 *          animation (active ragdoll) and reacts to hard hits
 * held:    in the giant's hand (pos = feet)
 * flying / stuck / splat: body along `flightDir` (pos = body centre)
 * ragdoll: dead and limp; pos follows the body (≈ feet) so cameras keep working
 */
export type PlayerMode = 'control' | 'held' | 'flying' | 'stuck' | 'splat' | 'ragdoll';

export interface Circle {
  x: number;
  z: number;
  r: number;
}

export const PLAYER_RADIUS = 0.35;
const CAPSULE_HALF = 0.55; // + radius = 0.9 = half the player's height
const WALK_SPEED = 5;
const SPRINT_SPEED = 8.5;
const JUMP_SPEED = 7.5;
const GRAVITY = 22;

/** A hit knocks you loose if the other object's relative speed and momentum are at least this. */
const KNOCK_MIN_SPEED = 5;
const KNOCK_MIN_MOMENTUM = 25;
/** After a knock, muscles stay at this strength for the stun time, then recover over `RECOVER_TIME`. */
const STUNNED_MUSCLE = 0;
const RECOVER_TIME = 1.0;

export class Player {
  pos: Vec3 = [0, 0, 6];
  vel: Vec3 = [0, 0, 0];
  facing = 0;
  /** Head direction while flying; the body keeps it when it lands (stuck / splat). */
  flightDir: Vec3 = [0, 0, -1];
  mode: PlayerMode = 'control';
  onGround = true;
  /** The player's movement capsule; exclude it from ray casts. */
  collider: RAPIER.Collider | null = null;
  body: PhysBody | null = null;
  /** The collider of whatever the player is carrying (it never knocks them over). */
  carrying: RAPIER.Collider | null = null;
  /** Seconds left before muscles start recovering from a knock. */
  stun = 0;
  private physics: Physics | null = null;
  private controller: RAPIER.KinematicCharacterController | null = null;
  private walk = 0;
  private moveAmount = 0;
  private time = 0;
  private pose: Pose = REST_POSE;
  // The pelvis target advances smoothly through the physics substeps of each frame.
  private driveFeet: Vec3 = [0, 0, 0];
  private driveVel: Vec3 = [0, 0, 0];
  /** Loose objects near the player and their velocity just before the current physics step. */
  private incoming = new Map<Body, Vec3>();

  reset(pos: Vec3, facing = 0) {
    this.pos = [...pos];
    this.vel = [0, 0, 0];
    this.facing = facing;
    this.flightDir = [0, 0, -1];
    this.mode = 'control';
    this.onGround = true;
    this.stun = 0;
    this.pose = REST_POSE;
  }

  /** Gives the player a capsule, character controller and physical body in a (new) physics world. */
  attach(physics: Physics) {
    this.physics = physics;
    const c = this.center();
    this.collider = physics.world.createCollider(
      RAPIER.ColliderDesc.capsule(CAPSULE_HALF, PLAYER_RADIUS)
        .setTranslation(c[0], c[1], c[2])
        .setCollisionGroups(GROUPS_PLAYER_CAPSULE),
    );
    this.controller = physics.world.createCharacterController(0.02);
    this.controller.enableAutostep(0.35, 0.2, true);
    this.controller.enableSnapToGround(0.3);
    this.controller.setApplyImpulsesToDynamicBodies(true);
    this.controller.setCharacterMass(80);

    this.body = new PhysBody(physics, poseFrames(standingRoot(this.pos, this.facing), REST_POSE));
    this.driveFeet = [...this.pos];
    physics.substepHooks.push((h) => this.substep(h));
    physics.postStepHooks.push(() => this.checkHits());
  }

  private center(): Vec3 {
    return [this.pos[0], this.pos[1] + CAPSULE_HALF + PLAYER_RADIUS, this.pos[2]];
  }

  update(dt: number, input: Input, camYaw: number, obstacles: Circle[]) {
    this.time += dt;
    const stunned = this.stun > 0 || (this.body !== null && this.body.muscle < 0.5);
    this.stun = Math.max(0, this.stun - dt);
    if (this.body && this.stun <= 0 && this.body.muscle < 1) {
      this.body.muscle = Math.min(1, this.body.muscle + dt / RECOVER_TIME);
    }

    const fx = -Math.sin(camYaw), fz = -Math.cos(camYaw);
    const rx = Math.cos(camYaw), rz = -Math.sin(camYaw);
    let mx = 0, mz = 0;
    if (!stunned) {
      if (input.isDown('KeyW')) { mx += fx; mz += fz; }
      if (input.isDown('KeyS')) { mx -= fx; mz -= fz; }
      if (input.isDown('KeyD')) { mx += rx; mz += rz; }
      if (input.isDown('KeyA')) { mx -= rx; mz -= rz; }
    }
    const len = Math.hypot(mx, mz);
    if (len > 0) { mx /= len; mz /= len; }

    const sprint = input.isDown('ShiftLeft') || input.isDown('ShiftRight');
    const speed = sprint ? SPRINT_SPEED : WALK_SPEED;
    const k = 1 - Math.exp(-dt * (stunned ? 3 : this.onGround ? 14 : 4));
    this.vel[0] += (mx * speed - this.vel[0]) * k;
    this.vel[2] += (mz * speed - this.vel[2]) * k;

    if (this.onGround && !stunned && input.wasPressed('Space')) {
      this.vel[1] = JUMP_SPEED;
      this.onGround = false;
    }
    this.vel[1] -= GRAVITY * dt;

    const before: Vec3 = [...this.pos];
    let delta = scale(this.vel, dt);
    if (stunned && this.body) {
      // While knocked loose, the capsule is dragged along by the tumbling body.
      const p = this.body.position('pelvis');
      delta = [(p[0] - this.pos[0]) * Math.min(1, dt * 8), delta[1], (p[2] - this.pos[2]) * Math.min(1, dt * 8)];
    }
    this.move(delta, dt);

    const p = this.pos;
    for (const c of obstacles) {
      const dx = p[0] - c.x, dz = p[2] - c.z;
      const d = Math.hypot(dx, dz);
      const min = c.r + PLAYER_RADIUS;
      if (d < min && d > 1e-4) {
        p[0] = c.x + (dx / d) * min;
        p[2] = c.z + (dz / d) * min;
      }
    }

    const hs = Math.hypot(this.vel[0], this.vel[2]);
    this.moveAmount = Math.min(1, hs / WALK_SPEED);
    if (len > 0) this.facing = approachAngle(this.facing, Math.atan2(-mx, -mz), dt * 12);
    this.walk += dt * hs * 1.6;

    this.driveFeet = before;
    this.driveVel = dt > 0 ? scale(sub(this.pos, before), 1 / dt) : [0, 0, 0];
  }

  /** Moves by `delta`, sliding along walls, stepping up small ledges and pushing loose objects. */
  private move(delta: Vec3, dt: number) {
    const col = this.collider, ctrl = this.controller;
    if (!col || !ctrl) {
      this.pos = [this.pos[0] + delta[0], Math.max(0, this.pos[1] + delta[1]), this.pos[2] + delta[2]];
      this.onGround = this.pos[1] <= 0;
      if (this.onGround) this.vel[1] = Math.max(0, this.vel[1]);
      return;
    }
    // `pos` is the source of truth (levels may teleport the player), so sync the capsule first.
    const c = this.center();
    col.setTranslation({ x: c[0], y: c[1], z: c[2] });
    ctrl.computeColliderMovement(col, { x: delta[0], y: delta[1], z: delta[2] }, undefined, GROUPS_QUERY_WORLD);
    const m = ctrl.computedMovement();
    this.pos = [this.pos[0] + m.x, this.pos[1] + m.y, this.pos[2] + m.z];
    this.onGround = ctrl.computedGrounded();
    if (this.onGround && this.vel[1] < 0) this.vel[1] = 0;
    if (delta[1] > 0 && m.y < delta[1] * 0.5) this.vel[1] = Math.min(this.vel[1], 0); // bumped head
    if (dt > 0 && this.pos[1] < -20) this.pos[1] = 0; // fell out of the world
    const n = this.center();
    col.setTranslation({ x: n[0], y: n[1], z: n[2] });
  }

  /** Call once per tick before the physics step. */
  syncCollider() {
    if (this.mode !== 'control') {
      this.driveFeet = [...this.pos];
      this.driveVel = [0, 0, 0];
    }
    this.pose = this.computePose();
    if (!this.collider) return;
    if (this.mode === 'control') {
      const c = this.center();
      this.collider.setTranslation({ x: c[0], y: c[1], z: c[2] });
    }
  }

  /** Runs every physics substep: the active ragdoll follows the animation. */
  private substep(h: number) {
    const body = this.body;
    if (!body) return;
    this.recordIncoming();
    if (this.mode === 'ragdoll') {
      body.drive(h, poseFrames(standingRoot(this.pos, this.facing), this.pose), [0, 0, 0], this.pose);
      return;
    }
    if (this.mode !== 'control') {
      body.setEnabled(false); // scripted poses are drawn directly
      return;
    }
    this.driveFeet = [
      this.driveFeet[0] + this.driveVel[0] * h,
      this.driveFeet[1] + this.driveVel[1] * h,
      this.driveFeet[2] + this.driveVel[2] * h,
    ];
    const targets = poseFrames(standingRoot(this.driveFeet, this.facing), this.pose);
    if (!body.isEnabled) {
      body.teleport(targets, this.driveVel);
      body.setEnabled(true);
    }
    body.drive(h, targets, this.driveVel, this.pose);
  }

  /** Before a step: remember how fast nearby loose objects were moving. */
  private recordIncoming() {
    this.incoming.clear();
    if (this.mode !== 'control' || !this.physics) return;
    for (const b of this.physics.bodies) {
      const t = b.rb.translation();
      if (Math.hypot(t.x - this.pos[0], t.y - this.pos[1] - 1, t.z - this.pos[2]) > 4) continue;
      const v = b.rb.linvel();
      this.incoming.set(b, [v.x, v.y, v.z]);
    }
  }

  /** After a step: anything that just hit the body fast and heavy enough knocks the player loose. */
  private checkHits() {
    const body = this.body, physics = this.physics;
    if (!body || !physics || this.mode !== 'control' || this.stun > 0) return;
    for (const [b, v] of this.incoming) {
      if (this.carrying && b.collider.handle === this.carrying.handle) continue;
      const rel: Vec3 = [v[0] - this.vel[0], v[1] - this.vel[1], v[2] - this.vel[2]];
      const speed = length(rel);
      const momentum = speed * b.rb.mass();
      if (speed < KNOCK_MIN_SPEED || momentum < KNOCK_MIN_MOMENTUM) continue;
      let touching = false;
      physics.world.contactPairsWith(b.collider, (other) => {
        if (touching || !body.owns(other)) return;
        // Pairs are listed while merely close; require actual contact points.
        physics.world.contactPair(b.collider, other, (manifold) => {
          if (manifold.numContacts() > 0) touching = true;
        });
      });
      if (!touching) continue;
      this.knock(scale(normalize(rel), Math.min(9, momentum / 12)), 0.3 + Math.min(1.2, momentum / 150));
      return;
    }
  }

  /**
   * Knocks the player loose: muscles go slack for `stunSeconds`, the body is shoved by
   * `velocity` (m/s), then the player pulls themselves together.
   */
  knock(velocity: Vec3, stunSeconds: number) {
    if (this.mode !== 'control' || !this.body) return;
    this.body.muscle = STUNNED_MUSCLE;
    this.stun = stunSeconds;
    this.body.addVelocity(velocity);
    this.vel = [this.vel[0] + velocity[0] * 0.6, Math.max(this.vel[1], velocity[1] * 0.3), this.vel[2] + velocity[2] * 0.6];
  }

  /** Call once per tick after the physics step. */
  afterPhysics() {
    if (this.mode === 'ragdoll' && this.body) {
      const p = this.body.position('pelvis');
      this.pos = [p[0], p[1] - 0.98, p[2]];
    }
  }

  /** Goes limp with the given extra velocity (m/s). Comic deaths use this. */
  kill(launch: Vec3 = [0, 0, 0]) {
    const body = this.body;
    if (!body || this.mode === 'ragdoll') return;
    if (!body.isEnabled || this.mode !== 'control') {
      body.teleport(poseFrames(this.scriptedRoot(), this.pose));
      body.setEnabled(true);
    }
    body.muscle = 0;
    body.addVelocity([this.vel[0] + launch[0], this.vel[1] + launch[1], this.vel[2] + launch[2]]);
    // A little tumble so deaths don't all look the same.
    body.parts.chest.setAngvel({ x: (Math.random() - 0.5) * 8, y: (Math.random() - 0.5) * 5, z: (Math.random() - 0.5) * 8 }, true);
    this.mode = 'ragdoll';
    this.collider?.setEnabled(false);
  }

  private scriptedRoot(): Mat4 {
    const horizontal = this.mode === 'flying' || this.mode === 'stuck' || this.mode === 'splat';
    return horizontal
      ? mul(translation(this.pos), alongDirection(this.flightDir), translation([0, -0.9, 0]))
      : standingRoot(this.pos, this.facing);
  }

  private computePose(): Pose {
    const t = this.time;
    switch (this.mode) {
      case 'control': {
        if (!this.onGround) {
          return {
            lean: -0.1, headPitch: 0.1, shoulderL: -0.5, shoulderR: -0.5, armOut: 0.5, elbowL: 0.7, elbowR: 0.7,
            hipL: 0.7, hipR: -0.1, kneeL: -1.1, kneeR: -0.35,
          };
        }
        const a = this.moveAmount, s = Math.sin(this.walk), c = Math.cos(this.walk);
        return {
          lean: -0.12 * a,
          headPitch: 0.1 * a,
          shoulderL: s * 0.55 * a,
          shoulderR: -s * 0.55 * a,
          armOut: 0.08,
          elbowL: 0.2 + 0.45 * a,
          elbowR: 0.2 + 0.45 * a,
          hipL: -s * 0.6 * a,
          hipR: s * 0.6 * a,
          kneeL: -0.05 - (0.1 + 1.0 * Math.max(0, -c)) * a,
          kneeR: -0.05 - (0.1 + 1.0 * Math.max(0, c)) * a,
        };
      }
      case 'held':
        return {
          lean: 0.1, headPitch: -0.2,
          shoulderL: 2.3 + Math.sin(t * 14) * 0.6, shoulderR: 2.3 + Math.cos(t * 13) * 0.6, armOut: 0.4,
          elbowL: 0.6 + Math.sin(t * 11) * 0.5, elbowR: 0.6 + Math.cos(t * 12) * 0.5,
          hipL: Math.sin(t * 16) * 0.7, hipR: -Math.sin(t * 16) * 0.7,
          kneeL: -0.7 - Math.sin(t * 15) * 0.5, kneeR: -0.7 + Math.sin(t * 15) * 0.5,
        };
      case 'flying':
        return {
          lean: 0, headPitch: 0.3, shoulderL: Math.PI, shoulderR: Math.PI, armOut: 0.05, elbowL: 0, elbowR: 0,
          hipL: 0.05, hipR: 0.05, kneeL: -0.1 - Math.sin(t * 10) * 0.15, kneeR: -0.1 + Math.sin(t * 10) * 0.15,
        };
      case 'stuck':
      case 'splat':
        return { ...REST_POSE, shoulderL: Math.PI, shoulderR: Math.PI, armOut: 0.3, elbowL: 0.2, elbowR: 0.2 };
      default:
        return REST_POSE;
    }
  }

  draw(out: DrawItem[], _time: number) {
    const body = this.body;
    if (body && body.isEnabled && (this.mode === 'control' || this.mode === 'ragdoll')) {
      drawBody(out, body.frames());
    } else {
      drawBody(out, poseFrames(this.scriptedRoot(), this.pose));
    }
  }
}

/**
 * Rotation that points the body's head (+y) along `dir`, with the back (+z) kept as close
 * to world up as possible, so the player flies belly-down like a thrown dart.
 */
function alongDirection(dir: Vec3): Mat4 {
  const y = normalize(dir);
  const up: Vec3 = Math.abs(y[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0];
  const z = normalize(sub(up, scale(y, dot(up, y))));
  const x = cross(y, z);
  return basis(x, y, z, [0, 0, 0]);
}
