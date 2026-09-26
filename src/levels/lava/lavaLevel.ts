import { add, mul, normalize, rotationX, rotationY, scale, scaling, sub, translation, type Vec3 } from '../../engine/math';
import { Pattern, type DrawItem, type Environment } from '../../engine/renderer';
import { CHAMBER_HALF } from '../../game/chamber';
import { ExitPortal, PortalArrival } from '../../entities/portal';
import { UselessBox } from '../../entities/uselessBox';
import { DEFAULT_ENV, type CameraShot, type Level, type LevelContext, type LevelStatus, type TrackedTarget, type WorldLabel } from '../level';

/*
 * Useless Box. Lava fills the chamber, rising slowly. You arrive on a ledge by the exit; in the
 * far corner, across a line of rock pillars, a tiny island holds a black box with a switch. The
 * switch opens the exit, but the box flips it back off: after 1 s the first time, then 2 s, 3 s...
 * Keep switching it on until the box waits long enough for you to jump all the way back.
 */

const TOP = 3;
/**
 * The ledge by the exit, as small as it can be: x from LEDGE_X to the east wall, z within
 * ±LEDGE_HALF_Z (just wider than the exit door, with room to land when you arrive).
 */
const LEDGE_X = 9;
const LEDGE_HALF_Z = 2;
const SPAWN: Vec3 = [10.5, TOP, 0];
const ISLAND: Vec3 = [-9.6, 0, -9.6];
const ISLAND_R = 1.5;
const PILLAR_R = 1.0;
/**
 * The stepping stones, in order: from the left (south) end of the ledge, a long S through the
 * whole pit to the island in the far corner. Gaps are 0.7–1.8 m (a walking jump clears ~3 m).
 */
const PATH: [number, number][] = [
  [7.2, 4.0], [4.6, 6.8], [1.0, 7.6], [-2.5, 6.6], [-4.6, 3.6], [-2.6, 0.6],
  [0.9, -0.6], [2.2, -4.0], [-0.8, -6.2], [-3.6, -7.4], [-6.8, -8.0],
];
/** Lava surface height at the start, and how fast it rises (m/s): the lowest stone goes under after ~3 min 20 s. */
const LAVA_START = 0.3;
const LAVA_RISE = 0.013;
const LAVA_MAX = 9;
const DEATH_SCREEN_DELAY = 1.8;
/** Warm light bouncing up off the lava. */
const LAVA_ENV: Environment = { ...DEFAULT_ENV, groundColor: [0.6, 0.24, 0.08] };

const ROCK = [0.16, 0.13, 0.115];
const ROCK_DARK = [0.08, 0.065, 0.06];
const ROCK_TOP = [0.22, 0.18, 0.16];
const LEDGE = [0.86, 0.87, 0.88];

interface Pillar {
  pos: Vec3;
  radius: number;
  top: number;
  /** Its lumpy rock look, built once. */
  pieces: DrawItem[];
}

/** A rock column: a dark core wrapped in rings of lumps, with a domed top that matches the collider. */
function rockPieces(pos: Vec3, radius: number, top: number): DrawItem[] {
  const out: DrawItem[] = [];
  const base = translation([pos[0], 0, pos[2]]);
  out.push({ mesh: 'cylinder', model: mul(base, translation([0, top / 2, 0]), scaling([radius * 0.92, top, radius * 0.92])), color: ROCK_DARK });
  const layers = 4;
  for (let j = 0; j < layers; j++) {
    const y = (top * (j + 0.5)) / layers;
    for (let i = 0; i < 5; i++) {
      const a = j * 0.7 + (i / 5) * Math.PI * 2 + (Math.random() - 0.5) * 0.5;
      const r = radius * (0.66 + Math.random() * 0.1);
      const size: Vec3 = [radius * (0.65 + Math.random() * 0.25), (top / layers) * (1.2 + Math.random() * 0.3), radius * (0.5 + Math.random() * 0.2)];
      const shade = Math.random();
      out.push({
        mesh: 'roundbox',
        model: mul(base, translation([Math.cos(a) * r, y, Math.sin(a) * r]), rotationY(-a + Math.PI / 2), rotationX((Math.random() - 0.5) * 0.4), scaling(size)),
        color: ROCK.map((c, k) => c + (ROCK_DARK[k] - c) * shade * 0.6),
        spec: 0.05,
      });
    }
  }
  out.push({ mesh: 'sphere', model: mul(base, translation([0, top - 0.2, 0]), scaling([radius * 1.02, 0.2, radius * 1.02])), color: ROCK_TOP, spec: 0.08 });
  return out;
}

export class LavaLevel implements Level {
  readonly number = 4;
  readonly title = 'Useless Box';
  status: LevelStatus = 'playing';
  private arrival: PortalArrival;
  private exit = new ExitPortal(0, TOP);
  private box: UselessBox;
  private pillars: Pillar[] = [];
  private lava = LAVA_START;
  private t = 0;
  private deadAt = -1;
  private labelList: WorldLabel[];

  constructor(private ctx: LevelContext) {
    const { physics, hud } = ctx;
    hud.setLevel(`The Chamber · Level ${this.number}`);
    hud.show(`LEVEL ${this.number}`, '', 2.5);
    hud.hint('');
    // Dropped straight down: the ledge is small and the alternative is lava.
    this.arrival = new PortalArrival(ctx, SPAWN, { minElevationDeg: 84 });

    // The ledge by the exit.
    const ledgeW = CHAMBER_HALF - LEDGE_X;
    physics.addStaticBox([LEDGE_X + ledgeW / 2, TOP / 2, 0], [ledgeW, TOP, LEDGE_HALF_Z * 2]);

    for (const [x, z] of PATH) this.addPillar([x, 0, z], PILLAR_R, TOP - 0.1 + Math.random() * 0.25);
    this.addPillar(ISLAND, ISLAND_R, TOP);

    // The box on the island, its switch facing the last stepping stone.
    const last = PATH[PATH.length - 1];
    const face = sub([last[0], 0, last[1]], ISLAND);
    this.box = new UselessBox(
      physics,
      [ISLAND[0], TOP, ISLAND[2]],
      Math.atan2(face[0], face[2]),
      (on) => (on ? this.exit.openNow() : this.exit.closeNow()),
    );
    const front = add([ISLAND[0], TOP + 0.3, ISLAND[2]], scale(normalize(face), 0.42));
    this.labelList = [{ pos: front, text: 'DO NOT TOUCH', size: 0.08, color: '#ffd166' }];
  }

  private addPillar(pos: Vec3, radius: number, top: number) {
    this.ctx.physics.addStaticCylinder([pos[0], top / 2, pos[2]], radius, top);
    this.pillars.push({ pos, radius, top, pieces: rockPieces(pos, radius, top) });
  }

  update(dt: number) {
    const { player, hud } = this.ctx;
    this.t += dt;
    this.lava = Math.min(LAVA_MAX, this.lava + LAVA_RISE * dt);
    this.arrival.update(dt);
    this.box.update(dt);
    this.exit.update(dt, player);
    if (this.exit.entered && this.status === 'playing') this.status = 'exited';

    // Into the lava.
    if (this.deadAt < 0 && player.mode === 'control' && !player.inPortal && player.pos[1] < this.lava - 0.15) {
      player.kill([(Math.random() - 0.5) * 3, 9, (Math.random() - 0.5) * 3], { violence: 12 });
      this.ctx.camera.addShake(0.5);
      hud.hide();
      this.deadAt = this.t;
    }
    if (this.deadAt >= 0 && this.status === 'playing' && this.t - this.deadAt > DEATH_SCREEN_DELAY) {
      this.status = 'lost';
      hud.show('HOT HOT HOT', 'The floor is lava. The floor is also rising.\nPress R to try again.');
      hud.tips([
        ['Hint', this.box.flips === 0
          ? 'Sprint (Shift) and jump (Space) from rock to rock. The lava will not wait.'
          : 'The box waits one second longer every time. Keep switching it on until it waits long enough for you to get back to the exit.'],
        ['Controls', 'WASD move · Shift sprint · Space jump · E flips the switch'],
      ]);
    }
  }

  draw(out: DrawItem[]) {
    // The ledge, in the same white panels as the walls.
    const ledgeW = CHAMBER_HALF - LEDGE_X;
    out.push({
      mesh: 'box',
      model: mul(translation([LEDGE_X + ledgeW / 2, TOP / 2, 0]), scaling([ledgeW, TOP, LEDGE_HALF_Z * 2])),
      color: LEDGE,
      pattern: Pattern.panels,
      param: 2,
      spec: 0.15,
    });
    for (const p of this.pillars) for (const piece of p.pieces) out.push(piece);
    out.push({
      mesh: 'box',
      model: mul(translation([0, this.lava / 2, 0]), scaling([CHAMBER_HALF * 2 - 0.02, this.lava, CHAMBER_HALF * 2 - 0.02])),
      color: [1, 1, 1],
      pattern: Pattern.lava,
      shadow: false,
    });
    this.arrival.draw(out);
    this.exit.draw(out);
  }

  labels(): WorldLabel[] {
    return this.labelList;
  }

  trackedTargets(): TrackedTarget[] {
    const exit = this.exit.target();
    return exit ? [exit] : [];
  }

  environment() {
    return LAVA_ENV;
  }

  obstacles() {
    return [];
  }

  cameraShot(): CameraShot | null {
    return this.arrival.cameraShot();
  }
}
