import type { Input } from '../engine/input';
import type { Physics } from '../engine/physics';
import type { Vec3 } from '../engine/math';
import type { DrawItem, Environment } from '../engine/renderer';
import type { ThirdPersonCamera } from '../game/camera';
import type { Hud } from '../game/hud';
import type { Circle, Player } from '../game/player';

export type LevelStatus = 'playing' | 'won' | 'lost';

export interface LevelContext {
  player: Player;
  camera: ThirdPersonCamera;
  hud: Hud;
  input: Input;
  /** Fresh physics world for this attempt, with the chamber colliders already added. */
  physics: Physics;
}

/** A camera position a level wants instead of the normal over-the-shoulder view. */
export interface CameraShot {
  pos: Vec3;
  target: Vec3;
  sharpness: number;
}

/**
 * One self-contained survival scenario. Most levels start with the player in the
 * default chamber; a level adds its own props, hazards, lighting and rules.
 */
export interface Level {
  readonly number: number;
  readonly title: string;
  status: LevelStatus;
  update(dt: number): void;
  draw(out: DrawItem[], time: number): void;
  environment(): Environment;
  /** Extra circular obstacles the player collides with. */
  obstacles(): Circle[];
  cameraShot(): CameraShot | null;
}

export const DEFAULT_ENV: Environment = {
  sunDir: [0.3, 1.0, 0.75],
  sunColor: [1.9, 1.8, 1.62],
  skyColor: [0.2, 0.3, 0.5],
  groundColor: [0.22, 0.2, 0.18],
  fogColor: [0.72, 0.8, 0.9],
  fogDensity: 0.003,
};
