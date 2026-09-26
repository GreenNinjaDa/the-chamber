import { noise, note, sfx, tone } from '../../engine/audio';
import { clamp, mul, normalize, rotationX, rotationY, scaling, translation, type Vec3 } from '../../engine/math';
import { GROUPS_RAGDOLL_ONLY, RAPIER } from '../../engine/physics';
import { Pattern, type DrawItem } from '../../engine/renderer';
import { CHAMBER_HALF } from '../../game/chamber';
import type { Circle } from '../../game/player';
import { drawChessPiece, drawCrown, PIECE_NAME, PIECE_RADIUS, type PieceKind } from '../../entities/chess';
import { ExitPortal, PortalArrival } from '../../entities/portal';
import { DEFAULT_ENV, type CameraShot, type Level, type LevelContext, type LevelStatus, type TrackedTarget, type WorldLabel } from '../level';

/*
 * Chess. The chamber floor is an 8 x 8 board of 3 m squares and you're a white pawn at the south
 * end; Black's whole army stands at the north end, as solid as it looks. The pieces move by the
 * rules (knights jump, bishops go diagonally, pawns only forward...) on a clock, each move shown a
 * moment ahead as a glowing red square: whatever stands there when the piece lands is captured.
 * They come for you, which is also how the back rows open up: reach the far row and you promote,
 * and Black resigns.
 */

/** Square size (m): eight of them span the chamber. */
const SQ = 3;
/** How long a move shows (red square) before the piece lifts off, and how long it's in the air (s). */
const WARN = 0.95;
const FLY = 0.45;
const KNIGHT_FLY = 0.6;
/** Seconds between Black's turns, and how many pieces move per turn as time goes on. */
const TURN_EVERY = 1.35;
const MOVES_AT: [number, number][] = [[0, 1], [4, 2], [22, 3]];
/** If White doesn't move off the first square, Black gets impatient after this long. */
const IMPATIENT = 5;
const DEATH_SCREEN_DELAY = 1.8;
/** How far over a square's edge your body can be and still count as on it (m). */
const OVERLAP = 0.2;
/** Pieces block the player a little wider than their bases, so neighbours leave no gap to squeeze through. */
const BLOCK_RADIUS = PIECE_RADIUS + 0.25;

const LIGHT = [0.86, 0.79, 0.64];
const DARK = [0.36, 0.22, 0.13];
const BLACK = [0.025, 0.025, 0.03];

const BACK_ROW: PieceKind[] = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'];

const JOKES: Record<PieceKind, string[]> = {
  p: ['Taken by a pawn. Somewhere, a grandmaster winced.', 'A pawn. A PAWN.'],
  n: ['Nobody sees the knight coming. It moves in an L. Look it up.', 'Horse.'],
  b: ['Diagonals. Bishops love them. You stood on one.', 'The bishop moves in mysterious ways. Diagonal ways.'],
  r: ['Straight down the line. That is what rooks do.', 'You were in the rook’s lane.'],
  q: ['The queen goes wherever she likes. Today she liked you.', 'Never stand in front of the queen. Or beside her. Or diagonally.'],
  k: ['The king himself got up for this. You should be honoured.', 'Checkmate. Well, pawnmate.'],
};

const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

/** Square (file 0-7 = a-h, west to east; rank 0-7 = 1-8, south to north) to world. */
const sqX = (f: number) => -CHAMBER_HALF + SQ / 2 + f * SQ;
const sqZ = (r: number) => CHAMBER_HALF - SQ / 2 - r * SQ;
const fileOf = (x: number) => clamp(Math.floor((x + CHAMBER_HALF) / SQ), 0, 7);
const rankOf = (z: number) => clamp(Math.floor((CHAMBER_HALF - z) / SQ), 0, 7);

interface Piece {
  kind: PieceKind;
  f: number;
  r: number;
  /** Where it's drawn (it glides between squares). */
  pos: Vec3;
  yaw: number;
  move: Move | null;
  collider: RAPIER.Collider;
  /** 0-1: toppled over (the king resigning) / sunk into the board (after the game). */
  topple: number;
  sink: number;
}

interface Move {
  piece: Piece;
  from: [number, number];
  to: [number, number];
  /** Seconds since it was announced (lifts off at WARN, lands at WARN + fly). */
  t: number;
  fly: number;
}

interface Death {
  t: number;
  big: string;
  small: string;
}

export class ChessLevel implements Level {
  readonly number: number;
  readonly title = 'Chess';
  status: LevelStatus = 'playing';
  private arrival: PortalArrival;
  private exit = new ExitPortal(-4.5);
  private pieces: Piece[] = [];
  private moves: Move[] = [];
  private circles: Circle[] = [];
  private t = 0;
  /** Level time Black started playing (-1: White hasn't moved yet). */
  private started = -1;
  private nextTurn = 0;
  private startSquare: [number, number] | null = null;
  private waitT = 0;
  private death: Death | null = null;
  private promoted = -1;
  private board: DrawItem[] = [];
  private wallLabel: WorldLabel = { pos: [0, 6.6, -CHAMBER_HALF + 0.3], text: 'WHITE TO MOVE', size: 1.1, color: '#ffffff' };
  private subLabel: WorldLabel = { pos: [0, 5.6, -CHAMBER_HALF + 0.3], text: '', size: 0.5, color: '#ffd166' };
  private labelList: WorldLabel[] = [this.wallLabel, this.subLabel];

  constructor(private ctx: LevelContext) {
    this.number = ctx.number;
    const { hud, physics } = ctx;
    hud.setLevel(`The Chamber · Level ${this.number}`);
    hud.show(`LEVEL ${this.number}`, '', 2.5);
    hud.hint('');
    // e2, near enough (the portal throws you about).
    this.arrival = new PortalArrival(ctx, [sqX(4), 0, sqZ(1)], { minElevationDeg: 70 });

    for (let f = 0; f < 8; f++) {
      this.addPiece(physics, BACK_ROW[f], f, 7);
      this.addPiece(physics, 'p', f, 6);
    }
    // The board, built once.
    for (let f = 0; f < 8; f++) {
      for (let r = 0; r < 8; r++) {
        this.board.push({ mesh: 'box', model: mul(translation([sqX(f), 0.015, sqZ(r)]), scaling([SQ, 0.03, SQ])), color: (f + r) % 2 === 0 ? DARK : LIGHT, spec: 0.35 });
      }
    }
    for (let f = 0; f < 8; f++) this.labelList.push({ pos: [sqX(f), 0.35, CHAMBER_HALF - 0.25], text: 'abcdefgh'[f], size: 0.45, color: '#ffffff' });
    for (let r = 0; r < 8; r++) this.labelList.push({ pos: [-CHAMBER_HALF + 0.25, 0.35, sqZ(r)], text: String(r + 1), size: 0.45, color: '#ffffff' });
  }

  private addPiece(physics: LevelContext['physics'], kind: PieceKind, f: number, r: number) {
    // Solid to a flung body; the living player is kept out by obstacles() instead.
    const collider = physics.world.createCollider(
      RAPIER.ColliderDesc.cylinder(1.6, PIECE_RADIUS).setTranslation(sqX(f), 1.6, sqZ(r)).setCollisionGroups(GROUPS_RAGDOLL_ONLY),
    );
    this.pieces.push({ kind, f, r, pos: [sqX(f), 0, sqZ(r)], yaw: 0, move: null, collider, topple: 0, sink: 0 });
  }

  // --- The rules -----------------------------------------------------------------------------------

  /** Whether the player's body is on a square (even partly: over its edge by a little counts). */
  private overlaps(f: number, r: number) {
    const p = this.ctx.player.pos;
    return Math.abs(p[0] - sqX(f)) < SQ / 2 + OVERLAP && Math.abs(p[2] - sqZ(r)) < SQ / 2 + OVERLAP;
  }

  /**
   * The square Black goes for: yours, or, if you're tucked into the corner of an occupied one, the
   * nearest free square you're overlapping.
   */
  private target(): [number, number] {
    const p = this.ctx.player.pos;
    const f0 = fileOf(p[0]), r0 = rankOf(p[2]);
    if (!this.occupied(f0, r0)) return [f0, r0];
    let best: [number, number] = [f0, r0], bestD = Infinity;
    for (let df = -1; df <= 1; df++) {
      for (let dr = -1; dr <= 1; dr++) {
        const f = f0 + df, r = r0 + dr;
        if (f < 0 || f > 7 || r < 0 || r > 7 || this.occupied(f, r) || !this.overlaps(f, r)) continue;
        const d = Math.hypot(p[0] - sqX(f), p[2] - sqZ(r));
        if (d < bestD) {
          bestD = d;
          best = [f, r];
        }
      }
    }
    return best;
  }

  /** A piece on (or on its way to) a square. */
  private occupied(f: number, r: number) {
    for (const p of this.pieces) {
      if (p.sink > 0) continue;
      if (p.move ? p.move.to[0] === f && p.move.to[1] === r : p.f === f && p.r === r) return true;
      // (A piece in the air has left its square; one about to take off hasn't yet.)
      if (p.move && p.move.t < WARN && p.f === f && p.r === r) return true;
    }
    return false;
  }

  /** Every square this piece may move to, with the player's square (`you`) counting as a white piece. */
  private legal(p: Piece, you: [number, number]): [number, number][] {
    const out: [number, number][] = [];
    const on = (f: number, r: number) => f >= 0 && f < 8 && r >= 0 && r < 8;
    const isYou = (f: number, r: number) => f === you[0] && r === you[1];
    const slide = (dirs: number[][]) => {
      for (const [df, dr] of dirs) {
        for (let k = 1; k < 8; k++) {
          const f = p.f + df * k, r = p.r + dr * k;
          if (!on(f, r) || this.occupied(f, r)) break;
          out.push([f, r]);
          if (isYou(f, r)) break;
        }
      }
    };
    const step = (deltas: number[][]) => {
      for (const [df, dr] of deltas) {
        const f = p.f + df, r = p.r + dr;
        if (on(f, r) && !this.occupied(f, r)) out.push([f, r]);
      }
    };
    const ROOK = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const BISHOP = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
    switch (p.kind) {
      case 'r': slide(ROOK); break;
      case 'b': slide(BISHOP); break;
      case 'q': slide([...ROOK, ...BISHOP]); break;
      case 'k': step([...ROOK, ...BISHOP]); break;
      case 'n': step([[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]]); break;
      case 'p': {
        // Black pawns go south (down the ranks), take diagonally, and can't take straight ahead.
        const r1 = p.r - 1;
        if (on(p.f, r1) && !this.occupied(p.f, r1) && !isYou(p.f, r1)) {
          out.push([p.f, r1]);
          if (p.r === 6 && !this.occupied(p.f, r1 - 1) && !isYou(p.f, r1 - 1)) out.push([p.f, r1 - 1]);
        }
        for (const df of [-1, 1]) if (isYou(p.f + df, r1) && !this.occupied(p.f + df, r1)) out.push([p.f + df, r1]);
        break;
      }
    }
    return out;
  }

  /** Black's turn: the best few moves, mostly aimed at where you are or are about to be. */
  private blackMoves(count: number) {
    const { player } = this.ctx;
    const you = this.target();
    const lead = WARN + FLY * 0.6;
    const ahead: [number, number] = [fileOf(player.pos[0] + player.vel[0] * lead), rankOf(player.pos[2] + player.vel[2] * lead)];
    const aimAhead = Math.random() < 0.6;
    // Once you're in their half, they guard the far row: the hole in it nearest you most of all.
    const deep = you[1] >= 4;
    let hole = -1;
    for (let f = 0; f < 8; f++) if (!this.occupied(f, 7) && (hole < 0 || Math.abs(f - you[0]) < Math.abs(hole - you[0]))) hole = f;
    const taken: string[] = this.moves.map((m) => `${m.to[0]},${m.to[1]}`);
    for (let n = 0; n < count; n++) {
      let best: { p: Piece; to: [number, number]; score: number } | null = null;
      for (const p of this.pieces) {
        if (p.move) continue;
        for (const to of this.legal(p, you)) {
          if (taken.includes(`${to[0]},${to[1]}`)) continue;
          const cheb = (a: [number, number], b: [number, number]) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
          const onYou = to[0] === you[0] && to[1] === you[1];
          const onAhead = to[0] === ahead[0] && to[1] === ahead[1];
          let score = 0;
          if (onAhead && aimAhead) score += 100;
          else if (onYou) score += 90;
          else if (onAhead) score += 60;
          else {
            // Otherwise close in (which also opens up their back rows).
            const before = cheb([p.f, p.r], you), after = cheb(to, you);
            score += (before - after) * 6 + (8 - after) * 1.5;
            if (after <= 1) score += 8; // hem you in
          }
          if (p.kind === 'k') score -= 60; // the king stays home unless it can take you
          if (deep && !onYou && !onAhead) {
            if (p.r === 7 && to[1] < 7) score -= 25; // don't leave the far row now
            if (to[1] === 7 && to[0] === hole) score += 35; // plug the hole
            else if (to[1] === 7 && p.r < 7) score += 12;
          }
          if (p.kind === 'p' && !onYou) score -= 4;
          score += Math.random() * 9;
          if (!best || score > best.score) best = { p, to, score };
        }
      }
      if (!best || best.score < 0) break;
      const fly = best.p.kind === 'n' ? KNIGHT_FLY : FLY;
      const move: Move = { piece: best.p, from: [best.p.f, best.p.r], to: best.to, t: 0, fly };
      best.p.move = move;
      this.moves.push(move);
      taken.push(`${best.to[0]},${best.to[1]}`);
      tone(1250, 0.04, { wave: 'square', vol: 0.06 });
    }
  }

  private updateMoves(dt: number) {
    const { player, camera } = this.ctx;
    for (let i = this.moves.length - 1; i >= 0; i--) {
      const m = this.moves[i], p = m.piece;
      m.t += dt;
      const from: Vec3 = [sqX(m.from[0]), 0, sqZ(m.from[1])], to: Vec3 = [sqX(m.to[0]), 0, sqZ(m.to[1])];
      if (m.t < WARN) {
        // Getting ready: a little lift and wobble at the end.
        const k = clamp((m.t - WARN + 0.3) / 0.3, 0, 1);
        p.pos = [from[0], 0.25 * k, from[2]];
        continue;
      }
      const s = clamp((m.t - WARN) / m.fly, 0, 1);
      const e = s * s * (3 - 2 * s);
      const hop = p.kind === 'n' ? 3.2 : 1.3;
      p.pos = [from[0] + (to[0] - from[0]) * e, 0.25 * (1 - s) + hop * 4 * s * (1 - s), from[2] + (to[2] - from[2]) * e];
      p.collider.setTranslation({ x: p.pos[0], y: 1.6 + p.pos[1], z: p.pos[2] });
      if (s < 1) continue;
      // Landed.
      p.f = m.to[0];
      p.r = m.to[1];
      p.pos = [...to];
      p.move = null;
      this.moves.splice(i, 1);
      tone(180, 0.12, { to: 120, wave: 'square', vol: 0.12 });
      noise(0.12, { freq: 1800, to: 700, type: 'bandpass', q: 2, vol: 0.35 });
      const d = Math.hypot(player.pos[0] - to[0], player.pos[2] - to[2]);
      camera.addShake(Math.max(0, 0.3 - d * 0.02));
      const alive = player.mode === 'control' && !this.death && !player.inPortal && this.promoted < 0;
      if (alive && this.overlaps(m.to[0], m.to[1])) this.capture(p);
    }
  }

  private capture(p: Piece) {
    const { player, camera } = this.ctx;
    // Taken off the board: flicked away from the piece, high and far.
    const away = normalize([player.pos[0] - p.pos[0] + (Math.random() - 0.5) * 0.4, 0, player.pos[2] - p.pos[2] + (Math.random() - 0.5) * 0.4]);
    player.kill([away[0] * 9, 13, away[2] * 9], { violence: p.kind === 'q' || p.kind === 'k' ? 22 : 12, origin: [p.pos[0], 1.5, p.pos[2]] });
    camera.addShake(0.7);
    this.wallLabel.text = 'CHECKMATE';
    this.subLabel.text = `${PIECE_NAME[p.kind]} TAKES PAWN`;
    this.death = { t: 0, big: 'CAPTURED', small: pick(JOKES[p.kind]) };
  }

  // --- The game ------------------------------------------------------------------------------------

  update(dt: number) {
    const { player, hud } = this.ctx;
    this.t += dt;
    const death = this.death;
    if (death && this.status === 'playing') {
      death.t += dt;
      if (death.t > DEATH_SCREEN_DELAY) {
        this.status = 'lost';
        hud.show(death.big, `${death.small}\nPress R to try again.`);
        hud.tips([
          ['Hint', 'The pieces move like chess pieces. A red square is where one is about to land: get off it. They leave their rows to chase you; slip through the gaps they leave and reach the far row.'],
          ['Controls', 'WASD move · Shift sprint · Space jump'],
        ]);
      }
    }
    this.arrival.update(dt);
    this.exit.update(dt, player);
    if (this.exit.entered && this.status === 'playing') this.status = 'exited';
    this.updateMoves(dt);

    const alive = player.mode === 'control' && !this.death && !player.inPortal;
    const you: [number, number] = [fileOf(player.pos[0]), rankOf(player.pos[2])];

    // White to move: Black waits until you step off your first square (or dawdle too long).
    if (this.started < 0 && this.arrival.done && alive) {
      this.startSquare ??= you;
      this.waitT += dt;
      if (you[0] !== this.startSquare[0] || you[1] !== this.startSquare[1] || this.waitT > IMPATIENT) {
        this.started = this.t;
        this.nextTurn = this.t + 0.4;
        this.wallLabel.text = 'BLACK TO MOVE';
        tone(note('C5'), 0.15, { wave: 'triangle', vol: 0.15 });
      }
    }
    if (this.started >= 0 && alive && this.promoted < 0 && this.t >= this.nextTurn) {
      const since = this.t - this.started;
      let count = 1;
      for (const [at, n] of MOVES_AT) if (since >= at) count = n;
      this.blackMoves(count);
      this.nextTurn = this.t + TURN_EVERY;
    }
    // "CHECK." when a move is coming for your square.
    if (alive && this.promoted < 0 && this.started >= 0) {
      const check = this.moves.some((m) => this.overlaps(m.to[0], m.to[1]));
      // (Standing in the corner of an occupied square on the far row doesn't count.)
      this.subLabel.text = check ? 'CHECK.' : you[1] === 7 ? "AN EMPTY SQUARE, PLEASE. THIS ISN'T CHECKERS." : '';
    }

    // The far row (an empty square of it, as in chess): promotion, and Black resigns.
    if (alive && this.promoted < 0 && you[1] === 7 && !this.occupied(you[0], 7)) {
      this.promoted = this.t;
      this.moves.length = 0;
      for (const p of this.pieces) {
        p.move = null;
        p.pos = [sqX(p.f), 0, sqZ(p.r)];
      }
      this.wallLabel.text = 'PROMOTED TO QUEEN';
      this.subLabel.text = '';
      sfx.win();
      hud.show('PROMOTION', 'You are now a queen. Congratulations, Your Majesty.', 3);
    }
    if (this.promoted >= 0) {
      const since = this.t - this.promoted;
      const king = this.pieces.find((p) => p.kind === 'k')!;
      const before = king.topple;
      king.topple = clamp((since - 1.2) / 0.9, 0, 1);
      if (before < 1 && king.topple >= 1) {
        sfx.thud(0.8);
        this.wallLabel.text = 'BLACK RESIGNS';
        this.subLabel.text = 'GG';
        this.exit.openNow();
      }
      // Then the pieces sink away (and stop being in the way).
      for (const p of this.pieces) {
        p.sink = clamp((since - 2.6) / 2, 0, 1);
        if (p.sink >= 1) p.collider.setEnabled(false);
      }
    }

    // Knights turn to look at you.
    for (const p of this.pieces) {
      if (p.kind !== 'n' || p.move) continue;
      const want = Math.atan2(player.pos[0] - p.pos[0], player.pos[2] - p.pos[2]);
      let d = want - p.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      p.yaw += d * Math.min(1, dt * 2);
    }
  }

  draw(out: DrawItem[], time: number) {
    this.arrival.draw(out);
    this.exit.draw(out);
    for (const b of this.board) out.push(b);
    // Squares about to be landed on glow red (pulsing faster as it gets close).
    for (const m of this.moves) {
      if (m.t >= WARN + m.fly) continue;
      const k = clamp(m.t / WARN, 0, 1);
      const pulse = 0.55 + 0.45 * Math.sin(time * (8 + 14 * k));
      out.push({
        mesh: 'box',
        model: mul(translation([sqX(m.to[0]), 0.04, sqZ(m.to[1])]), scaling([SQ - 0.1, 0.03, SQ - 0.1])),
        color: [3.2 * pulse + 0.6, 0.12, 0.08],
        pattern: Pattern.emissive,
        opacity: 0.75 + 0.25 * k,
        shadow: false,
      });
    }
    for (const p of this.pieces) {
      if (p.sink >= 1) continue;
      let base = mul(translation([p.pos[0], p.pos[1] - p.sink * 5, p.pos[2]]), rotationY(p.yaw));
      // Resigning: the king tips over onto his face (toward you, south).
      if (p.topple > 0) {
        const a = (p.topple * p.topple) * (Math.PI / 2 - 0.05);
        base = mul(translation([p.pos[0], p.pos[1] - p.sink * 5, p.pos[2] + PIECE_RADIUS]), rotationX(a), translation([0, 0, -PIECE_RADIUS]));
      }
      const glow = p.move && p.move.t < WARN ? 0.06 + 0.06 * Math.sin(time * 20) : 0;
      drawChessPiece(out, p.kind, base, [BLACK[0] + glow * 3, BLACK[1] + glow, BLACK[2] + glow]);
    }
    if (this.promoted >= 0 && this.ctx.player.mode === 'control') drawCrown(out, this.ctx.player.partFrames().head);
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

  /** The pieces on the ground are in the way (those in the air, or sunk, aren't). */
  obstacles(): Circle[] {
    let n = 0;
    for (const p of this.pieces) {
      if (p.sink > 0.4 || (p.move && p.move.t >= WARN)) continue;
      const c = (this.circles[n] ??= { x: 0, z: 0, r: BLOCK_RADIUS });
      c.x = p.pos[0];
      c.z = p.pos[2];
      n++;
    }
    this.circles.length = n;
    return this.circles;
  }

  cameraShot(): CameraShot | null {
    return this.arrival.cameraShot();
  }
}
