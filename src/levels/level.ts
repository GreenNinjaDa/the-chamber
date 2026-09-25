import type { Input } from '../engine/input';
import type { Physics } from '../engine/physics';
import type { Vec3 } from '../engine/math';
import type { DrawItem, Environment } from '../engine/renderer';
import type { ThirdPersonCamera } from '../game/camera';
import type { ChamberOptions } from '../game/chamber';
import type { Hud } from '../game/hud';
import type { Circle, Player } from '../game/player';

/** 'exited' means the player went through the level's exit portal: go straight to the next level. */
export type LevelStatus = 'playing' | 'won' | 'lost' | 'exited';

export interface LevelContext {
  player: Player;
  camera: ThirdPersonCamera;
  hud: Hud;
  input: Input;
  /** Fresh physics world for this attempt, with the chamber colliders already added. */
  physics: Physics;
}

export interface TrackedTarget {
  pos: Vec3;
  /** World-space radius, so the ring fits around the object. */
  radius: number;
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
  /** Tweaks to the standard chamber (e.g. a hole in a wall). */
  readonly chamber?: ChamberOptions;
  status: LevelStatus;
  update(dt: number): void;
  draw(out: DrawItem[], time: number): void;
  environment(): Environment;
  /** Extra circular obstacles the player collides with. */
  obstacles(): Circle[];
  cameraShot(): CameraShot | null;
  /** Things to flag on screen (a pulsing ring when visible, an edge arrow when not), e.g. live grenades. */
  trackedTargets?(): TrackedTarget[];
}

export const DEFAULT_ENV: Environment = {
  sunDir: [0.3, 1.0, 0.75],
  sunColor: [1.9, 1.8, 1.62],
  skyColor: [0.2, 0.3, 0.5],
  groundColor: [0.22, 0.2, 0.18],
  fogColor: [0.72, 0.8, 0.9],
  fogDensity: 0.003,
};
