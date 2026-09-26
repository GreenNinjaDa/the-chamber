import {
  add, clamp, dot, easeInOut, length, mul, normalize, rotationX, rotationZ, scale, scaling, segment, sub, toQuat, transformDir, transformPoint, translation,
  type Mat4, type Vec3,
} from '../../engine/math';
import { GROUPS_BOULDER, GROUPS_BOULDER_BRIDGE, RAPIER, type Body } from '../../engine/physics';
import { Pattern, type DrawItem, type Environment } from '../../engine/renderer';
import { drawPortal, PORTAL_SQUEEZE_TIME, PortalArrival } from '../../entities/portal';
import { DEFAULT_ENV, type CameraShot, type Level, type LevelContext, type LevelStatus } from '../level';

/*
 * The boulder temple (an Indiana Jones parody). Its own map: a dark, sloping stone tunnel lit only
 * by the torch in your hand. The exit portal is right there... until a boulder drops out of the
 * ceiling in front of it and chases you down the tunnel, over spiked pits (one needs a vine).
 * At the dead end the wall sinks into the floor to reveal a second boulder, and gravity slowly
 * rolls over: a quarter turn drops you onto the side wall for a moment, another onto the ceiling,
 * and the new boulder chases you home. The first one rolls ahead of you and drops down its own shaft,
 * now a pit, which you cross on a second vine to reach the portal. Boulders kill on contact.
 *
 * The map is built in "track" space (floor y = 0, ceiling y = H, running along +z) on one fixed
 * body. It never moves: the flip turns gravity (the physics world's and the player's own) about
 * the tunnel's axis, so the player really does fall onto the wall and then the ceiling.
 */

// --- Track layout (track space) -----------------------------------------------------------------
const H = 5; // tunnel height
const W = 4.6; // tunnel width (a 4 m boulder leaves no room to dodge past)
const WALL_T = 1;
const SLOPE = 0; // drop per metre toward +z (flat: gravity has to be square to the walls and ceiling too)
const Z_START = -20;
const Z_ALCOVE_END = 87;
const END_Z = 80; // the dead-end wall that sinks away
const PORTAL_Z = -18;
const PORTAL_R = 2;
const SPAWN_Z = -2;
/** The shaft the first boulder drops from, in the ceiling above the cave (a pit after the flip). */
const SHAFT: [number, number] = [-11, -5];
const SHAFT_DEPTH = 6;
const LAND_Z = -8;
/** Spiked pits in the floor; the wide one needs the vine. */
const PITS: [number, number][] = [[14, 16.5], [30, 32.5], [46.5, 51.5], [64, 66.5]];
const PIT_DEPTH = 6;
const BOULDER_R = 2;
const BOULDER2_Z = 83.5;

// Vines: pivot (track space), rope length, and which way along the track they swing you.
const VINE_LEN = 2.6;
const VINE1 = { pivot: [0, H, 49] as Vec3, dir: 1 };
const VINE2 = { pivot: [0, 0, LAND_Z] as Vec3, dir: -1 };
/** Hands to feet while hanging. */
const HANG = 2.0;
const SWING_TIME = 0.9;
const SWING_TO = (45 * Math.PI) / 180;
const RELEASE_FORWARD = 7;
const RELEASE_UP = 3.5;

// Chase: boulder speed (m/s) by the gap to the player. Walking (5) gets you caught, sprinting (8.5) doesn't.
const CHASE_SLOW = 6.2;
const CHASE = 7.2;
const CHASE_CATCHUP = 9.5;
const ROLL_DELAY = 0.7;
/** After the flip the first boulder rolls away toward the start faster than anyone can run. */
const FLEE = 10.5;

const END_WAIT = 1;
const WALL_SINK = 1;
/** The gravity roll: each quarter turn takes this long, with a pause standing on the side wall in between. */
const QUARTER_TURN = 2.5;
const ON_THE_WALL = 1.5;
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
  dir: number;
}

type Stage = 'start' | 'drop' | 'chase' | 'endWait' | 'wallDown' | 'turn1' | 'onWall' | 'turn2' | 'chaseBack';

const DEATHS = {
  boulder: {
    big: 'FLATTENED',
    small: 'Indiana Jones made that look a lot easier.',
    hint: 'Sprint (hold Shift). The boulder rolls faster than you walk, but slower than you run.',
  },
  pit: {
    big: 'SKEWERED',
    small: 'Mind the gap. The gap did not mind you.',
    hint: 'Jump the pits (Space). For the widest one, jump into the vine: it swings you across.',
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
  private levelBody: RAPIER.RigidBody;
  private base: Mat4 = rotationX(Math.atan(SLOPE));
  private flip: Mat4 = rotationX(0);
  private level: Mat4 = this.base;
  private inverse: Mat4 = this.base;
  private flipped = false;
  private endWall: RAPIER.Collider;
  private wallDrop = 0;
  private boulders: Body[] = [];
  /** Boulders parked (kinematic) at a track-space position until they're let go. */
  private parked: (Vec3 | null)[] = [];
  private chasing: Body | null = null;
  private fleeing: Body | null = null;
  private fleeDelay = 0;
  private chaseDelay = 0;
  private swing: { vine: Vine; t: number; from: number } | null = null;
  private vineCooldown = 0;
  private exiting = -1;
  private death: { t: number; kind: keyof typeof DEATHS } | null = null;
  private env: Environment = { ...CAVE_ENV, pointLight: { pos: [0, 0, 0], color: [0, 0, 0], range: 16 } };

  constructor(private ctx: LevelContext) {
    const { physics, hud, camera } = ctx;
    hud.setLevel(`The Chamber · Level ${this.number}`);
    hud.show(`LEVEL ${this.number}`, '', 2.5);
    hud.hint('');
    camera.confine = false;

    this.levelBody = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.setLevelPose();
    this.build();
    this.endWall = this.solid([0, H / 2, END_Z + 0.5], [W, H, 1], STONE_WALL, false);

    // Boulder 1 waits up the shaft; boulder 2 behind the dead-end wall.
    this.boulders = [this.makeBoulder([0, H + 2.5, LAND_Z]), this.makeBoulder([0, BOULDER_R, BOULDER2_Z])];
    this.parked = [[0, H + 2.5, LAND_Z], [0, BOULDER_R, BOULDER2_Z]];
    for (const b of this.boulders) b.rb.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    this.placeParked();

    this.arrival = new PortalArrival(ctx, this.toWorld([0, 0, SPAWN_Z]), { minElevationDeg: 80 });
  }

  // --- Level space ---------------------------------------------------------------------------------

  private turning() {
    return this.stage === 'turn1' || this.stage === 'turn2';
  }

  /** The whole roll, pause included: boulders stay frozen and nothing chases. */
  private rolling() {
    return this.turning() || this.stage === 'onWall';
  }

  private setLevelPose() {
    this.level = mul(this.base, this.flip);
    this.inverse = invertRigid(this.level);
    const q = toQuat(this.level);
    const p = { x: this.level[12], y: this.level[13], z: this.level[14] };
    if (this.turning()) {
      this.levelBody.setNextKinematicTranslation(p);
      this.levelBody.setNextKinematicRotation(q);
    } else {
      this.levelBody.setTranslation(p, true);
      this.levelBody.setRotation(q, true);
    }
  }

  private toWorld(p: Vec3): Vec3 {
    return transformPoint(this.level, p);
  }

  private toTrack(p: Vec3): Vec3 {
    return transformPoint(this.inverse, p);
  }

  private dirToTrack(d: Vec3): Vec3 {
    const m = this.inverse;
    return [m[0] * d[0] + m[4] * d[1] + m[8] * d[2], m[1] * d[0] + m[5] * d[1] + m[9] * d[2], m[2] * d[0] + m[6] * d[1] + m[10] * d[2]];
  }

  private dirToWorld(d: Vec3): Vec3 {
    const m = this.level;
    return [m[0] * d[0] + m[4] * d[1] + m[8] * d[2], m[1] * d[0] + m[5] * d[1] + m[9] * d[2], m[2] * d[0] + m[6] * d[1] + m[10] * d[2]];
  }

  // --- Building ------------------------------------------------------------------------------------

  /** A solid block of temple (track space), attached to the level body. */
  private solid(pos: Vec3, size: Vec3, color: number[], draw = true): RAPIER.Collider {
    const desc = RAPIER.ColliderDesc.cuboid(size[0] / 2, size[1] / 2, size[2] / 2).setTranslation(pos[0], pos[1], pos[2]);
    const c = this.ctx.physics.world.createCollider(desc, this.levelBody);
    if (draw) this.pieces.push({ pos, size, color });
    return c;
  }

  private build() {
    const wallX = W / 2 + WALL_T / 2;
    const yLow = -PIT_DEPTH - 1, yHigh = H + SHAFT_DEPTH + 1;
    const len = Z_ALCOVE_END - Z_START;
    const midZ = (Z_START + Z_ALCOVE_END) / 2;
    // Side walls, tall enough to line the pits and the shaft.
    for (const x of [-wallX, wallX]) this.solid([x, (yLow + yHigh) / 2, midZ], [WALL_T, yHigh - yLow, len + 2], STONE_WALL);
    // End caps.
    this.solid([0, (yLow + yHigh) / 2, Z_START - 0.5], [W, yHigh - yLow, 1], STONE_WALL);
    this.solid([0, (yLow + yHigh) / 2, Z_ALCOVE_END + 0.5], [W, yHigh - yLow, 1], STONE_WALL);

    // Floor: solid blocks between the pits, each pit with a spiked floor far below.
    let z = Z_START;
    for (const [a, b] of [...PITS, [Z_ALCOVE_END, Z_ALCOVE_END]] as [number, number][]) {
      if (a > z) this.solid([0, -PIT_DEPTH / 2, (z + a) / 2], [W, PIT_DEPTH, a - z], STONE_FLOOR);
      if (b > a) {
        this.solid([0, -PIT_DEPTH - 0.5, (a + b) / 2], [W, 1, b - a], STONE_FLOOR);
        // Boulders roll over the pits on an invisible bridge only they can touch.
        const bridge = RAPIER.ColliderDesc.cuboid(W / 2, 0.15, (b - a) / 2).setTranslation(0, -0.15, (a + b) / 2).setCollisionGroups(GROUPS_BOULDER_BRIDGE);
        this.ctx.physics.world.createCollider(bridge, this.levelBody);
      }
      z = b;
    }

    // Ceiling: solid except the shaft, which has a lid at the top.
    this.solid([0, H + SHAFT_DEPTH / 2, (Z_START + SHAFT[0]) / 2], [W, SHAFT_DEPTH, SHAFT[0] - Z_START], STONE_CEIL);
    this.solid([0, H + SHAFT_DEPTH / 2, (SHAFT[1] + Z_ALCOVE_END) / 2], [W, SHAFT_DEPTH, Z_ALCOVE_END - SHAFT[1]], STONE_CEIL);
    this.solid([0, H + SHAFT_DEPTH + 0.5, (SHAFT[0] + SHAFT[1]) / 2], [W, 1, SHAFT[1] - SHAFT[0]], STONE_CEIL);
  }

  private makeBoulder(track: Vec3): Body {
    const body = this.ctx.physics.addBall(this.toWorld(track), BOULDER_R, {
      mass: 3000,
      friction: 1,
      restitution: 0.05,
      grabbable: false,
      model: boulderModel,
    });
    body.collider.setCollisionGroups(GROUPS_BOULDER);
    body.rb.setAngularDamping(0);
    return body;
  }

  private placeParked() {
    this.boulders.forEach((b, i) => {
      const p = this.parked[i];
      if (!p) return;
      const w = this.toWorld(p);
      b.rb.setNextKinematicTranslation({ x: w[0], y: w[1], z: w[2] });
    });
  }

  private release(i: number, velocity: Vec3 = [0, 0, 0]) {
    const rb = this.boulders[i].rb;
    this.parked[i] = null;
    rb.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    rb.setLinvel({ x: velocity[0], y: velocity[1], z: velocity[2] }, true);
    rb.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  // --- Update --------------------------------------------------------------------------------------

  private boulderTrack(i: number): Vec3 {
    const t = this.boulders[i].rb.translation();
    return this.toTrack([t.x, t.y, t.z]);
  }

  private setStage(stage: Stage) {
    this.stage = stage;
    this.stageT = 0;
  }

  update(dt: number) {
    const { player, camera } = this.ctx;
    this.t += dt;
    this.stageT += dt;
    this.vineCooldown = Math.max(0, this.vineCooldown - dt);
    this.arrival.update(dt);
    const me = this.toTrack(player.pos);

    switch (this.stage) {
      case 'start':
        // The boulder drops the moment you head for the portal (or a second after you land).
        if (this.arrival.done && (me[2] < SPAWN_Z - 1.2 || this.stageT > 1)) {
          this.release(0, scale(this.dirToWorld([0, -1, 0]), 12));
          camera.addShake(0.3);
          this.setStage('drop');
        }
        break;
      case 'drop':
        if (this.boulderTrack(0)[1] < BOULDER_R + 0.3) {
          camera.addShake(0.8);
          this.chasing = this.boulders[0];
          this.chaseDelay = ROLL_DELAY;
          this.setStage('chase');
        }
        break;
      case 'chase':
        if (me[2] > END_Z - 7) this.setStage('endWait');
        break;
      case 'endWait':
        if (this.stageT >= END_WAIT) this.setStage('wallDown');
        break;
      case 'wallDown':
        // The end wall sinks into the floor with a rumble: a second boulder was behind it.
        this.wallDrop = easeInOut(clamp(this.stageT / WALL_SINK, 0, 1)) * (H + 0.1);
        this.endWall.setTranslationWrtParent({ x: 0, y: H / 2 - this.wallDrop, z: END_Z + 0.5 });
        camera.addShake(0.25);
        if (this.stageT >= WALL_SINK) this.startTurn('turn1');
        break;
      case 'turn1':
      case 'turn2': {
        // Gravity turns about the tunnel's axis; the player (and their camera) turn with it.
        const k = easeInOut(clamp(this.stageT / QUARTER_TURN, 0, 1));
        this.setGravity((Math.PI / 2) * ((this.stage === 'turn2' ? 1 : 0) + k));
        if (this.stageT >= QUARTER_TURN) {
          if (this.stage === 'turn1') this.setStage('onWall');
          else this.endFlip();
        }
        break;
      }
      case 'onWall':
        if (this.stageT >= ON_THE_WALL) this.startTurn('turn2');
        break;
      case 'chaseBack':
        break;
    }

    this.driveChase(dt, me);
    this.driveFlee(dt);
    this.updateVines(dt, me);
    this.checkDeaths(me);
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
          ['Controls', 'WASD move · Shift sprint · Space jump (jump into a vine to grab it)'],
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
    const i = this.boulders.indexOf(b);
    const along = this.flipped ? -1 : 1; // which way down the track it chases
    const gap = (me[2] - this.boulderTrack(i)[2]) * along - BOULDER_R;
    let target = gap > 14 ? CHASE_CATCHUP : gap < 4 ? CHASE_SLOW : CHASE;
    if (this.stage === 'endWait' || this.stage === 'wallDown') {
      // Don't arrive before the temple flips (that's the rescue).
      const left = (this.stage === 'endWait' ? END_WAIT - this.stageT + WALL_SINK : WALL_SINK - this.stageT) + 0.3;
      // (and stop well short: after the roll it has to get away from the player, not onto them).
      target = Math.min(target, Math.max(0, (gap - 8) / left));
    }
    if (this.death) target = CHASE;
    this.rollAlong(b, along, target, dt);
  }

  /** The first boulder, after the flip: rolls off ahead of you toward the start (and its pit). */
  private driveFlee(dt: number) {
    const b = this.fleeing;
    if (!b || this.rolling()) return;
    if (this.fleeDelay > 0) {
      this.fleeDelay -= dt;
      return;
    }
    this.rollAlong(b, -1, FLEE, dt);
  }

  /** Eases a boulder's speed along the track (+1: toward the end, -1: toward the start) to `target`. */
  private rollAlong(b: Body, along: number, target: number, dt: number) {
    const dir = this.dirToWorld([0, 0, along]);
    const v = b.rb.linvel();
    const vel: Vec3 = [v.x, v.y, v.z];
    const cur = dot(vel, dir);
    const next = add(vel, scale(dir, (target - cur) * Math.min(1, dt * 3)));
    b.rb.setLinvel({ x: next[0], y: next[1], z: next[2] }, true);
  }

  /** A quarter turn of gravity. The boulders freeze where they are until it's all over. */
  private startTurn(stage: 'turn1' | 'turn2') {
    if (stage === 'turn1') {
      this.parked = this.boulders.map((_, i) => this.boulderTrack(i));
      for (const b of this.boulders) b.rb.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
      this.chasing = null;
    }
    this.ctx.camera.addShake(0.3);
    this.setStage(stage);
  }

  /** Gravity rolled by `angle` about the tunnel's axis (0: normal, π/2: onto a side wall, π: onto the ceiling). */
  private setGravity(angle: number) {
    const g = rotationZ(angle);
    this.ctx.player.setGravity(g);
    this.ctx.physics.setGravityDirection(transformDir(g, [0, -1, 0]));
  }

  private endFlip() {
    const { camera } = this.ctx;
    this.flipped = true;
    this.setGravity(Math.PI);
    this.setStage('chaseBack');
    // Both boulders fall to the new floor; the first rolls off ahead, the second chases you home.
    this.release(0, scale(this.dirToWorld([0, 0, -1]), FLEE));
    this.release(1);
    this.chasing = this.boulders[1];
    this.chaseDelay = ROLL_DELAY + 0.5;
    this.fleeing = this.boulders[0];
    this.fleeDelay = 0;
    camera.addShake(0.6);
  }

  // --- Vines ---------------------------------------------------------------------------------------

  private activeVine(): Vine {
    return this.flipped ? VINE2 : VINE1;
  }

  /** A vine's swing plane: its pivot, which way is down (gravity), and the direction it carries you. */
  private vineFrame(vine: Vine): { pivot: Vec3; ahead: Vec3; down: Vec3 } {
    const up = this.ctx.player.up;
    const d = this.dirToWorld([0, 0, vine.dir]);
    const ahead = normalize(sub(d, scale(up, dot(d, up))));
    return { pivot: this.toWorld(vine.pivot), ahead, down: scale(up, -1) };
  }

  private updateVines(dt: number, me: Vec3) {
    const { player } = this.ctx;
    const vine = this.activeVine();
    const { pivot, ahead, down } = this.vineFrame(vine);
    if (this.swing) {
      const s = this.swing;
      s.t += dt;
      const k = clamp(s.t / SWING_TIME, 0, 1);
      const angle = s.from + (SWING_TO - s.from) * easeInOut(k);
      const hand = add(pivot, add(scale(ahead, Math.sin(angle) * VINE_LEN), scale(down, Math.cos(angle) * VINE_LEN)));
      player.pos = add(hand, scale(down, HANG));
      if (k >= 1) {
        this.swing = null;
        this.vineCooldown = 1;
        player.resume(add(scale(ahead, RELEASE_FORWARD), scale(down, -RELEASE_UP)));
      }
      return;
    }
    if (player.mode !== 'control' || player.onGround || this.vineCooldown > 0 || this.rolling()) return;
    // Jumped into the vine? Grab it if your hands pass close to the rope while heading the right way.
    const hands = add(player.pos, scale(down, -HANG));
    const bottom = add(pivot, scale(down, VINE_LEN));
    if (distToSegment(hands, pivot, bottom) > 1.3 || dot(player.vel, ahead) < 0.5) return;
    const rel = sub(hands, pivot);
    const from = clamp(Math.atan2(dot(rel, ahead), dot(rel, down)), -1, 0.2);
    player.mode = 'swinging';
    player.facing = Math.atan2(-ahead[0], -ahead[2]);
    this.swing = { vine, t: 0, from };
    void me;
  }

  // --- Deaths and the exit -----------------------------------------------------------------------

  private checkDeaths(me: Vec3) {
    const { player, camera } = this.ctx;
    if (this.death || player.mode === 'ragdoll' || player.mode === 'hidden' || player.inPortal || this.turning()) return;
    // Boulders: any contact is fatal.
    for (const b of this.boulders) {
      const c = b.rb.translation();
      const centre: Vec3 = [c.x, c.y, c.z];
      for (const h of [0.3, 1.0, 1.7]) {
        if (length(sub(add(player.pos, scale(player.up, h)), centre)) > BOULDER_R + 0.3) continue;
        const v = b.rb.linvel();
        if (player.mode !== 'control') player.resume();
        player.kill([v.x * 1.2, v.y * 1.2 + 4, v.z * 1.2], { violence: 45, origin: centre });
        camera.addShake(1);
        this.die('boulder');
        return;
      }
    }
    // Pits: down past the floor means onto the spikes.
    const below = this.stage === 'onWall' ? false : this.flipped ? me[1] > H + 1.2 : me[1] < -1.2;
    if (below && player.mode === 'control') {
      player.kill([0, -2, 0], { violence: 20 });
      this.die('pit');
    }
  }

  private die(kind: keyof typeof DEATHS) {
    this.ctx.hud.hide();
    this.death = { t: 0, kind };
  }

  private portalCentre(): Vec3 {
    return this.toWorld([0, H / 2, PORTAL_Z]);
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
      player.shrinkInto(centre, PORTAL_SQUEEZE_TIME);
      this.exiting = 0;
    }
  }

  // --- Torch ---------------------------------------------------------------------------------------

  /** The torch in the right hand: the tip of it, where the flame is. */
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
    light.pos = [flame[0], flame[1] + 0.1, flame[2]];
    light.color = [2.8 * flicker, 1.35 * flicker, 0.45 * flicker];
    light.range = 13;
  }

  // --- Drawing -------------------------------------------------------------------------------------

  draw(out: DrawItem[], time: number) {
    const L = this.level;
    for (const p of this.pieces) {
      out.push({ mesh: 'box', model: mul(L, translation(p.pos), scaling(p.size)), color: p.color, pattern: Pattern.panels, param: 1.5, spec: 0.05 });
    }
    // The sinking end wall.
    if (this.wallDrop < H) {
      out.push({
        mesh: 'box',
        model: mul(L, translation([0, H / 2 - this.wallDrop, END_Z + 0.5]), scaling([W, H, 1])),
        color: STONE_WALL,
        pattern: Pattern.panels,
        param: 1.5,
        spec: 0.05,
      });
    }
    // Spikes at the bottom of every pit.
    for (const [a, b] of PITS) {
      for (let z = a + 0.4; z < b; z += 0.8) {
        for (let x = -W / 2 + 0.4; x < W / 2; x += 0.75) {
          out.push({ mesh: 'cone', model: mul(L, translation([x, -PIT_DEPTH + 0.35, z]), scaling([0.16, 0.7, 0.16])), color: [0.5, 0.48, 0.44], spec: 0.6 });
        }
      }
    }

    // The exit portal, and the vine for this half of the run.
    const n = this.dirToWorld([0, 0, 1]);
    drawPortal(out, this.portalCentre(), n, PORTAL_R, true);
    this.arrival.draw(out);
    const vine = this.activeVine();
    const { pivot, down } = this.vineFrame(vine);
    const player = this.ctx.player;
    const end: Vec3 = this.swing ? add(player.pos, scale(down, -HANG)) : add(pivot, scale(down, VINE_LEN));
    out.push({ mesh: 'cylinder', model: segment(pivot, end, 0.05), color: VINE_COLOR });
    for (let i = 1; i < 5; i++) {
      const p = add(pivot, scale(sub(end, pivot), i / 5));
      out.push({ mesh: 'sphere', model: mul(translation(p), scaling([0.14, 0.05, 0.1])), color: [0.18, 0.35, 0.08] });
    }

    // The torch.
    const f = this.torchFrame();
    if (f) {
      out.push({ mesh: 'cylinder', model: mul(f, translation([0, 0.25, 0]), scaling([0.03, 0.62, 0.03])), color: [0.3, 0.18, 0.08] });
      out.push({ mesh: 'cylinder', model: mul(f, translation([0, 0.53, 0]), scaling([0.05, 0.12, 0.05])), color: [0.12, 0.08, 0.05] });
      const flicker = 1 + Math.sin(time * 23) * 0.15 + Math.sin(time * 41) * 0.1;
      out.push({ mesh: 'cone', model: mul(f, translation([0, 0.68, 0]), scaling([0.07, 0.2 * flicker, 0.07])), color: [6, 2.6, 0.5], pattern: Pattern.emissive, shadow: false });
      out.push({ mesh: 'sphere', model: mul(f, translation([0, 0.63, 0]), scaling([0.06, 0.08, 0.06])), color: [8, 4.5, 1.2], pattern: Pattern.emissive, shadow: false });
    }
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

/** A rough, almost-round boulder in its body frame. */
function boulderModel(out: DrawItem[], m: Mat4) {
  const r = BOULDER_R;
  out.push({ mesh: 'sphere', model: mul(m, scaling([r, r * 0.95, r * 0.98])), color: BOULDER_COLOR, spec: 0.05 });
  const lumps: [Vec3, Vec3][] = [
    [[0.8, 0.9, 0.9], [0.9, 0.6, 0.8]], [[-0.9, -0.5, 0.7], [0.8, 0.7, 0.6]], [[0.2, -1.0, -0.9], [0.9, 0.6, 0.7]],
    [[-0.6, 1.1, -0.6], [0.7, 0.5, 0.8]], [[1.2, -0.3, -0.6], [0.6, 0.8, 0.7]],
  ];
  for (const [p, s] of lumps) {
    out.push({ mesh: 'sphere', model: mul(m, translation(p), scaling(s)), color: BOULDER_COLOR.map((c) => c * 0.9), spec: 0.05 });
  }
}

function distToSegment(p: Vec3, a: Vec3, b: Vec3): number {
  const ab = sub(b, a);
  const t = clamp(dot(sub(p, a), ab) / Math.max(dot(ab, ab), 1e-6), 0, 1);
  return length(sub(p, add(a, scale(ab, t))));
}

/** Inverse of a rotation + translation matrix. */
function invertRigid(m: Mat4): Mat4 {
  const r = new Float32Array(16);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i * 4 + j] = m[j * 4 + i];
  const t = [m[12], m[13], m[14]];
  for (let i = 0; i < 3; i++) r[12 + i] = -(r[i] * t[0] + r[4 + i] * t[1] + r[8 + i] * t[2]);
  r[15] = 1;
  return r;
}
