import type { Input } from '../engine/input';
import { add, clamp, fromQuat, lerp3, lookAt, perspective, quatSlerp, scale, sub, toQuat, transformDir, type Mat4, type Quat, type Vec3 } from '../engine/math';
import type { CameraView } from '../engine/renderer';
import { CHAMBER_HALF } from './chamber';
import type { Player } from './player';
import { settings } from './settings';

const MOUSE_SENSITIVITY = 0.0022;
const SHOULDER_OFFSET = 0.6;
const DISTANCE = 3.2;
/** How quickly the camera catches up when the player's gravity turns (1/s): lower lags more. */
const TURN_CATCH_UP = 1.6;

/** Over-the-shoulder third-person camera that levels can temporarily take over. */
export class ThirdPersonCamera {
  yaw = 0;
  pitch = -0.2;
  pos: Vec3 = [0, 8, 26];
  target: Vec3 = [0, 3, 0];
  fov = (70 * Math.PI) / 180;
  private shake = 0;
  /** Keep the camera inside the test chamber (levels with their own map turn this off). */
  confine = true;
  /** The camera's up (follows the player's gravity). */
  up: Vec3 = [0, 1, 0];
  /** For levels with their own map: a box the camera must stay inside. */
  bounds: { min: Vec3; max: Vec3 } | null = null;
  /** The camera's own idea of the player's gravity: trails behind when it turns. */
  private frame: Quat = { x: 0, y: 0, z: 0, w: 1 };
  /** Turn the view toward this orientation instead of the player's gravity (a level's camera-only roll). */
  turnTarget: Mat4 | null = null;

  reset(yaw = 0) {
    this.confine = true;
    this.bounds = null;
    this.up = [0, 1, 0];
    this.frame = { x: 0, y: 0, z: 0, w: 1 };
    this.turnTarget = null;
    this.yaw = yaw;
    this.pitch = -0.2;
    this.shake = 0;
  }

  look(dt: number, input: Input) {
    const sensitivity = MOUSE_SENSITIVITY * settings.mouseSpeed;
    this.yaw -= input.mouseDX * sensitivity;
    this.pitch -= input.mouseDY * sensitivity * (settings.invertY ? -1 : 1);
    const turn = (input.isDown('ArrowLeft') ? 1 : 0) - (input.isDown('ArrowRight') ? 1 : 0);
    const tilt = (input.isDown('ArrowUp') ? 1 : 0) - (input.isDown('ArrowDown') ? 1 : 0);
    this.yaw += turn * 2.2 * dt;
    this.pitch += tilt * 1.5 * dt;
    this.pitch = clamp(this.pitch, -1.2, 1.0);
  }

  follow(dt: number, player: Player) {
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    // Yaw and pitch are in the player's own frame, so the view turns with their gravity, a little
    // behind it so a turn is felt.
    this.frame = quatSlerp(this.frame, toQuat(this.turnTarget ?? player.gravity), 1 - Math.exp(-dt * TURN_CATCH_UP));
    const g = fromQuat(this.frame, [0, 0, 0]);
    const fwd = transformDir(g, [-Math.sin(this.yaw) * cp, sp, -Math.cos(this.yaw) * cp]);
    const right = transformDir(g, [Math.cos(this.yaw), 0, -Math.sin(this.yaw)]);
    this.up = transformDir(g, [0, 1, 0]);
    // Orbit the middle of the player's body, so a view turned on its own still frames them.
    const middle = add(player.pos, scale(player.up, 0.9));
    const shoulder = add(add(middle, scale(this.up, 0.75)), scale(right, SHOULDER_OFFSET));
    const desired = sub(shoulder, scale(fwd, DISTANCE));
    if (!this.confine) {
      const b = this.bounds;
      if (b) for (let k = 0; k < 3; k++) desired[k] = clamp(desired[k], b.min[k], b.max[k]);
      this.moveTo(desired, add(shoulder, scale(fwd, 10)), dt, 18);
      return;
    }
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

  /** True once the view has caught up with where it's turning to (within about a degree). */
  aligned(player: Player): boolean {
    const t = toQuat(this.turnTarget ?? player.gravity);
    const f = this.frame;
    return Math.abs(t.x * f.x + t.y * f.y + t.z * f.z + t.w * f.w) > 0.99996;
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
      view: lookAt(pos, add(this.target, offset), this.up),
      proj: perspective(this.fov, aspect, 0.1, 1500),
    };
  }
}
