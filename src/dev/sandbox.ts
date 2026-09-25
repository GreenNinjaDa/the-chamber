import { mul, scaling, translation, type Vec3 } from '../engine/math';
import type { Body } from '../engine/physics';
import type { DrawItem } from '../engine/renderer';
import { Button, Lever } from '../game/props';
import { DEFAULT_ENV, type CameraShot, type Level, type LevelContext, type LevelStatus } from '../levels/level';

/*
 * Mechanics test room (open with ?sandbox). Not a game level: it just puts every shared
 * mechanic in one place — crates to carry, a fridge too heavy to lift, balls, barrels,
 * a lever that toggles a crate rain, and a button that kills you (to test the ragdoll).
 */

const WOOD = [0.62, 0.45, 0.26];
const MAX_BODIES = 150;

export class Sandbox implements Level {
  readonly number = 0;
  readonly title = 'Sandbox';
  status: LevelStatus = 'playing';
  private raining = false;
  private rainTimer = 0;
  private rained: Body[] = [];

  constructor(private ctx: LevelContext) {
    const { physics, hud } = ctx;
    hud.setLevel('Sandbox · mechanics test');
    hud.show('SANDBOX', 'Hold left click to carry · right-click to throw · E on levers and buttons', 3);
    hud.hint('');

    // Loose crates of a few sizes, plus a stack to knock over.
    for (let i = 0; i < 8; i++) {
      const s = 0.6 + Math.random() * 0.6;
      physics.addBox([-8 + i * 2.2, s / 2 + 0.01, -3], [s, s, s], { color: WOOD, mass: 8 + s * 20 });
    }
    for (let i = 0; i < 5; i++) {
      physics.addBox([6, 0.45 + i * 0.91, 3], [0.9, 0.9, 0.9], { color: WOOD, mass: 15 });
    }
    // Too heavy to lift: can only be dragged along the floor.
    physics.addBox([-6, 0.96, 5], [0.9, 1.9, 0.8], { color: [0.92, 0.93, 0.95], mass: 120 });
    for (let i = 0; i < 4; i++) {
      physics.addBall([-2 + i * 1.4, 0.4, 7], 0.35 + i * 0.1, { color: [0.85, 0.2 + i * 0.15, 0.15], mass: 3, restitution: 0.6 });
    }
    for (let i = 0; i < 3; i++) {
      physics.addCylinder([3 + i * 1.5, 0.6, -8], 0.4, 1.2, { color: [0.2, 0.35, 0.7], mass: 25 });
    }

    // A static bar at head height: the movement capsule fits under it, the head doesn't.
    // Sprint into it to test head knocks from non-physics objects.
    const barY = 1.91, barZ = 2, barHalf = 3.5;
    physics.addStaticBox([0, barY, barZ], [barHalf * 2, 0.12, 0.12]);
    for (const x of [-barHalf, barHalf]) physics.addStaticBox([x, (barY + 0.06) / 2, barZ], [0.15, barY + 0.06, 0.15]);
    physics.addDrawable({
      draw: (out) => {
        const yellow = [0.95, 0.75, 0.1];
        out.push({ mesh: 'box', model: mul(translation([0, barY, barZ]), scaling([barHalf * 2, 0.12, 0.12])), color: yellow, spec: 0.3 });
        for (const x of [-barHalf, barHalf]) {
          out.push({ mesh: 'box', model: mul(translation([x, (barY + 0.06) / 2, barZ]), scaling([0.15, barY + 0.06, 0.15])), color: [0.15, 0.15, 0.16] });
        }
      },
    });

    new Lever(physics, [-10, 0, -9], Math.PI / 2, (on) => { this.raining = on; });
    new Button(physics, [10, 0, -9], [0.85, 0.08, 0.06], () => this.pressedTheButton());
  }

  private pressedTheButton() {
    const { player, hud } = this.ctx;
    if (player.mode !== 'control') return;
    player.kill([(Math.random() - 0.5) * 6, 16, (Math.random() - 0.5) * 6]);
    this.status = 'lost';
    hud.show('WHY', 'It was a big red button. What did you expect?\nPress R to un-die.');
  }

  update(dt: number) {
    if (!this.raining) return;
    this.rainTimer -= dt;
    if (this.rainTimer > 0) return;
    this.rainTimer = 0.35;
    const pos: Vec3 = [(Math.random() - 0.5) * 20, 18, (Math.random() - 0.5) * 20];
    const s = 0.5 + Math.random() * 0.7;
    this.rained.push(this.ctx.physics.addBox(pos, [s, s, s], { color: WOOD, mass: 5 + s * 15 }));
    if (this.ctx.physics.bodies.length > MAX_BODIES) this.ctx.physics.remove(this.rained.shift()!);
  }

  draw(_out: DrawItem[]) {}

  environment() {
    return DEFAULT_ENV;
  }

  obstacles() {
    return [];
  }

  cameraShot(): CameraShot | null {
    return null;
  }
}
