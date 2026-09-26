import { note, tone } from '../../engine/audio';
import { add, basis, clamp, mul, normalize, rotationY, scale, scaling, sub, translation, type Vec3 } from '../../engine/math';
import { Pattern, type DrawItem } from '../../engine/renderer';
import { CHAMBER_HALF } from '../../game/chamber';
import { Guard } from '../../entities/guard';
import { junk } from '../../entities/junk';
import { ExitPortal, PortalArrival } from '../../entities/portal';
import { DEFAULT_ENV, type CameraShot, type Level, type LevelContext, type LevelStatus, type TrackedTarget, type WorldLabel } from '../level';

/*
 * Tactical Espionage. Three guards patrol the chamber between stacks of crates, each with a
 * vision cone painted on the floor. Get seen (inside a cone, nothing in between) for a moment
 * and it's "!": they come running, and if they catch you, it's game over. Break line of sight
 * and they give up after a while ("Must've been the wind."). There are cardboard boxes: press E
 * to get in one (and again to get out). Guards don't look twice at a box that keeps still,
 * but a box that moves while they watch gets a "?". The keycard on the far side opens the exit.
 */

const FOV = Math.PI / 2;
const RANGE = 7.5;
/** Seconds in view before the "!" (in a box that's moving: longer). */
const SPOT = 0.4;
const SPOT_BOX = 1.1;
const PATROL_SPEED = 1.8;
const CHASE_SPEED = 5.2;
const CATCH = 1.0;
const GIVE_UP = 3;
const BOX_SPEED = 0.45;
const DEATH_SCREEN_DELAY = 1.8;

const CRATES: [number, number][] = [[-5, 4], [-2, -1.5], [2.5, 5], [4.5, -4], [-6.5, -5.5], [7.5, 1.5], [0, -9], [-1, 8.5]];
const CRATE = 1.6;
const CRATE_H = 2.3;
const KEYCARD: Vec3 = [9, 0, -9.5];
const EXIT_Z = 5;
const ENV = { ...DEFAULT_ENV, sunColor: [1.3, 1.3, 1.4] as Vec3, skyColor: [0.18, 0.22, 0.32] as Vec3 };

type GuardState = 'patrol' | 'alert' | 'search';

interface Sentry {
  g: Guard;
  route: Vec3[];
  next: number;
  wait: number;
  state: GuardState;
  suspicion: number;
  lastSeen: Vec3;
  lost: number;
  label: WorldLabel;
  labelT: number;
  lookAround: number;
  /** Where they were at the last progress check, and the time since it (to spot them stuck on a crate). */
  checkPos: Vec3;
  checkT: number;
}

interface Death {
  t: number;
}

const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

export class StealthLevel implements Level {
  readonly number: number;
  readonly title = 'Tactical Espionage';
  status: LevelStatus = 'playing';
  private arrival: PortalArrival;
  private exit = new ExitPortal(EXIT_Z);
  private sentries: Sentry[] = [];
  private boxes: { pos: Vec3; yaw: number }[] = [[-8.5, 0, 5.5], [2.5, 0, 1.2], [5.5, 0, -8]].map((p) => ({ pos: p as Vec3, yaw: Math.random() * 3 }));
  /** Which box you're in (index), or -1. */
  private inBox = -1;
  private hasCard = false;
  private t = 0;
  private death: Death | null = null;
  private labelList: WorldLabel[] = [];
  private boxModel = junk('cardboard box').model;

  constructor(private ctx: LevelContext) {
    this.number = ctx.number;
    const { hud, physics } = ctx;
    hud.setLevel(`The Chamber · Level ${this.number}`);
    hud.show(`LEVEL ${this.number}`, '', 2.5);
    hud.hint('');
    this.arrival = new PortalArrival(ctx, [-9.5, 0, 9.5]);
    for (const [x, z] of CRATES) physics.addStaticBox([x, CRATE_H / 2, z], [CRATE, CRATE_H, CRATE]);
    const routes: Vec3[][] = [
      [[-9.5, 0, 1.5], [5.6, 0, 1.2], [5.6, 0, 3.4], [9.5, 0, 3.4]],
      [[-9, 0, -3], [9, 0, -2.5], [9, 0, -7], [-3, 0, -7]],
      [[5, 0, 9.5], [5.5, 0, -1], [10, 0, -1], [10, 0, 9.5]],
    ];
    for (const route of routes) {
      const s: Sentry = {
        g: new Guard(route[0], 0), route, next: 1, wait: 0, state: 'patrol', suspicion: 0, lastSeen: [0, 0, 0], lost: 0,
        label: { pos: [0, 0, 0], text: '', size: 0.55, color: '#ffffff' }, labelT: 0, lookAround: 0, checkPos: [...route[0]], checkT: 0,
      };
      this.sentries.push(s);
      this.labelList.push(s.label);
    }
    this.labelList.push({ pos: [0, 7, -CHAMBER_HALF + 0.3], text: 'RESTRICTED AREA', size: 1, color: '#ff5555' }, { pos: [0, 6.1, -CHAMBER_HALF + 0.3], text: 'authorised test subjects only (there are none)', size: 0.4, color: '#ffffff' });
  }

  private say(s: Sentry, text: string, color = '#ffffff', time = 2) {
    s.label.text = text;
    s.label.color = color;
    s.labelT = time;
  }

  /** Can this guard see the player right now? */
  private sees(s: Sentry): boolean {
    const { player, physics } = this.ctx;
    const eye = s.g.eye();
    const chest: Vec3 = add(player.pos, [0, this.inBox >= 0 ? 0.5 : 1.25, 0]);
    const to = sub(chest, eye);
    const dist = Math.hypot(to[0], to[2]);
    if (dist > RANGE) return false;
    const f = s.g.forward();
    const cos = (to[0] * f[0] + to[2] * f[2]) / (dist || 1);
    if (cos < Math.cos(FOV / 2) && dist > 1.2) return false;
    const hit = physics.raycast(eye, normalize(to), Math.hypot(to[0], to[1], to[2]));
    return !hit;
  }

  update(dt: number) {
    const { player, hud, input, camera } = this.ctx;
    const death = this.death;
    if (death && this.status === 'playing') {
      death.t += dt;
      if (death.t > DEATH_SCREEN_DELAY) {
        this.status = 'lost';
        hud.show('GAME OVER', `${pick(['Snake? Snake?! SNAAAAKE!', 'Tactical espionage is mostly not being seen. You managed "mostly seen".', 'Kept you waiting, huh? Not for long.'])}\nPress R to try again.`);
        hud.tips([
          ['Hint', 'Stay out of the cones, behind the crates. Get in a cardboard box (E) and keep still when someone looks your way. The keycard on the far side opens the exit.'],
          ['Controls', 'WASD move · E get in / out of a box · Shift sprint'],
        ]);
      }
    }
    this.arrival.update(dt);
    this.exit.update(dt, player);
    if (this.exit.entered && this.status === 'playing') this.status = 'exited';
    this.t += dt;
    const alive = player.mode === 'control' && !this.death && !player.inPortal;
    const started = this.arrival.done;

    // The box: E next to one gets you in; E again gets you out (it stays where you leave it).
    const near = this.boxes.findIndex((b) => Math.hypot(b.pos[0] - player.pos[0], b.pos[2] - player.pos[2]) < 1.3);
    if (alive && input.wasPressed('KeyE')) {
      if (this.inBox >= 0) this.inBox = -1;
      else if (near >= 0) this.inBox = near;
    }
    const boxed = this.inBox >= 0 && alive;
    player.opacity = boxed ? 0 : 1;
    player.speedScale = boxed ? BOX_SPEED : 1;
    if (boxed) {
      const b = this.boxes[this.inBox];
      b.pos = [player.pos[0], 0, player.pos[2]];
      b.yaw = player.facing;
    }
    const moving = Math.hypot(player.vel[0], player.vel[2]) > 0.3;

    // The keycard.
    if (alive && !this.hasCard && Math.hypot(player.pos[0] - KEYCARD[0], player.pos[2] - KEYCARD[2]) < 1.2) {
      this.hasCard = true;
      this.exit.openNow();
      hud.show('KEYCARD ACQUIRED', 'Clearance level: test subject. The exit is open.', 3);
    }

    // The guards.
    for (const s of this.sentries) {
      const g = s.g;
      s.labelT -= dt;
      if (s.labelT <= 0 && s.label.text !== '!') s.label.text = '';
      s.label.pos = add(g.pos, [0, 2.3, 0]);
      if (!started) {
        g.vel = [0, 0, 0];
        g.update(dt);
        continue;
      }
      // What they see: you (unless you're a box keeping still).
      const sees = alive && this.sees(s) && !(boxed && !moving);
      if (sees) {
        s.lastSeen = [...player.pos];
        s.lost = 0;
        if (s.state !== 'alert') {
          s.suspicion += dt / (boxed ? SPOT_BOX : SPOT);
          if (boxed && s.suspicion > 0.4 && s.label.text !== '?') {
            this.say(s, '?', '#ffd166', 1.5);
            tone(note('C5'), 0.25, { to: note('G5'), wave: 'triangle', vol: 0.12 });
          }
          if (s.suspicion >= 1) {
            s.state = 'alert';
            this.say(s, '!', '#ff3b3b', 99);
            // The sting.
            tone(note('A5'), 0.12, { wave: 'square', vol: 0.12 });
            tone(note('E6'), 0.5, { wave: 'square', vol: 0.12, at: 0.1 });
            camera.addShake(0.15);
          }
        }
      } else {
        s.suspicion = Math.max(0, s.suspicion - dt * 0.5);
        s.lost += dt;
      }
      let turnTo: number | undefined;
      switch (s.state) {
        case 'patrol': {
          const target = s.route[s.next];
          const to = sub(target, g.pos);
          const d = Math.hypot(to[0], to[2]);
          if (d < 0.3) {
            g.vel = [0, 0, 0];
            s.wait += dt;
            // A look left and right at each end of the beat.
            s.lookAround += dt;
            turnTo = g.facing + Math.sin(s.lookAround * 1.6) * 0.04;
            if (s.wait > 1.6) {
              s.wait = 0;
              s.next = (s.next + 1) % s.route.length;
            }
          } else {
            g.vel = scale([to[0] / d, 0, to[2] / d], PATROL_SPEED);
          }
          break;
        }
        case 'alert': {
          // Running at you (or where you were).
          const to = sub(s.lastSeen, g.pos);
          const d = Math.hypot(to[0], to[2]);
          g.vel = d > 0.2 ? scale([to[0] / d, 0, to[2] / d], CHASE_SPEED) : [0, 0, 0];
          if (alive && Math.hypot(player.pos[0] - g.pos[0], player.pos[2] - g.pos[2]) < CATCH) this.caught(s);
          if (s.lost > GIVE_UP) {
            s.state = 'search';
            s.wait = 0;
            this.say(s, '?', '#ffd166', 2.5);
          }
          break;
        }
        case 'search': {
          g.vel = [0, 0, 0];
          s.wait += dt;
          turnTo = g.facing + dt * 2.2;
          if (s.wait > 2.5) {
            s.state = 'patrol';
            s.suspicion = 0;
            this.say(s, pick(["Must've been the wind.", 'Huh. Nothing.', 'Just a box.', 'I need a vacation.']), '#ffffff', 2.5);
          }
          break;
        }
      }
      g.update(dt, turnTo);
      // Keep them out of the crates (they walk round them, roughly).
      for (const [x, z] of CRATES) {
        const dx = g.pos[0] - x, dz = g.pos[2] - z, lim = CRATE / 2 + 0.35;
        if (Math.abs(dx) < lim && Math.abs(dz) < lim) {
          if (Math.abs(dx) > Math.abs(dz)) g.pos[0] = x + Math.sign(dx) * lim;
          else g.pos[2] = z + Math.sign(dz) * lim;
        }
      }
      g.pos[0] = clamp(g.pos[0], -CHAMBER_HALF + 0.4, CHAMBER_HALF - 0.4);
      g.pos[2] = clamp(g.pos[2], -CHAMBER_HALF + 0.4, CHAMBER_HALF - 0.4);
      // Walking into a crate and getting nowhere: give up on that spot and carry on.
      s.checkT += dt;
      if (s.checkT > 1.2) {
        const moved = Math.hypot(g.pos[0] - s.checkPos[0], g.pos[2] - s.checkPos[2]);
        if (moved < 0.35 && Math.hypot(g.vel[0], g.vel[2]) > 0.5) {
          if (s.state === 'patrol') s.next = (s.next + 1) % s.route.length;
          else {
            s.state = 'search';
            s.wait = 0;
          }
        }
        s.checkT = 0;
        s.checkPos = [g.pos[0], g.pos[1], g.pos[2]];
      }
    }
  }

  private caught(s: Sentry) {
    const { player, camera } = this.ctx;
    if (this.death) return;
    const dir = normalize(sub(player.pos, s.g.pos));
    this.inBox = -1;
    player.opacity = 1;
    player.speedScale = 1;
    player.kill([dir[0] * 5, 3.5, dir[2] * 5], { violence: 6 });
    camera.addShake(0.6);
    this.death = { t: 0 };
    for (const o of this.sentries) this.say(o, '!', '#ff3b3b', 99);
  }

  draw(out: DrawItem[]) {
    this.arrival.draw(out);
    this.exit.draw(out);
    // Crate stacks.
    for (const [x, z] of CRATES) {
      for (let k = 0; k < 3; k++) {
        const s = k === 2 ? 0.8 : 1;
        const y = k * 0.78 + 0.39 * s;
        if (k === 2 && (x + z) % 2 === 0) continue;
        out.push({ mesh: 'bevelbox', model: mul(translation([x + (k === 2 ? 0.2 : 0), y, z]), rotationY(k * 0.2), scaling([CRATE * s, 0.76 * s, CRATE * s])), color: [0.55, 0.42, 0.25] });
      }
    }
    // Guards and their vision cones.
    for (const s of this.sentries) {
      s.g.draw(out);
      const f = s.g.forward();
      const color = s.state === 'alert' ? [2.6, 0.2, 0.1] : s.suspicion > 0.05 ? [2.4, 1.7, 0.2] : [2.0, 1.8, 0.4];
      // Two 45-degree wedges make the 90-degree cone: the wedge mesh spans from its local +x round
      // toward +z, so each gets x along its first edge and z a right angle further round.
      const phi = Math.atan2(f[2], f[0]);
      for (const start of [phi - Math.PI / 4, phi]) {
        const x: Vec3 = [Math.cos(start) * RANGE, 0, Math.sin(start) * RANGE];
        const z: Vec3 = [Math.cos(start + Math.PI / 2) * RANGE, 0, Math.sin(start + Math.PI / 2) * RANGE];
        out.push({ mesh: 'wedge', model: basis(x, [0, 0.01, 0], z, add(s.g.pos, [0, 0.02, 0])), color, pattern: Pattern.emissive, opacity: 0.5, shadow: false });
      }
    }
    // Cardboard boxes (one of them might be you).
    for (const b of this.boxes) this.boxModel(out, mul(translation(add(b.pos, [0, 0.62, 0])), rotationY(b.yaw), scaling([2.2, 2.7, 2.6])));
    // The keycard on its pedestal.
    if (!this.hasCard) {
      out.push({ mesh: 'cylinder', model: mul(translation(add(KEYCARD, [0, 0.5, 0])), scaling([0.35, 1, 0.35])), color: [0.25, 0.26, 0.3], spec: 0.5 });
      out.push({ mesh: 'box', model: mul(translation(add(KEYCARD, [0, 1.25 + Math.sin(this.t * 3) * 0.05, 0])), rotationY(this.t * 1.5), scaling([0.5, 0.32, 0.03])), color: [0.4, 1.8, 0.6], pattern: Pattern.emissive });
    }
  }

  labels(): WorldLabel[] {
    return this.labelList;
  }

  trackedTargets(): TrackedTarget[] {
    const exit = this.exit.target();
    if (exit) return [exit];
    return [];
  }

  environment() {
    return ENV;
  }

  obstacles() {
    return [];
  }

  cameraShot(): CameraShot | null {
    return this.arrival.cameraShot();
  }
}
