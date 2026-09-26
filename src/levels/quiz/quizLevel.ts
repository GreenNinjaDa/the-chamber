import { add, basis, clamp, mul, scaling, translation, type Vec3 } from '../../engine/math';
import { Pattern, type DrawItem } from '../../engine/renderer';
import { CHAMBER_HALF } from '../../game/chamber';
import { ExitPortal, PortalArrival } from '../../entities/portal';
import { drawTrapdoor } from '../../entities/trapdoor';
import { DEFAULT_ENV, type CameraShot, type Level, type LevelContext, type LevelStatus, type TrackedTarget, type WorldLabel } from '../level';

/*
 * Who Wants To Be A Test Subject? A game show. Four answer pads (A, B, C, D) on the floor, a
 * question on the big screen, a timer bar. When time's up, every pad but the right one turns
 * out to be a trapdoor (and so does the floor between them: stand on an answer). Some questions
 * are easy, some are tricks, some are about other chambers, and the last one is about leaving.
 */

interface Question {
  q: string;
  answers: [string, string, string, string];
  /** Which pads are safe (indices). */
  right: number[];
  time: number;
  /** Said when you survive it. */
  quip: string;
}

/** The fixed first and last questions, and a pool for the middle. */
const FIRST: Question = { q: 'WHAT IS 2 + 2?', answers: ['4', '22', 'FISH', '5 (FOR LARGE VALUES OF 2)'], right: [0], time: 9, quip: 'CORRECT. WE WERE WORRIED FOR A MOMENT.' };
const POOL: Question[] = [
  { q: 'WHICH OF THESE IS A LIE?', answers: ['THE CAKE', 'THE FLOOR', 'THIS QUESTION', 'YOUR SCORE'], right: [0], time: 8, quip: 'EVERYBODY KNOWS THAT.' },
  { q: 'HOW MANY LEGS DOES A SENTRY TURRET HAVE?', answers: ['TWO', 'THREE', 'FOUR', 'NONE. IT FLOATS.'], right: [1], time: 8, quip: 'THEY SAY HELLO.' },
  { q: 'PICK THE SAFE PAD.', answers: ['NOT THIS ONE', 'NOR THIS ONE', 'THIS ONE', 'DEFINITELY THIS ONE'], right: [2], time: 7, quip: "NEVER TRUST 'DEFINITELY'." },
  { q: 'WHAT DOES THE BIG RED BUTTON DO?', answers: ['NOTHING', 'FREE CAKE', 'PRESS IT AND SEE', "DON'T"], right: [3], time: 8, quip: 'GOOD. DON’T.' },
  { q: 'WHICH ANSWER IS WRONG?', answers: ['THIS ONE', 'THIS ONE', 'THIS ONE', 'THIS ONE'], right: [0, 1, 2, 3], time: 7, quip: 'WE COULDN’T DECIDE EITHER.' },
  { q: 'THE FLOOR IS...?', answers: ['LAVA', 'A TRAPDOOR', 'FINE', 'LYING'], right: [2], time: 7, quip: 'FOR NOW.' },
  { q: 'WHAT DO GARDEN GNOMES DO WHEN YOU LOOK AWAY?', answers: ['NOTHING', 'SLEEP', 'KNITTING', 'MOVE'], right: [3], time: 8, quip: 'DON’T LOOK BEHIND YOU.' },
  { q: 'HOW MANY OF THESE ANSWERS ARE CORRECT?', answers: ['ONE', 'TWO', 'THREE', 'FOUR'], right: [0], time: 9, quip: 'ONE. THAT ONE.' },
  { q: 'QUICK! WHICH IS THE LETTER B?', answers: ['A', 'B', 'C', 'D'], right: [1], time: 4, quip: 'THE ALPHABET: MASTERED.' },
];
const LAST: Question = { q: 'FINAL QUESTION: DO YOU WANT TO LEAVE?', answers: ['YES', 'NO', 'MAYBE', "WHAT'S A LEAVE"], right: [0], time: 8, quip: 'THEN GO. THE DOOR IS OPEN.' };
const MIDDLE = 5;

const PAD_COLORS = [[0.2, 0.45, 0.95], [0.95, 0.65, 0.1], [0.2, 0.8, 0.35], [0.9, 0.2, 0.25]];
const PAD_R = 1.25;
const LETTERS = ['A', 'B', 'C', 'D'];
const SCREEN_Y = 6.2;
const DEATH_SCREEN_DELAY = 2;
/** Standing on one answer this long locks it in ("FINAL ANSWER?") and reveals early. */
const LOCK_IN = 3.5;

const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

interface Death {
  t: number;
  big: string;
  small: string;
}

export class QuizLevel implements Level {
  readonly number: number;
  readonly title = 'Quiz Show';
  status: LevelStatus = 'playing';
  private arrival: PortalArrival;
  private exit = new ExitPortal(0);
  private questions: Question[];
  private index = -1;
  private qt = 0;
  private phase: 'intro' | 'asking' | 'reveal' | 'done' = 'intro';
  private phaseT = 0;
  private pads: Vec3[] = [];
  private padGoals: Vec3[] = [];
  private death: Death | null = null;
  private trapdoors: { pos: Vec3; t: number }[] = [];
  private questionLabel: WorldLabel = { pos: [0, SCREEN_Y + 1.1, -CHAMBER_HALF + 0.4], text: '', size: 0.8, color: '#ffffff' };
  private statusLabel: WorldLabel = { pos: [0, SCREEN_Y - 1.4, -CHAMBER_HALF + 0.4], text: '', size: 0.5, color: '#ffd166' };
  private answerLabels: WorldLabel[] = [];
  private padLabels: WorldLabel[] = [];
  private labelList: WorldLabel[];
  private timer = -1;
  private held = -1;
  private heldFor = 0;
  /** The pad you were already on when the question came up: it can't lock in until you step off it. */
  private stale = -1;

  constructor(private ctx: LevelContext) {
    this.number = ctx.number;
    const { hud } = ctx;
    hud.setLevel(`The Chamber · Level ${this.number}`);
    hud.show(`LEVEL ${this.number}`, '', 2.5);
    hud.hint('');
    this.arrival = new PortalArrival(ctx, [0, 0, 7]);
    const pool = POOL.slice().sort(() => Math.random() - 0.5).slice(0, MIDDLE);
    this.questions = [FIRST, ...pool, LAST];
    for (let i = 0; i < 4; i++) {
      const p = this.homePad(i);
      this.pads.push([...p]);
      this.padGoals.push([...p]);
      this.answerLabels.push({ pos: [(i % 2 ? 4 : -4), SCREEN_Y - 0.1 - Math.floor(i / 2) * 0.75, -CHAMBER_HALF + 0.4], text: '', size: 0.42, color: '#dfe8ff' });
      this.padLabels.push({ pos: add(p, [0, 1.6, 0]), text: LETTERS[i], size: 0.8, color: '#ffffff' });
    }
    this.labelList = [this.questionLabel, this.statusLabel, ...this.answerLabels, ...this.padLabels];
  }

  private homePad(i: number): Vec3 {
    return [(i % 2 ? 1 : -1) * 3.6, 0, -2 + Math.floor(i / 2) * 5.2];
  }

  /** Which pad the player is standing on, or -1. */
  private padUnder(): number {
    const p = this.ctx.player.pos;
    for (let i = 0; i < 4; i++) if (Math.hypot(p[0] - this.pads[i][0], p[2] - this.pads[i][2]) < PAD_R) return i;
    return -1;
  }

  private ask(i: number) {
    this.index = i;
    this.phase = 'asking';
    this.phaseT = 0;
    const q = this.questions[i];
    this.questionLabel.text = q.q;
    this.questionLabel.size = Math.min(0.8, 20 / (0.72 * q.q.length));
    q.answers.forEach((a, k) => (this.answerLabels[k].text = `${LETTERS[k]}: ${a}`));
    this.statusLabel.text = i === this.questions.length - 1 ? 'FOR ALL THE MARBLES' : `QUESTION ${i + 1} OF ${this.questions.length}`;
    this.held = -1;
    this.heldFor = 0;
    this.stale = this.padUnder();
    // Now and then the pads swap places, to keep you on your toes.
    if (i >= 3 && Math.random() < 0.5) {
      const order = [0, 1, 2, 3].sort(() => Math.random() - 0.5);
      order.forEach((from, to) => (this.padGoals[to] = this.homePad(from)));
    }
  }

  update(dt: number) {
    const { player, hud, camera } = this.ctx;
    const death = this.death;
    if (death && this.status === 'playing') {
      death.t += dt;
      if (death.t > DEATH_SCREEN_DELAY) {
        this.status = 'lost';
        hud.show(death.big, `${death.small}\nPress R to try again.`);
        hud.tips([
          ['Hint', 'Stand on the pad with the right answer (the letters on the floor match the screen) before the bar runs out. Standing between pads counts as no answer.'],
          ['Controls', 'WASD move · Shift sprint'],
        ]);
      }
    }
    this.arrival.update(dt);
    this.exit.update(dt, player);
    if (this.exit.entered && this.status === 'playing') this.status = 'exited';
    for (const d of this.trapdoors) d.t += dt;
    for (let i = 0; i < 4; i++) {
      const p = this.pads[i], g = this.padGoals[i];
      for (let k = 0; k < 3; k++) p[k] += (g[k] - p[k]) * Math.min(1, dt * 2.5);
      this.padLabels[i].pos = add(p, [0, 1.6, 0]);
    }
    if (!this.arrival.done) return;
    this.phaseT += dt;
    const alive = player.mode === 'control' && !this.death;
    switch (this.phase) {
      case 'intro':
        this.questionLabel.text = 'WHO WANTS TO BE A TEST SUBJECT?';
        this.questionLabel.size = 0.8;
        this.statusLabel.text = 'THE RULES: STAND ON YOUR ANSWER.';
        if (this.phaseT > 3) this.ask(0);
        break;
      case 'asking': {
        const q = this.questions[this.index];
        this.timer = clamp(1 - this.phaseT / q.time, 0, 1);
        const on = this.padUnder();
        if (on !== this.stale) this.stale = -2;
        if (on === this.held && on >= 0 && on !== this.stale) this.heldFor += dt;
        else {
          this.held = on;
          this.heldFor = 0;
        }
        const locked = this.heldFor >= LOCK_IN && this.phaseT > 1.5;
        if (this.held >= 0 && this.heldFor > 1.2 && !locked) this.statusLabel.text = `FINAL ANSWER? ${LETTERS[this.held]}...`;
        if (this.phaseT >= q.time || locked) {
          this.phase = 'reveal';
          this.phaseT = 0;
          this.timer = -1;
          // Every wrong pad drops, and so does the floor between them.
          const under = this.padUnder();
          for (let i = 0; i < 4; i++) if (!q.right.includes(i)) this.trapdoors.push({ pos: [...this.pads[i]], t: 0 });
          if (alive && !q.right.includes(under)) {
            const yaw = Math.random() * Math.PI * 2;
            if (under < 0) this.trapdoors.push({ pos: [player.pos[0], 0, player.pos[2]], t: 0 });
            player.kill([Math.sin(yaw) * 4, 22, Math.cos(yaw) * 4], { violence: 12 });
            camera.addShake(0.6);
            this.statusLabel.text = under < 0 ? 'NO ANSWER GIVEN' : 'WRONG';
            this.death = under < 0
              ? { t: 0, big: 'NO ANSWER', small: pick(['Sitting on the fence is not an answer. It is, however, a trapdoor.', 'You have to pick one. That is how questions work.']) }
              : { t: 0, big: 'WRONG ANSWER', small: pick(['That was not it. Thanks for playing.', 'Unlucky. Also incorrect.', 'Would you like to phone a friend? You have no friends here.']) };
          } else if (alive) {
            this.statusLabel.text = q.quip;
          }
        }
        break;
      }
      case 'reveal':
        if (this.phaseT > 2 && !this.death) {
          this.trapdoors = [];
          if (this.index < this.questions.length - 1) this.ask(this.index + 1);
          else {
            this.phase = 'done';
            this.exit.openNow();
            this.questionLabel.text = 'YOU ARE NOW A CERTIFIED TEST SUBJECT';
            this.questionLabel.size = 0.7;
            for (const a of this.answerLabels) a.text = '';
            hud.show('WINNER', 'Your prize is: leaving.', 3);
          }
        }
        break;
      case 'done':
        break;
    }
  }

  draw(out: DrawItem[]) {
    this.arrival.draw(out);
    this.exit.draw(out);
    const q = this.index >= 0 ? this.questions[this.index] : null;
    const revealing = this.phase === 'reveal';
    // The answer pads (the wrong ones become trapdoors on the reveal).
    for (let i = 0; i < 4; i++) {
      const p = this.pads[i];
      const lit = revealing && q && q.right.includes(i);
      if (revealing && q && !q.right.includes(i)) continue;
      out.push({ mesh: 'cylinder', model: mul(translation(add(p, [0, 0.03, 0])), scaling([PAD_R + 0.12, 0.06, PAD_R + 0.12])), color: [0.12, 0.12, 0.14] });
      out.push({
        mesh: 'cylinder',
        model: mul(translation(add(p, [0, 0.07, 0])), scaling([PAD_R, 0.04, PAD_R])),
        color: lit ? PAD_COLORS[i].map((c) => c * 2.2) : PAD_COLORS[i],
        pattern: lit ? Pattern.emissive : Pattern.plain,
        spec: 0.6,
      });
    }
    for (const d of this.trapdoors) drawTrapdoor(out, d.pos, 0.2, d.t);
    // The big screen, and the timer bar under it.
    const wz = -CHAMBER_HALF + 0.16;
    out.push({ mesh: 'box', model: mul(translation([0, SCREEN_Y, wz]), scaling([17, 4.6, 0.3])), color: [0.18, 0.12, 0.3], spec: 0.5 });
    out.push({ mesh: 'box', model: mul(translation([0, SCREEN_Y, wz + 0.02]), scaling([16.2, 4, 0.3])), color: [0.03, 0.02, 0.08], spec: 0.8 });
    if (this.timer >= 0) {
      const w = 15 * this.timer;
      out.push({ mesh: 'box', model: basis([w, 0, 0], [0, 0.22, 0], [0, 0, 0.34], [-7.5 + w / 2, SCREEN_Y - 1.95, wz]), color: this.timer > 0.3 ? [1.5, 1.2, 0.3] : [2.2, 0.3, 0.2], pattern: Pattern.emissive });
    }
    // Spotlights on the floor round the pads, game-show style.
    for (let i = 0; i < 4; i++) {
      const p = this.pads[i];
      out.push({ mesh: 'cylinder', model: mul(translation(add(p, [0, 0.005, 0])), scaling([PAD_R + 0.6, 0.004, PAD_R + 0.6])), color: [0.9, 0.85, 0.6], opacity: 0.25, shadow: false });
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
