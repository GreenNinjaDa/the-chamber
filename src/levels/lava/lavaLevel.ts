import { add, mul, normalize, rotationX, rotationY, scale, scaling, segment, sub, translation, type Vec3 } from '../../engine/math';
import { Pattern, type DrawItem, type Environment } from '../../engine/renderer';
import { CHAMBER_HALF, WALL_HEIGHT } from '../../game/chamber';
import { RAPIER } from '../../engine/physics';
import { ExitPortal, PortalArrival } from '../../entities/portal';
import { UselessBox } from '../../entities/uselessBox';
import { DEFAULT_ENV, type CameraShot, type Level, type LevelContext, type LevelStatus, type TrackedTarget, type WorldLabel } from '../level';

/*
 * Useless Box. Lava fills the chamber, rising slowly. You arrive on a ledge by the exit; in the
 * far corner, across a line of rock pillars, a ledge holds a big black box with a lever. The
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
/** The far corner ledge (the same white panels as the start ledge): x and z from -CHAMBER_HALF to CORNER_EDGE. */
const CORNER_EDGE = -8.8;
/** The box: 1.8x a normal useless box, standing near the corner and facing out into the room. */
const BOX_SIZE = 1.8;
const BOX_POS: Vec3 = [-10.9, TOP, -10.9];
const PILLAR_R = 1.0;
const CORNER_W = CORNER_EDGE + CHAMBER_HALF;
const LEDGES: { pos: Vec3; size: Vec3 }[] = [
  { pos: [(LEDGE_X + CHAMBER_HALF) / 2, TOP / 2, 0], size: [CHAMBER_HALF - LEDGE_X, TOP, LEDGE_HALF_Z * 2] },
  { pos: [-CHAMBER_HALF + CORNER_W / 2, TOP / 2, -CHAMBER_HALF + CORNER_W / 2], size: [CORNER_W, TOP, CORNER_W] },
];
/**
 * The stepping stones, in order: from the left (south) end of the ledge, a long S through the
 * whole pit to the ledge in the far corner. Gaps are about 2–2.4 m (a walking jump clears ~3.4 m), except
 * the long sprint-jump from the 4th to the 5th under the wrecking ball.
 */
const PATH: [number, number][] = [
  [8.4, 4.3], [5.3, 7.3], [1.1, 8.2], [-3.1, 7.1], [-3.3, 1.2],
  [1.0, -0.6], [2.5, -4.3], [-1.1, -6.7], [-4.4, -8.0], [-7.1, -7.0],
];
/** Lava surface height at the start, and how fast it rises (m/s): the lowest stone goes under after ~1 min 40 s. */
const LAVA_START = 0.3;
const LAVA_RISE = 0.026;
const LAVA_MAX = 9;
const DEATH_SCREEN_DELAY = 1.8;
/**
 * Roofed over, so the lava is the only light: it shines straight up, fading with height above the
 * lava (so the room brightens as it rises), and leaves soft, faint shading on the roof above things.
 */
const LAVA_LIGHT: Environment = {
  ...DEFAULT_ENV,
  sunDir: [0.1, -1, 0.06],
  sunColor: [3.2, 1.15, 0.28],
  skyColor: [0.14, 0.05, 0.02],
  groundColor: [0.5, 0.17, 0.04],
  fogColor: [0.08, 0.02, 0.008],
  fogDensity: 0.012,
  lightFromBelow: LAVA_START,
};

/**
 * The wrecking ball: hangs from the roof between the 4th and 5th stones and swings across the
 * gap at jumping head height. Get hit and you're knocked limp, sideways, into the lava.
 */
const BALL_PIVOT: Vec3 = [-3.2, 10, 4.15];
const BALL_R = 0.6;
/** Rope length (ball centre hangs this far below the roof), swing amplitude (rad) and period (s). */
const BALL_ROPE = 4.4;
const BALL_SWING = 0.45;
const BALL_PERIOD = 3.2;
const BALL_KNOCK_STUN = 2.5;

/** The 3rd stone from the end sinks this far and back up over one loop (half down, half up). */
const SINKER = PATH.length - 3;
const SINK_DEPTH = 1.8;
const SINK_PERIOD = 10;

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
  collider: RAPIER.Collider;
  /** How far it has sunk right now (only the sinking stone moves). */
  drop: number;
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
  readonly chamber = { litFromBelow: true };
  private env: Environment = { ...LAVA_LIGHT };
  status: LevelStatus = 'playing';
  private arrival: PortalArrival;
  private exit = new ExitPortal(0, TOP);
  private box: UselessBox;
  private pillars: Pillar[] = [];
  private lava = LAVA_START;
  private t = 0;
  private deadAt = -1;
  private labelList: WorldLabel[];
  private ball: RAPIER.RigidBody;
  private ballPos: Vec3 = [0, 0, 0];
  private ballVel: Vec3 = [0, 0, 0];
  private lastHit = -10;

  constructor(private ctx: LevelContext) {
    const { physics, hud } = ctx;
    hud.setLevel(`The Chamber · Level ${this.number}`);
    hud.show(`LEVEL ${this.number}`, '', 2.5);
    hud.hint('');
    // Dropped straight down: the ledge is small and the alternative is lava.
    this.arrival = new PortalArrival(ctx, SPAWN, { minElevationDeg: 84 });

    // The ledge by the exit, and the one in the far corner with the box.
    for (const l of LEDGES) physics.addStaticBox(l.pos, l.size);

    for (const [x, z] of PATH) this.addPillar([x, 0, z], PILLAR_R, TOP - 0.1 + Math.random() * 0.25);

    // The wrecking ball: kinematic, so a limp body bounces off it too.
    this.ball = physics.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(BALL_PIVOT[0], BALL_PIVOT[1] - BALL_ROPE, BALL_PIVOT[2]));
    physics.world.createCollider(RAPIER.ColliderDesc.ball(BALL_R), this.ball);
    this.swingBall(0);

    // The box in the corner, its lever facing out into the room.
    const face: Vec3 = [1, 0, 1];
    this.box = new UselessBox(
      physics,
      BOX_POS,
      Math.atan2(face[0], face[2]),
      (on) => (on ? this.exit.openNow() : this.exit.closeNow()),
      BOX_SIZE,
    );
    const front = add(add(BOX_POS, [0, 0.55, 0]), scale(normalize(face), 0.68));
    this.labelList = [{ pos: front, text: 'DO NOT TOUCH', size: 0.13, color: '#ffd166' }];
  }

  private addPillar(pos: Vec3, radius: number, top: number) {
    const collider = this.ctx.physics.addStaticCylinder([pos[0], top / 2, pos[2]], radius, top);
    this.pillars.push({ pos, radius, top, pieces: rockPieces(pos, radius, top), collider, drop: 0 });
  }

  /** The sinking stone: eases down for half the loop and back up for the other half, carrying whoever stands on it. */
  private moveSinker() {
    const p = this.pillars[SINKER];
    const drop = (SINK_DEPTH * (1 - Math.cos((this.t / SINK_PERIOD) * Math.PI * 2))) / 2;
    const dy = p.drop - drop; // how far the top moved up this tick
    const player = this.ctx.player;
    const onIt = player.mode === 'control' && Math.hypot(player.pos[0] - p.pos[0], player.pos[2] - p.pos[2]) < p.radius + 0.2 &&
      Math.abs(player.pos[1] - (p.top - p.drop)) < 0.15;
    p.drop = drop;
    p.collider.setTranslation({ x: p.pos[0], y: p.top / 2 - drop, z: p.pos[2] });
    if (onIt) {
      player.pos[1] += dy;
      player.syncCollider(); // the character controller moves from its collider, so bring that along too
    }
  }

  /** Swings across the path (along x), pendulum-style. */
  private swingBall(t: number) {
    const w = (Math.PI * 2) / BALL_PERIOD;
    const a = BALL_SWING * Math.sin(w * t);
    const da = BALL_SWING * w * Math.cos(w * t);
    this.ballPos = [BALL_PIVOT[0] + Math.sin(a) * BALL_ROPE, BALL_PIVOT[1] - Math.cos(a) * BALL_ROPE, BALL_PIVOT[2]];
    this.ballVel = [Math.cos(a) * BALL_ROPE * da, Math.sin(a) * BALL_ROPE * da, 0];
    this.ball.setNextKinematicTranslation({ x: this.ballPos[0], y: this.ballPos[1], z: this.ballPos[2] });
  }

  /** A hit to the head (or chest) knocks the player limp along the ball's swing. */
  private checkBall() {
    const { player } = this.ctx;
    const body = player.body;
    if (!body || player.mode !== 'control' || player.inPortal || this.t - this.lastHit < 1) return;
    for (const part of ['head', 'chest'] as const) {
      const p = body.position(part);
      if (Math.hypot(p[0] - this.ballPos[0], p[1] - this.ballPos[1], p[2] - this.ballPos[2]) > BALL_R + 0.28) continue;
      const side = Math.sign(this.ballVel[0]) || 1;
      player.knock([side * Math.max(7, Math.abs(this.ballVel[0]) * 1.3), 2, (p[2] - this.ballPos[2]) * 3], BALL_KNOCK_STUN);
      this.ctx.camera.addShake(0.5);
      this.lastHit = this.t;
      return;
    }
  }

  update(dt: number) {
    const { player, hud } = this.ctx;
    this.t += dt;
    this.swingBall(this.t);
    this.moveSinker();
    this.checkBall();
    this.lava = Math.min(LAVA_MAX, this.lava + LAVA_RISE * dt);
    this.arrival.update(dt);
    this.box.update(dt);
    this.exit.update(dt, player);
    if (this.exit.entered && this.status === 'playing') this.status = 'exited';

    // Into the lava.
    if (this.deadAt < 0 && player.mode === 'control' && !player.inPortal && player.pos[1] < this.lava - 0.15) {
      // No drama: they just go limp where they are.
      player.kill([0, 0, 0], { violence: 0 });
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
        ['Controls', 'WASD move · Shift sprint · Space jump · Hold left click to grab the lever and push it'],
      ]);
    }
  }

  draw(out: DrawItem[]) {
    // The roof.
    out.push({
      mesh: 'box',
      model: mul(translation([0, WALL_HEIGHT + 0.15, 0]), scaling([CHAMBER_HALF * 2 + 0.4, 0.3, CHAMBER_HALF * 2 + 0.4])),
      color: LEDGE,
      pattern: Pattern.panels,
      param: 2,
      spec: 0.1,
    });
    // The wrecking ball and its chain.
    const b = this.ballPos;
    // The cap on top of the ball always points up the chain at the pivot.
    const up = normalize(sub(BALL_PIVOT, b));
    const capTop = add(b, scale(up, BALL_R + 0.1));
    out.push({ mesh: 'cylinder', model: segment(capTop, BALL_PIVOT, 0.035), color: [0.2, 0.2, 0.22], spec: 0.7 });
    out.push({ mesh: 'cylinder', model: mul(translation(BALL_PIVOT), scaling([0.2, 0.1, 0.2])), color: [0.2, 0.2, 0.22], spec: 0.5 });
    out.push({ mesh: 'sphere', model: mul(translation(b), scaling([BALL_R, BALL_R, BALL_R])), color: [0.28, 0.28, 0.3], spec: 0.9 });
    out.push({ mesh: 'cylinder', model: segment(add(b, scale(up, BALL_R * 0.8)), capTop, 0.12), color: [0.2, 0.2, 0.22], spec: 0.7 });
    // The ledge, in the same white panels as the walls.
    for (const l of LEDGES) out.push({
      mesh: 'box',
      model: mul(translation(l.pos), scaling(l.size)),
      color: LEDGE,
      pattern: Pattern.panels,
      param: 2,
      spec: 0.15,
    });
    for (const p of this.pillars) {
      if (p.drop === 0) for (const piece of p.pieces) out.push(piece);
      else for (const piece of p.pieces) out.push({ ...piece, model: mul(translation([0, -p.drop, 0]), piece.model) });
    }
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
    this.env.lightFromBelow = this.lava;
    return this.env;
  }

  obstacles() {
    return [];
  }

  cameraShot(): CameraShot | null {
    return this.arrival.cameraShot();
  }
}
