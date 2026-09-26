import { add, clamp, length, mul, normalize, rotationX, rotationY, scale, scaling, segment, sub, translation, type Vec3 } from '../../engine/math';
import type { RAPIER, Usable } from '../../engine/physics';
import { Pattern, type DrawItem, type Environment } from '../../engine/renderer';
import { CHAMBER_HALF } from '../../game/chamber';
import { junk } from '../../entities/junk';
import { ExitPortal, PortalArrival } from '../../entities/portal';
import { PressurePlate } from '../../entities/pressurePlate';
import { drawTrapdoor } from '../../entities/trapdoor';
import { DEFAULT_ENV, type CameraShot, type Level, type LevelContext, type LevelStatus, type TrackedTarget, type WorldLabel } from '../level';

/*
 * The Big Red Button. A button on a pedestal, a sign: DO NOT PRESS. That's it. For a while.
 * Then the sign starts pleading, the button starts whispering, then it follows you around, more
 * buttons come up out of the floor, and the way to the exit is paved with DO NOT STEP plates.
 * The exit opens after 45 s of doing nothing at all, with one last sign: PRESS E TO ENTER.
 * Pressing anything, ever, has consequences (an anvil, a piano, a boxing glove, the floor, or
 * the self-destruct).
 */

const EXIT_AT = 45;
const EXIT_Z = 0;
const DEATH_SCREEN_DELAY = 2;

const RED = [0.9, 0.06, 0.05];
const METAL = [0.28, 0.29, 0.31];
const DARK = [0.1, 0.1, 0.11];

const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

/** A big red button on a pedestal, with a sign over it. Pressing it (E) is always a mistake. */
class RedButton implements Usable {
  highlight = 0;
  /** 0-1: how much it's glowing (it hums when it wants to be pressed). */
  hum = 0;
  /** Grows out of the floor from 0 to 1. */
  grow = 0;
  sign: WorldLabel;
  whisper: WorldLabel;
  private collider: RAPIER.Collider;

  constructor(
    level: ButtonLevel,
    public pos: Vec3,
    public size: number,
    text: string,
    private onPress: () => void,
  ) {
    this.collider = level.ctx.physics.addStaticBox(add(pos, [0, 0.55 * size, 0]), [0.7 * size, 1.1 * size, 0.7 * size]);
    level.ctx.physics.registerUsable(this.collider, this);
    this.sign = { pos: add(pos, [0, 1.9 * size, 0]), text, size: 0.28 * size, color: '#ffd166' };
    this.whisper = { pos: add(pos, [0, 1.45 * size, 0]), text: '', size: 0.22 * size, color: '#ff9a9a' };
    this.place(pos);
  }

  use() {
    if (this.grow > 0.8) this.onPress();
  }

  place(pos: Vec3) {
    this.pos = pos;
    const s = this.size * Math.max(0.01, this.grow);
    this.collider.setTranslation({ x: pos[0], y: 0.55 * s - (1 - this.grow) * 1.2, z: pos[2] });
    this.sign.pos = add(pos, [0, 1.9 * this.size * this.grow, 0]);
    this.whisper.pos = add(pos, [0, 1.45 * this.size * this.grow, 0]);
  }

  draw(out: DrawItem[], t: number) {
    if (this.grow <= 0) return;
    const s = this.size;
    const base = mul(translation([this.pos[0], -(1 - this.grow) * 1.2 * s, this.pos[2]]), scaling([s, s, s]));
    out.push({ mesh: 'cylinder', model: mul(base, translation([0, 0.5, 0]), scaling([0.3, 1, 0.3])), color: METAL, spec: 0.4 });
    out.push({ mesh: 'cylinder', model: mul(base, translation([0, 1.02, 0]), scaling([0.36, 0.06, 0.36])), color: DARK });
    const glow = this.hum * (0.6 + 0.4 * Math.sin(t * 6));
    out.push({
      mesh: 'cylinder',
      model: mul(base, translation([0, 1.1, 0]), scaling([0.26, 0.13, 0.26])),
      color: glow > 0.05 ? [RED[0] + glow * 2.2, RED[1] + glow * 0.3, RED[2] + glow * 0.2] : RED,
      pattern: glow > 0.05 ? Pattern.emissive : Pattern.plain,
      spec: 0.7,
      highlight: this.highlight,
    });
  }
}

type Fate = 'anvil' | 'piano' | 'glove' | 'trapdoor' | 'selfdestruct';

interface Death {
  t: number;
  big: string;
  small: string;
}

export class ButtonLevel implements Level {
  readonly number: number;
  readonly title = 'Big Red Button';
  status: LevelStatus = 'playing';
  private arrival: PortalArrival;
  private exit = new ExitPortal(EXIT_Z);
  private buttons: RedButton[] = [];
  private main: RedButton;
  private plates: PressurePlate[] = [];
  private plateSigns: WorldLabel[] = [];
  private t = -1;
  private death: Death | null = null;
  private labelList: WorldLabel[] = [];
  private exitSign: WorldLabel = { pos: [CHAMBER_HALF - 0.3, 3.4, EXIT_Z], text: '', size: 0.34, color: '#e7c6ff' };
  private countdown: WorldLabel = { pos: [0, 6, -CHAMBER_HALF + 0.3], text: '', size: 2.4, color: '#ff4040' };
  // The consequences, once chosen.
  private fate: { kind: Fate; t: number; pos: Vec3; dir: Vec3; from: Vec3 } | null = null;
  private env: Environment = { ...DEFAULT_ENV };
  private anvilModel = junk('anvil').model;
  private pianoModel = junk('piano').model;
  private whispered = -1;

  constructor(readonly ctx: LevelContext) {
    this.number = ctx.number;
    const { hud } = ctx;
    hud.setLevel(`The Chamber · Level ${this.number}`);
    hud.show(`LEVEL ${this.number}`, '', 2.5);
    hud.hint('');
    this.arrival = new PortalArrival(ctx, [0, 0, 6]);
    this.main = this.addButton([0, 0, -2], 1.4, 'DO NOT PRESS');
    this.main.grow = 1;
    this.main.place(this.main.pos);
    // Extra buttons wait under the floor for their moment.
    const extras: [Vec3, string][] = [[[-7, 0, -6], "DON'T"], [[7, 0, -6], 'NOPE'], [[-7, 0, 6], 'FREE CAKE (DO NOT PRESS)'], [[6, 0, 7], 'PRESS FOR NOTHING']];
    for (const [pos, text] of extras) this.addButton(pos, 1, text);
    this.labelList.push(this.exitSign, this.countdown);
  }

  private addButton(pos: Vec3, size: number, text: string): RedButton {
    const b = new RedButton(this, pos, size, text, () => this.pressed());
    this.ctx.physics.addDrawable(b);
    this.buttons.push(b);
    this.labelList.push(b.sign, b.whisper);
    return b;
  }

  private pressed() {
    this.doom('YOU PRESSED THE BUTTON', pick<Fate>(['anvil', 'piano', 'glove', 'trapdoor', 'selfdestruct']));
  }

  /** The consequences. */
  private doom(big: string, kind: Fate) {
    const { player } = this.ctx;
    if (this.fate || this.death || player.mode !== 'control') return;
    const pos: Vec3 = [...player.pos];
    // The glove comes out of the nearest wall.
    const walls: Vec3[] = [[CHAMBER_HALF, 1.4, pos[2]], [-CHAMBER_HALF, 1.4, pos[2]], [pos[0], 1.4, CHAMBER_HALF], [pos[0], 1.4, -CHAMBER_HALF]];
    const from = walls.reduce((a, b) => (length(sub(a, pos)) < length(sub(b, pos)) ? a : b));
    this.fate = { kind, t: 0, pos, dir: normalize(sub([pos[0], 1.4, pos[2]], from)), from };
    const small: Record<Fate, string> = {
      anvil: 'An anvil. Of course it was an anvil.',
      piano: 'It played one last note. The note was you.',
      glove: 'It had one job: not being pressed. So did you.',
      trapdoor: 'The floor has been expecting you.',
      selfdestruct: 'Self-destruct buttons are labelled DO NOT PRESS for a reason.',
    };
    this.pendingDeath = { big, small: small[kind] };
    for (const b of this.buttons) b.whisper.text = '';
  }

  private pendingDeath: { big: string; small: string } | null = null;

  private kill(launch: Vec3, violence: number, origin?: Vec3) {
    const { player, camera } = this.ctx;
    if (this.death) return;
    player.kill(launch, { violence, origin });
    camera.addShake(0.8);
    this.death = { t: 0, big: this.pendingDeath!.big, small: this.pendingDeath!.small };
  }

  update(dt: number) {
    const { player, hud, input } = this.ctx;
    const death = this.death;
    if (death && this.status === 'playing') {
      death.t += dt;
      if (death.t > DEATH_SCREEN_DELAY) {
        this.status = 'lost';
        hud.show(death.big, `${death.small}\nPress R to try again.`);
        hud.tips([
          ['Hint', "Don't press anything. Anything at all. And don't step on anything that asks you not to: jump it."],
          ['Controls', 'WASD move · Space jump · E press (please don’t)'],
        ]);
      }
    }
    this.arrival.update(dt);
    this.exit.update(dt, player);
    if (this.exit.entered && this.status === 'playing') this.status = 'exited';
    for (const p of this.plates) p.update(dt);
    if (this.arrival.done && this.t < 0) this.t = 0;
    if (this.t >= 0) this.t += dt;
    this.updateFate(dt);
    if (this.t < 0 || this.fate) return;
    const t = this.t;
    const alive = player.mode === 'control';

    // The escalation.
    this.main.sign.text = t < 8 ? 'DO NOT PRESS' : t < 16 ? 'PLEASE DO NOT PRESS' : t < 24 ? "IT'S JUST A BUTTON" : t < 32 ? 'DO NOT PRESS (PLEASE PRESS)' : 'DO. NOT.';
    this.main.hum = clamp((t - 14) / 6, 0, 1);
    const lines = ['psst.', 'hey.', '...press me.', 'just once.', 'no one will know.', "i'm so lonely.", 'go on.', 'pleeease.'];
    const k = Math.floor((t - 16) / 3.5);
    if (t > 16 && k !== this.whispered) {
      this.whispered = k;
      for (const b of this.buttons) if (b.grow > 0.5) b.whisper.text = pick(lines);
    }
    // From 22 s it follows you; at 30 s the others come up and follow too.
    for (const b of this.buttons) {
      if (b !== this.main && t > 30) b.grow = Math.min(1, b.grow + dt * 1.2);
      b.hum = b === this.main ? b.hum : b.grow * clamp((t - 32) / 4, 0, 1);
      const chase = b === this.main ? t > 22 : t > 33;
      if (chase && alive && b.grow > 0.9) {
        const to = sub([player.pos[0], 0, player.pos[2]], b.pos);
        const d = Math.hypot(to[0], to[2]);
        const keep = 1.6 * b.size;
        if (d > keep) b.place(add(b.pos, scale([to[0] / d, 0, to[2] / d], Math.min(d - keep, dt * (b === this.main ? 0.8 : 0.5)))));
      } else {
        b.place(b.pos);
      }
    }
    // DO NOT STEP plates appear across the way to the exit.
    if (t > EXIT_AT - 8 && !this.plates.length) {
      for (const z of [-1.7, 0, 1.7]) {
        this.plates.push(new PressurePlate(this.ctx.physics, [10.2, 0, EXIT_Z + z], [], player, (down) => {
          if (down) this.doom('YOU STEPPED ON IT', pick<Fate>(['glove', 'anvil', 'trapdoor']));
        }, { radius: 0.75 }));
        const sign: WorldLabel = { pos: [10.2, 0.8, EXIT_Z + z], text: 'DO NOT STEP', size: 0.2, color: '#ffd166' };
        this.plateSigns.push(sign);
        this.labelList.push(sign);
      }
    }
    if (t >= EXIT_AT && !this.exit.open) {
      this.exit.openNow();
      this.exitSign.text = 'PRESS E TO ENTER';
      hud.show('YOU MAY LEAVE', "Don't touch anything on your way out.", 3);
    }
    // The last sign is a lie too.
    if (this.exit.open && input.wasPressed('KeyE') && Math.hypot(player.pos[0] - CHAMBER_HALF, player.pos[2] - EXIT_Z) < 5 && alive) {
      this.doom('IT SAID PRESS E', 'glove');
    }
  }

  private updateFate(dt: number) {
    const f = this.fate;
    if (!f) return;
    f.t += dt;
    const { player } = this.ctx;
    const head: Vec3 = [f.pos[0], 1.7, f.pos[2]];
    switch (f.kind) {
      case 'anvil':
      case 'piano': {
        // Falls from the sky right onto where you stood (you can't outrun your mistakes).
        const y = 22 - 0.5 * 30 * f.t * f.t;
        if (y < 1.9 && !this.death) this.kill([0, -3, 0], 16, head);
        break;
      }
      case 'glove':
        if (f.t > 0.28 && !this.death) this.kill(add(scale(f.dir, 22), [0, 7, 0]), 22, add(player.pos, [0, 1.2, 0]));
        break;
      case 'trapdoor':
        if (!this.death) this.kill([Math.sin(f.t) * 3, 24, Math.cos(f.t) * 3], 12);
        break;
      case 'selfdestruct': {
        const n = 3 - Math.floor(f.t);
        this.countdown.text = f.t < 3 ? `SELF-DESTRUCT IN ${n}` : '';
        if (f.t >= 3 && !this.death) this.kill([(Math.random() - 0.5) * 20, 18, (Math.random() - 0.5) * 20], 45, [0, 0.5, 0]);
        break;
      }
    }
  }

  draw(out: DrawItem[]) {
    this.arrival.draw(out);
    this.exit.draw(out);
    const f = this.fate;
    if (!f) return;
    switch (f.kind) {
      case 'anvil':
      case 'piano': {
        const y = Math.max(f.kind === 'anvil' ? 0.5 : 0.65, 22 - 0.5 * 30 * f.t * f.t);
        const s = f.kind === 'anvil' ? 3 : 1.4;
        const m = mul(translation([f.pos[0], y, f.pos[2]]), rotationY(0.4), scaling([s, s, s]));
        (f.kind === 'anvil' ? this.anvilModel : this.pianoModel)(out, m);
        // Its shadow, growing as it comes down.
        const r = 1.6 * clamp(1 - y / 22, 0.1, 1);
        out.push({ mesh: 'cylinder', model: mul(translation([f.pos[0], 0.01, f.pos[2]]), scaling([r, 0.01, r])), color: [0, 0, 0], pattern: Pattern.blob, param: 0.7, shadow: false });
        break;
      }
      case 'glove': {
        const reach = clamp(f.t / 0.28, 0, 1);
        const tip = add(f.from, scale(sub([f.pos[0], 1.4, f.pos[2]], f.from), reach));
        out.push({ mesh: 'cylinder', model: segment(f.from, tip, 0.06), color: METAL, spec: 0.6 });
        out.push({ mesh: 'sphere', model: mul(translation(tip), scaling([0.38, 0.32, 0.38])), color: [0.85, 0.08, 0.06], spec: 0.5 });
        out.push({ mesh: 'cylinder', model: mul(translation(sub(tip, scale(f.dir, 0.35))), rotationX(Math.PI / 2), scaling([0.2, 0.25, 0.2])), color: [0.95, 0.95, 0.9] });
        break;
      }
      case 'trapdoor':
        drawTrapdoor(out, [f.pos[0], 0, f.pos[2]], 0.3, f.t);
        break;
      case 'selfdestruct':
        if (f.t >= 3 && f.t < 3.6) {
          const r = 2 + (f.t - 3) * 40;
          out.push({ mesh: 'sphere', model: mul(translation([0, 1, 0]), scaling([r, r * 0.7, r])), color: [8, 4, 1.2], pattern: Pattern.emissive, opacity: 1 - (f.t - 3) / 0.6, shadow: false });
        }
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
    const f = this.fate;
    if (f && f.kind === 'selfdestruct' && f.t < 3.5) {
      // Red alert.
      const flash = 0.5 + 0.5 * Math.sin(f.t * 12);
      this.env.sunColor = [1.2 + flash, 0.25, 0.2];
      this.env.skyColor = [0.35 + flash * 0.3, 0.05, 0.05];
    } else {
      this.env.sunColor = DEFAULT_ENV.sunColor;
      this.env.skyColor = DEFAULT_ENV.skyColor;
    }
    return this.env;
  }

  obstacles() {
    return [];
  }

  cameraShot(): CameraShot | null {
    return this.arrival.cameraShot();
  }
}
