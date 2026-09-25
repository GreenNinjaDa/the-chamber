import { rotationY, toQuat, type Vec3 } from '../../engine/math';
import type { Body } from '../../engine/physics';
import type { DrawItem } from '../../engine/renderer';
import { Cake } from '../../entities/cake';
import { COMPANION_SHAPES, spawnCompanion } from '../../entities/companions';
import { ExitPortal, PortalArrival } from '../../entities/portal';
import { PressurePlate } from '../../entities/pressurePlate';
import { DEFAULT_ENV, type CameraShot, type Level, type LevelContext, type LevelStatus, type TrackedTarget } from '../level';

/*
 * Piece of Cake (a secret level, one day; for now level 3). A cake on a pedestal with one slice
 * cut, which you can eat. Companion shapes (every shape but a cube) lie around the room; put one
 * on the floor button and the exit opens.
 */

const PLATE_POS: Vec3 = [-7, 0, -7];

const EAT_QUIPS: [string, string][] = [
  ['THE CAKE IS NOT A LIE', 'It was, however, mostly frosting.'],
  ['DELICIOUS', 'You will be baked, and then there will be cake. Wait, no. Other way round.'],
  ['CONGRATULATIONS', 'Your reward has been consumed. Please do not ask for another reward.'],
  ['NOM', 'Moist. Chocolatey. Suspiciously real.'],
];

const SECONDS_QUIPS: [string, string][] = [
  ['NO SECONDS', 'The rest of the cake is for display purposes only.'],
  ['DENIED', 'One slice per test subject. It says so in the fine print.'],
  ['PUT THE FORK DOWN', 'That cake is load-bearing.'],
];

const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

export class CakeLevel implements Level {
  readonly number = 3;
  readonly title = 'Piece of Cake';
  status: LevelStatus = 'playing';
  private arrival: PortalArrival;
  private exit = new ExitPortal(0);
  private plate: PressurePlate;
  private companions: Body[] = [];
  private cake: Cake;

  constructor(private ctx: LevelContext) {
    const { physics, hud } = ctx;
    hud.setLevel(`The Chamber · Level ${this.number}`);
    hud.show('PIECE OF CAKE', '', 2.5);
    hud.hint('');
    this.arrival = new PortalArrival(ctx, [0, 0, 6]);

    this.cake = new Cake(
      physics,
      [0, 0, 0],
      -Math.PI / 2 + Math.PI / 8, // the gap (and the slice) face the arrival spot, to the south
      () => ctx.hud.show(...pick(EAT_QUIPS), 3.5),
      () => ctx.hud.show(...pick(SECONDS_QUIPS), 2.5),
    );

    // Scatter the companion shapes around the room, away from the cake and the button.
    const spots: Vec3[] = [];
    for (const shape of COMPANION_SHAPES) {
      let pos: Vec3 = [0, 0, 0];
      for (let tries = 0; tries < 60; tries++) {
        pos = [(Math.random() * 2 - 1) * 9, 0.8, (Math.random() * 2 - 1) * 9];
        const clear = Math.hypot(pos[0], pos[2]) > 3 &&
          Math.hypot(pos[0] - PLATE_POS[0], pos[2] - PLATE_POS[2]) > 3.5 &&
          spots.every((s) => Math.hypot(s[0] - pos[0], s[2] - pos[2]) > 2.5);
        if (clear) break;
      }
      spots.push(pos);
      const tip = toQuat(rotationY(Math.random() * Math.PI * 2));
      this.companions.push(spawnCompanion(physics, shape, pos, tip));
    }

    this.plate = new PressurePlate(physics, PLATE_POS, this.companions, () => this.exit.openNow());
  }

  update(dt: number) {
    this.arrival.update(dt);
    this.plate.update(dt);
    this.cake.update(dt);
    this.exit.update(dt, this.ctx.player);
    if (this.exit.entered && this.status === 'playing') this.status = 'exited';
  }

  draw(out: DrawItem[]) {
    this.arrival.draw(out);
    this.exit.draw(out);
  }

  trackedTargets(): TrackedTarget[] {
    const exit = this.exit.target();
    return exit ? [exit] : [];
  }

  environment() {
    return DEFAULT_ENV;
  }

  obstacles() {
    return [];
  }

  cameraShot(): CameraShot | null {
    return this.arrival.cameraShot();
  }
}
