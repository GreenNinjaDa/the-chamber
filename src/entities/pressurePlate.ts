import { add, mul, scaling, translation, type Vec3 } from '../engine/math';
import type { Body, Physics, RAPIER } from '../engine/physics';
import type { DrawItem } from '../engine/renderer';
import type { Player } from '../game/player';

/*
 * A big round floor button in the Portal style: a red plate in a dark ring. The objects it is given
 * (e.g. companion shapes) press it, and so does the player (or their corpse) standing on it; while
 * something is on it the plate sinks and `pressed` is set.
 */

const RING = [0.22, 0.23, 0.25];
const PLATE = [0.85, 0.16, 0.08];
const PLATE_LIT = [1.0, 0.5, 0.1];

const RADIUS = 0.95;
const RAISED = 0.13;
const SUNK = 0.07;
/** Stays down this long after losing contact, so a settling object doesn't make it flicker. */
const RELEASE_DELAY = 0.3;

export class PressurePlate {
  pressed = false;
  /** Set the first time it's pressed. */
  everPressed = false;
  private depth = 0;
  private sinceContact = Infinity;
  private plate: RAPIER.Collider;

  constructor(
    private physics: Physics,
    private pos: Vec3,
    private pressers: Body[],
    private player: Player | null,
    /** Called with true when something presses it, false when the last thing leaves. */
    private onChange?: (pressed: boolean) => void,
  ) {
    physics.addStaticCylinder(add(pos, [0, 0.03, 0]), RADIUS + 0.2, 0.06);
    this.plate = physics.addStaticCylinder(this.plateCentre(RAISED), RADIUS, 0.1);
    physics.addDrawable(this);
  }

  private plateCentre(top: number): Vec3 {
    return add(this.pos, [0, top - 0.05, 0]);
  }

  /** The player's movement capsule never makes contacts, so check where their feet (or body) are. */
  private playerOnIt() {
    const p = this.player;
    if (!p || p.mode === 'hidden' || p.inPortal) return false;
    const at = p.mode === 'control' || p.mode === 'ragdoll' ? p.pos : null;
    if (!at) return false;
    return Math.hypot(at[0] - this.pos[0], at[2] - this.pos[2]) < RADIUS + 0.1 && at[1] - this.pos[1] < 0.45;
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
      this.plate.setTranslation(vec(this.plateCentre(down ? SUNK : RAISED)));
      if (down) this.everPressed = true;
      this.onChange?.(down);
    }
    const target = this.pressed ? 1 : 0;
    this.depth += (target - this.depth) * Math.min(1, dt * 14);
  }

  draw(out: DrawItem[]) {
    const p = this.pos;
    out.push({ mesh: 'cylinder', model: mul(translation(add(p, [0, 0.03, 0])), scaling([RADIUS + 0.2, 0.06, RADIUS + 0.2])), color: RING, spec: 0.3 });
    const top = RAISED + (SUNK - RAISED) * this.depth;
    out.push({
      mesh: 'cylinder',
      model: mul(translation(add(p, [0, top - 0.05, 0])), scaling([RADIUS, 0.1, RADIUS])),
      color: this.pressed ? PLATE_LIT : PLATE,
      spec: 0.5,
    });
  }
}

const vec = (v: Vec3) => ({ x: v[0], y: v[1], z: v[2] });
