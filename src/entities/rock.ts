import { add, basis, cross, mul, normalize, scale, scaling, type Mat4, type Vec3 } from '../engine/math';
import type { BodyModel } from '../engine/physics';
import { Pattern, type DrawItem } from '../engine/renderer';

/*
 * Stone, with the rock texture (Pattern.rock: speckled grain and dark cracks, fixed to the object
 * so it turns as it rolls). Two shapes: a big, almost-round boulder, and odd-shaped chunks built
 * from a few overlapping bevelled blocks. Build once; draw as a physics body's model.
 */

/** Rock colours to pick from: greys and browns. */
export const STONE_COLORS = [
  [0.46, 0.42, 0.36], [0.4, 0.37, 0.33], [0.5, 0.45, 0.37], [0.36, 0.34, 0.31], [0.44, 0.38, 0.3],
];

interface Part {
  mesh: 'sphere' | 'roundbox' | 'bevelbox';
  local: Mat4;
  color: number[];
  /** Rock texture feature size (per unit of the mesh). */
  grain: number;
}

const draw = (parts: Part[]): BodyModel => (out: DrawItem[], m: Mat4) => {
  for (const p of parts) {
    out.push({ mesh: p.mesh, model: mul(m, p.local), color: p.color, pattern: Pattern.rock, param: p.grain, spec: 0.05 });
  }
};

/**
 * A rough, chipped boulder of about `radius` (it stays just inside a ball collider that size): a
 * lumpy core with flattened slabs pressed into its surface at random angles. `facets` sets the
 * detail (20+ for a big boulder).
 */
export function boulderModel(radius: number, color: number[] = STONE_COLORS[0], facets = 24): BodyModel {
  const shade = (k: number) => color.map((c) => c * k);
  const parts: Part[] = [{
    mesh: 'sphere',
    local: scaling([radius * 0.86, radius * (0.78 + Math.random() * 0.1), radius * 0.84]),
    color: shade(0.9),
    grain: 3,
  }];
  for (let i = 0; i < facets; i++) {
    // Spread the slabs evenly-ish over the surface (a jittered Fibonacci sphere).
    const t = (i + 0.5) / facets;
    const lat = Math.acos(1 - 2 * t) + (Math.random() - 0.5) * 0.35;
    const lon = i * 2.39996 + (Math.random() - 0.5) * 0.6;
    const n: Vec3 = [Math.sin(lat) * Math.cos(lon), Math.cos(lat), Math.sin(lat) * Math.sin(lon)];
    // A slab lying flat against the surface there, spun randomly about its outward normal. The
    // axes (a, n, b) must be right-handed, or the slab is mirrored inside out and shows through.
    const helper: Vec3 = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const a0 = normalize(cross(helper, n));
    const b0 = cross(a0, n);
    const spin = Math.random() * Math.PI * 2;
    const a = add(scale(a0, Math.cos(spin)), scale(b0, Math.sin(spin)));
    const b = cross(a, n);
    const wide = radius * (0.75 + Math.random() * 0.45);
    const thick = radius * (0.3 + Math.random() * 0.25);
    const deep = radius * (0.62 + Math.random() * 0.1);
    parts.push({
      mesh: 'roundbox',
      local: basis(scale(a, wide), scale(n, thick), scale(b, wide * (0.7 + Math.random() * 0.4)), scale(n, deep)),
      color: shade(0.8 + Math.random() * 0.35),
      grain: 1.2,
    });
  }
  return draw(parts);
}

/**
 * An odd-shaped chunk of rock filling roughly a `size` box (its collider): a main block and a
 * couple of smaller ones jutting out of it at angles, all bevelled.
 */
export function chunkModel(size: Vec3, color: number[] = STONE_COLORS[0]): BodyModel {
  const shade = (k: number) => color.map((c) => c * k);
  const parts: Part[] = [{ mesh: 'bevelbox', local: scaling([size[0] * 0.95, size[1] * 0.9, size[2] * 0.95]), color, grain: 2.5 }];
  const extra = 2 + Math.floor(Math.random() * 2);
  for (let i = 0; i < extra; i++) {
    const s: Vec3 = [size[0] * (0.45 + Math.random() * 0.3), size[1] * (0.5 + Math.random() * 0.4), size[2] * (0.45 + Math.random() * 0.3)];
    // Offset toward a random corner, but kept inside the collider box.
    const o: Vec3 = [0, 1, 2].map((k) => (Math.random() - 0.5) * (size[k] - s[k]) * 0.9) as Vec3;
    const a = Math.random() * Math.PI, b = (Math.random() - 0.5) * 0.5;
    // A right-handed rotation (yaw a, then a little tilt b), so the faces point outward.
    const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
    const x: Vec3 = [ca, 0, -sa];
    const y: Vec3 = [sa * sb, cb, ca * sb];
    const z: Vec3 = [sa * cb, -sb, ca * cb];
    const k = 0.75; // shrink a little so a turned block stays inside the box
    parts.push({
      mesh: 'bevelbox',
      local: basis([x[0] * s[0] * k, x[1] * s[0] * k, x[2] * s[0] * k], [y[0] * s[1], y[1] * s[1], y[2] * s[1]], [z[0] * s[2] * k, z[1] * s[2] * k, z[2] * s[2] * k], o),
      color: shade(0.85 + Math.random() * 0.25),
      grain: 2.5,
    });
  }
  return draw(parts);
}
