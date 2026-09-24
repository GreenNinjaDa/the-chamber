import type { Input } from '../engine/input';
import { add, clamp, lerp3, lookAt, perspective, scale, sub, type Vec3 } from '../engine/math';
import type { CameraView } from '../engine/renderer';
import { CHAMBER_HALF } from './chamber';
import type { Player } from './player';

const MOUSE_SENSITIVITY = 0.0022;
const SHOULDER_OFFSET = 0.6;
const DISTANCE = 3.2;

/** Over-the-shoulder third-person camera that levels can temporarily take over. */
export class ThirdPersonCamera {
  yaw = 0;
  pitch = -0.2;
  pos: Vec3 = [0, 8, 26];
  target: Vec3 = [0, 3, 0];
  fov = (70 * Math.PI) / 180;
  private shake = 0;

  reset(yaw = 0) {
    this.yaw = yaw;
    this.pitch = -0.2;
    this.shake = 0;
  }

  look(dt: number, input: Input) {
    this.yaw -= input.mouseDX * MOUSE_SENSITIVITY;
    this.pitch -= input.mouseDY * MOUSE_SENSITIVITY;
    const turn = (input.isDown('ArrowLeft') ? 1 : 0) - (input.isDown('ArrowRight') ? 1 : 0);
    const tilt = (input.isDown('ArrowUp') ? 1 : 0) - (input.isDown('ArrowDown') ? 1 : 0);
    this.yaw += turn * 2.2 * dt;
    this.pitch += tilt * 1.5 * dt;
    this.pitch = clamp(this.pitch, -1.2, 1.0);
  }

  follow(dt: number, player: Player) {
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const fwd: Vec3 = [-Math.sin(this.yaw) * cp, sp, -Math.cos(this.yaw) * cp];
    const right: Vec3 = [Math.cos(this.yaw), 0, -Math.sin(this.yaw)];
    const shoulder = add(add(player.pos, [0, 1.65, 0]), scale(right, SHOULDER_OFFSET));
    const desired = sub(shoulder, scale(fwd, DISTANCE));
    // Keep the camera inside the chamber; when a wall pushes it in, lift it over the shoulder instead.
    const lim = CHAMBER_HALF - 0.3;
    const cx = clamp(desired[0], -lim, lim);
    const cz = clamp(desired[2], -lim, lim);
    const pushed = Math.hypot(desired[0] - cx, desired[2] - cz);
    desired[0] = cx;
    desired[2] = cz;
    desired[1] = Math.max(0.4, desired[1] + pushed * 0.8);
    this.moveTo(desired, add(shoulder, scale(fwd, 10)), dt, 18);
  }

  moveTo(pos: Vec3, target: Vec3, dt: number, sharpness: number) {
    const k = 1 - Math.exp(-dt * sharpness);
    this.pos = lerp3(this.pos, pos, k);
    this.target = lerp3(this.target, target, k);
  }

  addShake(amount: number) {
    this.shake = Math.max(this.shake, amount);
  }

  view(aspect: number, dt: number): CameraView {
    this.shake = Math.max(0, this.shake - dt * 1.5);
    const s = this.shake * 0.35;
    const offset: Vec3 = [(Math.random() - 0.5) * s, (Math.random() - 0.5) * s, (Math.random() - 0.5) * s];
    const pos = add(this.pos, offset);
    return {
      pos,
      view: lookAt(pos, add(this.target, offset), [0, 1, 0]),
      proj: perspective(this.fov, aspect, 0.1, 1500),
    };
  }
}
