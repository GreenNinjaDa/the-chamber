import {
  add, basis, clamp, cross, easeInOut, lerp, mul, normalize, rotationX, rotationY, rotationZ, scale, scaling, segment, sub, transformPoint,
  translation, type Mat4, type Vec3,
} from '../engine/math';
import { Pattern, type DrawItem } from '../engine/renderer';
import type { WorldLabel } from '../levels/level';

/*
 * Things from The Sims: the plumbob over a Sim's head, the giant white build-mode cursor hand,
 * speech and thought bubbles, a needs panel, and the Grim Reaper (with his clipboard).
 */

// --- Plumbob --------------------------------------------------------------------------------------

const MOOD_GREEN: Vec3 = [0.2, 1.0, 0.22];
const MOOD_YELLOW: Vec3 = [1.0, 0.82, 0.08];
const MOOD_RED: Vec3 = [1.0, 0.1, 0.06];

/** The plumbob's colour for a mood from 1 (green, happy) through 0.5 (yellow) to 0 (red). */
export function moodColor(mood: number): Vec3 {
  const m = clamp(mood, 0, 1);
  const a = m < 0.5 ? MOOD_RED : MOOD_YELLOW, b = m < 0.5 ? MOOD_YELLOW : MOOD_GREEN;
  const k = m < 0.5 ? m * 2 : m * 2 - 1;
  return [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)];
}

/** A cube stood on one corner (its long diagonal up), which stretched tall makes a faceted diamond. */
const ON_CORNER = mul(rotationZ(Math.atan(Math.SQRT2)), rotationY(Math.PI / 4));

/**
 * The plumbob: a faceted green diamond hanging at `pos` (its middle), spinning (`spin`, rad), in a
 * mood's colour, `size` about its height in metres. A faint glow shell rides round it.
 */
export function drawPlumbob(out: DrawItem[], pos: Vec3, spin: number, mood: number, size = 0.55) {
  if (size < 0.01) return;
  const c = moodColor(mood);
  const s = size / 1.732 / 1.7;
  const m = mul(translation(pos), rotationY(spin), scaling([s, s * 1.7, s]), ON_CORNER);
  out.push({ mesh: 'box', model: m, color: [c[0] * 0.75, c[1] * 0.75, c[2] * 0.75], spec: 1.2, shadow: false });
  // The glow: a slightly bigger see-through shell that shines by itself.
  const g = mul(translation(pos), rotationY(spin), scaling([s * 1.12, s * 1.9, s * 1.12]), ON_CORNER);
  out.push({ mesh: 'box', model: g, color: [c[0] * 1.3, c[1] * 1.3, c[2] * 1.3], pattern: Pattern.emissive, opacity: 0.35, shadow: false });
}

// --- The build-mode cursor ------------------------------------------------------------------------

const GLOVE = [1.12, 1.12, 1.16];
const GLOVE_SHADE = [0.9, 0.92, 1.0];
const STITCH = [0.2, 0.2, 0.24];
/** How big the hand is: its pointing finger is about 1.7 m long. */
const HAND_SCALE = 2.3;

/**
 * The giant white-gloved cursor hand of build mode, pointing straight down. `tip` is its hotspot
 * (the end of the pointing finger). `flyTo` glides it somewhere (optionally along an arc);
 * `pinch` (0-1) curls the finger and thumb together to pick something up.
 */
export class CursorHand {
  tip: Vec3;
  /** 0: pointing; 1: pinched shut on something. */
  pinch = 0;
  visible = false;
  /** Which way the back of the hand faces (about the vertical). */
  yaw = 0;
  /** Leaning into its motion (rad, about the hand's own x and z). */
  private leanX = 0;
  private leanZ = 0;
  private from: Vec3 = [0, 0, 0];
  private to: Vec3 = [0, 0, 0];
  private t = 1;
  private dur = 1;
  private arc = 0;
  private vel: Vec3 = [0, 0, 0];
  private time = 0;

  constructor(tip: Vec3) {
    this.tip = [...tip];
  }

  /** Glides to `to` over `seconds` (eased), bulging up by `arc` metres on the way. */
  flyTo(to: Vec3, seconds: number, arc = 0) {
    this.from = [...this.tip];
    this.to = [...to];
    this.t = 0;
    this.dur = Math.max(0.01, seconds);
    this.arc = arc;
  }

  /** Keeps gliding toward a moving target, easing in (no fixed arrival time). */
  follow(to: Vec3, dt: number, sharpness = 3) {
    this.t = 1;
    const k = 1 - Math.exp(-dt * sharpness);
    for (let i = 0; i < 3; i++) this.tip[i] += (to[i] - this.tip[i]) * k;
  }

  get arrived() {
    return this.t >= 1;
  }

  update(dt: number) {
    this.time += dt;
    const before: Vec3 = [...this.tip];
    if (this.t < 1) {
      this.t = Math.min(1, this.t + dt / this.dur);
      const k = easeInOut(this.t);
      for (let i = 0; i < 3; i++) this.tip[i] = lerp(this.from[i], this.to[i], k);
      this.tip[1] += Math.sin(Math.PI * k) * this.arc;
    }
    if (dt > 0) this.vel = scale(sub(this.tip, before), 1 / dt);
    // Lean into the motion a little, like a cursor dragged by a hand.
    const kl = 1 - Math.exp(-dt * 6);
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    const side = this.vel[0] * c - this.vel[2] * s, fwd = this.vel[0] * s + this.vel[2] * c;
    this.leanZ += (clamp(side * 0.03, -0.35, 0.35) - this.leanZ) * kl;
    this.leanX += (clamp(-fwd * 0.03, -0.35, 0.35) - this.leanX) * kl;
  }

  draw(out: DrawItem[]) {
    if (!this.visible) return;
    const bob = Math.sin(this.time * 2.1) * 0.04;
    const m = mul(translation(add(this.tip, [0, bob, 0])), rotationY(this.yaw), rotationZ(this.leanZ), rotationX(this.leanX), scaling([HAND_SCALE, HAND_SCALE, HAND_SCALE]));
    drawHand(out, m, this.pinch);
  }
}

/** The glove in its own frame: fingertip at the origin, the finger up +y, the back of the hand toward +z. */
function drawHand(out: DrawItem[], m: Mat4, pinch: number) {
  const seg = (a: Vec3, b: Vec3, r: number, color = GLOVE) => out.push({ mesh: 'cylinder', model: mul(m, segment(a, b, r)), color, spec: 0.35 });
  const ball = (p: Vec3, r: number, color = GLOVE) => out.push({ mesh: 'sphere', model: mul(m, translation(p), scaling([r, r, r])), color, spec: 0.35 });
  const rbox = (p: Vec3, size: Vec3, color = GLOVE, rot?: Mat4) =>
    out.push({ mesh: 'roundbox', model: rot ? mul(m, translation(p), rot, scaling(size)) : mul(m, translation(p), scaling(size)), color, spec: 0.3 });
  // The pointing finger, in two bones that curl forward (-z) to pinch.
  const k1: Vec3 = [0, 0.86, 0];
  const a1 = pinch * 0.55, a2 = pinch * 1.0;
  const k2 = add(k1, [0, -Math.cos(a1) * 0.44, -Math.sin(a1) * 0.44]);
  const tip = add(k2, [0, -Math.cos(a1 + a2) * 0.4, -Math.sin(a1 + a2) * 0.4]);
  seg(k1, k2, 0.125);
  ball(k2, 0.125);
  seg(k2, tip, 0.115);
  ball(tip, 0.115);
  // The palm, the three curled fingers and the thumb (which swings in to meet the finger).
  rbox([0.24, 1.28, 0.02], [0.66, 0.86, 0.32]);
  for (let i = 0; i < 3; i++) rbox([0.17 + i * 0.16, 0.82, -0.12], [0.15, 0.3, 0.28], i % 2 ? GLOVE : GLOVE_SHADE, rotationX(-0.35));
  ball(k1, 0.13);
  const thumbBase: Vec3 = [-0.06, 1.18, -0.08];
  const thumbTip: Vec3 = [lerp(-0.26, -0.02, pinch), lerp(0.84, tip[1] + 0.12, pinch), lerp(-0.2, tip[2] - 0.05, pinch)];
  seg(thumbBase, thumbTip, 0.105);
  ball(thumbTip, 0.105);
  // The cuff, with a flared rim, and the three stitched lines on the back of the glove.
  out.push({ mesh: 'cylinder', model: mul(m, translation([0.24, 1.82, 0.02]), scaling([0.4, 0.3, 0.26])), color: GLOVE_SHADE, spec: 0.3 });
  out.push({ mesh: 'cylinder', model: mul(m, translation([0.24, 1.99, 0.02]), scaling([0.46, 0.06, 0.3])), color: GLOVE, spec: 0.3 });
  for (let i = 0; i < 3; i++) {
    out.push({ mesh: 'box', model: mul(m, translation([0.1 + i * 0.14, 1.36, 0.185]), scaling([0.025, 0.42, 0.01])), color: STITCH });
  }
}

// --- Speech and thought bubbles -----------------------------------------------------------------------

/**
 * A white speech (or thought) bubble facing the camera: `centre`, the camera's `right` and `up`,
 * `width` and `height` in metres. The level floats its text over it as a world label. `icon`
 * draws something inside (in the bubble's frame: x right, y up, 1 = its half height).
 */
export function drawBubble(out: DrawItem[], centre: Vec3, right: Vec3, up: Vec3, width: number, height: number, thought = false, icon?: (out: DrawItem[], m: Mat4) => void) {
  const fwd = cross(right, up); // toward the camera
  const w = width / 2, h = height / 2;
  const white = [2.4, 2.4, 2.4];
  out.push({ mesh: 'sphere', model: basis(scale(right, w), scale(up, h), scale(fwd, 0.04), centre), color: white, pattern: Pattern.emissive, shadow: false });
  // A dark rim just behind it.
  out.push({ mesh: 'sphere', model: basis(scale(right, w + 0.035), scale(up, h + 0.035), scale(fwd, 0.03), sub(centre, scale(fwd, 0.02))), color: [0.02, 0.03, 0.05], pattern: Pattern.emissive, shadow: false });
  const below = sub(centre, scale(up, h));
  if (thought) {
    for (const [k, r] of [[0.28, 0.09], [0.62, 0.06]] as [number, number][]) {
      const p = add(sub(below, scale(up, k)), scale(right, -k * 0.5));
      out.push({ mesh: 'sphere', model: basis(scale(right, r), scale(up, r), scale(fwd, 0.03), p), color: white, pattern: Pattern.emissive, shadow: false });
    }
  } else {
    const tipAt = add(sub(below, scale(up, 0.28)), scale(right, -w * 0.25));
    const base = add(below, scale(up, 0.06));
    const mid = scale(add(base, tipAt), 0.5);
    out.push({ mesh: 'cone', model: basis(scale(right, -0.1), sub(tipAt, base), scale(fwd, 0.03), mid), color: white, pattern: Pattern.emissive, shadow: false });
  }
  if (icon) icon(out, basis(scale(right, h), scale(up, h), scale(fwd, h), add(centre, scale(fwd, 0.05))));
}

// --- The needs panel ------------------------------------------------------------------------------

export interface Need {
  name: string;
  /** 0-1: how full the bar is. */
  value: number;
  caption: string;
}

const PANEL_BG = [0.05, 0.08, 0.16];
const PANEL_EDGE = [0.25, 0.45, 0.8];
const BAR_BG = [0.02, 0.03, 0.06];

/**
 * A Sims needs panel on a wall: a row per need with its name, a bar that goes green / yellow / red,
 * and a caption. `centre` is its middle on the wall, `right` along the wall, `normal` out of it.
 */
export class NeedsPanel {
  needs: Need[];
  /** 0-1: how far it has popped into view. */
  shown = 0;
  /** Makes the first bar flash (a failing motive). */
  alarm = false;
  private labelList: WorldLabel[] = [];
  private nameLabels: WorldLabel[] = [];
  private captionLabels: WorldLabel[] = [];
  private title: WorldLabel;
  private time = 0;

  constructor(private centre: Vec3, private right: Vec3, private normal: Vec3, needs: Need[], private width = 9, private rowHeight = 0.85) {
    this.needs = needs;
    const out = add(centre, scale(normal, 0.12));
    this.title = { pos: add(out, [0, this.height / 2 - 0.45, 0]), text: 'NEEDS', size: 0.42, color: '#9cc4ff' };
    needs.forEach((_, i) => {
      const y = this.rowY(i);
      this.nameLabels.push({ pos: add(add(out, scale(right, -width / 2 + 1.25)), [0, y, 0]), text: '', size: 0.36, color: '#ffffff' });
      this.captionLabels.push({ pos: add(add(out, scale(right, width / 2 - 1.9)), [0, y, 0]), text: '', size: 0.26, color: '#cfe0ff' });
    });
  }

  private get height() {
    return this.needs.length * this.rowHeight + 1.1;
  }

  private rowY(i: number) {
    return this.height / 2 - 1.05 - i * this.rowHeight;
  }

  update(dt: number) {
    this.time += dt;
  }

  draw(out: DrawItem[]) {
    if (this.shown <= 0.01) return;
    const s = this.shown;
    const box = (centre: Vec3, w: number, h: number, depth: number, color: number[], emissive = false) => out.push({
      mesh: 'box',
      model: basis(scale(this.right, w * s), [0, h * s, 0], scale(this.normal, depth), centre),
      color,
      pattern: emissive ? Pattern.emissive : undefined,
      spec: 0.3,
      shadow: false,
    });
    const face = add(this.centre, scale(this.normal, 0.05));
    box(face, this.width + 0.16, this.height + 0.16, 0.08, PANEL_EDGE, true);
    box(add(face, scale(this.normal, 0.02)), this.width, this.height, 0.1, PANEL_BG, true);
    const barW = this.width * 0.36, barH = 0.34;
    const barX = -this.width / 2 + 2.6 + barW / 2;
    this.needs.forEach((need, i) => {
      const at = add(add(this.centre, scale(this.right, barX * s)), [0, this.rowY(i) * s, 0]);
      box(add(at, scale(this.normal, 0.1)), barW, barH, 0.04, BAR_BG, true);
      const v = clamp(need.value, 0, 1);
      if (v <= 0.005) return;
      let c = moodColor(v);
      if (i === 0 && this.alarm && Math.floor(this.time * 4) % 2 === 0) c = [1.6, 0.25, 0.15];
      const fillW = barW * v;
      box(add(add(at, scale(this.right, (-barW / 2 + fillW / 2) * s)), scale(this.normal, 0.12)), fillW, barH - 0.08, 0.04, [c[0] * 1.2, c[1] * 1.2, c[2] * 1.2], true);
    });
  }

  labels(): WorldLabel[] {
    const list = this.labelList;
    list.length = 0;
    if (this.shown < 0.95) return list;
    list.push(this.title);
    this.needs.forEach((need, i) => {
      this.nameLabels[i].text = need.name;
      this.captionLabels[i].text = need.caption;
      list.push(this.nameLabels[i], this.captionLabels[i]);
    });
    return list;
  }
}

// --- The Grim Reaper ------------------------------------------------------------------------------

const ROBE = [0.035, 0.035, 0.045];
const ROBE_EDGE = [0.07, 0.065, 0.085];
const BONE = [0.86, 0.84, 0.76];
const POLE = [0.3, 0.2, 0.11];
const BLADE = [0.78, 0.8, 0.84];

/**
 * The Grim Reaper, hovering: a hooded black robe with no feet, glowing eyes, a scythe in his right
 * hand and a clipboard in his left. `pos` is the bottom of his robe, `yaw` which way he faces
 * (0: toward -z), `t` for his drifting hem, `writing` (0-1) raises the clipboard and moves the pen.
 */
export function drawGrimReaper(out: DrawItem[], pos: Vec3, yaw: number, t: number, writing = 0, size = 1.15) {
  const m = mul(translation(pos), rotationY(yaw), scaling([size, size, size]));
  const put = (mesh: DrawItem['mesh'], p: Vec3, s: Vec3, color: number[], extra: Partial<DrawItem> = {}, rot?: Mat4) =>
    out.push({ mesh, model: rot ? mul(m, translation(p), rot, scaling(s)) : mul(m, translation(p), scaling(s)), color, ...extra });
  const seg = (a: Vec3, b: Vec3, r: number, color: number[], spec = 0.1) => out.push({ mesh: 'cylinder', model: mul(m, segment(a, b, r)), color, spec });
  // The robe: a flared skirt of cloth up to the waist, a body, broad shoulders, and ragged
  // points round the hem that drift about.
  put('cone', [0, 1.1, 0], [0.66, 2.2, 0.58], ROBE, { spec: 0.15 });
  put('cylinder', [0, 1.45, 0.01], [0.32, 0.9, 0.27], ROBE, { spec: 0.15 });
  for (let i = 0; i < 11; i++) {
    const a = (i / 11) * Math.PI * 2;
    const sway = Math.sin(t * 2.3 + i * 1.7) * 0.08;
    put('cone', [Math.cos(a) * 0.5 + sway, 0.1, Math.sin(a) * 0.44], [0.17, 0.44, 0.17], ROBE_EDGE, {}, rotationX(Math.PI + sway));
  }
  put('sphere', [0, 1.92, 0.02], [0.46, 0.24, 0.32], ROBE, { spec: 0.15 });
  // The hood (peaked at the back), the dark hole where a face should be, and two cold little eyes.
  put('sphere', [0, 2.22, 0.04], [0.29, 0.34, 0.31], ROBE, { spec: 0.15 });
  put('cone', [0, 2.48, 0.18], [0.15, 0.32, 0.15], ROBE, { spec: 0.15 }, rotationX(0.7));
  put('sphere', [0, 2.2, -0.19], [0.19, 0.24, 0.1], [0, 0, 0]);
  const glow = 0.75 + 0.25 * Math.sin(t * 3);
  for (const x of [-0.07, 0.07]) put('sphere', [x, 2.24, -0.27], [0.04, 0.03, 0.02], [0.6 * glow, 2.6 * glow, 2.2 * glow], { pattern: Pattern.emissive, shadow: false });
  // Right arm: the scythe, held upright.
  const handR: Vec3 = [0.46, 1.45, -0.32];
  seg([0.36, 1.95, 0], handR, 0.11, ROBE);
  put('sphere', handR, [0.07, 0.08, 0.07], BONE);
  const poleLow: Vec3 = [0.5, 0.1, -0.36], poleTop: Vec3 = [0.44, 3.1, -0.3];
  seg(poleLow, poleTop, 0.035, POLE);
  // The blade: a curve of flat pieces sweeping out and down from the top of the pole.
  let prev: Vec3 = poleTop;
  for (let i = 1; i <= 6; i++) {
    const a = (i / 6) * 1.9;
    const p: Vec3 = [poleTop[0] - Math.sin(a) * 0.75, poleTop[1] + 0.05 - (1 - Math.cos(a)) * 0.45, poleTop[2] - 0.02];
    const w = 0.13 * (1 - i / 7) + 0.02;
    const d = sub(p, prev);
    const along = normalize(d);
    const down: Vec3 = [-along[1], along[0], 0];
    out.push({ mesh: 'box', model: mul(m, basis(d, scale(down, w), [0, 0, 0.02], add(scale(add(prev, p), 0.5), scale(down, w / 2)))), color: BLADE, spec: 1 });
    prev = p;
  }
  // Left arm: the clipboard, raised to read (and write on) when `writing`.
  const lift = easeInOut(clamp(writing, 0, 1));
  const handL: Vec3 = [-0.3, 1.45 + lift * 0.25, -0.38];
  seg([-0.36, 1.95, 0], handL, 0.11, ROBE);
  put('sphere', handL, [0.07, 0.08, 0.07], BONE);
  const board = mul(m, translation(add(handL, [0.12, 0.12, -0.08])), rotationX(-0.9 + lift * 0.35), rotationY(0.35));
  out.push({ mesh: 'box', model: mul(board, scaling([0.36, 0.48, 0.025])), color: [0.45, 0.3, 0.16], spec: 0.2 });
  out.push({ mesh: 'box', model: mul(board, translation([0, -0.02, -0.016]), scaling([0.3, 0.4, 0.01])), color: [0.95, 0.95, 0.9] });
  out.push({ mesh: 'box', model: mul(board, translation([0, 0.22, -0.02]), scaling([0.14, 0.05, 0.03])), color: BLADE, spec: 1 });
  for (let i = 0; i < 4; i++) out.push({ mesh: 'box', model: mul(board, translation([0, 0.1 - i * 0.07, -0.022]), scaling([0.22, 0.012, 0.005])), color: [0.3, 0.3, 0.35] });
  if (lift > 0.5) {
    // A bony finger scribbling.
    const pen = transformPoint(board, [Math.sin(t * 9) * 0.08, -0.05 + Math.sin(t * 3.1) * 0.08, -0.06]);
    out.push({ mesh: 'sphere', model: mul(translation(pen), scaling([0.04 * size, 0.04 * size, 0.04 * size])), color: BONE });
  }
}
