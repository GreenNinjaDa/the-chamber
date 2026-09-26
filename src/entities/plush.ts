import { mul, rotationX, rotationZ, scaling, segment, transformPoint, translation, type Mat4, type Quat, type Vec3 } from '../engine/math';
import type { Body, BodyModel, Physics } from '../engine/physics';
import { Pattern, type DrawItem } from '../engine/renderer';
import { junk } from './junk';

/*
 * Plush toys: claw-machine prizes about the player's size (in there, so are you). Light and
 * bouncy. Little green three-eyed aliens (a loving nod to a certain toy-story franchise),
 * teddy bears, giant rubber ducks and beach balls. Spawn one with `spawnPlush`.
 */

export type PlushKind = 'alien' | 'teddy' | 'duck' | 'ball';

/** Shared looks a level can change at run time (e.g. every alien's eyes glowing in the dark). */
export interface PlushLook {
  /** 0: normal eyes; 1: glowing. */
  eyeGlow: number;
}

export interface Plush {
  kind: PlushKind;
  body: Body;
  /** Roughly how far the toy reaches from its centre (m), for gripping and crowding. */
  radius: number;
}

const FUR = { pattern: Pattern.skin, spec: 0.03 };
const GLOSSY = { spec: 0.6 };
const BLACK = [0.03, 0.03, 0.035];

function push(out: DrawItem[], m: Mat4, mesh: DrawItem['mesh'], pos: Vec3, size: Vec3, color: number[], extra: Partial<DrawItem> = {}, rot?: Mat4) {
  out.push({ mesh, model: rot ? mul(m, translation(pos), rot, scaling(size)) : mul(m, translation(pos), scaling(size)), color, ...extra });
}

// --- Alien ---------------------------------------------------------------------------------
// Capsule collider (radius 0.3, 0.46 straight): about 1.06 m tall. Front faces -z.
const ALIEN_R = 0.3;
const ALIEN_LEN = 0.46;
const SUIT = [0.25, 0.47, 0.92];
const SKIN = [0.42, 0.86, 0.26];
const SKIN_DARK = [0.3, 0.68, 0.18];
const EYE_WHITE = [0.95, 0.95, 0.92];
const EYE_GLOW = [2.4, 3.2, 1.6];

const alienModel = (look: PlushLook): BodyModel => (out, m) => {
  // Space suit: a rounded body.
  push(out, m, 'cylinder', [0, -0.2, 0], [0.27, 0.34, 0.27], SUIT, FUR);
  push(out, m, 'sphere', [0, -0.37, 0], [0.27, 0.16, 0.27], SUIT, FUR);
  push(out, m, 'cylinder', [0, -0.02, 0], [0.22, 0.06, 0.22], [0.9, 0.9, 0.95], FUR); // collar
  // A planet-and-ring badge on the chest.
  push(out, m, 'cylinder', [0, -0.16, -0.255], [0.085, 0.02, 0.085], [0.95, 0.82, 0.15], GLOSSY, rotationX(Math.PI / 2));
  push(out, m, 'cylinder', [0, -0.16, -0.268], [0.05, 0.02, 0.05], [0.9, 0.2, 0.15], GLOSSY, rotationX(Math.PI / 2));
  // Stubby arms with green hands.
  for (const side of [-1, 1]) {
    const shoulder = transformPoint(m, [side * 0.24, -0.08, -0.02]);
    const hand = transformPoint(m, [side * 0.36, -0.27, -0.08]);
    out.push({ mesh: 'cylinder', model: segment(shoulder, hand, 0.065), color: SUIT, ...FUR });
    push(out, m, 'sphere', [side * 0.37, -0.3, -0.09], [0.07, 0.07, 0.07], SKIN, FUR);
  }
  // The big green head, antenna on top.
  push(out, m, 'sphere', [0, 0.22, 0], [0.31, 0.26, 0.28], SKIN, FUR);
  push(out, m, 'cylinder', [0, 0.54, 0], [0.022, 0.2, 0.022], SKIN_DARK, FUR);
  push(out, m, 'sphere', [0, 0.66, 0], [0.055, 0.055, 0.055], SKIN, FUR);
  // Three eyes: "Ooooh."
  const glow = look.eyeGlow > 0.5;
  for (let i = -1; i <= 1; i++) {
    const x = i * 0.125, y = i === 0 ? 0.27 : 0.25, z = i === 0 ? -0.25 : -0.225;
    push(out, m, 'sphere', [x, y, z], [0.075, 0.08, 0.06], glow ? EYE_GLOW : EYE_WHITE, glow ? { pattern: Pattern.emissive, shadow: false } : GLOSSY);
    push(out, m, 'sphere', [x, y, z - 0.05], [0.035, 0.04, 0.02], BLACK, GLOSSY);
  }
  // A small, slightly worried smile.
  push(out, m, 'box', [0, 0.11, -0.262], [0.1, 0.018, 0.02], SKIN_DARK);
};

// --- Teddy bear ----------------------------------------------------------------------------
// Capsule collider (radius 0.4, 0.46 straight): about 1.26 m tall, sitting.
const TEDDY_R = 0.4;
const TEDDY_LEN = 0.46;
const TEDDY_COLORS: [number[], number[]][] = [
  [[0.55, 0.34, 0.18], [0.86, 0.7, 0.5]],
  [[0.95, 0.56, 0.72], [1, 0.86, 0.9]],
  [[0.45, 0.62, 0.95], [0.86, 0.91, 1]],
  [[0.9, 0.9, 0.86], [0.98, 0.84, 0.86]],
];
const BOW_COLORS = [[0.85, 0.1, 0.15], [0.2, 0.3, 0.85], [0.95, 0.75, 0.1], [0.2, 0.7, 0.35]];

const teddyModel = (fur: number[], light: number[], bow: number[]): BodyModel => (out, m) => {
  push(out, m, 'sphere', [0, -0.24, 0], [0.4, 0.42, 0.36], fur, FUR);
  push(out, m, 'sphere', [0, -0.22, -0.16], [0.26, 0.28, 0.22], light, FUR); // tummy
  push(out, m, 'sphere', [0, 0.3, 0], [0.3, 0.28, 0.27], fur, FUR);
  push(out, m, 'sphere', [0, 0.23, -0.22], [0.13, 0.1, 0.1], light, FUR); // snout
  push(out, m, 'sphere', [0, 0.27, -0.315], [0.045, 0.035, 0.03], BLACK, GLOSSY);
  for (const side of [-1, 1]) {
    push(out, m, 'sphere', [side * 0.1, 0.36, -0.24], [0.035, 0.04, 0.025], BLACK, GLOSSY); // eyes
    push(out, m, 'sphere', [side * 0.21, 0.52, 0], [0.1, 0.1, 0.06], fur, FUR); // ears
    push(out, m, 'sphere', [side * 0.21, 0.52, -0.035], [0.06, 0.06, 0.04], light, FUR);
    push(out, m, 'sphere', [side * 0.36, -0.12, -0.08], [0.12, 0.2, 0.12], fur, FUR, rotationZ(side * 0.4)); // arms
    push(out, m, 'sphere', [side * 0.2, -0.52, -0.2], [0.14, 0.12, 0.2], fur, FUR); // legs
    push(out, m, 'sphere', [side * 0.2, -0.52, -0.39], [0.09, 0.08, 0.02], light, FUR); // paw pads
    push(out, m, 'cone', [side * 0.08, 0.03, -0.27], [0.06, 0.1, 0.035], bow, GLOSSY, rotationZ(side * Math.PI / 2)); // bow tie
  }
};

// --- Ducks and balls (the junk pile's, scaled up) ---------------------------------------------
const DUCK_SCALE = 2.4;
const BALL_SCALE = 1.5;

function scaled(model: BodyModel, s: number): BodyModel {
  const k = scaling([s, s, s]);
  return (out, m) => {
    const start = out.length;
    model(out, mul(m, k));
    for (let i = start; i < out.length; i++) if (out[i].pattern === undefined) out[i].pattern = Pattern.skin;
  };
}

/** Plush doesn't roll far: spin damping (1/s), so toys pile up instead of spreading out flat. */
const PLUSH_SPIN_DAMPING = 3;

/** Adds a plush toy to the physics world: light, bouncy and grabbable. */
export function spawnPlush(physics: Physics, kind: PlushKind, pos: Vec3, look: PlushLook, rotation?: Quat): Plush {
  const plush = makePlush(physics, kind, pos, look, rotation);
  plush.body.rb.setAngularDamping(PLUSH_SPIN_DAMPING);
  plush.body.angularDamping = PLUSH_SPIN_DAMPING;
  return plush;
}

function makePlush(physics: Physics, kind: PlushKind, pos: Vec3, look: PlushLook, rotation?: Quat): Plush {
  const bouncy = { restitution: 0.45, friction: 1.0, rotation };
  switch (kind) {
    case 'alien': {
      const body = physics.addCapsule(pos, ALIEN_R, ALIEN_LEN, { ...bouncy, mass: 3, model: alienModel(look) });
      return { kind, body, radius: 0.5 };
    }
    case 'teddy': {
      const i = Math.floor(Math.random() * TEDDY_COLORS.length);
      const [fur, light] = TEDDY_COLORS[i];
      const bow = BOW_COLORS[Math.floor(Math.random() * BOW_COLORS.length)];
      const body = physics.addCapsule(pos, TEDDY_R, TEDDY_LEN, { ...bouncy, mass: 4, model: teddyModel(fur, light, bow) });
      return { kind, body, radius: 0.62 };
    }
    case 'duck': {
      const r = 0.25 * DUCK_SCALE;
      const body = physics.addBall(pos, r, { ...bouncy, restitution: 0.55, mass: 2.5, model: scaled(junk('rubber duck').model, DUCK_SCALE) });
      return { kind, body, radius: r };
    }
    case 'ball': {
      const r = 0.35 * BALL_SCALE;
      const body = physics.addBall(pos, r, { ...bouncy, restitution: 0.7, mass: 1, model: scaled(junk('beach ball').model, BALL_SCALE) });
      return { kind, body, radius: r };
    }
  }
}
