import { add, mul, scaling, translation, type Vec3 } from '../engine/math';
import type { Body, Physics, RAPIER } from '../engine/physics';
import { Pattern, type DrawItem } from '../engine/renderer';
import type { Player } from '../game/player';

/*
 * A floor pressure plate. By default a big round button in the Portal style: a red plate in a dark
 * ring. It can instead be a slab of stone (`stone`: square-ish, rock textured, for temples). The
 * objects it is given (e.g. companion shapes) press it, and so does the player (or their corpse)
 * standing on it; while something is on it the plate sinks and `pressed` is set.
 */

const RING = [0.22, 0.23, 0.25];
const PLATE = [0.85, 0.16, 0.08];
const PLATE_LIT = [1.0, 0.5, 0.1];
const STONE = [0.44, 0.4, 0.34];
const STONE_FRAME = [0.26, 0.23, 0.2];

const RADIUS = 0.95;
const RAISED = 0.13;
const SUNK = 0.07;
/** The stone slab is a solid block that sticks up this far until it's pressed down to this. */
const STONE_RAISED = 0.28;
const STONE_SUNK = 0.1;
/** Stays down this long after losing contact, so a settling object doesn't make it flicker. */
const RELEASE_DELAY = 0.3;

export interface PlateShape {
  /** Radius of the round plate itself (m). */
  radius?: number;
  /** A square-ish stone slab this size [width x, depth z] instead of the round button. */
  stone?: [number, number];
}

export class PressurePlate {
  pressed = false;
  /** Set the first time it's pressed. */
  everPressed = false;
  private depth = 0;
  private sinceContact = Infinity;
  private plate: RAPIER.Collider;
  private readonly radius: number;
  private readonly stone: [number, number] | null;

  constructor(
    private physics: Physics,
    private pos: Vec3,
    private pressers: Body[],
    private player: Player | null,
    /** Called with true when something presses it, false when the last thing leaves. */
    private onChange?: (pressed: boolean) => void,
    shape: PlateShape = {},
  ) {
    this.radius = shape.radius ?? RADIUS;
    this.stone = shape.stone ?? null;
    if (this.stone) {
      const [w, d] = this.stone;
      physics.addStaticBox(add(pos, [0, 0.03, 0]), [w + 0.3, 0.06, d + 0.3]);
      this.plate = physics.addStaticBox(this.plateCentre(STONE_RAISED), [w, STONE_RAISED, d]);
    } else {
      physics.addStaticCylinder(add(pos, [0, 0.03, 0]), this.radius + 0.2, 0.06);
      this.plate = physics.addStaticCylinder(this.plateCentre(RAISED), this.radius, 0.1);
    }
    physics.addDrawable(this);
  }

  /** Centre of the plate's collider with its top at `top` (the stone block reaches the floor). */
  private plateCentre(top: number): Vec3 {
    return add(this.pos, [0, this.stone ? top - STONE_RAISED / 2 : top - 0.05, 0]);
  }

  /** The player's movement capsule never makes contacts, so check where their feet (or body) are. */
  private playerOnIt() {
    const p = this.player;
    if (!p || p.mode === 'hidden' || p.inPortal) return false;
    const at = p.mode === 'control' || p.mode === 'ragdoll' ? p.pos : null;
    if (!at || Math.abs(at[1] - this.pos[1]) >= 0.45) return false;
    if (this.stone) {
      return Math.abs(at[0] - this.pos[0]) < this.stone[0] / 2 + 0.1 && Math.abs(at[2] - this.pos[2]) < this.stone[1] / 2 + 0.1;
    }
    return Math.hypot(at[0] - this.pos[0], at[2] - this.pos[2]) < this.radius + 0.1;
  }

  /** Call every tick. */
  update(dt: number) {
    const world = this.physics.world;
    let touching = this.playerOnIt();
    for (const b of this.pressers) {
      if (!b.rb.isValid()) continue;
      world.contactPair(this.plate, b.collider, (manifold) => {
        if (manifold.numContacts() > 0) touching = true;
      });
      if (touching) break;
    }
    this.sinceContact = touching ? 0 : this.sinceContact + dt;
    const down = this.sinceContact < RELEASE_DELAY;
    if (down !== this.pressed) {
      this.pressed = down;
      const [raised, sunk] = this.stone ? [STONE_RAISED, STONE_SUNK] : [RAISED, SUNK];
      this.plate.setTranslation(vec(this.plateCentre(down ? sunk : raised)));
      if (down) this.everPressed = true;
      this.onChange?.(down);
    }
    const target = this.pressed ? 1 : 0;
    this.depth += (target - this.depth) * Math.min(1, dt * 14);
  }

  draw(out: DrawItem[]) {
    const p = this.pos;
    const top = RAISED + (SUNK - RAISED) * this.depth;
    if (this.stone) {
      const [w, d] = this.stone;
      const stoneTop = STONE_RAISED + (STONE_SUNK - STONE_RAISED) * this.depth;
      out.push({ mesh: 'bevelbox', model: mul(translation(add(p, [0, 0.03, 0])), scaling([w + 0.3, 0.06, d + 0.3])), color: STONE_FRAME, pattern: Pattern.rock, param: 1, spec: 0.05 });
      out.push({ mesh: 'bevelbox', model: mul(translation(add(p, [0, stoneTop / 2, 0])), scaling([w, stoneTop, d])), color: STONE, pattern: Pattern.rock, param: 1.5, spec: 0.05 });
      return;
    }
    out.push({ mesh: 'cylinder', model: mul(translation(add(p, [0, 0.03, 0])), scaling([this.radius + 0.2, 0.06, this.radius + 0.2])), color: RING, spec: 0.3 });
    out.push({
      mesh: 'cylinder',
      model: mul(translation(add(p, [0, top - 0.05, 0])), scaling([this.radius, 0.1, this.radius])),
      color: this.pressed ? PLATE_LIT : PLATE,
      spec: 0.5,
    });
  }
}

const vec = (v: Vec3) => ({ x: v[0], y: v[1], z: v[2] });
