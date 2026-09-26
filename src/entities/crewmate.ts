import { add, approachAngle, clamp, mul, rotationX, rotationY, rotationZ, scaling, segment, sub, translation, type Mat4, type Vec3 } from '../engine/math';
import { Pattern, type DrawItem } from '../engine/renderer';

/*
 * A bean-shaped crewmate (about 1.5 m): a round-topped body, a wide glassy visor, a backpack and
 * two stubby legs, scripted (no physics). The level steers one by setting `vel` (it turns to face
 * where it's going and waddles); it can hop (`lift`, also negative to sink down a vent), freeze,
 * cheer, flip its head open into a toothy mouth with a tongue (`mouth`, `tongue`, `tongueTo`: the
 * impostor), glow red in the visor (`glow`), be killed (`kill`: the top half flies off and the
 * bottom half stays with a bone sticking out) or be ejected (`eject`: it tumbles up and away).
 */

export interface CrewColor {
  name: string;
  body: number[];
  /** For labels. */
  css: string;
}

export const CREW_COLORS: CrewColor[] = [
  { name: 'RED', body: [0.78, 0.06, 0.05], css: '#ff5a4f' },
  { name: 'BLUE', body: [0.08, 0.2, 0.85], css: '#6f9bff' },
  { name: 'GREEN', body: [0.04, 0.48, 0.16], css: '#43d86e' },
  { name: 'PINK', body: [0.93, 0.34, 0.72], css: '#ff86dd' },
  { name: 'YELLOW', body: [0.95, 0.84, 0.18], css: '#ffe45a' },
  { name: 'CYAN', body: [0.18, 0.88, 0.84], css: '#5cf2ea' },
  { name: 'PURPLE', body: [0.42, 0.18, 0.72], css: '#c08bff' },
  { name: 'LIME', body: [0.45, 0.9, 0.18], css: '#b3ff5c' },
  { name: 'WHITE', body: [0.86, 0.88, 0.92], css: '#ffffff' },
];

/** Body radius and heights (m, feet at 0). */
export const CREW_RADIUS = 0.42;
export const CREW_HEIGHT = 1.5;
const R = CREW_RADIUS;
const BODY_BOTTOM = 0.36;
const BODY_TOP = 1.06;
const DOME_Y = 0.44;
/** Where the head flips open (the mouth), and where a killed one is cut in half. */
const MOUTH_CUT = 0.9;
const DEAD_CUT = 0.7;
const PACK_BOTTOM = 0.5;
const PACK_TOP = 1.08;
const VISOR = [0.34, 0.56, 0.72];
const VISOR_SHINE = [0.95, 0.98, 1];
const MOUTH = [0.35, 0.02, 0.04];
const FLESH = [0.72, 0.1, 0.12];
const BONE = [0.94, 0.92, 0.84];
const TOOTH = [0.96, 0.95, 0.9];
const TONGUE = [0.85, 0.2, 0.32];
const GRAVITY = 20;

interface FlyingTop {
  pos: Vec3;
  vel: Vec3;
  yaw: number;
  rx: number;
  spin: number;
  landed: boolean;
}

export type CrewState = 'alive' | 'dead' | 'ejected';

export class Crewmate {
  pos: Vec3;
  facing: number;
  /** Horizontal velocity the level wants (m/s). */
  vel: Vec3 = [0, 0, 0];
  state: CrewState = 'alive';
  /** Extra height (m): hops, or negative to sink through the floor (a vent). */
  lift = 0;
  /** 0..1: how far the head is flipped open. */
  mouth = 0;
  /** 0..1: how far the tongue has shot out toward `tongueTo`. */
  tongue = 0;
  tongueTo: Vec3 = [0, 0, 0];
  /** 0..1: the visor glowing red (in the dark). */
  glow = 0;
  cheering = false;
  /** Stops the waddle (e.g. frozen in terror, or standing at a task). */
  frozen = false;
  /** Not drawn at all (e.g. crawling through a vent). */
  hidden = false;
  /** Drawn scaled by this (e.g. a pet). */
  size = 1;
  /** See-through-ness (1 solid), e.g. when it's right in front of the camera. */
  opacity = 1;
  /** The crosshair's pulsing glow (e.g. a body you can report). */
  highlight = 0;
  private shade: number[];
  private phase = Math.random() * 6;
  private amount = 0;
  private t = Math.random() * 10;
  private top: FlyingTop | null = null;
  /** Ejected: tumbling up into space. */
  private ejT = 0;
  private ejSpin = 0;
  /** Seconds since it was killed, and the red spray. */
  private deadT = 0;
  private gore: { pos: Vec3; vel: Vec3; r: number }[] = [];

  constructor(readonly color: CrewColor, pos: Vec3, facing: number) {
    this.pos = [...pos];
    this.facing = facing;
    this.shade = color.body.map((c) => c * 0.72);
  }

  get alive() {
    return this.state === 'alive';
  }

  forward(): Vec3 {
    return [-Math.sin(this.facing), 0, -Math.cos(this.facing)];
  }

  /** Roughly where the visor is (world). */
  visor(): Vec3 {
    const f = this.forward();
    return [this.pos[0] + f[0] * 0.4 * this.size, this.pos[1] + (this.lift + 1.12) * this.size, this.pos[2] + f[2] * 0.4 * this.size];
  }

  /** Killed by something at `from`: the top half flies off away from it; the bottom half stays put. */
  kill(from: Vec3) {
    if (this.state !== 'alive') return;
    this.state = 'dead';
    this.mouth = this.tongue = 0;
    this.lift = 0;
    const dx = this.pos[0] - from[0], dz = this.pos[2] - from[2];
    const d = Math.hypot(dx, dz) || 1;
    const side = (Math.random() - 0.5) * 1.5;
    this.top = {
      pos: [this.pos[0], this.pos[1] + 0.9, this.pos[2]],
      vel: [(dx / d) * 2.6 - (dz / d) * side, 6.5, (dz / d) * 2.6 + (dx / d) * side],
      yaw: this.facing,
      rx: 0,
      spin: (Math.random() < 0.5 ? -1 : 1) * (7 + Math.random() * 5),
      landed: false,
    };
    // A spray of red (visible from across the room), and a puddle that spreads.
    this.deadT = 0;
    this.gore.length = 0;
    for (let i = 0; i < 10; i++) {
      const a = Math.random() * Math.PI * 2, s = 1.5 + Math.random() * 3;
      this.gore.push({
        pos: [this.pos[0], this.pos[1] + DEAD_CUT + 0.05, this.pos[2]],
        vel: [Math.cos(a) * s + (dx / d) * 1.5, 3 + Math.random() * 4, Math.sin(a) * s + (dz / d) * 1.5],
        r: 0.06 + Math.random() * 0.06,
      });
    }
  }

  /** Ejected: flung up out of the room, tumbling, and never seen again. */
  eject() {
    if (this.state !== 'alive') return;
    this.state = 'ejected';
    this.ejT = 0;
    this.ejSpin = (Math.random() < 0.5 ? -1 : 1) * (2.5 + Math.random());
  }

  update(dt: number) {
    this.t += dt;
    if (this.state === 'ejected') {
      this.ejT += dt;
      // Up and away, slowing to a drift (space is floaty).
      this.pos[1] += (6 + 16 * Math.exp(-this.ejT * 0.9)) * dt;
      this.facing += this.ejSpin * 0.6 * dt;
      return;
    }
    if (this.state === 'dead') {
      this.deadT += dt;
      for (const g of this.gore) {
        if (g.pos[1] <= 0.02) continue;
        g.vel[1] -= GRAVITY * dt;
        for (let k = 0; k < 3; k++) g.pos[k] += g.vel[k] * dt;
        if (g.pos[1] <= 0.02) g.pos[1] = 0.02;
      }
      const top = this.top;
      if (top && !top.landed) {
        top.vel[1] -= GRAVITY * dt;
        for (let k = 0; k < 3; k++) top.pos[k] += top.vel[k] * dt;
        top.rx += top.spin * dt;
        // Bounce off the chamber walls.
        for (const k of [0, 2]) {
          if (Math.abs(top.pos[k]) > 11.6) {
            top.pos[k] = Math.sign(top.pos[k]) * 11.6;
            top.vel[k] *= -0.4;
          }
        }
        if (top.pos[1] <= R && top.vel[1] < 0) {
          // Down it comes, on its side.
          top.pos[1] = R;
          top.landed = true;
          top.rx = Math.sign(top.spin) * Math.PI * 0.5;
        }
      }
      return;
    }
    const hs = Math.hypot(this.vel[0], this.vel[2]);
    this.pos[0] += this.vel[0] * dt;
    this.pos[2] += this.vel[2] * dt;
    if (hs > 0.05) this.facing = approachAngle(this.facing, Math.atan2(-this.vel[0], -this.vel[2]), dt * 9);
    const want = this.frozen ? 0 : Math.min(1.3, hs / 3);
    this.amount += (want - this.amount) * (1 - Math.exp(-dt * 10));
    if (!this.frozen) this.phase += dt * (hs > 0.05 ? 5 + hs * 2.2 : 0);
  }

  /** Turns to face a point. */
  lookAt(p: Vec3, dt: number, rate = 8) {
    const dx = p[0] - this.pos[0], dz = p[2] - this.pos[2];
    if (Math.hypot(dx, dz) < 0.01) return;
    this.facing = approachAngle(this.facing, Math.atan2(-dx, -dz), dt * rate);
  }

  draw(out: DrawItem[]) {
    const first = out.length;
    this.drawModel(out);
    if (this.opacity < 1 || this.highlight > 0) {
      for (let i = first; i < out.length; i++) {
        if (this.opacity < 1) out[i].opacity = this.opacity;
        if (this.highlight > 0) out[i].highlight = this.highlight;
      }
    }
  }

  private drawModel(out: DrawItem[]) {
    if (this.hidden) return;
    const col = this.color.body, shade = this.shade;
    if (this.state === 'ejected') {
      if (this.pos[1] > 90) return;
      const m = mul(translation([this.pos[0], this.pos[1] + 0.75, this.pos[2]]), rotationY(this.facing), rotationX(this.ejT * this.ejSpin), rotationZ(this.ejT * 1.3), translation([0, -0.75, 0]));
      drawLower(out, m, col, shade, BODY_TOP, 0, 0, false);
      drawUpper(out, m, col, shade, BODY_TOP, 0);
      return;
    }
    if (this.state === 'dead') {
      // A puddle, the spray, and the bottom half with a bone sticking out.
      const pr = 0.35 + 0.75 * clamp(this.deadT / 1.2, 0, 1);
      out.push({ mesh: 'cylinder', model: mul(translation([this.pos[0] + 0.15, 0.011, this.pos[2] - 0.1]), scaling([pr, 0.01, pr * 0.85])), color: [0.4, 0.02, 0.03], pattern: Pattern.blob, param: 0.85, shadow: false });
      for (const g of this.gore) {
        const flatten = g.pos[1] <= 0.021 ? 0.25 : 1;
        out.push({ mesh: 'sphere', model: mul(translation(g.pos), scaling([g.r * (2 - flatten), g.r * flatten, g.r * (2 - flatten)])), color: FLESH, spec: 0.6, shadow: false });
      }
      const m = mul(translation(this.pos), rotationY(this.facing));
      drawLower(out, m, col, shade, DEAD_CUT, 0, 0, false);
      out.push({ mesh: 'cylinder', model: mul(m, translation([0, DEAD_CUT + 0.005, 0]), scaling([R * 0.97, 0.02, R * 0.97])), color: FLESH, spec: 0.5 });
      out.push({ mesh: 'cylinder', model: mul(m, translation([0, DEAD_CUT + 0.18, 0]), scaling([0.055, 0.36, 0.055])), color: BONE, spec: 0.3 });
      out.push({ mesh: 'sphere', model: mul(m, translation([-0.055, DEAD_CUT + 0.38, 0]), scaling([0.075, 0.075, 0.075])), color: BONE, spec: 0.3 });
      out.push({ mesh: 'sphere', model: mul(m, translation([0.055, DEAD_CUT + 0.38, 0]), scaling([0.075, 0.075, 0.075])), color: BONE, spec: 0.3 });
      const top = this.top;
      if (top) {
        const tm = mul(translation(top.pos), rotationY(top.yaw), rotationX(top.rx), translation([0, -0.9, 0]));
        drawUpper(out, tm, col, shade, DEAD_CUT, 0);
        out.push({ mesh: 'cylinder', model: mul(tm, translation([0, DEAD_CUT - 0.005, 0]), scaling([R * 0.97, 0.02, R * 0.97])), color: FLESH, spec: 0.5 });
      }
      return;
    }
    // Alive: waddle (a sway and a bob), hop, cheer.
    const a = this.amount, s = Math.sin(this.phase);
    let hop = Math.abs(s) * 0.05 * a;
    if (this.cheering) hop += Math.abs(Math.sin(this.t * 8)) * 0.35;
    const sc = this.size;
    const m = mul(
      translation([this.pos[0], this.pos[1] + (this.lift + hop) * sc, this.pos[2]]),
      rotationY(this.facing + (this.cheering ? Math.sin(this.t * 4) * 0.4 : 0)),
      rotationZ(s * 0.08 * a),
      sc !== 1 ? scaling([sc, sc, sc]) : IDENTITY_SCALE,
    );
    const mouth = this.mouth;
    const cut = mouth > 0.001 ? MOUTH_CUT : BODY_TOP;
    drawLower(out, m, col, shade, cut, s * a, Math.cos(this.phase) * a, this.cheering);
    if (mouth > 0.001) {
      // The head flips back on a hinge at the back: a gaping mouth full of teeth.
      const head = mul(m, translation([0, MOUTH_CUT, R * 0.9]), rotationX(-mouth * 1.05), translation([0, -MOUTH_CUT, -R * 0.9]));
      drawUpper(out, head, col, shade, MOUTH_CUT, this.glow);
      out.push({ mesh: 'cylinder', model: mul(m, translation([0, MOUTH_CUT + 0.004, 0]), scaling([R * 0.93, 0.02, R * 0.93])), color: MOUTH });
      out.push({ mesh: 'cylinder', model: mul(head, translation([0, MOUTH_CUT - 0.004, 0]), scaling([R * 0.93, 0.02, R * 0.93])), color: MOUTH });
      for (let i = 0; i < 7; i++) {
        const ang = Math.PI * (0.15 + (i / 6) * 0.7);
        const x = Math.cos(ang) * R * 0.8, z = -Math.sin(ang) * R * 0.8;
        out.push({ mesh: 'cone', model: mul(m, translation([x, MOUTH_CUT + 0.07, z]), scaling([0.05, 0.13, 0.05])), color: TOOTH, spec: 0.4 });
        out.push({ mesh: 'cone', model: mul(head, translation([x, MOUTH_CUT - 0.07, z]), rotationX(Math.PI), scaling([0.05, 0.13, 0.05])), color: TOOTH, spec: 0.4 });
      }
      if (this.tongue > 0.01) {
        const base = add(this.pos, [0, (MOUTH_CUT + 0.05 + this.lift) * sc, 0]);
        const tip = add(base, scaleV(sub(this.tongueTo, base), this.tongue));
        out.push({ mesh: 'cylinder', model: segment(base, tip, 0.07), color: TONGUE, spec: 0.6 });
        out.push({ mesh: 'cone', model: mul(segment(tip, add(tip, scaleV(sub(tip, base), 0.25 / Math.max(0.05, dist(tip, base)))), 0.09)), color: TONGUE, spec: 0.6 });
      }
    } else {
      drawUpper(out, m, col, shade, BODY_TOP, this.glow);
    }
  }
}

const IDENTITY_SCALE = scaling([1, 1, 1]);
const scaleV = (v: Vec3, k: number): Vec3 => [v[0] * k, v[1] * k, v[2] * k];
const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * Legs, the body up to `cut` and the bit of backpack below it. `swing` / `lift` animate the legs
 * (sin / cos of the walk phase times the walk amount).
 */
function drawLower(out: DrawItem[], m: Mat4, col: number[], shade: number[], cut: number, swing: number, lift: number, cheer: boolean) {
  for (const side of [-1, 1]) {
    const sw = swing * side * 0.45;
    const up = Math.max(0, lift * side) * 0.09 + (cheer ? 0.04 : 0);
    out.push({
      mesh: 'roundbox',
      model: mul(m, translation([side * 0.19, 0.42 + up, 0.02]), rotationX(sw), translation([0, -0.21, 0]), scaling([0.28, 0.44, 0.36])),
      color: col,
      spec: 0.25,
    });
  }
  const h = cut - BODY_BOTTOM;
  out.push({ mesh: 'cylinder', model: mul(m, translation([0, BODY_BOTTOM + h / 2, 0]), scaling([R, h, R])), color: col, spec: 0.25 });
  // A rounded bottom between the legs.
  out.push({ mesh: 'sphere', model: mul(m, translation([0, BODY_BOTTOM, 0]), scaling([R, 0.09, R])), color: col, spec: 0.25 });
  const packTop = Math.min(PACK_TOP, cut);
  if (packTop > PACK_BOTTOM + 0.02) {
    const ph = packTop - PACK_BOTTOM;
    out.push({ mesh: 'roundbox', model: mul(m, translation([0, PACK_BOTTOM + ph / 2, R + 0.02]), scaling([0.54, ph, 0.28])), color: shade, spec: 0.2 });
  }
}

/** The body above `cut`: the rest of the cylinder, the dome, the visor and the backpack's top. */
function drawUpper(out: DrawItem[], m: Mat4, col: number[], shade: number[], cut: number, glow: number) {
  const h = BODY_TOP - cut;
  if (h > 0.005) out.push({ mesh: 'cylinder', model: mul(m, translation([0, cut + h / 2, 0]), scaling([R, h, R])), color: col, spec: 0.25 });
  out.push({ mesh: 'sphere', model: mul(m, translation([0, BODY_TOP, 0]), scaling([R, DOME_Y, R])), color: col, spec: 0.25 });
  if (glow > 0.01) {
    const g = clamp(glow, 0, 1);
    out.push({ mesh: 'sphere', model: mul(m, translation([0, 1.1, -0.34]), scaling([0.28, 0.165, 0.15])), color: [VISOR[0] + (3 - VISOR[0]) * g, VISOR[1] * (1 - g) + 0.1 * g, VISOR[2] * (1 - g) + 0.05 * g], pattern: g > 0.5 ? Pattern.emissive : undefined, spec: 1 });
  } else {
    out.push({ mesh: 'sphere', model: mul(m, translation([0, 1.1, -0.34]), scaling([0.28, 0.165, 0.15])), color: VISOR, spec: 1.2 });
    out.push({ mesh: 'sphere', model: mul(m, translation([0.1, 1.16, -0.47]), scaling([0.1, 0.035, 0.025])), color: VISOR_SHINE, spec: 1 });
  }
  const packBottom = Math.max(PACK_BOTTOM, cut);
  if (PACK_TOP > packBottom + 0.02) {
    const ph = PACK_TOP - packBottom;
    out.push({ mesh: 'roundbox', model: mul(m, translation([0, packBottom + ph / 2, R + 0.02]), scaling([0.54, ph, 0.28])), color: shade, spec: 0.2 });
  }
}
