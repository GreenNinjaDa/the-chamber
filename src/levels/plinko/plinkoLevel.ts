import { noise, note, sfx, tone } from '../../engine/audio';
import { clamp, mul, rotationZ, scaling, translation, type Vec3 } from '../../engine/math';
import { Pattern, type DrawItem } from '../../engine/renderer';
import { CHAMBER_HALF } from '../../game/chamber';
import { PixelText } from '../../entities/pixelText';
import { ExitPortal, PortalArrival } from '../../entities/portal';
import { drawTrapdoor } from '../../entities/trapdoor';
import { DEFAULT_ENV, type CameraShot, type Level, type LevelContext, type LevelStatus, type TrackedTarget, type WorldLabel } from '../level';

/*
 * Plinko (The Price Is Right). The east wall is a giant pegboard and you're the chip: the portal
 * drops you on a shelf along its top, and standing on one of the hatches there drops you in. You
 * bounce down through the pegs (A / D steer a little) into one of seven slots: EXIT in the middle
 * (the exit portal's right behind it), cash either side (a spring throws you back up for another
 * go), and trapdoors at the ends. Three goes at the cash and the rules change: everything but the
 * exit is a trapdoor.
 */

/** The plane you fall in (x), the shelf's top, and the board's half-width (z). */
const BX = 11.1;
const SHELF_Y = 10.6;
const HALF = 9.55;
/** The chip (you): radius, gravity, bounciness, and how hard A / D steer (m/s²). */
const R = 0.45;
const G = 14;
const BOUNCE = 0.5;
const STEER = 6;
const MAX_VZ = 6;
/** Pegs: rows, spacing, radius. */
const ROWS = 8;
const TOP_ROW = 9.4;
const ROW_GAP = 0.95;
const COL = 2.6;
const PEG_R = 0.16;
/** Slots along the bottom (centres at -3..3 × COL) and their dividers' height. */
const SLOT_H = 1.8;
const CASH_GOES = 3;
/** Standing on a hatch this long drops you. */
const HATCH_TIME = 0.5;
const DEATH_SCREEN_DELAY = 1.8;

type Slot = 'TRAP' | '100' | '500' | 'EXIT';
const SLOTS: Slot[] = ['TRAP', '100', '500', 'EXIT', '500', '100', 'TRAP'];
const SLOT_COLOR: Record<Slot, number[]> = { TRAP: [2.2, 0.25, 0.2], '100': [1.8, 1.4, 0.3], '500': [1.8, 1.4, 0.3], EXIT: [0.3, 2.0, 0.5] };

interface Death {
  t: number;
  big: string;
  small: string;
}

const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

export class PlinkoLevel implements Level {
  readonly number: number;
  readonly title = 'Plinko';
  status: LevelStatus = 'playing';
  private arrival: PortalArrival;
  private exit = new ExitPortal(0);
  private pegs: [number, number][] = [];
  private slots: Slot[] = [...SLOTS];
  private slotText: PixelText[] = [];
  /** 'shelf' (walking about up top), 'drop' (bouncing down), 'spring' (thrown back up), 'done'. */
  private phase: 'shelf' | 'drop' | 'spring' | 'done' = 'shelf';
  private hatchT = 0;
  /** Hatches work once you've been off them (so landing on one from the portal doesn't drop you in). */
  private armed = false;
  private hatch = -1;
  /** In the board's plane: position (z, y) and velocity while dropping. */
  private cz = 0;
  private cy = 0;
  private vz = 0;
  private vy = 0;
  private spin = 0;
  private plinkT = 0;
  private spring: { from: Vec3; to: Vec3; t: number } | null = null;
  private cash = 0;
  private cashGoes = 0;
  private trapdoor: { pos: Vec3; t: number } | null = null;
  private death: Death | null = null;
  private board: DrawItem[] = [];
  private hostLabel: WorldLabel = { pos: [0, 7.2, -CHAMBER_HALF + 0.3], text: 'COME ON DOWN!', size: 1.1, color: '#ffd166' };
  private cashLabel: WorldLabel = { pos: [0, 5.9, -CHAMBER_HALF + 0.3], text: '$0', size: 0.8, color: '#ffffff' };
  private labelList: WorldLabel[] = [{ pos: [0, 8.7, -CHAMBER_HALF + 0.3], text: 'PLINKO', size: 1.8, color: '#ff5fa2' }, this.hostLabel, this.cashLabel];

  constructor(private ctx: LevelContext) {
    this.number = ctx.number;
    const { hud, physics } = ctx;
    hud.setLevel(`The Chamber · Level ${this.number}`);
    hud.show(`LEVEL ${this.number}`, '', 2.5);
    hud.hint('');
    // (Between two hatches, so nobody drops in before they've even stood up.)
    this.arrival = new PortalArrival(ctx, [BX, SHELF_Y, COL / 2], { minElevationDeg: 86 });
    this.exit.openAlready();

    // The shelf along the top, with a rail you can't hop over and ends.
    physics.addStaticBox([10.95, SHELF_Y - 0.2, 0], [2.1, 0.4, HALF * 2 + 0.3]);
    physics.addStaticBox([9.85, SHELF_Y + 0.85, 0], [0.12, 1.7, HALF * 2 + 0.3]);
    for (const s of [-1, 1]) physics.addStaticBox([10.95, SHELF_Y + 0.85, s * (HALF + 0.2)], [2.1, 1.7, 0.12]);
    physics.addStaticBox([CHAMBER_HALF + 0.1, SHELF_Y + 1, 0], [0.2, 2, HALF * 2 + 0.3]);

    for (let r = 0; r < ROWS; r++) {
      const y = TOP_ROW - r * ROW_GAP;
      const off = r % 2 ? COL / 2 : 0;
      for (let z = -3 * COL - off; z <= 3 * COL + off + 0.01; z += COL) if (Math.abs(z) < HALF - 0.3) this.pegs.push([z, y]);
    }
    this.buildBoard();
    for (let i = 0; i < SLOTS.length; i++) {
      const z = (i - 3) * COL;
      this.slotText.push(new PixelText({ centre: [11.86, 1.0, z], right: [0, 0, 1], up: [0, 1, 0], pixel: 0.085, color: SLOT_COLOR[SLOTS[i]], depth: 0.02, pattern: Pattern.emissive }, SLOTS[i]));
    }
  }

  /** The static parts of the board, built once. */
  private buildBoard() {
    const b = this.board;
    // The board face (leaving the bottom of the middle slot open for the exit portal behind it).
    b.push({ mesh: 'box', model: mul(translation([11.86, (SLOT_H + 11.2) / 2, 0]), scaling([0.08, 11.2 - SLOT_H, HALF * 2])), color: [0.93, 0.93, 0.96], spec: 0.4 });
    for (const s of [-1, 1]) b.push({ mesh: 'box', model: mul(translation([11.86, SLOT_H / 2, s * (COL / 2 + (HALF - COL / 2) / 2)]), scaling([0.08, SLOT_H, HALF - COL / 2])), color: [0.2, 0.2, 0.3], spec: 0.4 });
    // A gold frame.
    for (const s of [-1, 1]) b.push({ mesh: 'box', model: mul(translation([11.85, 5.6, s * HALF]), scaling([0.3, 11.2, 0.3])), color: [1.0, 0.75, 0.2], spec: 0.8 });
    // Pegs.
    for (const [z, y] of this.pegs) b.push({ mesh: 'cylinder', model: mul(translation([11.45, y, z]), rotationZ(Math.PI / 2), scaling([PEG_R, 0.95, PEG_R])), color: [0.85, 0.85, 0.9], spec: 1 });
    // Slot dividers.
    for (let i = 0; i <= SLOTS.length; i++) {
      const z = (i - 3.5) * COL;
      b.push({ mesh: 'box', model: mul(translation([11.45, SLOT_H / 2, clamp(z, -HALF, HALF)]), scaling([0.95, SLOT_H, 0.14])), color: [0.95, 0.75, 0.2], spec: 0.8 });
    }
    // The shelf, its rail and ends, and the hatches along it.
    b.push({ mesh: 'box', model: mul(translation([10.95, SHELF_Y - 0.2, 0]), scaling([2.1, 0.4, HALF * 2 + 0.3])), color: [0.35, 0.2, 0.45], spec: 0.4 });
    b.push({ mesh: 'box', model: mul(translation([9.85, SHELF_Y + 0.85, 0]), scaling([0.12, 1.7, HALF * 2 + 0.3])), color: [0.8, 0.9, 1.0], opacity: 0.35, shadow: false });
  }

  private hatchZ(i: number) {
    return (i - 3) * COL;
  }

  update(dt: number) {
    const { player, hud, input, camera } = this.ctx;
    const death = this.death;
    if (death && this.status === 'playing') {
      death.t += dt;
      if (death.t > DEATH_SCREEN_DELAY) {
        this.status = 'lost';
        hud.show(death.big, `${death.small}\nPress R to try again.`);
        hud.tips([
          ['Hint', 'Stand on a hatch along the top to drop in above that slot, and steer a little with A / D on the way down. EXIT is the one in the middle. Cash buys another go, but only three.'],
          ['Controls', 'A / D move along the shelf and steer while falling'],
        ]);
      }
    }
    this.arrival.update(dt);
    this.exit.update(dt, player);
    if (this.exit.entered && this.status === 'playing') this.status = 'exited';
    if (this.trapdoor) this.trapdoor.t += dt;
    this.plinkT -= dt;

    switch (this.phase) {
      case 'shelf': {
        if (!this.arrival.done || player.mode !== 'control' || this.death) break;
        camera.yaw = -Math.PI / 2;
        // Standing on a hatch drops you through it.
        const p = player.pos;
        let on = -1;
        for (let i = 0; i < SLOTS.length; i++) if (player.onGround && p[1] > SHELF_Y - 0.3 && Math.abs(p[2] - this.hatchZ(i)) < 0.75) on = i;
        if (on < 0) this.armed = true;
        if (!this.armed) break;
        if (on !== this.hatch) {
          this.hatch = on;
          this.hatchT = 0;
          if (on >= 0) tone(700, 0.08, { wave: 'square', vol: 0.08 });
        } else if (on >= 0) {
          this.hatchT += dt;
          if (this.hatchT > HATCH_TIME) this.drop(on);
        }
        break;
      }
      case 'drop':
        this.updateDrop(dt, input);
        break;
      case 'spring': {
        const sp = this.spring!;
        sp.t += dt / 1.3;
        const k = Math.min(1, sp.t);
        player.pos = [sp.from[0] + (sp.to[0] - sp.from[0]) * k, sp.from[1] + (sp.to[1] - sp.from[1]) * k + 6 * 4 * k * (1 - k), sp.from[2] + (sp.to[2] - sp.from[2]) * k];
        this.spin += dt * 9;
        player.flightDir = [0, Math.cos(this.spin), Math.sin(this.spin)];
        if (k >= 1) {
          this.spring = null;
          this.trapdoor = null;
          this.phase = 'shelf';
          player.emerge([sp.to[0], sp.to[1] + 0.95, sp.to[2]], -Math.PI / 2, [0, 0, 0], 0.4);
        }
        break;
      }
    }
  }

  private drop(i: number) {
    const { player } = this.ctx;
    this.phase = 'drop';
    this.hatch = -1;
    this.cz = this.hatchZ(i) + (Math.random() - 0.5) * 0.3;
    this.cy = SHELF_Y - 0.9;
    this.vz = 0;
    this.vy = -1;
    player.mode = 'flying';
    player.pos = [BX, this.cy, this.cz];
    this.trapdoor = { pos: [BX, SHELF_Y + 0.01, this.hatchZ(i)], t: 0 };
    noise(0.3, { freq: 400, to: 1400, type: 'bandpass', q: 1, vol: 0.3 });
    this.hostLabel.text = pick(['HERE WE GO!', 'PLINKO!', 'COME ON, CHIP!']);
  }

  /** Bouncing down through the pegs, in the board's plane. */
  private updateDrop(dt: number, input: LevelContext['input']) {
    const { player } = this.ctx;
    if (player.mode !== 'flying') return;
    const steer = (input.isDown('KeyD') ? 1 : 0) - (input.isDown('KeyA') ? 1 : 0);
    this.vz = clamp(this.vz + steer * STEER * dt, -MAX_VZ, MAX_VZ);
    this.vy -= G * dt;
    this.cz += this.vz * dt;
    this.cy += this.vy * dt;
    // Pegs.
    for (const [z, y] of this.pegs) {
      const dz = this.cz - z, dy = this.cy - y;
      const d = Math.hypot(dz, dy), min = R + PEG_R;
      if (d >= min || d < 1e-4) continue;
      const nz = dz / d, ny = dy / d;
      this.cz = z + nz * min;
      this.cy = y + ny * min;
      const vn = this.vz * nz + this.vy * ny;
      if (vn < 0) {
        this.vz -= (1 + BOUNCE) * vn * nz;
        this.vy -= (1 + BOUNCE) * vn * ny;
        // A dead-centre hit goes one way or the other.
        this.vz += (Math.random() - 0.5) * 1.6 + (Math.abs(nz) < 0.15 ? (Math.random() < 0.5 ? -1.2 : 1.2) : 0);
        if (this.plinkT <= 0) {
          this.plinkT = 0.05;
          tone(1500 + Math.random() * 900, 0.06, { wave: 'triangle', vol: 0.16 });
        }
      }
    }
    // The sides, and the slot dividers.
    if (Math.abs(this.cz) > HALF - R) {
      this.cz = Math.sign(this.cz) * (HALF - R);
      this.vz = -this.vz * BOUNCE;
    }
    if (this.cy < SLOT_H + R) {
      for (let i = 0; i <= SLOTS.length; i++) {
        const wz = (i - 3.5) * COL;
        const dz = this.cz - wz;
        if (Math.abs(dz) < R + 0.07) {
          this.cz = wz + Math.sign(dz || 1) * (R + 0.07);
          this.vz = -this.vz * BOUNCE;
          if (this.cy > SLOT_H) this.vy = Math.abs(this.vy) * 0.3; // bounced off the top of one
        }
      }
    }
    this.spin += dt * (4 + Math.abs(this.vz) * 1.5);
    player.pos = [BX, this.cy, this.cz];
    player.flightDir = [0, Math.cos(this.spin), Math.sin(this.spin)];
    if (this.cy <= R) this.land();
  }

  private land() {
    const { player, camera, hud } = this.ctx;
    const i = clamp(Math.round(this.cz / COL) + 3, 0, SLOTS.length - 1);
    const slot = this.slots[i];
    const z = this.hatchZ(i);
    camera.addShake(0.3);
    if (slot === 'EXIT') {
      this.phase = 'done';
      this.hostLabel.text = 'A NEW EXIT!';
      sfx.win();
      // Out of the slot and straight into the portal behind it.
      player.emerge([CHAMBER_HALF - 0.55, 0.95, clamp(z, -0.8, 0.8)], -Math.PI / 2, [0, 0, 0], 0);
      return;
    }
    if (slot === 'TRAP') {
      this.phase = 'done';
      this.trapdoor = { pos: [BX, 0.02, z], t: 0 };
      player.emerge([BX, 0.95, z], -Math.PI / 2, [0, 0, 0], 0.1);
      player.kill([-2, 16, (Math.random() < 0.5 ? -1 : 1) * (2 + Math.random() * 3)], { violence: 12 });
      tone(note('C3'), 0.3, { to: note('A2'), wave: 'sawtooth', vol: 0.15 });
      this.hostLabel.text = 'OHHHHH...';
      this.death = {
        t: 0,
        big: 'THE PRICE IS WRONG',
        small: pick(['Trapdoor. Worth $0 and one test subject.', 'Please spay or neuter your pets.', 'Better luck next time. There is no next time.']),
      };
      return;
    }
    // Cash: a spring throws you back up to the shelf for another go.
    const value = slot === '500' ? 500 : 100;
    this.cash += value;
    this.cashGoes++;
    this.cashLabel.text = `$${this.cash}`;
    tone(note('E6'), 0.12, { wave: 'square', vol: 0.12 });
    tone(note('A6'), 0.3, { wave: 'square', vol: 0.12, at: 0.1 });
    tone(220, 0.4, { to: 900, wave: 'triangle', vol: 0.2, at: 0.25 }); // boing
    this.phase = 'spring';
    const back = clamp(z, -3 * COL, 3 * COL);
    this.spring = { from: [BX, R, z], to: [BX - 0.2, SHELF_Y + 0.05, back + (back > 0 ? -COL / 2 : COL / 2)], t: 0 };
    if (this.cashGoes >= CASH_GOES) {
      // New rules.
      this.slots = this.slots.map((s) => (s === 'EXIT' ? 'EXIT' : 'TRAP'));
      this.slots.forEach((s, k) => this.slotText[k].setText(s));
      this.hostLabel.text = 'NEW RULES: EVERYTHING BUT THE EXIT IS A TRAPDOOR';
      hud.show('FINAL CHIP', 'Greed has been noted.', 2.2);
    } else this.hostLabel.text = pick(['PLAY AGAIN!', `$${value}! AGAIN!`, 'SO CLOSE. GO AGAIN.']);
  }

  draw(out: DrawItem[]) {
    this.arrival.draw(out);
    this.exit.draw(out);
    for (const b of this.board) out.push(b);
    // Hatches on the shelf (the one you're on glows as it's about to open).
    for (let i = 0; i < SLOTS.length; i++) {
      const glow = i === this.hatch ? 0.6 + 1.2 * (this.hatchT / HATCH_TIME) : 0.35;
      const c = SLOT_COLOR[this.slots[i]];
      out.push({ mesh: 'box', model: mul(translation([BX, SHELF_Y + 0.01, this.hatchZ(i)]), scaling([1.3, 0.02, 1.3])), color: [c[0] * glow * 0.6, c[1] * glow * 0.6, c[2] * glow * 0.6], pattern: Pattern.emissive, shadow: false });
    }
    // Slot names (they change colour with the rules).
    for (let i = 0; i < this.slotText.length; i++) this.slotText[i].draw(out);
    if (this.trapdoor) drawTrapdoor(out, this.trapdoor.pos, Math.PI / 2, this.trapdoor.t);
  }

  labels(): WorldLabel[] {
    return this.labelList;
  }

  trackedTargets(): TrackedTarget[] {
    return [];
  }

  environment() {
    return DEFAULT_ENV;
  }

  obstacles() {
    return [];
  }

  cameraShot(): CameraShot | null {
    const shot = this.arrival.cameraShot();
    if (shot) return shot;
    const p = this.ctx.player.pos;
    // Facing the board: along the shelf up top, following the chip down.
    if (this.phase === 'drop' || this.phase === 'spring' || (this.phase === 'done' && this.death)) {
      const y = clamp(p[1], 2.5, 9.5);
      return { pos: [BX - 11, y + 1.5, clamp(p[2], -6, 6) * 0.6], target: [BX, y - 0.3, clamp(p[2], -6, 6) * 0.6], sharpness: 4 };
    }
    if (this.phase === 'shelf' && this.arrival.done) {
      return { pos: [BX - 8.5, SHELF_Y + 3.2, clamp(p[2], -7, 7) * 0.7], target: [BX, SHELF_Y - 2.5, clamp(p[2], -7, 7) * 0.7], sharpness: 4 };
    }
    return null;
  }
}
