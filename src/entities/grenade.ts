import { basis, cross, lerp, mul, normalize, rotationZ, scale, scaling, translation, type Mat4, type Vec3 } from '../engine/math';
import { Pattern, type DrawItem } from '../engine/renderer';

/** The usual olive drab. */
export const GRENADE_OLIVE = [0.13, 0.16, 0.06];

/**
 * A "pineapple" frag grenade: segmented olive body, fuse cap, spoon lever and a blinking light.
 * `m` places its centre; `s` scales it (1 = 0.16 m radius).
 */
export function drawPineapple(out: DrawItem[], m: Mat4, s: number, color: number[], lightOn: boolean) {
  const metal = [0.34, 0.35, 0.33];
  const dark = color.map((c) => c * 0.55);
  out.push({ mesh: 'sphere', model: mul(m, scaling([0.12 * s, 0.145 * s, 0.12 * s])), color: dark });
  // Rows of raised segments over an egg-shaped body.
  const rx = 0.128 * s, ry = 0.155 * s;
  for (let row = 0; row < 6; row++) {
    const lat = lerp(-1.05, 1.05, row / 5);
    for (let col = 0; col < 8; col++) {
      const lon = ((col + (row % 2) * 0.5) / 8) * Math.PI * 2;
      const n = normalize([Math.cos(lat) * Math.cos(lon) / rx, Math.sin(lat) / ry, Math.cos(lat) * Math.sin(lon) / rx]);
      const p: Vec3 = [Math.cos(lat) * Math.cos(lon) * rx, Math.sin(lat) * ry, Math.cos(lat) * Math.sin(lon) * rx];
      const east = normalize(cross([0, 1, 0], n));
      const north = cross(n, east);
      const size = 0.062 * s * (0.75 + 0.25 * Math.cos(lat));
      out.push({
        mesh: 'roundbox',
        model: mul(m, basis(scale(east, size), scale(north, 0.07 * s), scale(n, 0.035 * s), p)),
        color,
        spec: 0.25,
      });
    }
  }
  // Fuse assembly, spoon lever and the fuse light.
  out.push({ mesh: 'cylinder', model: mul(m, translation([0, 0.165 * s, 0]), scaling([0.045 * s, 0.06 * s, 0.045 * s])), color: metal, spec: 0.6 });
  out.push({ mesh: 'cylinder', model: mul(m, translation([0, 0.2 * s, 0]), scaling([0.032 * s, 0.03 * s, 0.032 * s])), color: metal, spec: 0.6 });
  out.push({
    mesh: 'box',
    model: mul(m, translation([0.075 * s, 0.1 * s, 0]), rotationZ(-0.22), scaling([0.022 * s, 0.19 * s, 0.05 * s])),
    color: metal,
    spec: 0.6,
  });
  out.push({
    mesh: 'sphere',
    model: mul(m, translation([0, 0.225 * s, 0]), scaling([0.028 * s, 0.028 * s, 0.028 * s])),
    color: lightOn ? [8, 0.4, 0.2] : [0.25, 0.03, 0.03],
    pattern: Pattern.emissive,
    shadow: false,
  });
}
