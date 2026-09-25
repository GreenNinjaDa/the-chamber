// Small vector / matrix library. Matrices are column-major (m[col * 4 + row]),
// projection matrices target WebGPU clip space (z in [0, 1]).
export type Vec3 = [number, number, number];
export type Mat4 = Float32Array;

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const length = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
export const normalize = (a: Vec3): Vec3 => {
  const l = length(a);
  return l > 1e-8 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [
  lerp(a[0], b[0], t),
  lerp(a[1], b[1], t),
  lerp(a[2], b[2], t),
];
export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
export const distXZ = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[2] - b[2]);
export const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/** Moves angle `a` toward `b` along the shortest arc by fraction `t`. */
export function approachAngle(a: number, b: number, t: number) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * Math.min(1, t);
}

export function identity(): Mat4 {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

export function translation(v: Vec3): Mat4 {
  const m = identity();
  m[12] = v[0];
  m[13] = v[1];
  m[14] = v[2];
  return m;
}

export function scaling(v: Vec3): Mat4 {
  const m = identity();
  m[0] = v[0];
  m[5] = v[1];
  m[10] = v[2];
  return m;
}

export function rotationX(a: number): Mat4 {
  const c = Math.cos(a), s = Math.sin(a);
  return new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]);
}

export function rotationY(a: number): Mat4 {
  const c = Math.cos(a), s = Math.sin(a);
  return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]);
}

export function rotationZ(a: number): Mat4 {
  const c = Math.cos(a), s = Math.sin(a);
  return new Float32Array([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = sum;
    }
  return out;
}

/** mul(A, B, C) = A * B * C */
export function mul(...ms: Mat4[]): Mat4 {
  let out = ms[0];
  for (let i = 1; i < ms.length; i++) out = multiply(out, ms[i]);
  return out;
}

export function transformPoint(m: Mat4, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14],
  ];
}

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** Rotation from a unit quaternion followed by a translation. */
export function fromQuat(q: Quat, t: Vec3): Mat4 {
  const { x, y, z, w } = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return new Float32Array([
    1 - (yy + zz), xy + wz, xz - wy, 0,
    xy - wz, 1 - (xx + zz), yz + wx, 0,
    xz + wy, yz - wx, 1 - (xx + yy), 0,
    t[0], t[1], t[2], 1,
  ]);
}

/** Rotates `v` by the unit quaternion `q`. */
export function rotateByQuat(q: Quat, v: Vec3): Vec3 {
  const u: Vec3 = [q.x, q.y, q.z];
  const t = scale(cross(u, v), 2);
  return add(add(v, scale(t, q.w)), cross(u, t));
}

/** Matrix whose columns are the given axes and translation. */
export function basis(x: Vec3, y: Vec3, z: Vec3, t: Vec3): Mat4 {
  return new Float32Array([
    x[0], x[1], x[2], 0,
    y[0], y[1], y[2], 0,
    z[0], z[1], z[2], 0,
    t[0], t[1], t[2], 1,
  ]);
}

/** Maps the unit cylinder (radius 1, y in [-0.5, 0.5]) onto the segment a -> b. */
export function segment(a: Vec3, b: Vec3, radius: number): Mat4 {
  const d = sub(b, a);
  const y = normalize(d);
  const helper: Vec3 = Math.abs(y[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0];
  const x = normalize(cross(helper, y));
  const z = cross(x, y);
  return basis(scale(x, radius), d, scale(z, radius), lerp3(a, b, 0.5));
}

export function perspective(fovY: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovY / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = far / (near - far);
  m[11] = -1;
  m[14] = (far * near) / (near - far);
  return m;
}

export function ortho(l: number, r: number, b: number, t: number, n: number, f: number): Mat4 {
  const m = identity();
  m[0] = 2 / (r - l);
  m[5] = 2 / (t - b);
  m[10] = 1 / (n - f);
  m[12] = -(r + l) / (r - l);
  m[13] = -(t + b) / (t - b);
  m[14] = n / (n - f);
  return m;
}

export function lookAt(eye: Vec3, target: Vec3, up: Vec3): Mat4 {
  const z = normalize(sub(eye, target));
  const x = normalize(cross(up, z));
  const y = cross(z, x);
  return new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
  ]);
}

/** Inverse-transpose of the upper 3x3, padded to a mat4 (for transforming normals). */
export function normalMatrix(m: Mat4): Mat4 {
  const a00 = m[0], a10 = m[1], a20 = m[2];
  const a01 = m[4], a11 = m[5], a21 = m[6];
  const a02 = m[8], a12 = m[9], a22 = m[10];
  const c00 = a11 * a22 - a12 * a21;
  const c01 = -(a10 * a22 - a12 * a20);
  const c02 = a10 * a21 - a11 * a20;
  const c10 = -(a01 * a22 - a02 * a21);
  const c11 = a00 * a22 - a02 * a20;
  const c12 = -(a00 * a21 - a01 * a20);
  const c20 = a01 * a12 - a02 * a11;
  const c21 = -(a00 * a12 - a02 * a10);
  const c22 = a00 * a11 - a01 * a10;
  const det = a00 * c00 + a01 * c01 + a02 * c02;
  const s = Math.abs(det) > 1e-12 ? 1 / det : 0;
  return new Float32Array([
    c00 * s, c10 * s, c20 * s, 0,
    c01 * s, c11 * s, c21 * s, 0,
    c02 * s, c12 * s, c22 * s, 0,
    0, 0, 0, 1,
  ]);
}
