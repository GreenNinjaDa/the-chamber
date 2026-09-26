import { add, mul, rotationY, scaling, translation, type Mat4, type Vec3 } from '../../engine/math';
import type { RAPIER } from '../../engine/physics';
import { Pattern, type DrawItem } from '../../engine/renderer';
import { CHAMBER_HALF } from '../../game/chamber';
import { junk } from '../../entities/junk';
import { ExitPortal, PortalArrival } from '../../entities/portal';
import { drawDoorRaft, drawPalletRaft, drawVehicle, VEHICLE_SIZE, type VehicleKind } from '../../entities/vehicles';
import { DEFAULT_ENV, type CameraShot, type Level, type LevelContext, type LevelStatus, type TrackedTarget, type WorldLabel } from '../level';

/*
 * Frogger. Why did the test subject cross the road? The chamber floor is now a four-lane road
 * of ridiculous traffic (forklifts, a steamroller, golf carts, runaway office chairs, giant
 * robot vacuums, sports cars) and then a river of toxic goo crossed on floating junk. The exit
 * is open on the far bank the whole time. Vehicles come and go through tunnels in the north
 * and south walls, and so do the rafts, which won't stop for you at the wall.
 */

/** Everything but the river is raised to this height (road, sidewalk, median, far bank). */
const DECK = 0.6;
const GOO_TOP = 0.35;
const RIVER_WEST = 2.2;
const RIVER_EAST = 10.2;
const SIDEWALK_EAST = -10.2;
const MEDIAN_WEST = 1.0;
/**
 * Road lanes are this wide, so there's a strip about a metre wide along each line between lanes
 * that nothing reaches (a little less next to the steamroller): somewhere to stop and look.
 */
const LANE = 2.8;
/** Vehicles and rafts loop through the walls: z runs over this range, the rest hidden in the tunnels. */
const LOOP = 32;
const DEATH_SCREEN_DELAY = 1.7;

interface Lane {
  x: number;
  /** +1 drives south (+z), -1 north. */
  dir: 1 | -1;
  speed: number;
  items: { kind: VehicleKind; offset: number }[];
}

const ROAD: Lane[] = [
  { x: -8.8, dir: -1, speed: 3.2, items: [{ kind: 'forklift', offset: 0 }, { kind: 'steamroller', offset: 11 }, { kind: 'forklift', offset: 22 }] },
  { x: -6.0, dir: 1, speed: 6.5, items: [{ kind: 'golf cart', offset: 0 }, { kind: 'office chair', offset: 11 }, { kind: 'golf cart', offset: 21 }] },
  { x: -3.2, dir: -1, speed: 2.4, items: [{ kind: 'roomba', offset: 0 }, { kind: 'roomba', offset: 6.5 }, { kind: 'roomba', offset: 16 }, { kind: 'roomba', offset: 23 }] },
  { x: -0.4, dir: 1, speed: 10, items: [{ kind: 'sports car', offset: 0 }, { kind: 'sports car', offset: 17 }] },
];

type RaftKind = 'mattress' | 'door' | 'duck' | 'bathtub' | 'pallet';
/** Half width (x) and half length (z) of each raft's deck. */
const RAFT_SIZE: Record<RaftKind, [number, number]> = {
  mattress: [0.7, 1.0],
  door: [0.55, 1.1],
  duck: [1.0, 1.25],
  bathtub: [0.45, 0.85],
  pallet: [0.7, 0.7],
};

interface River {
  x: number;
  dir: 1 | -1;
  speed: number;
  items: { kind: RaftKind; offset: number }[];
}

const RIVER: River[] = [
  { x: 3.2, dir: -1, speed: 2.2, items: [{ kind: 'mattress', offset: 0 }, { kind: 'mattress', offset: 10.5 }, { kind: 'mattress', offset: 21 }] },
  { x: 5.2, dir: 1, speed: 3.0, items: [{ kind: 'door', offset: 0 }, { kind: 'door', offset: 8 }, { kind: 'door', offset: 16 }, { kind: 'door', offset: 24 }] },
  { x: 7.2, dir: -1, speed: 1.6, items: [{ kind: 'duck', offset: 0 }, { kind: 'bathtub', offset: 10 }, { kind: 'duck', offset: 20 }] },
  { x: 9.2, dir: 1, speed: 3.6, items: [{ kind: 'pallet', offset: 0 }, { kind: 'pallet', offset: 1.5 }, { kind: 'pallet', offset: 11 }, { kind: 'pallet', offset: 12.5 }, { kind: 'pallet', offset: 22 }, { kind: 'pallet', offset: 23.5 }] },
];

interface Raft {
  kind: RaftKind;
  x: number;
  z: number;
  vz: number;
  collider: RAPIER.Collider;
}

interface Death {
  t: number;
  big: string;
  small: string;
}

const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

export class FroggerLevel implements Level {
  readonly number: number;
  readonly title = 'Frogger';
  status: LevelStatus = 'playing';
  private arrival: PortalArrival;
  private exit = new ExitPortal(0, DECK);
  private time = 0;
  private death: Death | null = null;
  private rafts: Raft[] = [];
  private raftByCollider = new Map<number, Raft>();
  /** The raft the player stood on last (to tell a wall-dunking from a missed jump). */
  private lastRaft: Raft | null = null;
  private bubbles: { pos: Vec3; age: number }[] = [];
  private splash: Vec3 | null = null;
  private labelList: WorldLabel[] = [
    { pos: [-CHAMBER_HALF + 0.3, 4.2, 0], text: 'CAUTION: TEST SUBJECTS CROSSING', size: 0.55, color: '#ffd166' },
    { pos: [CHAMBER_HALF - 0.3, 4.6, 0], text: 'DO NOT DRINK THE GOO', size: 0.5, color: '#b6ff7a' },
  ];
  private duckModel = junk('rubber duck').model;
  private mattressModel = junk('mattress').model;
  private bathtubModel = junk('bathtub').model;

  constructor(private ctx: LevelContext) {
    this.number = ctx.number;
    const { physics, hud } = ctx;
    hud.setLevel(`The Chamber · Level ${this.number}`);
    hud.show(`LEVEL ${this.number}`, '', 2.5);
    hud.hint('');
    // Dropped almost straight down onto the sidewalk (not into the traffic).
    this.arrival = new PortalArrival(ctx, [-11.2, DECK, 0], { minElevationDeg: 75 });

    // The raised deck: sidewalk, road and median to the west of the river, and the far bank.
    const westWidth = RIVER_WEST + CHAMBER_HALF;
    physics.addStaticBox([-CHAMBER_HALF + westWidth / 2, DECK / 2, 0], [westWidth, DECK, CHAMBER_HALF * 2]);
    const eastWidth = CHAMBER_HALF - RIVER_EAST;
    physics.addStaticBox([RIVER_EAST + eastWidth / 2, DECK / 2, 0], [eastWidth, DECK, CHAMBER_HALF * 2]);

    // Rafts: a thin solid deck each (moved every frame), their tops level with the banks.
    for (const lane of RIVER) {
      for (const it of lane.items) {
        const [hw, hl] = RAFT_SIZE[it.kind];
        const collider = physics.addStaticBox([lane.x, DECK - 0.15, 0], [hw * 2, 0.3, hl * 2]);
        const raft: Raft = { kind: it.kind, x: lane.x, z: 0, vz: lane.dir * lane.speed, collider };
        this.rafts.push(raft);
        this.raftByCollider.set(collider.handle, raft);
      }
    }
    this.placeTraffic();
  }

  /** Where something on a loop is at the current time. */
  private loopZ(offset: number, dir: number, speed: number) {
    const s = (((offset + speed * this.time) % LOOP) + LOOP) % LOOP;
    return dir > 0 ? -LOOP / 2 + s : LOOP / 2 - s;
  }

  private placeTraffic() {
    let k = 0;
    for (const lane of RIVER) {
      for (const it of lane.items) {
        const raft = this.rafts[k++];
        raft.z = this.loopZ(it.offset, lane.dir, lane.speed);
        raft.collider.setTranslation({ x: raft.x, y: DECK - 0.15, z: raft.z });
      }
    }
  }

  private die(big: string, small: string) {
    this.death = { t: 0, big, small };
  }

  update(dt: number) {
    const { player, hud, physics } = this.ctx;
    const death = this.death;
    if (death && this.status === 'playing') {
      death.t += dt;
      if (death.t > DEATH_SCREEN_DELAY) {
        this.status = 'lost';
        hud.show(death.big, `${death.small}\nPress R to try again.`);
        hud.tips([
          ['Hint', 'Cross the road in the gaps (the little robots and chairs can be jumped). In the goo, hop from raft to raft, and get off before one carries you into the wall.'],
          ['Controls', 'WASD move · Space jump · Shift sprint'],
        ]);
      }
    }
    this.arrival.update(dt);
    this.exit.update(dt, player);
    if (this.exit.entered && this.status === 'playing') this.status = 'exited';
    this.time += dt;
    this.placeTraffic();
    if (this.arrival.done && !this.exit.open) this.exit.openNow();

    // Bubbles in the goo.
    if (Math.random() < dt * 6) {
      this.bubbles.push({ pos: [RIVER_WEST + Math.random() * (RIVER_EAST - RIVER_WEST), GOO_TOP, (Math.random() - 0.5) * 23], age: 0 });
    }
    for (const b of this.bubbles) b.age += dt;
    this.bubbles = this.bubbles.filter((b) => b.age < 1.2);

    // Riding a raft: carried along with it (the player adds this to their own movement).
    player.platformVel = [0, 0, 0];
    const alive = player.mode === 'control' && !this.death && !player.inPortal && this.arrival.done;
    if (!alive) return;
    const p = player.pos;
    const under = physics.raycast([p[0], p[1] + 0.3, p[2]], [0, -1, 0], 0.5, player.collider ?? undefined);
    const raft = under ? this.raftByCollider.get(under.collider.handle) : undefined;
    if (raft) {
      player.platformVel = [0, 0, raft.vz];
      this.lastRaft = raft;
    }

    // Into the goo.
    if (p[0] > RIVER_WEST + 0.1 && p[0] < RIVER_EAST - 0.1 && p[1] < GOO_TOP + 0.1) {
      this.splash = [p[0], GOO_TOP, p[2]];
      player.kill([0, 0.5, 0], { violence: 0 });
      const walled = this.lastRaft && Math.abs(p[2]) > CHAMBER_HALF - 2.5;
      this.die('DISSOLVED', walled
        ? "Rafts don't stop at walls. Neither did you."
        : pick(['The goo is not water. The goo was never water.', 'You swam like a brick. A dissolving brick.', 'Frogs can swim. You, it turns out, are not a frog.']));
      return;
    }
    if (p[0] < RIVER_WEST || p[0] > RIVER_EAST) this.lastRaft = null;

    // Traffic.
    for (const lane of ROAD) {
      if (Math.abs(p[0] - lane.x) > LANE * 0.6) continue;
      for (const it of lane.items) {
        const size = VEHICLE_SIZE[it.kind];
        const z = this.loopZ(it.offset, lane.dir, lane.speed);
        const hit = Math.abs(p[0] - lane.x) < size.hw + 0.2 && Math.abs(p[2] - z) < size.hl + 0.2 && p[1] < DECK + size.h - 0.05;
        if (!hit) continue;
        this.runOver(it.kind, lane);
        return;
      }
    }
  }

  private runOver(kind: VehicleKind, lane: Lane) {
    const { player, camera } = this.ctx;
    const v = lane.dir * lane.speed;
    const side = Math.sign(player.pos[0] - lane.x) || 1;
    switch (kind) {
      case 'roomba':
      case 'office chair':
        // Small, but rude: knocked flying (probably into the next lane).
        if (player.gettingUp || player.stun > 0) return;
        player.knock([side * 3, 4, v * 0.8], kind === 'roomba' ? 0.7 : 0.9);
        camera.addShake(0.3);
        return;
      case 'steamroller':
        player.kill([side * 1.5, 1, v * 0.3], { violence: 8 });
        camera.addShake(0.8);
        this.die('PANCAKED', pick(['Flat. Like a pancake. Or a doormat with ambitions.', 'It was doing three miles an hour. You had one job.']));
        return;
      default:
        player.kill([side * 2, 7 + Math.abs(v) * 0.4, v * 1.4], { violence: Math.min(30, 8 + Math.abs(v) * 1.6) });
        camera.addShake(0.9);
        this.die('ROADKILL', pick([
          'Why did the test subject cross the road? He did not.',
          kind === 'forklift' ? 'Delivered. To the afterlife. Sign here.' : kind === 'golf cart' ? 'FORE!' : 'Zero to sixty. You, not the car.',
          'Look left, look right, look left again. You looked up.',
        ]));
    }
  }

  // --- Drawing ------------------------------------------------------------------------------------

  draw(out: DrawItem[]) {
    this.arrival.draw(out);
    this.exit.draw(out);
    const H = CHAMBER_HALF;

    // The deck: sidewalk, road, median, far bank.
    const slab = (x0: number, x1: number, color: number[], y0 = 0, y1 = DECK, extra: Partial<DrawItem> = {}) =>
      out.push({ mesh: 'box', model: mul(translation([(x0 + x1) / 2, (y0 + y1) / 2, 0]), scaling([x1 - x0, y1 - y0, H * 2])), color, ...extra });
    slab(-H, SIDEWALK_EAST, [0.66, 0.66, 0.64], 0, DECK, { spec: 0.1 });
    slab(SIDEWALK_EAST - 0.2, SIDEWALK_EAST + 0.02, [0.8, 0.8, 0.78], 0, DECK + 0.04);
    slab(SIDEWALK_EAST, MEDIAN_WEST, [0.12, 0.12, 0.13], 0, DECK, { spec: 0.2 });
    slab(MEDIAN_WEST, RIVER_WEST, [0.22, 0.45, 0.17], 0, DECK);
    slab(RIVER_EAST, H, [0.66, 0.66, 0.64], 0, DECK, { spec: 0.1 });
    // Lane markings: dashed white between lanes, solid yellow along the median.
    for (let k = 1; k < ROAD.length; k++) {
      const x = SIDEWALK_EAST + k * LANE;
      for (let z = -H + 0.8; z < H; z += 3) {
        out.push({ mesh: 'box', model: mul(translation([x, DECK + 0.005, z]), scaling([0.12, 0.012, 1.5])), color: [0.9, 0.9, 0.88], shadow: false });
      }
    }
    out.push({ mesh: 'box', model: mul(translation([MEDIAN_WEST - 0.12, DECK + 0.005, 0]), scaling([0.12, 0.012, H * 2])), color: [0.95, 0.75, 0.1], shadow: false });
    // The goo.
    out.push({ mesh: 'box', model: mul(translation([(RIVER_WEST + RIVER_EAST) / 2, GOO_TOP / 2, 0]), scaling([RIVER_EAST - RIVER_WEST, GOO_TOP, H * 2])), color: [0, 0, 0], pattern: Pattern.lava, param: 1, shadow: false });
    for (const b of this.bubbles) {
      const r = 0.06 + b.age * 0.1;
      out.push({ mesh: 'sphere', model: mul(translation(add(b.pos, [0, b.age * 0.05, 0])), scaling([r, r * 0.6, r])), color: [0.4, 1.4, 0.2], pattern: Pattern.emissive, shadow: false });
    }
    if (this.splash && this.death) {
      const t = this.death.t;
      for (let k = 0; k < 6; k++) {
        const a = k * 1.05 + t;
        const r = 0.1 + t * 0.25;
        out.push({ mesh: 'sphere', model: mul(translation(add(this.splash, [Math.cos(a) * 0.4, t * 0.1, Math.sin(a) * 0.4])), scaling([r, r * 0.5, r])), color: [0.5, 1.6, 0.25], pattern: Pattern.emissive, shadow: false });
      }
    }

    // Tunnel mouths in the north and south walls, for every lane.
    for (const zs of [-1, 1]) {
      const z = zs * (H - 0.012);
      for (const lane of ROAD) out.push({ mesh: 'box', model: mul(translation([lane.x, DECK + 1.3, z]), scaling([LANE - 0.1, 2.6, 0.02])), color: [0.02, 0.02, 0.025], shadow: false });
      for (const r of RIVER) out.push({ mesh: 'box', model: mul(translation([r.x, GOO_TOP + 0.5, z]), scaling([1.95, 1.1, 0.02])), color: [0.02, 0.03, 0.02], shadow: false });
    }

    // Traffic.
    for (const lane of ROAD) {
      for (const it of lane.items) {
        const z = this.loopZ(it.offset, lane.dir, lane.speed);
        if (Math.abs(z) > H + VEHICLE_SIZE[it.kind].hl) continue;
        drawVehicle(out, it.kind, mul(translation([lane.x, DECK, z]), rotationY(lane.dir > 0 ? Math.PI : 0)), this.time + it.offset);
      }
    }
    for (const r of this.rafts) {
      if (Math.abs(r.z) > H + 1.5) continue;
      const bob = Math.sin(this.time * 2 + r.z) * 0.025;
      const m = mul(translation([r.x, DECK + bob, r.z]), rotationY(r.vz > 0 ? Math.PI : 0));
      this.drawRaft(out, r.kind, m);
    }
  }

  /** A raft, with the top of its deck at the origin of `m`. */
  private drawRaft(out: DrawItem[], kind: RaftKind, m: Mat4) {
    const side = rotationY(Math.PI / 2);
    switch (kind) {
      case 'mattress':
        this.mattressModel(out, mul(m, translation([0, -0.125, 0]), side));
        break;
      case 'door':
        drawDoorRaft(out, m);
        break;
      case 'pallet':
        drawPalletRaft(out, m);
        break;
      case 'bathtub':
        this.bathtubModel(out, mul(m, translation([0, -0.3, 0]), side));
        break;
      case 'duck':
        // A giant rubber duck: you ride on its back.
        this.duckModel(out, mul(m, translation([0, -0.35, 0]), scaling([5, 5, 5])));
        break;
    }
  }

  labels(): WorldLabel[] {
    return this.labelList;
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

