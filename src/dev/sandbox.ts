import { mul, scaling, translation, type Vec3 } from '../engine/math';
import type { Body } from '../engine/physics';
import type { DrawItem } from '../engine/renderer';
import { junk, spawnJunk } from '../entities/junk';
import { Button, Lever } from '../entities/props';
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

    // The same junk the levels use: crates of two sizes, plus a stack to knock over.
    for (let i = 0; i < 8; i++) {
      const def = junk(i % 2 ? 'small crate' : 'crate');
      spawnJunk(physics, def, [-8 + i * 2.2, def.size[1] / 2 + 0.01, -3]);
    }
    for (let i = 0; i < 5; i++) spawnJunk(physics, junk('crate'), [6, 0.4 + i * 0.81, 3]);
    // Too heavy to lift: can only be dragged along the floor (or tipped upright by one end).
    spawnJunk(physics, junk('fridge'), [-6, 0.96, 5]);
    // Things that roll.
    spawnJunk(physics, junk('beach ball'), [-2, 0.4, 7]);
    spawnJunk(physics, junk('rubber duck'), [-0.6, 0.3, 7]);
    for (let i = 0; i < 2; i++) spawnJunk(physics, junk('tire'), [0.8 + i * 1.4, 0.45, 7]);
    for (let i = 0; i < 3; i++) spawnJunk(physics, junk('oil drum'), [3 + i * 1.5, 0.46, -8]);

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
    // Violent enough to sometimes tear a limb or two off.
    player.kill([(Math.random() - 0.5) * 6, 26, (Math.random() - 0.5) * 6]);
    this.status = 'lost';
    hud.show('WHY', 'It was a big red button. What did you expect?\nPress R to un-die.');
    hud.tips([
      ['Hint', 'Do not press the big red button.'],
      ['Controls', 'E uses levers and buttons (evidently). Hold left click to carry things, right-click to throw.'],
    ]);
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
