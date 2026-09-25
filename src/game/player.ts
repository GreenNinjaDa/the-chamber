import type { Input } from '../engine/input';
import {
  approachAngle, basis, clamp, cross, dot, length, mul, normalize, scale, sub, translation,
  type Mat4, type Vec3,
} from '../engine/math';
import { GROUPS_PLAYER_CAPSULE, GROUPS_QUERY_WORLD, RAPIER, type Body, type Physics } from '../engine/physics';
import type { DrawItem } from '../engine/renderer';
import { crouchLegs, drawBody, PART_NAMES, PhysBody, poseFrames, REST_POSE, standingRoot, type PartName, type Pose } from './body';

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

// --- Movement -------------------------------------------------------------------------------
const WALK_SPEED = 5;
const SPRINT_SPEED = 8.5;
const JUMP_SPEED = 7.5;
const GRAVITY = 22;
/** How quickly the player reaches their target speed on the ground / in the air (higher = snappier). */
const GROUND_ACCEL = 14;
const AIR_ACCEL = 4;
/** How quickly the player turns to face their movement direction. */
const TURN_RATE = 12;

// --- Muscles ------------------------------------------------------------------------------
/**
 * How strong the player's muscles normally are: how firmly the body holds its animated pose
 * and how stiff the joints are. 1 = default; lower is floppier, higher is more robotic.
 */
const MUSCLE_STRENGTH = 0.3;

// --- Aiming the upper body at the camera --------------------------------------------------------
/** The torso twists this share of the way toward the camera's direction, up to AIM_MAX_TWIST (rad). */
const AIM_TWIST_SHARE = 0.7;
const AIM_MAX_TWIST = 0.9;
/**
 * Looking down bends you forward at the waist (share of the camera's pitch), up to AIM_MAX_BEND
 * (rad) — enough to duck behind low cover. Looking up leans back only a little.
 */
const AIM_BEND_SHARE = 0.85;
const AIM_MAX_BEND = 0.9;
const AIM_MAX_BACK_LEAN = 0.2;
/** How quickly the torso follows the camera (higher = snappier). */
const AIM_RATE = 8;
/** Standing still and looking down, you also crouch: the hips drop up to this much (m) at full bend. */
const AIM_MAX_CROUCH = 0.3;

/**
 * A hit to the head knocks you loose if the impact speed (m/s, into the surface) and momentum
 * (kg·m/s) are at least this. Hits anywhere else on the body need more of both.
 */
const KNOCK_MIN_SPEED = 6;
const KNOCK_MIN_MOMENTUM = 40;
const BODY_KNOCK_SPEED_SCALE = 1.5;
const BODY_KNOCK_MOMENTUM_SCALE = 5;
/** Static and scripted (non-physics) things count as this heavy; nothing counts as heavier. */
const NON_PHYSICS_MASS = 50;
const MAX_KNOCK_MASS = 50;
/** Objects up to this mass get pushed at walking speed; heavier ones move proportionally slower. */
const PUSH_MASS = 20;
// --- Knocked loose -------------------------------------------------------------------------
/** After a knock, muscles stay at this strength for the stun time, then recover over `RECOVER_TIME`. */
const STUNNED_MUSCLE = 0.07;
const RECOVER_TIME = 1;
/**
 * Getting up: body parts move at most this fast (m/s) and spin at most this fast (rad/s) while
 * pulling back into pose, so standing up is a visible scramble rather than a snap.
 */
const GETUP_SPEED = 1.6;
const GETUP_SPIN = 4;
/** You can move while getting up, at this fraction of your normal speed (no jumping). */
const GETUP_MOVE_SCALE = 0.2;
/** Getting up is done once the pelvis is back within this distance (m) of where it belongs. */
const GETUP_DONE_DISTANCE = 0.15;
/** If the body is stuck (e.g. pinned under crates), give up on the slow get-up after this long (s). */
const GETUP_MAX_TIME = 3;

// --- Violent deaths ---------------------------------------------------------------------------
/**
 * How violent a death is (by default the launch speed, m/s). From DISMEMBER_MIN_VIOLENCE up,
 * joints can tear apart; the chance per joint rises to DISMEMBER_MAX_CHANCE at
 * DISMEMBER_FULL_VIOLENCE. Torn-off parts fly off at about DISMEMBER_KICK x violence.
 */
const DISMEMBER_MIN_VIOLENCE = 18;
const DISMEMBER_FULL_VIOLENCE = 40;
const DISMEMBER_MAX_CHANCE = 0.9;
const DISMEMBER_KICK = 0.3;
/**
 * After standing back up, bumping into walls/bars/scripted things can't knock you again for
 * this long (s). Thrown and falling objects still can.
 */
const KNOCK_GRACE_TIME = 0.5;
/** Stun time scales with the hit's momentum: STUN_MIN at the knock threshold, up to STUN_MAX. */
const STUN_MIN = 0.1;
const STUN_MAX = 2.0;
const STUN_MAX_MOMENTUM = 400;

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
  /** True from a knock until the body is back on its feet. */
  gettingUp = false;
  private getUpTime = 0;
  private knockGrace = 0;
  private physics: Physics | null = null;
  private controller: RAPIER.KinematicCharacterController | null = null;
  private walk = 0;
  /** Current (smoothed) torso twist and waist bend toward the camera, and the camera's pitch. */
  private aimTwist = 0;
  private aimBend = 0;
  private aimPitch = 0;
  private moveAmount = 0;
  private time = 0;
  private pose: Pose = REST_POSE;
  // The pelvis target advances smoothly through the physics substeps of each frame.
  private driveFeet: Vec3 = [0, 0, 0];
  private driveVel: Vec3 = [0, 0, 0];
  /** Loose objects near the player and their velocity just before the current physics step. */
  private incoming = new Map<Body, Vec3>();
  /** Each body part's velocity just before the current physics step (by collider handle). */
  private partVelocity = new Map<number, Vec3>();

  reset(pos: Vec3, facing = 0) {
    this.pos = [...pos];
    this.vel = [0, 0, 0];
    this.facing = facing;
    this.flightDir = [0, 0, -1];
    this.mode = 'control';
    this.onGround = true;
    this.stun = 0;
    this.gettingUp = false;
    this.knockGrace = 0;
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
    // Pushing is done by hand in move(): the built-in version also shoves away anything that
    // flies into the (invisible, wider than the body) capsule, so nothing could ever hit the body.
    this.controller.setApplyImpulsesToDynamicBodies(false);

    this.body = new PhysBody(physics, poseFrames(standingRoot(this.pos, this.facing), REST_POSE));
    this.driveFeet = [...this.pos];
    physics.substepHooks.push((h) => this.substep(h));
    physics.postStepHooks.push(() => this.checkHits());
  }

  private center(): Vec3 {
    return [this.pos[0], this.pos[1] + CAPSULE_HALF + PLAYER_RADIUS, this.pos[2]];
  }

  update(dt: number, input: Input, camYaw: number, obstacles: Circle[], camPitch = 0) {
    this.time += dt;
    const stunned = this.stun > 0;
    this.stun = Math.max(0, this.stun - dt);
    this.knockGrace = Math.max(0, this.knockGrace - dt);
    if (this.body && this.stun <= 0 && this.body.muscle < 1) {
      this.body.muscle = Math.min(1, this.body.muscle + dt / RECOVER_TIME);
    }
    if (this.gettingUp && !stunned && this.body) {
      this.getUpTime += dt;
      const p = this.body.position('pelvis');
      const off = Math.hypot(p[0] - this.pos[0], p[1] - (this.pos[1] + 0.98), p[2] - this.pos[2]);
      if ((off < GETUP_DONE_DISTANCE && this.body.muscle >= 1) || this.getUpTime > GETUP_MAX_TIME) {
        this.gettingUp = false;
        this.knockGrace = KNOCK_GRACE_TIME;
      }
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
    const speed = (sprint ? SPRINT_SPEED : WALK_SPEED) * (this.gettingUp ? GETUP_MOVE_SCALE : 1);
    const k = 1 - Math.exp(-dt * (stunned ? 3 : this.onGround ? GROUND_ACCEL : AIR_ACCEL));
    this.vel[0] += (mx * speed - this.vel[0]) * k;
    this.vel[2] += (mz * speed - this.vel[2]) * k;

    if (this.onGround && !stunned && !this.gettingUp && input.wasPressed('Space')) {
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
    if (len > 0) this.facing = approachAngle(this.facing, Math.atan2(-mx, -mz), dt * TURN_RATE);

    // Aim the upper body toward where the camera looks.
    const rel = Math.atan2(Math.sin(camYaw - this.facing), Math.cos(camYaw - this.facing));
    const wantTwist = clamp(rel * AIM_TWIST_SHARE, -AIM_MAX_TWIST, AIM_MAX_TWIST);
    const wantBend = clamp(camPitch * AIM_BEND_SHARE, -AIM_MAX_BEND, AIM_MAX_BACK_LEAN);
    const ka = 1 - Math.exp(-dt * AIM_RATE);
    this.aimTwist += (wantTwist - this.aimTwist) * ka;
    this.aimBend += (wantBend - this.aimBend) * ka;
    this.aimPitch = camPitch;
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
    this.pushObstacles(ctrl);
    const n = this.center();
    col.setTranslation({ x: n[0], y: n[1], z: n[2] });
  }

  /** Pushes loose objects the capsule walked into, along the walking direction only. */
  private pushObstacles(ctrl: RAPIER.KinematicCharacterController) {
    for (let i = 0; i < ctrl.numComputedCollisions(); i++) {
      const hit = ctrl.computedCollision(i);
      const rb = hit?.collider?.parent();
      if (!hit || !rb || !rb.isDynamic()) continue;
      // Push along the horizontal line from the player to the object.
      const t = rb.translation();
      const dx = t.x - this.pos[0], dz = t.z - this.pos[2];
      const len = Math.hypot(dx, dz);
      if (len < 1e-3) continue;
      const nx = dx / len, nz = dz / len;
      const into = this.vel[0] * nx + this.vel[2] * nz;
      if (into <= 0) continue;
      // Light things get shoved along at walking speed; heavier ones only budge slowly.
      const mass = rb.mass();
      const target = into * Math.min(1, PUSH_MASS / mass);
      const v = rb.linvel();
      const dv = target - (v.x * nx + v.z * nz);
      if (dv <= 0) continue;
      rb.applyImpulse({ x: nx * dv * mass, y: 0, z: nz * dv * mass }, true);
    }
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
    // Record velocities before the animation drives the parts, so a limb being pulled
    // through an obstacle doesn't register as a fast impact.
    this.recordIncoming();
    body.strength = MUSCLE_STRENGTH;
    body.catchUpSpeed = this.gettingUp ? GETUP_SPEED : Infinity;
    body.catchUpSpin = this.gettingUp ? GETUP_SPIN : Infinity;
    // Limbs collide with each other only while the body is limp (dead or knocked loose).
    body.setSelfCollision(this.mode === 'ragdoll' || body.muscle < 0.3);
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
    const pelvis = body.position('pelvis');
    const farAway = Math.hypot(pelvis[0] - targets.pelvis[12], pelvis[1] - targets.pelvis[13], pelvis[2] - targets.pelvis[14]) > 2;
    // A teleported player snaps their body over rather than dragging it through the room.
    if (!body.isEnabled || (farAway && body.muscle > 0.5)) {
      body.teleport(targets, this.driveVel);
      body.setEnabled(true);
    }
    body.drive(h, targets, this.driveVel, this.pose);
  }

  /** Before a step: remember how fast nearby loose objects and each body part were moving. */
  private recordIncoming() {
    this.incoming.clear();
    this.partVelocity.clear();
    const body = this.body;
    if (this.mode !== 'control' || !this.physics || !body) return;
    for (const b of this.physics.bodies) {
      const t = b.rb.translation();
      if (Math.hypot(t.x - this.pos[0], t.y - this.pos[1] - 1, t.z - this.pos[2]) > 4) continue;
      const v = b.rb.linvel();
      this.incoming.set(b, [v.x, v.y, v.z]);
    }
    PART_NAMES.forEach((name, i) => this.partVelocity.set(body.colliders[i].handle, body.velocity(name)));
  }

  /**
   * After a step: find the hardest new impact on any body part and knock the player loose if
   * it clears that part's threshold (the head is more fragile than the rest of the body).
   *
   * Loose objects: fast hits are resolved by continuous collision detection and don't reliably
   * show up as contacts in the step they happen, so a hit is "this object was right next to a
   * body part and its velocity suddenly changed". The impact speed is how fast it was heading
   * toward that part. Mass counts up to `MAX_KNOCK_MASS`.
   *
   * Walls, bars and other non-physics things: actual contacts, with the impact speed measured
   * along the contact normal (so grazing past doesn't count), counting as `NON_PHYSICS_MASS`.
   * Only the head, chest and pelvis count: legs touch the floor all the time, and a swinging
   * hand clipping a wall shouldn't knock anyone out.
   */
  private checkHits() {
    const body = this.body, physics = this.physics;
    if (!body || !physics || this.mode !== 'control' || this.stun > 0) return;
    const world = physics.world;
    let best: { severity: number; rel: Vec3; momentum: number } | null = null;

    const consider = (name: PartName, rel: Vec3, impact: number, mass: number) => {
      const isHead = name === 'head';
      const minSpeed = KNOCK_MIN_SPEED * (isHead ? 1 : BODY_KNOCK_SPEED_SCALE);
      const minMomentum = KNOCK_MIN_MOMENTUM * (isHead ? 1 : BODY_KNOCK_MOMENTUM_SCALE);
      const momentum = impact * Math.min(mass, MAX_KNOCK_MASS);
      if (impact < minSpeed || momentum < minMomentum) return;
      const severity = clamp((momentum - minMomentum) / (STUN_MAX_MOMENTUM - minMomentum), 0, 1);
      if (!best || severity > best.severity) best = { severity, rel, momentum };
    };
    const partIndex = new Map(body.colliders.map((c, i) => [c.handle, i]));

    // Loose objects that just bounced off a body part.
    for (const [prop, vPre] of this.incoming) {
      if (this.carrying && prop.collider.handle === this.carrying.handle) continue;
      const lv = prop.rb.linvel();
      if (Math.hypot(lv.x - vPre[0], lv.y - vPre[1], lv.z - vPre[2]) < 1) continue;
      const t = prop.rb.translation();
      world.contactPairsWith(prop.collider, (other) => {
        const i = partIndex.get(other.handle);
        if (i === undefined) return;
        const name = PART_NAMES[i];
        const partVel = this.partVelocity.get(other.handle);
        if (!partVel) return;
        const rel = sub(vPre, partVel);
        const toPart = normalize(sub(body.position(name), [t.x, t.y, t.z]));
        consider(name, rel, dot(rel, toPart), prop.rb.mass());
      });
    }

    // Non-physics things the body ran into (not while scrambling back up, or just after).
    const canBump = !this.gettingUp && this.knockGrace <= 0;
    PART_NAMES.forEach((name, i) => {
      if (!canBump) return;
      if (name !== 'head' && name !== 'chest' && name !== 'pelvis') return;
      const part = body.colliders[i];
      const partVel = this.partVelocity.get(part.handle);
      if (!partVel) return;
      world.contactPairsWith(part, (other) => {
        const rb = other.parent();
        if (body.owns(other) || (rb && rb.isDynamic())) return;
        const lv = rb?.linvel();
        const rel = sub(lv ? [lv.x, lv.y, lv.z] : [0, 0, 0], partVel);
        world.contactPair(part, other, (manifold) => {
          if (manifold.numContacts() === 0 && manifold.numSolverContacts() === 0) return;
          const n = manifold.normal();
          consider(name, rel, Math.abs(rel[0] * n.x + rel[1] * n.y + rel[2] * n.z), NON_PHYSICS_MASS);
        });
      });
    });

    if (!best) return;
    const hit = best as { severity: number; rel: Vec3; momentum: number };
    this.knock(scale(normalize(hit.rel), Math.min(9, hit.momentum / 12)), STUN_MIN + (STUN_MAX - STUN_MIN) * hit.severity);
  }

  /**
   * Knocks the player loose: muscles go slack for `stunSeconds`, the body is shoved by
   * `velocity` (m/s), then the player pulls themselves together.
   */
  knock(velocity: Vec3, stunSeconds: number) {
    if (this.mode !== 'control' || !this.body) return;
    this.body.muscle = STUNNED_MUSCLE;
    this.stun = stunSeconds;
    this.gettingUp = true;
    this.getUpTime = 0;
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

  /**
   * Goes limp with the given extra velocity (m/s). Comic deaths use this. Violent enough deaths
   * (`violence`, default the launch speed) can tear the body apart, more so near `origin`.
   */
  kill(launch: Vec3 = [0, 0, 0], opts: { violence?: number; origin?: Vec3 } = {}) {
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
    this.tearApart(opts.violence ?? length(launch), opts.origin);
  }

  /** Rips joints apart if `violence` is high enough (dead bodies only). Returns joints broken. */
  tearApart(violence: number, origin?: Vec3): number {
    if (!this.body || this.mode !== 'ragdoll' || violence < DISMEMBER_MIN_VIOLENCE) return 0;
    const t = clamp((violence - DISMEMBER_MIN_VIOLENCE) / (DISMEMBER_FULL_VIOLENCE - DISMEMBER_MIN_VIOLENCE), 0, 1);
    return this.body.dismember(DISMEMBER_MAX_CHANCE * t, violence * DISMEMBER_KICK, origin);
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
            lean: -0.1 + this.aimBend * 0.5, twist: this.aimTwist, headPitch: 0.1, shoulderL: -0.5, shoulderR: -0.5, armOut: 0.5, elbowL: 0.7, elbowR: 0.7,
            hipL: 0.7, hipR: -0.1, kneeL: -1.1, kneeR: -0.35,
          };
        }
        const a = this.moveAmount, s = Math.sin(this.walk), c = Math.cos(this.walk);
        // Ducking: looking down while standing still also bends the knees.
        const crouch = AIM_MAX_CROUCH * clamp(-this.aimBend / AIM_MAX_BEND, 0, 1) * (1 - a);
        const legs = crouchLegs(crouch);
        return {
          crouch,
          lean: -0.12 * a + this.aimBend,
          twist: this.aimTwist,
          // Keep the head following the view rather than the bent-over chest.
          headPitch: clamp(this.aimPitch * 0.6 - this.aimBend, -0.5, 0.6) + 0.1 * a,
          shoulderL: s * 0.55 * a,
          shoulderR: -s * 0.55 * a,
          armOut: 0.08,
          elbowL: 0.2 + 0.45 * a,
          elbowR: 0.2 + 0.45 * a,
          hipL: -s * 0.6 * a + legs.hip,
          hipR: s * 0.6 * a + legs.hip,
          kneeL: -0.05 - (0.1 + 1.0 * Math.max(0, -c)) * a + legs.knee,
          kneeR: -0.05 - (0.1 + 1.0 * Math.max(0, c)) * a + legs.knee,
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
