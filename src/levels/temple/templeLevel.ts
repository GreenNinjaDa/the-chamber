import {
  add, clamp, dot, easeInOut, length, mul, normalize, rotationX, rotationZ, scale, scaling, segment, sub, transformDir, transformPoint,
  translation, type Mat4, type Vec3,
} from '../../engine/math';
import { GROUPS_BOULDER, GROUPS_BOULDER_BRIDGE, GROUPS_DEBRIS, RAPIER, type Body } from '../../engine/physics';
import { Pattern, type DrawItem, type Environment } from '../../engine/renderer';
import { drawPortal, PORTAL_SQUEEZE_TIME, PortalArrival } from '../../entities/portal';
import { PressurePlate } from '../../entities/pressurePlate';
import { boulderModel, chunkModel, STONE_COLORS } from '../../entities/rock';
import { DEFAULT_ENV, type CameraShot, type Level, type LevelContext, type LevelStatus } from '../level';

/*
 * The boulder temple (an Indiana Jones parody). Its own map: a dark stone tunnel lit only by the
 * torch in your hand. The exit portal is right there... until a boulder drops out of a deep shaft
 * in the ceiling in front of it and chases you down the tunnel, over spiked pits (the widest needs
 * a vine), spikes and loose rocks. At the end a pressure plate stops the boulder, the end wall sinks
 * into the floor to reveal a second boulder, and the world freezes while your view rolls over; then
 * gravity flips and you fall to the ceiling in a heap, rocks and all. Now the ceiling's pits and spikes are in your way, the new
 * boulder chases you home, and the first one rolls ahead of you and drops back down its shaft
 * (now a pit), which you cross on a second vine to reach the portal. Boulders kill on contact.
 *
 * Vines are physical ropes: hold E or left mouse near one to grab it wherever you reach, swing,
 * and let go to fly on. Each snaps after one use, so there's no going back.
 *
 * The map never moves: the view turns (the player's gravity, with the world frozen), then the
 * physics world's gravity flips to match and everything, the player included, falls to the ceiling.
 */

// --- Layout (world space: floor y = 0, ceiling y = H, running along +z) ------------------------------
const H = 5; // tunnel height
const W = 4.6; // tunnel width (a 4 m boulder leaves no room to dodge past)
const WALL_T = 1;
const Z_START = -24;
const Z_ALCOVE_END = 87;
const END_Z = 80; // the dead-end wall that sinks away
const PLATE_Z = 76;
const PORTAL_Z = -21;
const PORTAL_R = 2;
const SPAWN_Z = -2;
/** The shaft the first boulder drops from: long, wide and deep, so both boulders fit in the bottom when it's a pit. */
const SHAFT: [number, number] = [-14, -5];
const SHAFT_W = 7;
const SHAFT_DEPTH = 12;
const LAND_Z = (SHAFT[0] + SHAFT[1]) / 2;
/** Spiked pits in the floor (the way out) and the ceiling (the way back). The 8 m ones need a vine. */
const FLOOR_PITS: [number, number][] = [[14, 16.5], [30, 32.5], [46, 54], [64, 66.5]];
const CEILING_PITS: [number, number][] = [[8, 10.5], [24, 26.5], [40, 42.5], [58, 60.5]];
const PIT_DEPTH = 6;
const BOULDER_R = 2;
const BOULDER2_Z = 83.5;

/** Vines: where they hang from, which way they hang (gravity when they're used), and rope length. */
const VINE_LEN = 2.6;
/** Hands above the feet while holding on, and how close the hands must be to grab the rope. */
const GRAB_HEIGHT = 2.0;
const GRAB_REACH = 1.0;
const VINE_FALL_TIME = 1.2;

// Chase: boulder speed (m/s) by the gap to the player. Walking (5) gets you caught, sprinting (8.5) doesn't.
const CHASE_SLOW = 6.2;
const CHASE = 7.2;
const CHASE_CATCHUP = 9.5;
const ROLL_DELAY = 0.7;
/** After the roll the first boulder rolls away toward the start faster than anyone can run. */
const FLEE = 10.5;
/** How quickly the first boulder gets going again after the roll (it starts from rest). */
const FLEE_GAIN = 0.6;

/** After the plate: the end wall starts to sink this long after, taking WALL_SINK (frozen world or not). */
const WALL_SINK_AT = 1;
const WALL_SINK = 1;
/** The frozen camera turn starts when the first boulder is this close to the plate (m, edge to edge), or after TURN_AFTER s. */
const TURN_WHEN_BOULDER_WITHIN = 1;
const TURN_AFTER = 2;
/** The plate's radius (the standard pressure plate). */
const PLATE_R = 0.95;
/** The roll: with the world frozen, the camera turns a half turn about the tunnel's axis in this long... */
const ROLL_TIME = 4;
/** ...and holds there this long after it's caught up; then gravity snaps over and the player falls, limp for a moment. */
const ROLL_HOLD = 0.5;
const FALL_STUN = 0.1;

// Spikes: rows across the floor (the way out) and the ceiling (the way back), and spikes sticking
// out of the walls. They're not solid: touching one knocks you loose for a moment.
const SPIKE_STUN = 0.5;
const SPIKE_R = 0.16;
/** x positions of a row: some leave a way past, a full row has to be jumped. */
const ROWS = {
  left: [-1.8, -1.2, -0.6, 0],
  right: [0, 0.6, 1.2, 1.8],
  sides: [-1.8, -1.2, 1.2, 1.8],
  full: [-1.8, -1.2, -0.6, 0, 0.6, 1.2, 1.8],
};
const FLOOR_ROWS: [number, number[]][] = [[6, ROWS.left], [22, ROWS.full], [38, ROWS.sides], [58, ROWS.right], [71, ROWS.full]];
const CEILING_ROWS: [number, number[]][] = [[68, ROWS.right], [51, ROWS.full], [34, ROWS.left], [19, ROWS.sides], [2, ROWS.full]];
/** Wall spikes: [z, which wall (-1 / +1), height]. Low ones for the way out, high ones for the way back. */
const WALL_SPIKES: [number, number, number][] = [
  [11, -1, 0.5], [27, 1, 0.5], [43, -1, 0.5], [61, 1, 0.5], [73, -1, 0.5],
  [65, -1, H - 0.5], [47, 1, H - 0.5], [29, -1, H - 0.5], [13, 1, H - 0.5], [-1, -1, H - 0.5],
];

/**
 * Loose rocks all along the tunnel: heavy enough that you can barely shove them, but they fall when
 * gravity turns. Boulders roll straight through them.
 */
const ROCKS = 60;
const ROCK_MASS = 400;
const DEATH_SCREEN_DELAY = 1.6;

// --- Looks ---------------------------------------------------------------------------------------
const STONE_FLOOR = [0.3, 0.25, 0.19];
const STONE_WALL = [0.34, 0.28, 0.21];
const STONE_CEIL = [0.25, 0.21, 0.17];
const BOULDER_COLOR = [0.45, 0.39, 0.31];
const VINE_COLOR = [0.25, 0.3, 0.1];
const CAVE_ENV: Environment = {
  ...DEFAULT_ENV,
  sunColor: [0, 0, 0],
  skyColor: [0.035, 0.03, 0.03],
  groundColor: [0.02, 0.017, 0.015],
  fogColor: [0.006, 0.005, 0.004],
  fogDensity: 0.05,
};

interface Piece {
  pos: Vec3;
  size: Vec3;
  color: number[];
}

interface Vine {
  pivot: Vec3;
  /** The way it hangs (down, for whoever will use it). */
  hang: Vec3;
  used: boolean;
  /** Seconds since it snapped (it falls away into the pit). */
  fallT: number;
}

interface Spikes {
  z: [number, number];
  y: number;
  /** +1: pointing up (a floor pit), -1: pointing down (a ceiling pit). */
  dir: number;
}

/** A single spike on the path: from its base to its tip. */
interface Spike {
  base: Vec3;
  tip: Vec3;
  radius: number;
}

type Stage = 'start' | 'drop' | 'chase' | 'endWait' | 'turn' | 'chaseBack';

const DEATHS = {
  boulder: {
    big: 'FLATTENED',
    small: 'Indiana Jones made that look a lot easier.',
    hint: 'Sprint (hold Shift). The boulder rolls faster than you walk, but slower than you run.',
  },
  pit: {
    big: 'SKEWERED',
    small: 'Mind the gap. The gap did not mind you.',
    hint: 'Jump the pits (Space). The widest ones are too far: jump at the vine, hold E or left mouse to grab it, and let go at the top of the swing.',
  },
};

export class TempleLevel implements Level {
  readonly number = 5;
  readonly title = 'Raiders of the Lost Chamber';
  readonly chamber = { none: true };
  status: LevelStatus = 'playing';
  private arrival: PortalArrival;
  private t = 0;
  private stage: Stage = 'start';
  private stageT = 0;
  private pieces: Piece[] = [];
  private spikes: Spikes[] = [];
  private pathSpikes: Spike[] = [];
  private spikeGrace = 0;
  private levelBody: RAPIER.RigidBody;
  private flipped = false;
  /** How long the camera has sat turned over before gravity follows. */
  private holdT = 0;
  private endWall: RAPIER.Collider;
  private wallDrop = 0;
  /** Seconds since the plate was pressed (-1: not yet). */
  private sincePlate = -1;
  private plate: PressurePlate;
  private boulders: Body[] = [];
  /** Boulders parked (kinematic) at a position until they're let go. */
  private parked: (Vec3 | null)[] = [];
  private chasing: Body | null = null;
  private fleeing: Body | null = null;
  private fleeDelay = 0;
  private chaseDelay = 0;
  private vines: Vine[];
  /** The rope the player is holding, and how far along it their hands are. */
  private rope: { vine: Vine; length: number } | null = null;
  private exiting = -1;
  private death: { t: number; kind: keyof typeof DEATHS } | null = null;
  private env: Environment = { ...CAVE_ENV, pointLight: { pos: [0, 0, 0], color: [0, 0, 0], range: 16 } };

  constructor(private ctx: LevelContext) {
    const { physics, hud, camera, player } = ctx;
    hud.setLevel(`The Chamber · Level ${this.number}`);
    hud.show(`LEVEL ${this.number}`, '', 2.5);
    hud.hint('');
    camera.confine = false;

    this.levelBody = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.build();
    this.endWall = this.solid([0, H / 2, END_Z + 0.5], [W, H, 1], STONE_WALL, false);
    this.plate = new PressurePlate(physics, [0, 0, PLATE_Z], [], player, (down) => {
      if (down && this.stage === 'chase') {
        this.setStage('endWait');
        this.sincePlate = 0;
      }
    });
    this.placeSpikes();
    this.scatterRocks();

    // Vine 1 hangs from the ceiling over the widest floor pit; vine 2 hangs from the floor over the
    // shaft, for when gravity points at the ceiling. Both a little past the pit's middle.
    this.vines = [
      { pivot: [0, H, FLOOR_PITS[2][0] + 4.5], hang: [0, -1, 0], used: false, fallT: 0 },
      { pivot: [0, 0, LAND_Z - 0.5], hang: [0, 1, 0], used: false, fallT: 0 },
    ];

    // Boulder 1 waits at the top of the shaft; boulder 2 behind the dead-end wall.
    this.parked = [[0, H + SHAFT_DEPTH - BOULDER_R - 0.3, LAND_Z], [0, BOULDER_R, BOULDER2_Z]];
    this.boulders = this.parked.map((p) => this.makeBoulder(p!));
    for (const b of this.boulders) b.rb.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    this.placeParked();

    this.arrival = new PortalArrival(ctx, [0, 0, SPAWN_Z], { minElevationDeg: 80 });
  }

  // --- Building ------------------------------------------------------------------------------------

  /** A solid block of temple. */
  private solid(pos: Vec3, size: Vec3, color: number[], draw = true): RAPIER.Collider {
    const desc = RAPIER.ColliderDesc.cuboid(size[0] / 2, size[1] / 2, size[2] / 2).setTranslation(pos[0], pos[1], pos[2]);
    const c = this.ctx.physics.world.createCollider(desc, this.levelBody);
    if (draw) this.pieces.push({ pos, size, color });
    return c;
  }

  /** A block between two z values and two y values, across x from -hx to hx. */
  private slab(z0: number, z1: number, y0: number, y1: number, hx: number, color: number[]) {
    if (z1 - z0 < 1e-3 || y1 - y0 < 1e-3) return;
    this.solid([0, (y0 + y1) / 2, (z0 + z1) / 2], [hx * 2, y1 - y0, z1 - z0], color);
  }

  /** An invisible floor over a pit that only boulders touch, with its top at \`y\` (facing \`dir\`). */
  private bridge(z0: number, z1: number, y: number, dir: number) {
    const desc = RAPIER.ColliderDesc.cuboid(W / 2, 0.15, (z1 - z0) / 2)
      .setTranslation(0, y - dir * 0.15, (z0 + z1) / 2)
      .setCollisionGroups(GROUPS_BOULDER_BRIDGE);
    this.ctx.physics.world.createCollider(desc, this.levelBody);
  }

  private build() {
    const yLow = -PIT_DEPTH - 1;
    const yHigh = H + PIT_DEPTH + 1;
    const [s0, s1] = SHAFT;
    // Side walls, tall enough to line the pits. Around the shaft they stop at the ceiling and get
    // thicker, out to the shaft's own (wider) walls.
    for (const side of [-1, 1]) {
      const wall = (z0: number, z1: number, x0: number, x1: number, y0: number, y1: number) =>
        this.solid([side * (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], [x1 - x0, y1 - y0, z1 - z0], STONE_WALL);
      wall(Z_START - 1, s0, W / 2, W / 2 + WALL_T, yLow, yHigh);
      wall(s1, Z_ALCOVE_END + 1, W / 2, W / 2 + WALL_T, yLow, yHigh);
      wall(s0, s1, W / 2, SHAFT_W / 2 + WALL_T, yLow, H);
      wall(s0 - 1, s1 + 1, SHAFT_W / 2, SHAFT_W / 2 + WALL_T, H, H + SHAFT_DEPTH + 1);
    }
    // End caps.
    this.slab(Z_START - 1, Z_START, yLow, yHigh, W / 2, STONE_WALL);
    this.slab(Z_ALCOVE_END, Z_ALCOVE_END + 1, yLow, yHigh, W / 2, STONE_WALL);
    // The shaft's ends and lid.
    this.slab(s0 - 1, s0, H, H + SHAFT_DEPTH + 1, SHAFT_W / 2, STONE_WALL);
    this.slab(s1, s1 + 1, H, H + SHAFT_DEPTH + 1, SHAFT_W / 2, STONE_WALL);
    this.slab(s0, s1, H + SHAFT_DEPTH, H + SHAFT_DEPTH + 1, SHAFT_W / 2, STONE_CEIL);

    // Floor: solid blocks between the pits, each pit with a spiked bottom and a bridge for boulders.
    let z = Z_START;
    for (const [a, b] of FLOOR_PITS) {
      this.slab(z, a, -PIT_DEPTH, 0, W / 2, STONE_FLOOR);
      this.slab(a, b, -PIT_DEPTH - 1, -PIT_DEPTH, W / 2, STONE_FLOOR);
      this.bridge(a, b, 0, 1);
      this.spikes.push({ z: [a, b], y: -PIT_DEPTH, dir: 1 });
      z = b;
    }
    this.slab(z, Z_ALCOVE_END, -PIT_DEPTH, 0, W / 2, STONE_FLOOR);

    // Ceiling: the same, with its own pits (the way back), and a gap for the shaft (no bridge:
    // both boulders end up down there).
    z = Z_START;
    const gaps = [...CEILING_PITS, SHAFT].sort((p, q) => p[0] - q[0]);
    for (const [a, b] of gaps) {
      this.slab(z, a, H, H + PIT_DEPTH, W / 2, STONE_CEIL);
      if (a !== s0) {
        this.slab(a, b, H + PIT_DEPTH, H + PIT_DEPTH + 1, W / 2, STONE_CEIL);
        this.bridge(a, b, H, -1);
        this.spikes.push({ z: [a, b], y: H + PIT_DEPTH, dir: -1 });
      }
      z = b;
    }
    this.slab(z, Z_ALCOVE_END, H, H + PIT_DEPTH, W / 2, STONE_CEIL);
  }

  private placeSpikes() {
    // Every spike a different length (0.8-1.5x) and a little off the grid, so they look hand-set.
    const add1 = (base: Vec3, dir: Vec3, len: number) => {
      const k = 0.8 + Math.random() * 0.7;
      const tip = add(base, scale(dir, len * k));
      this.pathSpikes.push({ base, tip, radius: SPIKE_R * (0.85 + k * 0.15) });
    };
    const jitter = () => (Math.random() - 0.5) * 0.3;
    for (const [z, xs] of FLOOR_ROWS) for (const x of xs) add1([x + jitter(), 0, z + jitter() * 1.5], [0, 1, 0], 0.7);
    for (const [z, xs] of CEILING_ROWS) for (const x of xs) add1([x + jitter(), H, z + jitter() * 1.5], [0, -1, 0], 0.7);
    for (const [z, side, y] of WALL_SPIKES) add1([(side * W) / 2, y + jitter(), z + jitter() * 1.5], [-side, 0, 0], 0.9);
  }

  private scatterRocks() {
    const { physics } = this.ctx;
    for (let i = 0; i < ROCKS; i++) {
      const z = Z_START + 3 + Math.random() * (END_Z - Z_START - 5);
      const x = (Math.random() * 2 - 1) * (W / 2 - 0.5);
      const s = 0.3 + Math.random() * 0.45;
      const size: Vec3 = [s * (0.9 + Math.random() * 0.8), s * (0.5 + Math.random() * 0.4), s * (0.8 + Math.random() * 0.7)];
      const color = STONE_COLORS[Math.floor(Math.random() * STONE_COLORS.length)];
      const body = physics.addBox([x, size[1] / 2 + 0.02, z], size, {
        mass: ROCK_MASS,
        grabbable: false,
        friction: 1,
        rotation: { x: 0, y: Math.sin(i), z: 0, w: Math.cos(i) },
        model: chunkModel(size, color),
      });
      body.collider.setCollisionGroups(GROUPS_DEBRIS);
    }
  }

  private makeBoulder(pos: Vec3): Body {
    const body = this.ctx.physics.addBall(pos, BOULDER_R, {
      mass: 3000,
      friction: 1,
      restitution: 0.05,
      grabbable: false,
      model: boulderModel(BOULDER_R, BOULDER_COLOR),
    });
    body.collider.setCollisionGroups(GROUPS_BOULDER);
    body.rb.setAngularDamping(0);
    return body;
  }

  private placeParked() {
    this.boulders.forEach((b, i) => {
      const p = this.parked[i];
      if (p) b.rb.setNextKinematicTranslation({ x: p[0], y: p[1], z: p[2] });
    });
  }

  private release(i: number, velocity: Vec3 = [0, 0, 0]) {
    const rb = this.boulders[i].rb;
    this.parked[i] = null;
    rb.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    rb.setLinvel({ x: velocity[0], y: velocity[1], z: velocity[2] }, true);
    rb.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  private boulderPos(i: number): Vec3 {
    const t = this.boulders[i].rb.translation();
    return [t.x, t.y, t.z];
  }

  // --- Update --------------------------------------------------------------------------------------

  private turning() {
    return this.stage === 'turn';
  }

  /** During the roll the boulders stay frozen and nothing chases. */
  private rolling() {
    return this.turning();
  }

  private setStage(stage: Stage) {
    this.stage = stage;
    this.stageT = 0;
  }

  update(dt: number) {
    const { player, camera } = this.ctx;
    this.t += dt;
    this.stageT += dt;
    this.arrival.update(dt);
    this.plate.update(dt);
    const me = player.pos;

    if (this.sincePlate >= 0) {
      this.sincePlate += dt;
      const k = clamp((this.sincePlate - WALL_SINK_AT) / WALL_SINK, 0, 1);
      if (k > 0 && this.wallDrop < H + 0.1) {
        // The end wall sinks into the floor with a rumble: a second boulder was behind it.
        this.wallDrop = easeInOut(k) * (H + 0.1);
        this.endWall.setTranslationWrtParent({ x: 0, y: H / 2 - this.wallDrop, z: END_Z + 0.5 });
        camera.addShake(0.25);
      }
    }

    switch (this.stage) {
      case 'start':
        // The boulder drops the moment you head for the portal (or a second after you land).
        if (this.arrival.done && (me[2] < SPAWN_Z - 1.2 || this.stageT > 1)) {
          this.release(0, [0, -12, 0]);
          camera.addShake(0.3);
          this.setStage('drop');
        }
        break;
      case 'drop':
        if (this.boulderPos(0)[1] < BOULDER_R + 0.3) {
          camera.addShake(0.8);
          this.chasing = this.boulders[0];
          this.chaseDelay = ROLL_DELAY;
          this.setStage('chase');
        }
        break;
      case 'chase':
        break; // until the pressure plate at the end
      case 'endWait': {
        // The world freezes for the turn once the first boulder is nearly on the plate (its edge
        // within a metre of the plate's), or after a couple of seconds, whichever comes first.
        const gap = Math.abs(PLATE_Z - this.boulderPos(0)[2]) - BOULDER_R - PLATE_R;
        if (gap <= TURN_WHEN_BOULDER_WITHIN || this.stageT >= TURN_AFTER) this.startTurn();
        break;
      }
      case 'turn': {
        // The world is frozen and only the camera turns (a little behind its target). Once it has
        // caught up and held for a moment, gravity snaps over and everything falls to the ceiling.
        const { camera, player } = this.ctx;
        const k = easeInOut(clamp(this.stageT / ROLL_TIME, 0, 1));
        camera.turnTarget = rotationZ(Math.PI * k);
        if (this.stageT >= ROLL_TIME) {
          if (!camera.aligned(player)) this.holdT = 0;
          else if ((this.holdT += dt) >= ROLL_HOLD) this.endRoll();
        }
        break;
      }
      case 'chaseBack':
        break;
    }

    this.driveChase(dt, me);
    this.driveFlee(dt);
    this.updateRope(dt);
    this.checkSpikes(dt);
    this.checkDeaths();
    this.checkExit(dt);
    this.updateTorch();

    const death = this.death;
    if (death && this.status === 'playing') {
      death.t += dt;
      if (death.t > DEATH_SCREEN_DELAY) {
        const d = DEATHS[death.kind];
        this.status = 'lost';
        this.ctx.hud.show(d.big, `${d.small}\nPress R to try again.`);
        this.ctx.hud.tips([
          ['Hint', d.hint],
          ['Controls', 'WASD move · Shift sprint · Space jump · Hold E or left mouse to hang on to a vine'],
        ]);
      }
    }
  }

  /** Rubber-banded chase: keeps pace with a sprinting player, catches a walking one. */
  private driveChase(dt: number, me: Vec3) {
    const b = this.chasing;
    if (!b || this.rolling()) return;
    if (this.chaseDelay > 0) {
      this.chaseDelay -= dt;
      return;
    }
    const along = this.flipped ? -1 : 1; // which way down the tunnel it chases
    const gap = (me[2] - b.rb.translation().z) * along - BOULDER_R;
    let target = gap > 14 ? CHASE_CATCHUP : gap < 4 ? CHASE_SLOW : CHASE;
    if (this.death) target = 0; // it stops, rather than bulldozing the body
    this.rollAlong(b, along, target, dt);
  }

  /** The first boulder, after the roll: off ahead of you toward the start (and its pit). */
  private driveFlee(dt: number) {
    const b = this.fleeing;
    if (!b || this.rolling()) return;
    if (this.fleeDelay > 0) {
      this.fleeDelay -= dt;
      return;
    }
    this.rollAlong(b, -1, FLEE, dt, FLEE_GAIN);
  }

  /** Eases a boulder's speed along the tunnel (+1: toward the end, -1: toward the start) to \`target\`. */
  private rollAlong(b: Body, along: number, target: number, dt: number, gain = 3) {
    const v = b.rb.linvel();
    const next = v.z + (target * along - v.z) * Math.min(1, dt * gain);
    b.rb.setLinvel({ x: v.x, y: v.y, z: next }, true);
  }

  /** The roll: the world freezes (freezeWorld) while the view turns. */
  private startTurn() {
    this.chasing = null;
    this.rope = null;
    this.holdT = 0;
    this.ctx.player.hanging = false;
    this.ctx.camera.addShake(0.3);
    this.setStage('turn');
  }

  freezeWorld() {
    return this.stage === 'turn';
  }

  /** Gravity rolled by \`angle\` about the tunnel's axis (0: normal, π/2: onto a side wall, π: onto the ceiling). */
  private setGravity(angle: number) {
    const g = rotationZ(angle);
    this.ctx.player.setGravity(g);
    this.ctx.physics.setGravityDirection(transformDir(g, [0, -1, 0]));
  }

  private endRoll() {
    this.flipped = true;
    this.setGravity(Math.PI);
    this.ctx.camera.turnTarget = null; // it follows the player's (now flipped) gravity again
    this.setStage('chaseBack');
    // Everything falls to the ceiling, the player too: limp for a moment, then back on their feet.
    this.ctx.player.knock([0, 0, 0], FALL_STUN);
    // Both boulders fall to the new floor. The first starts rolling off toward the start from rest
    // (if it's close, that's your problem); the second chases you home.
    this.release(0);
    this.release(1);
    this.chasing = this.boulders[1];
    this.chaseDelay = ROLL_DELAY + 0.5;
    this.fleeing = this.boulders[0];
    this.fleeDelay = 0;
    this.ctx.camera.addShake(0.6);
  }

  // --- Vines ---------------------------------------------------------------------------------------

  /** The vine for this half of the run. */
  private activeVine(): Vine {
    return this.vines[this.flipped ? 1 : 0];
  }

  /**
   * A vine is a rope: hold E or left mouse with your hands near it and you're tied to the pivot at
   * that length. Gravity and your own momentum do the swinging; let go and you fly on. It snaps
   * once you let go.
   */
  private updateRope(dt: number) {
    const { player, input } = this.ctx;
    for (const v of this.vines) if (v.used) v.fallT += dt;
    const holding = input.isDown('KeyE') || input.mouseDown;
    const hands = add(player.pos, scale(player.up, GRAB_HEIGHT));
    const rope = this.rope;
    if (rope) {
      if (!holding || player.mode !== 'control' || this.death) {
        this.rope = null;
        rope.vine.used = true;
        player.hanging = false;
        return;
      }
      // Keep the hands on a sphere around the pivot; drop any velocity pulling away from it.
      const d = sub(hands, rope.vine.pivot);
      const dist = length(d);
      if (dist > rope.length) {
        const n = scale(d, 1 / dist);
        player.pos = sub(player.pos, scale(n, dist - rope.length));
        const outward = dot(player.vel, n);
        if (outward > 0) player.vel = sub(player.vel, scale(n, outward));
        player.syncCollider();
      }
      return;
    }
    const vine = this.activeVine();
    if (!holding || vine.used || player.mode !== 'control' || this.rolling()) return;
    const bottom = add(vine.pivot, scale(vine.hang, VINE_LEN));
    if (distToSegment(hands, vine.pivot, bottom) > GRAB_REACH) return;
    this.rope = { vine, length: clamp(length(sub(hands, vine.pivot)), 0.8, VINE_LEN) };
    player.hanging = true;
  }

  // --- Deaths and the exit -----------------------------------------------------------------------

  private checkDeaths() {
    const { player, camera } = this.ctx;
    if (this.death || player.mode !== 'control' || player.inPortal || this.turning()) return;
    // Boulders: any contact is fatal. A small shove; limbs might come off, it doesn't explode.
    for (const b of this.boulders) {
      const c = b.rb.translation();
      const centre: Vec3 = [c.x, c.y, c.z];
      for (const h of [0.3, 1.0, 1.7]) {
        const p = add(player.pos, scale(player.up, h));
        if (length(sub(p, centre)) > BOULDER_R + 0.3) continue;
        const away = normalize(sub(p, centre));
        player.hanging = false;
        player.kill(add(scale(away, 3), scale(player.up, 1.5)), { violence: 19, origin: centre });
        camera.addShake(0.7);
        this.die('boulder');
        return;
      }
    }
    // Pits: down past the floor means onto the spikes.
    const below = this.flipped ? player.pos[1] > H + 1.2 : player.pos[1] < -1.2;
    if (below) {
      player.hanging = false;
      player.kill(scale(player.up, -2), { violence: 10 });
      this.die('pit');
    }
  }

  /** Touching a spike knocks you loose for a moment (they're not deadly, just rude). */
  private checkSpikes(dt: number) {
    const { player } = this.ctx;
    this.spikeGrace = Math.max(0, this.spikeGrace - dt);
    if (this.spikeGrace > 0 || player.mode !== 'control' || player.inPortal || this.rope || this.death) return;
    const feet = player.pos;
    const head = add(feet, scale(player.up, 1.8));
    for (const sp of this.pathSpikes) {
      // Closest approach between the spike and the player's feet-to-head line, sampled along the spike.
      for (let k = 0.2; k <= 1.001; k += 0.2) {
        const p = add(sp.base, scale(sub(sp.tip, sp.base), k));
        if (distToSegment(p, feet, head) > 0.3) continue;
        const away = sub(add(feet, scale(player.up, 0.9)), p);
        const flat = sub(away, scale(player.up, dot(away, player.up)));
        const push = length(flat) > 1e-3 ? scale(normalize(flat), 3) : [0, 0, 0] as Vec3;
        player.knock(add(push, scale(player.up, 2)), SPIKE_STUN);
        this.ctx.camera.addShake(0.2);
        this.spikeGrace = 1;
        return;
      }
    }
  }

  private die(kind: keyof typeof DEATHS) {
    this.ctx.hud.hide();
    this.death = { t: 0, kind };
    this.rope = null;
  }

  private portalCentre(): Vec3 {
    return [0, H / 2, PORTAL_Z];
  }

  private checkExit(dt: number) {
    const { player } = this.ctx;
    if (this.exiting >= 0) {
      this.exiting += dt;
      if (this.exiting >= PORTAL_SQUEEZE_TIME && this.status === 'playing') this.status = 'exited';
      return;
    }
    if (player.mode !== 'control' || this.death) return;
    const centre = this.portalCentre();
    if (length(sub(add(player.pos, scale(player.up, 1.2)), centre)) < PORTAL_R + 0.2) {
      player.hanging = false;
      player.shrinkInto(centre, PORTAL_SQUEEZE_TIME);
      this.exiting = 0;
    }
  }

  // --- Torch ---------------------------------------------------------------------------------------

  /** The torch in the right hand. */
  private torchFrame(): Mat4 | null {
    const player = this.ctx.player;
    if (player.mode === 'hidden') return null;
    return mul(player.partFrames().foreArmR, translation([0, -0.2, -0.09]));
  }

  private updateTorch() {
    const light = this.env.pointLight!;
    const f = this.torchFrame();
    if (!f) {
      light.range = 0;
      return;
    }
    const flame = transformPoint(f, [0, 0.62, 0]);
    const flicker = 0.85 + Math.sin(this.t * 17) * 0.08 + Math.sin(this.t * 29) * 0.07;
    light.pos = add(flame, scale(this.ctx.player.up, 0.1));
    light.color = [2.8 * flicker, 1.35 * flicker, 0.45 * flicker];
    light.range = 13;
  }

  // --- Drawing -------------------------------------------------------------------------------------

  draw(out: DrawItem[], time: number) {
    for (const p of this.pieces) {
      out.push({ mesh: 'box', model: mul(translation(p.pos), scaling(p.size)), color: p.color, pattern: Pattern.panels, param: 1.5, spec: 0.05 });
    }
    // The sinking end wall.
    if (this.wallDrop < H) {
      out.push({
        mesh: 'box',
        model: mul(translation([0, H / 2 - this.wallDrop, END_Z + 0.5]), scaling([W, H, 1])),
        color: STONE_WALL,
        pattern: Pattern.panels,
        param: 1.5,
        spec: 0.05,
      });
    }
    // Spikes at the bottom of every pit (pointing down in the ceiling's).
    for (const s of this.spikes) {
      for (let z = s.z[0] + 0.4; z < s.z[1]; z += 0.8) {
        for (let x = -W / 2 + 0.4; x < W / 2; x += 0.75) {
          const model = mul(translation([x, s.y + s.dir * 0.35, z]), rotationX(s.dir > 0 ? 0 : Math.PI), scaling([0.16, 0.7, 0.16]));
          out.push({ mesh: 'cone', model, color: [0.5, 0.48, 0.44], spec: 0.6 });
        }
      }
    }

    for (const sp of this.pathSpikes) {
      out.push({ mesh: 'cone', model: segment(sp.base, sp.tip, sp.radius), color: [0.55, 0.52, 0.47], spec: 0.7 });
    }

    drawPortal(out, this.portalCentre(), [0, 0, 1], PORTAL_R, true);
    this.arrival.draw(out);
    this.drawVine(out);
    this.drawTorch(out, time);
  }

  private drawVine(out: DrawItem[]) {
    const vine = this.activeVine();
    if (vine.fallT > VINE_FALL_TIME) return;
    const player = this.ctx.player;
    // Snapped vines fall away into the pit.
    const drop = scale(vine.hang, 0.5 * 20 * vine.fallT * vine.fallT);
    const top = add(vine.pivot, drop);
    const end = this.rope ? add(player.pos, scale(player.up, GRAB_HEIGHT)) : add(add(vine.pivot, scale(vine.hang, VINE_LEN)), drop);
    out.push({ mesh: 'cylinder', model: segment(top, end, 0.05), color: VINE_COLOR });
    for (let i = 1; i < 5; i++) {
      const p = add(top, scale(sub(end, top), i / 5));
      out.push({ mesh: 'sphere', model: mul(translation(p), scaling([0.14, 0.05, 0.1])), color: [0.18, 0.35, 0.08] });
    }
  }

  private drawTorch(out: DrawItem[], time: number) {
    const f = this.torchFrame();
    if (!f) return;
    out.push({ mesh: 'cylinder', model: mul(f, translation([0, 0.25, 0]), scaling([0.03, 0.62, 0.03])), color: [0.3, 0.18, 0.08] });
    out.push({ mesh: 'cylinder', model: mul(f, translation([0, 0.53, 0]), scaling([0.05, 0.12, 0.05])), color: [0.12, 0.08, 0.05] });
    const flicker = 1 + Math.sin(time * 23) * 0.15 + Math.sin(time * 41) * 0.1;
    out.push({ mesh: 'cone', model: mul(f, translation([0, 0.68, 0]), scaling([0.07, 0.2 * flicker, 0.07])), color: [6, 2.6, 0.5], pattern: Pattern.emissive, shadow: false });
    out.push({ mesh: 'sphere', model: mul(f, translation([0, 0.63, 0]), scaling([0.06, 0.08, 0.06])), color: [8, 4.5, 1.2], pattern: Pattern.emissive, shadow: false });
  }

  environment() {
    return this.env;
  }

  obstacles() {
    return [];
  }

  cameraShot(): CameraShot | null {
    return this.arrival.cameraShot();
  }
}

function distToSegment(p: Vec3, a: Vec3, b: Vec3): number {
  const ab = sub(b, a);
  const t = clamp(dot(sub(p, a), ab) / Math.max(dot(ab, ab), 1e-6), 0, 1);
  return length(sub(p, add(a, scale(ab, t))));
}
