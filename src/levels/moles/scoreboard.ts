import { mul, rotationY, scaling, translation, type Vec3 } from '../../engine/math';
import { Pattern, type DrawItem } from '../../engine/renderer';
import { CHAMBER_HALF } from '../../game/chamber';
import { drawMole, MOLE_LOOKS } from '../../entities/mole';
import { PixelText } from '../../entities/pixelText';
import { DECK_TOP } from './cabinet';

/*
 * The cabinet's backboard on the north wall: WHACK-A-MOLE! in yellow LEDs, Timmy's SCORE and the
 * TIME, a message line (INSERT COIN, READY?, GO!, GAME OVER...), chasing bulbs round the frame,
 * and a giant mole mascot either side of it on the deck.
 */

const Z = -CHAMBER_HALF + 0.04;
const RIGHT: Vec3 = [1, 0, 0];
const UP: Vec3 = [0, 1, 0];
const X0 = -10, X1 = 10, Y0 = 4.1, Y1 = 9.7;
const BULB = [[2.6, 2.0, 0.4], [2.6, 0.4, 0.3]];

export class Scoreboard {
  /** 0-1: switched on (the LEDs light up in a scattered order). */
  on = 0;
  /** 0-1: the board unfolds out of the wall (and the mascots rise out of the deck). */
  appear = 0;
  /** Blink the message line. */
  blink = false;
  private title = new PixelText({ centre: [0, 8.55, Z], right: RIGHT, up: UP, pixel: 0.2, color: [2.6, 2.0, 0.3], depth: 0.05, pattern: Pattern.emissive }, 'WHACK-A-MOLE!');
  private score = new PixelText({ centre: [-4.6, 6.6, Z], right: RIGHT, up: UP, pixel: 0.11, color: [2.8, 0.4, 0.28], depth: 0.04, pattern: Pattern.emissive }, 'SCORE 000000');
  private time = new PixelText({ centre: [5.3, 6.6, Z], right: RIGHT, up: UP, pixel: 0.11, color: [0.45, 2.6, 0.6], depth: 0.04, pattern: Pattern.emissive }, 'TIME 40');
  private message = new PixelText({ centre: [0, 5.0, Z], right: RIGHT, up: UP, pixel: 0.13, color: [0.45, 2.0, 2.8], depth: 0.04, pattern: Pattern.emissive }, 'INSERT COIN');
  private statics: DrawItem[] = [];
  private lastScore = -1;
  private lastTime = -1;

  constructor() {
    const s = this.statics;
    s.push({ mesh: 'box', model: mul(translation([0, (Y0 + Y1) / 2, Z - 0.02]), scaling([X1 - X0, Y1 - Y0, 0.05])), color: [0.015, 0.015, 0.05], spec: 0.9 });
    const bar = (x: number, y: number, w: number, h: number, color: number[]) =>
      s.push({ mesh: 'box', model: mul(translation([x, y, Z + 0.02]), scaling([w, h, 0.12])), color, spec: 0.5 });
    const red = [0.85, 0.07, 0.08], yellow = [1, 0.75, 0.08];
    bar(0, Y1 + 0.15, X1 - X0 + 0.6, 0.3, red);
    bar(0, Y0 - 0.15, X1 - X0 + 0.6, 0.3, red);
    bar(X0 - 0.15, (Y0 + Y1) / 2, 0.3, Y1 - Y0 + 0.6, red);
    bar(X1 + 0.15, (Y0 + Y1) / 2, 0.3, Y1 - Y0 + 0.6, red);
    bar(0, 7.45, X1 - X0 - 1, 0.07, yellow);
    bar(0, 5.85, X1 - X0 - 1, 0.05, yellow);
  }

  setScore(score: number) {
    if (score === this.lastScore) return;
    this.lastScore = score;
    this.score.setText(`SCORE ${String(Math.min(999999, score)).padStart(6, '0')}`);
  }

  setTime(seconds: number) {
    const s = Math.max(0, Math.ceil(seconds));
    if (s === this.lastTime) return;
    this.lastTime = s;
    this.time.setText(`TIME ${String(s).padStart(2, '0')}`);
  }

  setMessage(text: string) {
    this.message.setText(text);
  }

  draw(out: DrawItem[], time: number) {
    if (this.appear <= 0) return;
    const first = out.length;
    for (const it of this.statics) out.push({ ...it });
    if (this.on > 0) {
      for (const p of [this.title, this.score, this.time]) {
        p.reveal = this.on;
        p.draw(out);
      }
      this.message.reveal = this.on;
      if (!this.blink || Math.sin(time * 9) > -0.3) this.message.draw(out);
    }
    // Chasing bulbs round the frame.
    const chase = Math.floor(time * 6);
    let k = 0;
    const bulb = (x: number, y: number) => {
      const lit = this.on >= 1 && (k + chase) % 3 !== 0;
      const c = BULB[k % 2];
      k++;
      out.push({
        mesh: 'sphere',
        model: mul(translation([x, y, Z + 0.1]), scaling([0.13, 0.13, 0.13])),
        color: lit ? c : [c[0] * 0.15, c[1] * 0.15, c[2] * 0.15],
        pattern: Pattern.emissive,
        shadow: false,
      });
    };
    for (let x = X0; x <= X1 + 0.01; x += 1) bulb(x, Y1 + 0.15);
    for (let y = Y1 - 0.85; y >= Y0 + 0.2; y -= 0.95) bulb(X1 + 0.15, y);
    for (let x = X1; x >= X0 - 0.01; x -= 1) bulb(x, Y0 - 0.15);
    for (let y = Y0 + 0.85; y <= Y1 - 0.2; y += 0.95) bulb(X0 - 0.15, y);
    if (this.appear < 1) {
      // Unfolding: squashed flat against the wall to start with, then springing out.
      const k = this.appear, s = Math.max(0.02, k < 0.7 ? k / 0.7 : 1 + Math.sin(((k - 0.7) / 0.3) * Math.PI) * 0.06);
      const yc = (Y0 + Y1) / 2;
      const m = mul(translation([0, yc, Z]), scaling([1, s, 1]), translation([0, -yc, -Z]));
      for (let i = first; i < out.length; i++) out[i].model = mul(m, out[i].model);
    }
    // The mascots: giant cool moles cheering either side of the board.
    for (const side of [-1, 1]) {
      const rise = Math.min(1, this.appear * 1.2);
      const y = DECK_TOP - 3.7 * (1 - rise) * (1 - rise);
      const m = mul(translation([side * 11.0, y, -CHAMBER_HALF + 1.1]), rotationY(Math.PI - side * 0.45), scaling([2.3, 2.3, 2.3]));
      drawMole(out, m, MOLE_LOOKS[0], { dazed: 0, armsUp: 1, walk: 0, walking: 0, time: time + side, flash: 0 });
    }
  }
}
