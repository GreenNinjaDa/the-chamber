import { add, rotationY, toQuat, type Vec3 } from '../../engine/math';
import type { Body } from '../../engine/physics';
import type { DrawItem } from '../../engine/renderer';
import { Cake, CAKE_SLICES } from '../../entities/cake';
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

/** After the first slice, one line per slice (2nd to 7th), growing steadily more worried. */
const MORE_QUIPS: [string, string][] = [
  ['SECONDS', 'Treat yourself. You earned it. Probably.'],
  ['THIRDS', 'That is quite a lot of cake. Science is taking notes.'],
  ['HALF A CAKE', 'We are legally required to remind you that cake is not a food group.'],
  ['FIVE SLICES', 'Your test results are now 40% frosting. Please pace yourself.'],
  ['SIX. SLICES.', 'We have called a nutritionist. She is crying.'],
  ['STOP EATING', 'Do NOT eat the last slice. We are not joking. Not even a wafer-thin one.'],
];

const REFUSE_QUIPS: [string, string][] = [
  ['MANNERS', 'Start with the slice that is already cut.'],
  ['ONE AT A TIME', 'Somebody already cut you a slice. Eat that one.'],
];

/** Each slice fattens the torso this much (just for this life). */
const GIRTH_PER_SLICE = 0.1;
const DEATH_SCREEN_DELAY = 1.6;

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
  /** Seconds since the fatal slice (-1: not yet). */
  private burst = -1;

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
      (n) => this.ate(n),
      () => ctx.hud.show(...pick(REFUSE_QUIPS), 2.5),
    );

    // Scatter the companion shapes around the room, away from the cake and the button.
    const spots: Vec3[] = [];
    for (const shape of COMPANION_SHAPES) {
      let pos: Vec3 = [0, 0, 0];
      for (let tries = 0; tries < 60; tries++) {
        pos = [(Math.random() * 2 - 1) * 9, 1.0, (Math.random() * 2 - 1) * 9];
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

  private ate(n: number) {
    const { player, hud, camera } = this.ctx;
    player.girth = 1 + n * GIRTH_PER_SLICE;
    if (n < CAKE_SLICES) {
      hud.show(...(n === 1 ? pick(EAT_QUIPS) : MORE_QUIPS[n - 2]), n === CAKE_SLICES - 1 ? 5 : 3.5);
      return;
    }
    // The last slice. It was only wafer-thin.
    const chest = add(player.pos, [0, 1.3, 0]);
    player.kill([(Math.random() - 0.5) * 4, 7, (Math.random() - 0.5) * 4], { violence: 45, origin: chest });
    camera.addShake(1);
    hud.hide();
    this.burst = 0;
  }

  update(dt: number) {
    if (this.burst >= 0 && this.status === 'playing') {
      this.burst += dt;
      if (this.burst > DEATH_SCREEN_DELAY) {
        this.status = 'lost';
        this.ctx.hud.show('DEATH BY CHOCOLATE', 'It was only wafer-thin.\nPress R to try again, on an empty stomach.');
        this.ctx.hud.tips([
          ['Hint', 'Seven slices is a meal. Eight is a eulogy.'],
          ['Controls', 'E eats cake. That was the whole problem.'],
        ]);
      }
    }
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
