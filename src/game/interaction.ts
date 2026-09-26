import type { Input } from '../engine/input';
import { add, clamp, length, normalize, rotateByQuat, scale, sub, type Vec3 } from '../engine/math';
import { GRAVITY, vec, type Body, type Physics, type Usable } from '../engine/physics';
import type { ThirdPersonCamera } from './camera';
import type { Player } from './player';

export type CrosshairState = 'hidden' | 'idle' | 'target' | 'holding';

/** How far from the player's chest things can be used or grabbed. */
const REACH = 3.2;
/** Objects up to this mass are carried; heavier ones can only be dragged along. */
const LIFT_MASS = 40;
/** Carried objects are held this far in front of the chest (m), however far away they were grabbed. */
const HOLD_MIN = 0.9;
const HOLD_MAX = 1.8;
/**
 * The most force the player can put into a carried object (N): enough to hold ~95 kg up, so a
 * lying fridge (120-150 kg) can be tipped upright by one end (that takes half its weight) but
 * not lifted clear of the floor, only dragged.
 */
const MAX_CARRY_FORCE = 95 * GRAVITY;
const HOLD_STIFFNESS = 10;
const MAX_HOLD_SPEED = 14;
const THROW_SPEED = 14;
/** Objects lighter than this (kg) are thrown faster, up to MAX_LIGHT_BOOST times the normal speed. */
const LIGHT_THROW_MASS = 1;
const MAX_LIGHT_BOOST = 1.15;

/**
 * Crosshair targeting plus the controls for things in the world. Any action button (E, left or
 * right click) uses what you're aiming at (levers, buttons), or on a loose object picks it up:
 * hold it to carry or drag it, and press any other action button meanwhile to throw it.
 */
export class Interaction {
  state: CrosshairState = 'hidden';
  private held: Body | null = null;
  /** Grab point in the held body's local space. */
  private grabLocal: Vec3 = [0, 0, 0];
  private holdDist = 3;
  private highlighted: Body | Usable | null = null;

  get holding() {
    return this.held;
  }

  update(dt: number, input: Input, camera: ThirdPersonCamera, player: Player, physics: Physics) {
    this.updateTargeting(dt, input, camera, player, physics);
    // Whatever you carry never knocks you over.
    player.carrying = this.held?.collider ?? null;
  }

  private updateTargeting(dt: number, input: Input, camera: ThirdPersonCamera, player: Player, physics: Physics) {
    if (this.highlighted) this.highlighted.highlight = 0;
    this.highlighted = null;
    if (this.held && !physics.bodies.includes(this.held)) this.held = null;

    if (player.mode !== 'control') {
      this.release();
      this.state = 'hidden';
      return;
    }

    const origin = camera.pos;
    const dir = normalize(sub(camera.target, camera.pos));
    const chest = add(player.pos, [0, 1.3, 0]);
    const camToChest = length(sub(chest, origin));

    if (this.held) {
      if (!input.actionDown) {
        this.release();
      } else if (input.actionPressed) {
        this.throw(dir);
      } else {
        this.drag(dt, origin, dir, camToChest);
      }
      this.state = this.held ? 'holding' : 'idle';
      if (this.held) this.setHighlight(this.held, 0.35);
      return;
    }

    const hit = physics.raycast(origin, dir, camToChest + REACH, player.collider ?? undefined);
    const inReach = hit !== null && length(sub(hit.point, chest)) <= REACH;
    const usable = hit && inReach ? physics.usableFor(hit.collider) : undefined;
    const body = hit && inReach ? physics.bodyFor(hit.collider) : undefined;

    if (usable) {
      this.setHighlight(usable, 1);
      if (input.actionPressed) usable.use();
      this.state = 'target';
    } else if (body?.grabbable && hit) {
      this.setHighlight(body, 1);
      if (input.actionPressed) this.grab(body, hit.point, hit.distance, camToChest);
      this.state = this.held ? 'holding' : 'target';
    } else {
      this.state = 'idle';
    }
  }

  private setHighlight(target: Body | Usable, amount: number) {
    target.highlight = amount;
    this.highlighted = target;
  }

  private grab(body: Body, point: Vec3, distance: number, camToChest: number) {
    const t = vec(body.rb.translation());
    const q = body.rb.rotation();
    const inv = { x: -q.x, y: -q.y, z: -q.z, w: q.w };
    this.grabLocal = rotateByQuat(inv, sub(point, t));
    this.holdDist = clamp(distance, camToChest + HOLD_MIN, camToChest + HOLD_MAX);
    this.held = body;
    // Steady light things in the hand; heavy ones need to be free to tip.
    body.rb.setAngularDamping(body.rb.mass() > LIFT_MASS ? 0.5 : 4);
    body.rb.wakeUp();
  }

  /**
   * Pulls the grab point toward a spot in front of the crosshair, with at most MAX_CARRY_FORCE:
   * light things follow closely, heavy ones can only be tipped or dragged.
   */
  private drag(dt: number, origin: Vec3, dir: Vec3, camToChest: number) {
    const body = this.held!;
    const rb = body.rb;
    const target = add(origin, scale(dir, clamp(this.holdDist, camToChest + HOLD_MIN, camToChest + HOLD_MAX)));
    const grabWorld = add(vec(rb.translation()), rotateByQuat(rb.rotation(), this.grabLocal));
    const toTarget = sub(target, grabWorld);
    if (length(toTarget) > 4.5) {
      this.release(); // snagged on something
      return;
    }
    const mass = rb.mass();
    let desired = scale(toTarget, HOLD_STIFFNESS);
    const speed = length(desired);
    if (speed > MAX_HOLD_SPEED) desired = scale(desired, MAX_HOLD_SPEED / speed);
    const dv = sub(desired, vec(rb.linvel()));
    let impulse = scale(dv, mass * 0.5);
    impulse[1] += GRAVITY * dt * mass; // hold it up against gravity...
    const cap = MAX_CARRY_FORCE * dt; // ...but only as hard as the player can pull
    const magnitude = length(impulse);
    if (magnitude > cap) impulse = scale(impulse, cap / magnitude);
    rb.applyImpulseAtPoint({ x: impulse[0], y: impulse[1], z: impulse[2] }, { x: grabWorld[0], y: grabWorld[1], z: grabWorld[2] }, true);
  }

  private throw(dir: Vec3) {
    const rb = this.held!.rb;
    const strength = clamp(LIFT_MASS / rb.mass(), 0.05, 1);
    const light = clamp(Math.sqrt(LIGHT_THROW_MASS / rb.mass()), 1, MAX_LIGHT_BOOST);
    const v = scale(dir, THROW_SPEED * strength * light * this.held!.throwScale);
    rb.setLinvel({ x: v[0], y: v[1] + 2 * strength, z: v[2] }, true);
    this.release();
  }

  release() {
    if (this.held) this.held.rb.setAngularDamping(this.held.angularDamping);
    this.held = null;
  }
}
