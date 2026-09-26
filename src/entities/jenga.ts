import {
  cross, mul, rotationX, rotationY, rotationZ, scaling, sub, toQuat, transformPoint, translation,
  type Mat4, type Vec3,
} from '../engine/math';
import { RAPIER, type Body, type Physics } from '../engine/physics';
import { Pattern, type DrawItem } from '../engine/renderer';

/*
 * A giant Jenga tower: layers of three wooden blocks, alternating directions (even layers run
 * along z, odd ones along x). It isn't simulated block by block while it stands (a real stack of
 * rigid boxes never leans, it just stands or falls). Instead it's a wobbly column with a lean
 * (`phi`, the tilt of the top toward +x and +z) that springs toward a target set by what's missing
 * (a layer leans toward the side it lost support on), the extra blocks stacked on top, and whatever
 * load the level adds (someone standing up there). The lean bends the tower most at its damaged
 * layers. Every block is a fixed collider moved along with it, so you can stand on it; `collapse`
 * turns them all into real physics boxes.
 */

/** Block size: across (x for an even layer), height, and length. */
export const BLOCK_W = 1.5;
export const BLOCK_H = 0.8;
export const BLOCK_L = 4.5;
/** Across offsets of a layer's three slots. */
export const SLOT_OFFSETS = [-BLOCK_W, 0, BLOCK_W];
/** Pale, warm hardwood. */
export const WOOD = [0.56, 0.36, 0.19];

/** Lean from a side block missing (rad per metre the layer's support centre moves). */
const BIAS_PER_M = 0.034 / 0.75;
/** Lean from blocks stacked on top off-centre (rad per metre of their offset). */
const PLACE_BIAS_PER_M = 0.008;
/** How wobbly: `gamma` 0 is stiff, toward 1 it amplifies every lean (1 / (1 - gamma)). */
const GAMMA_BASE = 0.12;
const GAMMA_PER_MISSING = 0.03;
const GAMMA_PER_LAYER = 0.025;
const GAMMA_PER_THIN = 0.05;
const GAMMA_MAX = 0.55;
/** Sway: natural frequency (rad/s, when stiff) and damping ratio. */
const OMEGA = 2.4;
const DAMPING = 0.38;
/** How much each layer bends: a baseline, more per missing block, and the base rocking on the floor. */
const BEND_BASE = 0.35;
const BEND_PER_MISSING = 1.0;
const BEND_FLOOR = 1.2;

export interface JengaBlock {
  seed: number;
  /** Which layer and slot it's in (-1: not in the tower, e.g. being carried). */
  layer: number;
  slot: number;
  /** How far it has slid out along its length (m, toward the pull side), and how far that counts as gone (0-1). */
  slide: number;
  out: number;
  /** A little shake (m), e.g. while being picked. */
  jiggle: number;
  /** Sits this much higher than it should (e.g. on top of someone it squashed). */
  raise: number;
  /** 0-1 glow (being picked). */
  glow: number;
  /** World transform while the level moves it (carried), otherwise null. */
  free: Mat4 | null;
  /** Its long axis along x (odd layers) rather than z; set when it's laid in a layer. */
  alongX: boolean;
  rb: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  /** After the collapse: its physics body. */
  body: Body | null;
  /** Its world transform as of the last update (no scale; local z is its long axis). */
  frame: Mat4;
}

export class JengaTower {
  /** Bottom centre of the tower (on the floor). `rise` lifts it out of the floor (negative = sunk). */
  readonly base: Vec3;
  rise = 0;
  /** Blocks by layer and slot (null = empty slot). */
  readonly layers: (JengaBlock | null)[][] = [];
  readonly blocks: JengaBlock[] = [];
  /** Lean of the top (rad toward +x, +z) and how fast it's changing. */
  phi: [number, number] = [0, 0];
  phiVel: [number, number] = [0, 0];
  /** Extra lean target from outside (e.g. someone's weight on top), before amplification. */
  load: [number, number] = [0, 0];
  /** Tipping over as a whole about its bottom east edge (the finale), rad. */
  tip = 0;
  /** Each layer's frame (origin at its bottom centre, tilted with the lean), recomputed by update(). */
  frames: Mat4[] = [];
  /** Smoothed bend share of each layer. */
  private bend: number[] = [];
  private time = 0;
  collapsed = false;

  constructor(private physics: Physics, base: Vec3, layerCount: number) {
    this.base = [...base];
    this.originalLayers = layerCount;
    for (let k = 0; k < layerCount; k++) {
      this.layers.push([null, null, null]);
      for (let j = 0; j < 3; j++) this.lay(this.makeBlock(), k, j);
    }
    this.update(0);
  }

  private makeBlock(): JengaBlock {
    const rb = this.physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const collider = this.physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(BLOCK_W / 2, BLOCK_H / 2, BLOCK_L / 2).setFriction(0.9),
      rb,
    );
    const b: JengaBlock = {
      seed: Math.random() * 60, layer: -1, slot: -1, slide: 0, out: 0, jiggle: 0, raise: 0, glow: 0, free: null, alongX: false,
      rb, collider, body: null, frame: translation([0, -50, 0]),
    };
    this.blocks.push(b);
    return b;
  }

  /** Puts a block in a slot (growing the tower by a layer if needed) and makes it solid. */
  lay(b: JengaBlock, layer: number, slot: number) {
    while (this.layers.length <= layer) this.layers.push([null, null, null]);
    this.layers[layer][slot] = b;
    b.layer = layer;
    b.slot = slot;
    b.slide = b.out = b.jiggle = b.raise = 0;
    b.free = null;
    b.alongX = layer % 2 === 1;
    // The collider is a box along z: an x-block is that turned a quarter.
    b.collider.setEnabled(true);
  }

  /** Takes a block out of the tower (the level carries it: set `free`). */
  unlay(b: JengaBlock) {
    if (b.layer >= 0) this.layers[b.layer][b.slot] = null;
    b.layer = b.slot = -1;
    b.collider.setEnabled(false);
  }

  /** The highest layer with anything in it. */
  topLayer() {
    for (let k = this.layers.length - 1; k >= 0; k--) if (this.layers[k].some((b) => b)) return k;
    return 0;
  }

  /** Whether a layer has all three blocks. */
  full(k: number) {
    return this.layers[k]?.every((b) => b && b.out < 0.5) ?? false;
  }

  /** Presence (0-1) of each slot of layer k, counting a block sliding out as partly gone. */
  presence(k: number): number[] {
    return this.layers[k].map((b) => (b ? 1 - b.out : 0));
  }

  /** Blocks gone from layer k (0-3), for layers that started full. */
  missing(k: number) {
    return this.presence(k).reduce((s, p) => s + (1 - p), 0);
  }

  /** The height the original, full layers reach: layers above are the added ones. */
  originalLayers = 0;

  /**
   * The lean the missing blocks and the extra blocks on top push toward (before amplification
   * and outside loads), as [x, z].
   */
  bias(): [number, number] {
    const out: [number, number] = [0, 0];
    const top = this.topLayer();
    this.layers.forEach((row, k) => {
      const axis = k % 2 === 0 ? 0 : 1; // even layers: blocks along z, spread along x
      const pres = this.presence(k);
      const sum = pres[0] + pres[1] + pres[2];
      if (sum < 1e-3) return;
      if (k >= this.originalLayers || k === top) {
        // Stacked on top: their weight off-centre.
        for (let j = 0; j < 3; j++) out[axis] += pres[j] * SLOT_OFFSETS[j] * PLACE_BIAS_PER_M;
        return;
      }
      const centroid = (pres[0] * SLOT_OFFSETS[0] + pres[1] * SLOT_OFFSETS[1] + pres[2] * SLOT_OFFSETS[2]) / sum;
      out[axis] += -centroid * BIAS_PER_M;
      void row;
    });
    return out;
  }

  /** How wobbly it is now (see GAMMA_*). */
  gamma() {
    let missing = 0, thin = 0;
    for (let k = 0; k < Math.min(this.originalLayers, this.layers.length); k++) {
      const m = this.missing(k);
      missing += m;
      if (m > 1.5) thin++;
    }
    const added = Math.max(0, this.layers.length - this.originalLayers);
    return Math.min(GAMMA_MAX, GAMMA_BASE + GAMMA_PER_MISSING * missing + GAMMA_PER_LAYER * added + GAMMA_PER_THIN * thin);
  }

  /** What the lean is heading for right now. */
  target(): [number, number] {
    const b = this.bias(), a = 1 / (1 - this.gamma());
    const idle = 0.005;
    return [
      a * (b[0] + this.load[0] + idle * Math.sin(this.time * 0.7)),
      a * (b[1] + this.load[1] + idle * Math.cos(this.time * 0.53)),
    ];
  }

  /** A shove to the sway (rad/s). */
  kick(vx: number, vz: number) {
    this.phiVel[0] += vx;
    this.phiVel[1] += vz;
  }

  /** How far it leans (rad). */
  leanAmount() {
    return Math.hypot(this.phi[0], this.phi[1]);
  }

  update(dt: number) {
    this.time += dt;
    if (dt > 0 && !this.collapsed) {
      const tgt = this.target();
      const w = OMEGA * Math.sqrt(1 - this.gamma());
      // Semi-implicit, in small steps so a long frame can't blow it up.
      const n = Math.max(1, Math.ceil(dt / (1 / 120)));
      const h = dt / n;
      for (let s = 0; s < n; s++) {
        for (let i = 0; i < 2; i++) {
          this.phiVel[i] += (w * w * (tgt[i] - this.phi[i]) - 2 * DAMPING * w * this.phiVel[i]) * h;
          this.phi[i] += this.phiVel[i] * h;
        }
      }
    }
    // Bend shares: more at the damaged layers, and some at the base rocking on the floor.
    const count = this.layers.length;
    let total = 0;
    const want: number[] = [];
    for (let k = 0; k < count; k++) {
      const m = k < this.originalLayers ? this.missing(k) : 0;
      const w = BEND_BASE + BEND_PER_MISSING * m + (k === 0 ? BEND_FLOOR : 0);
      want.push(w);
      total += w;
    }
    const kb = dt > 0 ? 1 - Math.exp(-dt * 2) : 1;
    for (let k = 0; k < count; k++) {
      const target = want[k] / total;
      this.bend[k] = this.bend[k] === undefined ? target : this.bend[k] + (target - this.bend[k]) * kb;
    }
    this.computeFrames();
    if (!this.collapsed) this.moveColliders();
  }

  /** The finale's tip: about the bottom east edge (x = base + half a block length). */
  pivot(): Vec3 {
    return [this.base[0] + BLOCK_L / 2, this.base[1], this.base[2]];
  }

  private computeFrames() {
    const p = this.pivot();
    let f = mul(
      translation(p), rotationZ(-this.tip), translation([-p[0], -p[1], -p[2]]),
      translation([this.base[0], this.base[1] + this.rise, this.base[2]]),
    );
    this.frames.length = 0;
    for (let k = 0; k < this.layers.length; k++) {
      const s = this.bend[k] ?? 0;
      if (k > 0) f = mul(f, translation([0, BLOCK_H, 0]));
      f = mul(f, rotationZ(-this.phi[0] * s), rotationX(this.phi[1] * s));
      this.frames.push(f);
    }
  }

  /** A block's world transform (no scale; its local z is its long axis), worked out afresh. */
  blockFrame(b: JengaBlock): Mat4 {
    if (b.free) return b.free;
    if (b.layer < 0) return b.frame;
    const f = this.frames[b.layer];
    const off = SLOT_OFFSETS[b.slot];
    const j = b.jiggle;
    // Even layers run along z and slide out toward +z (south); odd ones run along x and slide out
    // toward -x (west).
    return b.alongX
      ? mul(f, translation([-b.slide + j, BLOCK_H / 2 + b.raise, off]), rotationY(-Math.PI / 2))
      : mul(f, translation([off, BLOCK_H / 2 + b.raise, b.slide + j]));
  }

  private moveColliders() {
    for (const b of this.blocks) {
      if (b.body) continue;
      const m = (b.frame = this.blockFrame(b));
      b.rb.setTranslation({ x: m[12], y: m[13], z: m[14] }, false);
      b.rb.setRotation(toQuat(m), false);
    }
  }

  /** A point in layer k's frame (x, y above its bottom, z) in the world. */
  point(k: number, local: Vec3): Vec3 {
    const f = this.frames[Math.max(0, Math.min(this.frames.length - 1, k))];
    return transformPoint(f, local);
  }

  /** The top surface's height at the tower's axis, over layer k (its top). */
  topOf(k: number): number {
    return this.point(k, [0, BLOCK_H, 0])[1];
  }

  /** Where a world point is in layer k's frame (inverse of `point`, for rigid frames). */
  toLocal(k: number, p: Vec3): Vec3 {
    const f = this.frames[Math.max(0, Math.min(this.frames.length - 1, k))];
    const d = sub(p, [f[12], f[13], f[14]]);
    return [
      d[0] * f[0] + d[1] * f[1] + d[2] * f[2],
      d[0] * f[4] + d[1] * f[5] + d[2] * f[6],
      d[0] * f[8] + d[1] * f[9] + d[2] * f[10],
    ];
  }

  /**
   * Turns every block into a real physics box (the tower's, and one being carried, which is just
   * let go of), moving as if the whole tower were turning at `spin` (rad/s, world) about `about`,
   * plus a random `scatter` (m/s, rad/s; more the higher up) so it comes apart. `groups` sets their
   * collision groups.
   */
  collapse(spin: Vec3, about: Vec3, groups?: number, scatter = 0.4) {
    if (this.collapsed) return;
    this.collapsed = true;
    const height = Math.max(1, this.layers.length * BLOCK_H);
    for (const b of this.blocks) {
      const inTower = b.layer >= 0;
      const m = inTower ? this.blockFrame(b) : b.free ?? b.frame;
      const pos: Vec3 = [m[12], m[13], m[14]];
      this.physics.world.removeRigidBody(b.rb);
      const seed = b.seed;
      const body = this.physics.addBox(pos, [BLOCK_W, BLOCK_H * 0.97, BLOCK_L], {
        mass: 140,
        rotation: toQuat(m),
        friction: 0.45,
        restitution: 0.08,
        grabbable: false,
        model: (out, bm) => drawBlock(out, bm, seed),
      });
      if (groups !== undefined) body.collider.setCollisionGroups(groups);
      if (inTower) {
        const v = cross(spin, sub(pos, about));
        const s = scatter * Math.min(1, (pos[1] - this.base[1]) / height + 0.2);
        const r = () => (Math.random() - 0.5) * 2 * s;
        body.rb.setLinvel({ x: v[0] + r(), y: v[1] + Math.abs(r()) * 0.5, z: v[2] + r() }, true);
        body.rb.setAngvel({ x: spin[0] + r(), y: r(), z: spin[2] + r() }, true);
        this.layers[b.layer][b.slot] = null;
      }
      b.body = body;
      b.free = null;
    }
  }

  draw(out: DrawItem[]) {
    for (const b of this.blocks) {
      if (b.body) continue; // physics draws it
      const first = out.length;
      drawBlock(out, b.free ?? b.frame, b.seed);
      if (b.glow > 0) for (let i = first; i < out.length; i++) out[i].highlight = b.glow;
    }
  }
}

/** One block, in a frame whose local z is its long axis. */
export function drawBlock(out: DrawItem[], m: Mat4, seed: number) {
  out.push({ mesh: 'box', model: mul(m, scaling([BLOCK_W, BLOCK_H, BLOCK_L])), color: WOOD, pattern: Pattern.wood, param: seed, spec: 0.12 });
}
