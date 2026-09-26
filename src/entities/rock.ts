import { basis, cross, mul, normalize, scale, type Mat4, type Vec3 } from '../engine/math';
import type { BodyModel } from '../engine/physics';
import type { DrawItem } from '../engine/renderer';

/*
 * Natural-looking stone of any size: a lumpy core with flattened slabs pressed into its surface at
 * random angles, so it reads as a chipped, faceted rock rather than a ball. Each piece is a
 * slightly different shade. Built once; draw it as a physics body's model.
 */

const STONE = [0.42, 0.37, 0.3];

interface Part {
  local: Mat4;
  color: number[];
}

/**
 * A rock model roughly `radius` in size (it stays just inside a ball collider of that radius).
 * `facets` sets the detail (big boulders want 20+, pebbles 5 or so); `color` its base shade.
 */
export function rockModel(radius: number, facets: number, color: number[] = STONE): BodyModel {
  const parts: Part[] = [];
  const shade = (k: number) => color.map((c) => c * k);
  // A slightly squashed, off-centre core.
  parts.push({
    local: basis([radius * 0.86, 0, 0], [0, radius * (0.78 + Math.random() * 0.1), 0], [0, 0, radius * 0.84], [0, 0, 0]),
    color: shade(0.85),
  });
  for (let i = 0; i < facets; i++) {
    // Spread the slabs evenly-ish over the surface (a jittered Fibonacci sphere).
    const t = (i + 0.5) / facets;
    const lat = Math.acos(1 - 2 * t) + (Math.random() - 0.5) * 0.35;
    const lon = i * 2.39996 + (Math.random() - 0.5) * 0.6;
    const n: Vec3 = [Math.sin(lat) * Math.cos(lon), Math.cos(lat), Math.sin(lat) * Math.sin(lon)];
    // A slab lying flat against the surface there, spun randomly about its outward normal.
    const helper: Vec3 = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const a0 = normalize(cross(helper, n));
    const b0 = cross(n, a0);
    const spin = Math.random() * Math.PI * 2;
    const a: Vec3 = [
      a0[0] * Math.cos(spin) + b0[0] * Math.sin(spin),
      a0[1] * Math.cos(spin) + b0[1] * Math.sin(spin),
      a0[2] * Math.cos(spin) + b0[2] * Math.sin(spin),
    ];
    const b = cross(n, a);
    const wide = radius * (0.75 + Math.random() * 0.45);
    const thick = radius * (0.3 + Math.random() * 0.25);
    const deep = radius * (0.62 + Math.random() * 0.1);
    parts.push({
      local: basis(scale(a, wide), scale(n, thick), scale(b, wide * (0.7 + Math.random() * 0.4)), scale(n, deep)),
      color: shade(0.8 + Math.random() * 0.35),
    });
  }
  return (out: DrawItem[], m: Mat4) => {
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      out.push({ mesh: i === 0 ? 'sphere' : 'roundbox', model: mul(m, p.local), color: p.color, spec: 0.04 });
    }
  };
}
