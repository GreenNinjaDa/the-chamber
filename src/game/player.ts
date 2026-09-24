import type { Input } from '../engine/input';
import {
  approachAngle, clamp, mul, rotationX, rotationY, scaling, translation,
  type Mat4, type Vec3,
} from '../engine/math';
import type { DrawItem } from '../engine/renderer';
import { CHAMBER_HALF } from './chamber';

/**
 * control: walking around under player control (pos = feet)
 * held:    in the giant's hand (pos = feet)
 * flying / stuck / splat: body horizontal, head toward -z (pos = body centre)
 */
export type PlayerMode = 'control' | 'held' | 'flying' | 'stuck' | 'splat';

export interface Circle {
  x: number;
  z: number;
  r: number;
}

export const PLAYER_RADIUS = 0.35;
const WALK_SPEED = 5;
const SPRINT_SPEED = 8.5;
const JUMP_SPEED = 7.5;
const GRAVITY = 22;

const SUIT = [0.95, 0.4, 0.07];
const PANTS = [0.18, 0.19, 0.22];
const SKIN = [0.8, 0.58, 0.45];
const HAIR = [0.12, 0.08, 0.05];
const PACK = [0.35, 0.37, 0.4];

export class Player {
  pos: Vec3 = [0, 0, 6];
  vel: Vec3 = [0, 0, 0];
  facing = 0;
  mode: PlayerMode = 'control';
  onGround = true;
  private walk = 0;
  private moveAmount = 0;

  reset(pos: Vec3, facing = 0) {
    this.pos = [...pos];
    this.vel = [0, 0, 0];
    this.facing = facing;
    this.mode = 'control';
    this.onGround = true;
  }

  update(dt: number, input: Input, camYaw: number, obstacles: Circle[]) {
    const fx = -Math.sin(camYaw), fz = -Math.cos(camYaw);
    const rx = Math.cos(camYaw), rz = -Math.sin(camYaw);
    let mx = 0, mz = 0;
    if (input.isDown('KeyW')) { mx += fx; mz += fz; }
    if (input.isDown('KeyS')) { mx -= fx; mz -= fz; }
    if (input.isDown('KeyD')) { mx += rx; mz += rz; }
    if (input.isDown('KeyA')) { mx -= rx; mz -= rz; }
    const len = Math.hypot(mx, mz);
    if (len > 0) { mx /= len; mz /= len; }

    const sprint = input.isDown('ShiftLeft') || input.isDown('ShiftRight');
    const speed = sprint ? SPRINT_SPEED : WALK_SPEED;
    const k = 1 - Math.exp(-dt * (this.onGround ? 14 : 4));
    this.vel[0] += (mx * speed - this.vel[0]) * k;
    this.vel[2] += (mz * speed - this.vel[2]) * k;

    if (this.onGround && input.wasPressed('Space')) {
      this.vel[1] = JUMP_SPEED;
      this.onGround = false;
    }
    this.vel[1] -= GRAVITY * dt;

    const p = this.pos;
    p[0] += this.vel[0] * dt;
    p[1] += this.vel[1] * dt;
    p[2] += this.vel[2] * dt;
    if (p[1] <= 0) {
      p[1] = 0;
      this.vel[1] = 0;
      this.onGround = true;
    }

    const lim = CHAMBER_HALF - PLAYER_RADIUS;
    p[0] = clamp(p[0], -lim, lim);
    p[2] = clamp(p[2], -lim, lim);
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
  }

  draw(out: DrawItem[], time: number) {
    const horizontal = this.mode === 'flying' || this.mode === 'stuck' || this.mode === 'splat';
    const root = horizontal
      ? mul(translation(this.pos), rotationY(this.facing), rotationX(-Math.PI / 2), translation([0, -0.9, 0]))
      : mul(translation(this.pos), rotationY(this.facing));

    let armL = 0, armR = 0, legL = 0, legR = 0;
    if (this.mode === 'control') {
      const s = Math.sin(this.walk) * 0.8 * this.moveAmount;
      armL = s; armR = -s; legL = -s; legR = s;
      if (!this.onGround) { armL = armR = -0.6; legL = 0.5; legR = -0.2; }
    } else if (this.mode === 'held') {
      armL = Math.PI * 0.7 + Math.sin(time * 14) * 0.6;
      armR = Math.PI * 0.7 + Math.cos(time * 13) * 0.6;
      legL = Math.sin(time * 16) * 0.7;
      legR = -legL;
    } else if (this.mode === 'flying') {
      armL = armR = Math.PI;
      legL = Math.sin(time * 10) * 0.15;
      legR = -legL;
    } else {
      armL = armR = Math.PI;
    }

    const part = (mesh: 'box' | 'sphere', m: Mat4, color: number[]) => out.push({ mesh, model: m, color });
    const limb = (pivot: Vec3, angle: number, size: Vec3, color: number[]) =>
      part('box', mul(root, translation(pivot), rotationX(angle), translation([0, -size[1] / 2, 0]), scaling(size)), color);

    part('box', mul(root, translation([0, 1.2, 0]), scaling([0.56, 0.72, 0.3])), SUIT);
    part('box', mul(root, translation([0, 1.22, 0.2]), scaling([0.42, 0.5, 0.14])), PACK);
    part('sphere', mul(root, translation([0, 1.74, 0]), scaling([0.21, 0.23, 0.21])), SKIN);
    part('sphere', mul(root, translation([0, 1.8, 0.03]), scaling([0.22, 0.2, 0.22])), HAIR);
    limb([-0.37, 1.5, 0], armL, [0.15, 0.66, 0.17], SUIT);
    limb([0.37, 1.5, 0], armR, [0.15, 0.66, 0.17], SUIT);
    limb([-0.14, 0.86, 0], legL, [0.21, 0.86, 0.25], PANTS);
    limb([0.14, 0.86, 0], legR, [0.21, 0.86, 0.25], PANTS);
  }
}
