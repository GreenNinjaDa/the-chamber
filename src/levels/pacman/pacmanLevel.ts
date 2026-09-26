import { tone } from '../../engine/audio';
import { add, clamp, easeInOut, lerp, mul, rotationY, rotationZ, scale, scaling, segment, sub, translation, type Vec3 } from '../../engine/math';
import type { RAPIER } from '../../engine/physics';
import { Pattern, type DrawItem, type Environment } from '../../engine/renderer';
import { CHAMBER_HALF } from '../../game/chamber';
import { ExitPortal, PortalArrival } from '../../entities/portal';
import { GHOST_COLORS, GHOST_RADIUS } from '../../entities/ghost';
import { DEFAULT_ENV, type CameraShot, type Level, type LevelContext, type LevelStatus, type TrackedTarget, type WorldLabel } from '../level';
import { GhostCrew, type Ghost, type GhostName, type Quarry } from './ghosts';
import {
  addMazeColliders, BONUS_CELL, cellX, cellZ, drawMaze, MAZE_WALL_HEIGHT, PELLET_SPOTS, pushOutOfWalls, START_CELL,
} from './maze';

/*
 * Pac-Man, with the test subject as Pac-Man. The floor goes dark, a glowing blue maze rises out of
 * it with a ghost house in the middle, and four ghosts come out one by one to hunt you with their
 * arcade personalities. Eat every pellet to clear the maze (it flashes and sinks away) and open
 * the exit. The big blinking pellets turn the ghosts blue for a while, and blue ghosts can be
 * eaten. Touching any other ghost is GAME OVER.
 */

const SPAWN: Vec3 = [cellX(START_CELL.i), 0, cellZ(START_CELL.j)];

// --- Tunables --------------------------------------------------------------------------------
/** Seconds for the maze to rise out of the floor, and of READY! before the ghosts come out. */
const RISE_TIME = 1.8;
const READY_TIME = 2.2;
/** The camera's swoop back down behind the player at the end of READY!. */
const CAMERA_RETURN = 0.8;
/** Highest camera pitch while the maze is up, so the camera stays above the walls (about 2 m up). */
const MAX_PITCH = -0.1;
/** Eating reach (m, from the player's feet, across the floor) for pellets and power pellets. */
const EAT_RADIUS = 0.75;
const POWER_EAT_RADIUS = 0.9;
/** A ghost this close (m, centre to the player's feet) touches you. */
const TOUCH_RADIUS = GHOST_RADIUS + 0.28;
/** How long a power pellet scares the ghosts (s). */
const FRIGHT_TIME = 7;
const PELLET_SCORE = 10;
const POWER_SCORE = 50;
const GHOST_SCORES = [200, 400, 800, 1600];
/** A cherry turns up under the ghost house after this many pellets, for CHERRY_TIME seconds. */
const CHERRY_AT = [25, 60];
const CHERRY_TIME = 9.5;
const CHERRY_SCORE = 100;
const CHERRY_EAT_RADIUS = 0.9;
const CHERRY_POS: Vec3 = [cellX(BONUS_CELL.i), 0, cellZ(BONUS_CELL.j)];
const CHERRY_RED = [2.0, 0.07, 0.05];
const CHERRY_SHINE = [2.5, 2.2, 2.2];
const CHERRY_STEM = [0.55, 0.3, 0.08];
const CHERRY_LEAF = [0.2, 1.1, 0.15];
/** The high score on the wall. Billy Mitchell's perfect game; nobody's beating it in here. */
const HIGH_SCORE = 3333360;
/** Pellets float at waist height. */
const PELLET_Y = 0.85;
const PELLET_R = 0.11;
const POWER_R = 0.3;
/** With this few pellets left, they get markers so the last stragglers can be found. */
const MARK_PELLETS = 3;
/** Death: everything freezes this long, then the player spins, shrinks away and pops. */
const DEATH_FREEZE = 0.9;
const DEATH_SHRINK_AT = DEATH_FREEZE + 0.2;
const DEATH_SHRINK = 1.2;
const DEATH_POP_AT = DEATH_SHRINK_AT + DEATH_SHRINK;
const DEATH_SCREEN_AT = DEATH_POP_AT + 0.9;
/** Level clear: the maze flashes, then sinks, then the exit opens. */
const CLEAR_FLASH_START = 0.4;
const CLEAR_FLASHES = 8;
const CLEAR_FLASH_STEP = 0.22;
const CLEAR_SINK_AT = CLEAR_FLASH_START + CLEAR_FLASHES * CLEAR_FLASH_STEP;
const CLEAR_SINK_TIME = 1.6;

const PELLET_COLOR = [2.2, 0.6, 0.08];
const POWER_COLOR = [2.8, 0.8, 0.12];
const FLOOR_LIT = [0.6, 0.61, 0.63];
const FLOOR_DARK = [0.03, 0.035, 0.1];

/** Moonlit arcade: the sun dims to a moon, the sky goes black and the glowing maze does the rest. */
const ARCADE_ENV: Environment = {
  ...DEFAULT_ENV,
  sunColor: [0.2, 0.2, 0.22],
  skyColor: [0.025, 0.03, 0.08],
  groundColor: [0.02, 0.02, 0.05],
  fogColor: [0.006, 0.007, 0.022],
  fogDensity: 0.003,
};

const KILLER_LINES: Record<GhostName, string> = {
  blinky: "Blinky got you. He's been chasing people like you since 1980.",
  pinky: 'Pinky got you. She saw you coming, four cells ahead.',
  inky: 'Inky got you. Nobody knows what Inky is thinking. Not even Inky.',
  clyde: "Clyde got you. CLYDE. He wasn't even trying.",
};
const DEATH_OPENERS = ['Waka waka wasted.', 'Inky, Blinky, Pinky and Clyde send their regards.', 'You have been eaten by the things you were supposed to eat.'];
const CLEAR_QUIPS: [string, string][] = [
  ['NOM NOM NOM', 'The high score is still 3,333,360. Nice try, though.'],
  ['WAKA WAKA', 'You ate every glowing sphere off the floor. Science is proud, and slightly concerned.'],
];

const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

type Phase = 'arrival' | 'rise' | 'ready' | 'play' | 'dying' | 'clear';

interface Pellet {
  pos: Vec3;
  power: boolean;
  eaten: boolean;
  /** Seconds after the maze is up before it pops in (a wave out from the middle). */
  delay: number;
  item: DrawItem;
  target: TrackedTarget;
}

interface Burst {
  pos: Vec3;
  t: number;
  color: ArrayLike<number>;
  kind: 'pop' | 'sparkle';
}

interface Popup {
  label: WorldLabel;
  pos: Vec3;
  t: number;
}

export class PacmanLevel implements Level {
  readonly number: number;
  readonly title = 'Pac-Man';
  status: LevelStatus = 'playing';
  private arrival: PortalArrival;
  private exit = new ExitPortal(0);
  private phase: Phase = 'arrival';
  private phaseT = 0;
  private t = 0;
  /** How far the maze is out of the floor (0-1), and how dark the lighting is (0-1). */
  private rise = 0;
  private dark = 0;
  private flash = false;
  private colliders: RAPIER.Collider[] = [];
  private pellets: Pellet[];
  private pelletsLeft: number;
  private crew = new GhostCrew();
  private ghostsVisible = true;
  private score = 0;
  private powerEaten = 0;
  private waka = false;
  /** Seconds left on the bonus cherry (0: none). */
  private cherryT = 0;
  private heading: [number, number] = [0, -1];
  private quarry: Quarry = { x: 0, z: 0, hi: 0, hj: -1 };
  private bursts: Burst[] = [];
  private env: Environment = { ...DEFAULT_ENV, sunColor: [...DEFAULT_ENV.sunColor], skyColor: [...DEFAULT_ENV.skyColor], groundColor: [...DEFAULT_ENV.groundColor], fogColor: [...DEFAULT_ENV.fogColor] };
  private glow = { pos: [0, 0, 0] as Vec3, color: [0, 0, 0] as Vec3, range: 7 };
  private floorColor = [...FLOOR_LIT];
  // World text: the scoreboard on the north wall, READY!, and ghost scores.
  private oneUp: WorldLabel = { pos: [-6.5, 7.4, -CHAMBER_HALF + 0.05], text: '', size: 0.75, color: '#ffffff' };
  private scoreLabel: WorldLabel = { pos: [-6.5, 6.4, -CHAMBER_HALF + 0.05], text: '', size: 0.75, color: '#ffffff' };
  private highTitle: WorldLabel = { pos: [2.5, 7.4, -CHAMBER_HALF + 0.05], text: '', size: 0.75, color: '#ffffff' };
  private highLabel: WorldLabel = { pos: [2.5, 6.4, -CHAMBER_HALF + 0.05], text: '', size: 0.75, color: '#ffffff' };
  private ready: WorldLabel = { pos: [cellX(BONUS_CELL.i), 1.0, cellZ(BONUS_CELL.j)], text: '', size: 0.8, color: '#ffe600' };
  private popups: Popup[] = [];
  private labelList: WorldLabel[];
  private targets: TrackedTarget[] = [];
  /** The player's death: who did it, and the spin. */
  private killer: GhostName | null = null;
  private spinAxis: Vec3 = [0, 0, 0];
  private shrinkPivot: Vec3 = [0, 0, 0];
  private shrunk = false;
  private popped = false;
  /** Where the camera holds during the death: pulled back a little from where it was, looking at the player. */
  private deathCam: CameraShot | null = null;

  constructor(private ctx: LevelContext) {
    this.number = ctx.number;
    const { hud } = ctx;
    hud.setLevel(`The Chamber · Level ${this.number}`);
    hud.show(`LEVEL ${this.number}`, '', 2.5);
    hud.hint('');
    this.arrival = new PortalArrival(ctx, SPAWN);

    this.pellets = PELLET_SPOTS.map(({ i, j, power }) => {
      const pos: Vec3 = [cellX(i), PELLET_Y, cellZ(j)];
      const r = power ? POWER_R : PELLET_R;
      return {
        pos,
        power,
        eaten: false,
        delay: Math.hypot(pos[0], pos[2]) / 16 * 0.7,
        item: {
          mesh: 'sphere',
          model: mul(translation(pos), scaling([r, r, r])),
          color: power ? POWER_COLOR : PELLET_COLOR,
          pattern: Pattern.emissive,
          shadow: false,
        },
        target: { pos, radius: 0.35, color: 'purple' },
      };
    });
    this.pelletsLeft = this.pellets.length;
    this.popups = [0, 1, 2, 3].map(() => ({ label: { pos: [0, 0, 0], text: '', size: 0.55, color: '#5ff8ff' }, pos: [0, 0, 0], t: -1 }));
    this.labelList = [this.oneUp, this.scoreLabel, this.highTitle, this.highLabel, this.ready, ...this.popups.map((p) => p.label)];
  }

  private setPhase(p: Phase) {
    this.phase = p;
    this.phaseT = 0;
  }

  update(dt: number) {
    const { player, camera, hud } = this.ctx;
    this.t += dt;
    this.phaseT += dt;
    this.arrival.update(dt);
    this.updateQuarry();

    switch (this.phase) {
      case 'arrival':
        if (this.arrival.done) {
          this.setPhase('rise');
          // Face north for the overview, so the view comes back down behind the player.
          camera.yaw = 0;
          camera.pitch = -0.3;
        }
        break;
      case 'rise': {
        const k = easeInOut(clamp(this.phaseT / RISE_TIME, 0, 1));
        this.rise = k;
        this.dark = k;
        // The walls shove the player aside as they come up.
        if (player.mode === 'control' && pushOutOfWalls(player.pos, 0.42)) player.syncCollider();
        if (this.phaseT >= RISE_TIME) {
          this.colliders = addMazeColliders(this.ctx.physics);
          this.setPhase('ready');
        }
        break;
      }
      case 'ready':
        this.ready.text = 'READY!';
        if (this.phaseT >= READY_TIME) {
          this.ready.text = '';
          this.crew.running = true;
          this.setPhase('play');
        }
        break;
      case 'play':
        this.cherryT = Math.max(0, this.cherryT - dt);
        this.eatPellets();
        this.crew.pelletsLeft = this.pelletsLeft;
        this.crew.update(dt, this.quarry, this.t);
        this.checkGhosts();
        if (this.pelletsLeft === 0 && this.phase === 'play') this.cleared();
        break;
      case 'dying':
        this.updateDeath();
        break;
      case 'clear':
        this.updateClear();
        break;
    }
    if (!this.crew.running) this.crew.update(dt, this.quarry, this.t);
    // While the maze is up, keep the camera above the walls: no looking up (there's nothing up there).
    if (this.rise > 0.3) camera.pitch = Math.min(camera.pitch, MAX_PITCH);

    this.updateLabels(dt);
    for (const b of this.bursts) b.t += dt;
    if (this.bursts.length && this.bursts[0].t > 1) this.bursts = this.bursts.filter((b) => b.t <= 1);

    this.exit.update(dt, player);
    if (this.exit.entered && this.status === 'playing') this.status = 'exited';

    if (this.phase === 'dying' && this.status === 'playing' && this.phaseT >= DEATH_SCREEN_AT) {
      this.status = 'lost';
      const name = this.killer ?? 'blinky';
      hud.show('GAME OVER', `${pick(DEATH_OPENERS)}\n${KILLER_LINES[name]}\nPress R to insert another coin.`);
      hud.tips([
        ['Hint', this.powerEaten === 0
          ? 'Eat every pellet. The big blinking ones turn the ghosts blue for a while: then you can eat them.'
          : 'Eat every pellet. Blue ghosts are food; flashing ones are about to stop being food.'],
        ['Controls', 'WASD move · Shift sprint'],
      ]);
    }
  }

  /** Where the player is and which way they're heading on the grid (for Pinky and Inky). */
  private updateQuarry() {
    const p = this.ctx.player;
    const vx = p.vel[0], vz = p.vel[2];
    if (Math.hypot(vx, vz) > 1) {
      this.heading = Math.abs(vx) > Math.abs(vz) ? [Math.sign(vx), 0] : [0, Math.sign(vz)];
    }
    const q = this.quarry;
    q.x = p.pos[0];
    q.z = p.pos[2];
    q.hi = this.heading[0];
    q.hj = this.heading[1];
  }

  private eatPellets() {
    const { player } = this.ctx;
    if (player.mode !== 'control' || player.inPortal) return;
    const p = player.pos;
    for (const pellet of this.pellets) {
      if (pellet.eaten) continue;
      const reach = pellet.power ? POWER_EAT_RADIUS : EAT_RADIUS;
      const dx = pellet.pos[0] - p[0], dz = pellet.pos[2] - p[2];
      if (dx * dx + dz * dz > reach * reach) continue;
      // Jumping over one doesn't count: it has to be somewhere between your feet and your head.
      if (pellet.pos[1] < p[1] - 0.3 || pellet.pos[1] > p[1] + 1.9) continue;
      pellet.eaten = true;
      this.pelletsLeft--;
      this.waka = !this.waka;
      tone(this.waka ? 330 : 220, 0.09, { to: this.waka ? 220 : 330, wave: 'triangle', vol: 0.25 });
      if (pellet.power) {
        this.score += POWER_SCORE;
        this.powerEaten++;
        this.crew.frighten(FRIGHT_TIME);
        for (let i = 0; i < 6; i++) tone(200 + i * 60, 0.1, { to: 700 + i * 60, wave: 'square', vol: 0.08, at: i * 0.1 });
        this.bursts.push({ pos: pellet.pos, t: 0, color: POWER_COLOR, kind: 'pop' });
      } else {
        this.score += PELLET_SCORE;
      }
      // Bonus fruit appears under the ghost house after so many pellets, like the arcade's.
      const eatenCount = this.pellets.length - this.pelletsLeft;
      if (CHERRY_AT.includes(eatenCount)) this.cherryT = CHERRY_TIME;
    }
    if (this.cherryT > 0 && Math.hypot(CHERRY_POS[0] - p[0], CHERRY_POS[2] - p[2]) < CHERRY_EAT_RADIUS) {
      this.cherryT = 0;
      this.score += CHERRY_SCORE;
      this.bursts.push({ pos: CHERRY_POS, t: 0, color: CHERRY_RED, kind: 'pop' });
      this.popup(CHERRY_POS, String(CHERRY_SCORE), '#ffb8ff');
    }
  }

  private popup(at: Vec3, text: string, color: string) {
    const popup = this.popups.find((u) => u.t < 0) ?? this.popups[0];
    popup.t = 0;
    popup.pos = at;
    popup.label.text = text;
    popup.label.color = color;
  }

  private checkGhosts() {
    const { player, camera } = this.ctx;
    if (player.mode !== 'control' || player.inPortal) return;
    const p = player.pos;
    for (const g of this.crew.ghosts) {
      if (!g.solid) continue;
      if (Math.hypot(g.pos[0] - p[0], g.pos[2] - p[2]) > TOUCH_RADIUS) continue;
      if (g.scared) {
        this.eatGhost(g);
        continue;
      }
      // Caught.
      this.killer = g.name;
      this.crew.running = false;
      camera.addShake(0.35);
      const focus: Vec3 = [p[0], p[1] + 1.4, p[2]];
      const back = sub(camera.pos, focus);
      const flat = Math.hypot(back[0], back[2]) || 1;
      this.deathCam = {
        pos: [focus[0] + (back[0] / flat) * 3.6, Math.max(camera.pos[1], focus[1]) + 1.2, focus[2] + (back[2] / flat) * 3.6],
        target: focus,
        sharpness: 1.5,
      };
      const lim = CHAMBER_HALF - 0.3;
      this.deathCam.pos[0] = clamp(this.deathCam.pos[0], -lim, lim);
      this.deathCam.pos[2] = clamp(this.deathCam.pos[2], -lim, lim);
      this.setPhase('dying');
      this.ctx.hud.hide();
      return;
    }
  }

  private eatGhost(g: Ghost) {
    const points = GHOST_SCORES[Math.min(this.crew.eatChain, GHOST_SCORES.length - 1)];
    this.crew.eatChain++;
    this.score += points;
    tone(200, 0.35, { to: 1600, wave: 'square', vol: 0.12 });
    g.eaten();
    const at: Vec3 = [g.pos[0], 1.1, g.pos[2]];
    this.bursts.push({ pos: at, t: 0, color: [0.3, 0.45, 2.2], kind: 'pop' });
    this.popup(at, String(points), '#5ff8ff');
    this.ctx.camera.addShake(0.15);
  }

  /** The arcade death: freeze, the ghosts vanish, and the player spins, shrinks away and pops. */
  private updateDeath() {
    const { player } = this.ctx;
    const t = this.phaseT;
    if (t < DEATH_FREEZE) return;
    if (this.ghostsVisible) {
      this.ghostsVisible = false;
      for (const g of this.crew.ghosts) {
        if (g.solid) this.bursts.push({ pos: [g.pos[0], 1.1, g.pos[2]], t: 0, color: g.scared ? [0.3, 0.45, 2.2] : GHOST_COLORS[g.name], kind: 'pop' });
      }
      const pelvis = player.body?.position('pelvis') ?? add(player.pos, [0, 1, 0]);
      this.spinAxis = pelvis;
      this.shrinkPivot = add(pelvis, [0, 0.55, 0]);
      player.kill([0, 0, 0], { violence: 0 });
    }
    const body = player.body;
    if (body && !this.popped) {
      // Spin up like a top and float up a little; the parts keep their pose (a stiff little twirl).
      const k = clamp((t - DEATH_FREEZE) / (DEATH_POP_AT - DEATH_FREEZE), 0, 1);
      const w = lerp(4, 26, k * k);
      const lift = k < 0.6 ? 0.9 : 0;
      for (const rb of Object.values(body.parts)) {
        const p = rb.translation();
        const rx = p.x - this.spinAxis[0], rz = p.z - this.spinAxis[2];
        rb.setLinvel({ x: w * rz, y: lift, z: -w * rx }, true);
        rb.setAngvel({ x: 0, y: w, z: 0 }, true);
      }
    }
    if (!this.shrunk && t >= DEATH_SHRINK_AT) {
      this.shrunk = true;
      player.shrinkInto(this.shrinkPivot, DEATH_SHRINK);
    }
    if (!this.popped && t >= DEATH_POP_AT) {
      this.popped = true;
      this.bursts.push({ pos: this.shrinkPivot, t: 0, color: PELLET_COLOR, kind: 'sparkle' });
      this.ctx.camera.addShake(0.2);
    }
  }

  private cleared() {
    const { hud, camera } = this.ctx;
    this.setPhase('clear');
    this.crew.running = false;
    this.ghostsVisible = false;
    for (const g of this.crew.ghosts) {
      if (g.solid) this.bursts.push({ pos: [g.pos[0], 1.1, g.pos[2]], t: 0, color: g.scared ? [0.3, 0.45, 2.2] : GHOST_COLORS[g.name], kind: 'pop' });
    }
    const [big, small] = pick(CLEAR_QUIPS);
    hud.show(big, `${this.score} points.\n${small}`, 4);
    camera.addShake(0.2);
  }

  private updateClear() {
    const t = this.phaseT;
    const step = Math.floor((t - CLEAR_FLASH_START) / CLEAR_FLASH_STEP);
    this.flash = t >= CLEAR_FLASH_START && step < CLEAR_FLASHES && step % 2 === 0;
    if (t >= CLEAR_SINK_AT) {
      if (this.colliders.length) {
        for (const c of this.colliders) this.ctx.physics.world.removeCollider(c, true);
        this.colliders = [];
      }
      const k = easeInOut(clamp((t - CLEAR_SINK_AT) / CLEAR_SINK_TIME, 0, 1));
      this.rise = 1 - k;
      this.dark = 1 - k;
      if (k > 0.5 && !this.exit.open) this.exit.openNow();
    }
  }

  private updateLabels(dt: number) {
    const shown = this.rise > 0.5;
    this.oneUp.text = shown && Math.floor(this.t * 2.5) % 2 === 0 ? '1UP' : '';
    this.scoreLabel.text = shown ? String(this.score).padStart(5, '0') : '';
    this.highTitle.text = shown ? 'HIGH SCORE' : '';
    this.highLabel.text = shown ? String(HIGH_SCORE) : '';
    for (const u of this.popups) {
      if (u.t < 0) continue;
      u.t += dt;
      u.label.pos = [u.pos[0], u.pos[1] + u.t * 0.6, u.pos[2]];
      if (u.t > 1.2) {
        u.t = -1;
        u.label.text = '';
      }
    }
  }

  freezeWorld() {
    return this.phase === 'dying' && this.phaseT < DEATH_FREEZE;
  }

  draw(out: DrawItem[]) {
    const time = this.t;
    if (this.dark > 0) {
      // The dark floor, fading in over the chamber's.
      for (let k = 0; k < 3; k++) this.floorColor[k] = lerp(FLOOR_LIT[k], FLOOR_DARK[k], this.dark);
      out.push({
        mesh: 'box',
        model: mul(translation([0, -0.006, 0]), scaling([CHAMBER_HALF * 2, 0.02, CHAMBER_HALF * 2])),
        color: this.floorColor,
        pattern: Pattern.panels,
        param: 2,
        spec: 0.3,
        shadow: false,
      });
    }
    drawMaze(out, this.rise, this.flash);

    // Pellets pop in once the maze is up; the big ones blink.
    if (this.phase !== 'arrival' && this.phase !== 'rise') {
      const since = this.phase === 'ready' ? this.phaseT : 10;
      const blinkOn = Math.floor(time * 4) % 2 === 0;
      for (const p of this.pellets) {
        if (p.eaten) continue;
        if (p.power && !blinkOn) continue;
        const k = clamp((since - p.delay) / 0.25, 0, 1);
        if (k <= 0) continue;
        if (k < 1) {
          const r = (p.power ? POWER_R : PELLET_R) * (k < 0.7 ? k / 0.7 * 1.3 : 1.3 - (k - 0.7) / 0.3 * 0.3);
          out.push({ ...p.item, model: mul(translation(p.pos), scaling([r, r, r])) });
        } else {
          out.push(p.item);
        }
      }
    }

    this.crew.darkness = this.dark;
    if (this.ghostsVisible) this.crew.draw(out, time, -MAZE_WALL_HEIGHT * (1 - this.rise), this.ctx.camera.pos);
    if (this.cherryT > 0 && this.phase === 'play') this.drawCherry(out);
    this.drawBursts(out);
    this.arrival.draw(out);
    this.exit.draw(out);
  }

  /** The bonus cherry: two cherries on stems joined at a leaf, turning slowly and bobbing. */
  private drawCherry(out: DrawItem[]) {
    // Blink for the last two seconds before it goes.
    if (this.cherryT < 2 && Math.floor(this.cherryT * 6) % 2 === 0) return;
    const m = mul(translation([CHERRY_POS[0], 0.55 + Math.sin(this.t * 3) * 0.08, CHERRY_POS[2]]), rotationY(this.t * 1.5));
    const joint: Vec3 = [0.12, 0.95, 0];
    for (const [x, y] of [[-0.22, 0.2], [0.2, 0.12]]) {
      const c: Vec3 = [x, y, 0];
      out.push({ mesh: 'sphere', model: mul(m, translation(c), scaling([0.22, 0.22, 0.22])), color: CHERRY_RED, pattern: Pattern.emissive });
      out.push({ mesh: 'sphere', model: mul(m, translation([x - 0.08, y + 0.09, -0.15]), scaling([0.05, 0.05, 0.05])), color: CHERRY_SHINE, pattern: Pattern.emissive, shadow: false });
      out.push({ mesh: 'cylinder', model: mul(m, segment([x * 0.6, y + 0.2, 0], joint, 0.025)), color: CHERRY_STEM, pattern: Pattern.emissive });
    }
    out.push({ mesh: 'sphere', model: mul(m, translation([0.25, 1.0, 0]), rotationZ(-0.5), scaling([0.16, 0.05, 0.08])), color: CHERRY_LEAF, pattern: Pattern.emissive });
  }

  private drawBursts(out: DrawItem[]) {
    for (const b of this.bursts) {
      if (b.kind === 'pop') {
        if (b.t > 0.35) continue;
        const k = b.t / 0.35;
        const r = 0.4 + k * 1.4;
        out.push({
          mesh: 'sphere',
          model: mul(translation(b.pos), scaling([r, r, r])),
          color: b.color,
          pattern: Pattern.emissive,
          opacity: 1 - k,
          shadow: false,
        });
      } else {
        // The little starburst the arcade ends a death with.
        if (b.t > 0.5) continue;
        const k = b.t / 0.5;
        for (let i = 0; i < 12; i++) {
          const a = (i / 12) * Math.PI * 2;
          const tilt = i % 2 ? 0.35 : -0.35;
          const dir: Vec3 = [Math.cos(a) * Math.cos(tilt), Math.sin(tilt), Math.sin(a) * Math.cos(tilt)];
          const r0 = 0.15 + k * 1.3;
          const r1 = r0 + 0.45 * (1 - k);
          out.push({
            mesh: 'cylinder',
            model: segment(add(b.pos, scale(dir, r0)), add(b.pos, scale(dir, r1)), 0.035),
            color: b.color,
            pattern: Pattern.emissive,
            shadow: false,
          });
        }
      }
    }
  }

  labels(): WorldLabel[] {
    return this.labelList;
  }

  trackedTargets(): TrackedTarget[] {
    const list = this.targets;
    list.length = 0;
    const exit = this.exit.target();
    if (exit) list.push(exit);
    if (this.phase === 'play' && this.pelletsLeft <= MARK_PELLETS) {
      for (const p of this.pellets) if (!p.eaten) list.push(p.target);
    }
    return list;
  }

  environment() {
    const e = this.env, d = this.dark;
    for (let k = 0; k < 3; k++) {
      e.sunColor[k] = lerp(DEFAULT_ENV.sunColor[k], ARCADE_ENV.sunColor[k], d);
      e.skyColor[k] = lerp(DEFAULT_ENV.skyColor[k], ARCADE_ENV.skyColor[k], d);
      e.groundColor[k] = lerp(DEFAULT_ENV.groundColor[k], ARCADE_ENV.groundColor[k], d);
      e.fogColor[k] = lerp(DEFAULT_ENV.fogColor[k], ARCADE_ENV.fogColor[k], d);
    }
    // A warm glow around the player: every Pac-Man needs one.
    const player = this.ctx.player;
    if (d > 0 && player.mode !== 'hidden' && player.portalScale > 0.05) {
      const g = this.glow;
      g.pos[0] = player.pos[0];
      g.pos[1] = player.pos[1] + 1.3;
      g.pos[2] = player.pos[2];
      // Brighter and pulsing while the ghosts are scared: powered up.
      const power = this.crew.frightLeft > 0 ? 1.7 + 0.5 * Math.sin(this.t * 10) : 1;
      g.color[0] = 1.3 * d * power;
      g.color[1] = 1.0 * d * power;
      g.color[2] = 0.35 * d * power;
      e.pointLight = g;
    } else {
      e.pointLight = undefined;
    }
    return e;
  }

  obstacles() {
    return [];
  }

  cameraShot(): CameraShot | null {
    const shot = this.arrival.cameraShot();
    if (shot) return shot;
    if (this.phase === 'dying' && this.deathCam) return this.deathCam;
    const overview = this.phase === 'rise' || (this.phase === 'ready' && this.phaseT < READY_TIME - CAMERA_RETURN);
    if (overview) return { pos: [0, 31, 9.5], target: [0, 0, -1.2], sharpness: 2.2 };
    if (this.phase === 'ready' || (this.phase === 'play' && this.phaseT < 0.4)) {
      // Swoop back down to where the usual camera would be.
      const { player, camera } = this.ctx;
      const cp = Math.cos(camera.pitch), sp = Math.sin(camera.pitch);
      const fwd: Vec3 = [-Math.sin(camera.yaw) * cp, sp, -Math.cos(camera.yaw) * cp];
      const right: Vec3 = [Math.cos(camera.yaw), 0, -Math.sin(camera.yaw)];
      const shoulder = add(add(player.pos, [0, 1.65, 0]), scale(right, 0.6));
      const pos = add(shoulder, scale(fwd, -3.2));
      const lim = CHAMBER_HALF - 0.3;
      pos[0] = clamp(pos[0], -lim, lim);
      pos[2] = clamp(pos[2], -lim, lim);
      return { pos, target: add(shoulder, scale(fwd, 10)), sharpness: 5 };
    }
    return null;
  }
}
