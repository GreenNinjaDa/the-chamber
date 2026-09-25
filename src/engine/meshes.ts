// Procedural primitive meshes. Vertices are interleaved position (3) + normal (3).
// Front faces are counter-clockwise when seen from outside.
export interface MeshData {
  vertices: Float32Array<ArrayBuffer>;
  indices: Uint16Array<ArrayBuffer>;
}

class Builder {
  v: number[] = [];
  i: number[] = [];
  vert(px: number, py: number, pz: number, nx: number, ny: number, nz: number) {
    this.v.push(px, py, pz, nx, ny, nz);
    return this.v.length / 6 - 1;
  }
  tri(a: number, b: number, c: number) {
    this.i.push(a, b, c);
  }
  build(): MeshData {
    return { vertices: new Float32Array(this.v), indices: new Uint16Array(this.i) };
  }
}

/** Unit cube centred on the origin, [-0.5, 0.5] on each axis. */
export function box(): MeshData {
  const b = new Builder();
  const faces = [
    { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
    { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
    { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
    { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
    { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
    { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
  ];
  for (const { n, u, v } of faces) {
    const idx = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, c]) =>
      b.vert(
        (n[0] + a * u[0] + c * v[0]) * 0.5,
        (n[1] + a * u[1] + c * v[1]) * 0.5,
        (n[2] + a * u[2] + c * v[2]) * 0.5,
        n[0], n[1], n[2],
      ),
    );
    b.tri(idx[0], idx[1], idx[2]);
    b.tri(idx[0], idx[2], idx[3]);
  }
  return b.build();
}

/** Unit sphere (radius 1). */
export function sphere(segments = 24, rings = 16): MeshData {
  const b = new Builder();
  for (let i = 0; i <= rings; i++) {
    const theta = (i / rings) * Math.PI;
    for (let j = 0; j <= segments; j++) {
      const phi = (j / segments) * Math.PI * 2;
      const x = Math.sin(theta) * Math.cos(phi);
      const y = Math.cos(theta);
      const z = Math.sin(theta) * Math.sin(phi);
      b.vert(x, y, z, x, y, z);
    }
  }
  const row = segments + 1;
  for (let i = 0; i < rings; i++)
    for (let j = 0; j < segments; j++) {
      const a = i * row + j;
      const c = a + row;
      b.tri(a, a + 1, c);
      b.tri(a + 1, c + 1, c);
    }
  return b.build();
}

/** Capped cylinder, radius 1, y in [-0.5, 0.5]. */
export function cylinder(segments = 32): MeshData {
  const b = new Builder();
  for (let j = 0; j <= segments; j++) {
    const phi = (j / segments) * Math.PI * 2;
    const c = Math.cos(phi), s = Math.sin(phi);
    b.vert(c, -0.5, s, c, 0, s);
    b.vert(c, 0.5, s, c, 0, s);
  }
  for (let j = 0; j < segments; j++) {
    const bot = j * 2, top = j * 2 + 1, bot2 = (j + 1) * 2, top2 = (j + 1) * 2 + 1;
    b.tri(bot, top, bot2);
    b.tri(top, top2, bot2);
  }
  capRing(b, segments, 0.5, 1);
  capRing(b, segments, -0.5, -1);
  return b.build();
}

/** Cone with base radius 1 at y = -0.5 and apex at y = 0.5. */
export function cone(segments = 24): MeshData {
  const b = new Builder();
  const k = 1 / Math.SQRT2;
  for (let j = 0; j < segments; j++) {
    const p0 = (j / segments) * Math.PI * 2;
    const p1 = ((j + 1) / segments) * Math.PI * 2;
    const pm = (p0 + p1) / 2;
    const b0 = b.vert(Math.cos(p0), -0.5, Math.sin(p0), Math.cos(p0) * k, k, Math.sin(p0) * k);
    const apex = b.vert(0, 0.5, 0, Math.cos(pm) * k, k, Math.sin(pm) * k);
    const b1 = b.vert(Math.cos(p1), -0.5, Math.sin(p1), Math.cos(p1) * k, k, Math.sin(p1) * k);
    b.tri(b0, apex, b1);
  }
  capRing(b, segments, -0.5, -1);
  return b.build();
}

/**
 * A wedge (like a slice of cake): the sector of a unit cylinder between angles 0 and `angle`
 * (radians, measured from +x toward +z), y in [-0.5, 0.5], with its point on the y axis.
 */
export function wedge(angle = Math.PI / 4, segments = 8): MeshData {
  const b = new Builder();
  const at = (j: number) => (j / segments) * angle;
  // Curved outer side.
  for (let j = 0; j < segments; j++) {
    const p0 = at(j), p1 = at(j + 1);
    const q = [p0, p1].flatMap((p) => [
      b.vert(Math.cos(p), -0.5, Math.sin(p), Math.cos(p), 0, Math.sin(p)),
      b.vert(Math.cos(p), 0.5, Math.sin(p), Math.cos(p), 0, Math.sin(p)),
    ]);
    b.tri(q[0], q[1], q[2]);
    b.tri(q[1], q[3], q[2]);
  }
  // Top and bottom fans.
  for (const y of [0.5, -0.5]) {
    const c = b.vert(0, y, 0, 0, Math.sign(y), 0);
    for (let j = 0; j < segments; j++) {
      const a0 = b.vert(Math.cos(at(j)), y, Math.sin(at(j)), 0, Math.sign(y), 0);
      const a1 = b.vert(Math.cos(at(j + 1)), y, Math.sin(at(j + 1)), 0, Math.sign(y), 0);
      if (y > 0) b.tri(c, a1, a0);
      else b.tri(c, a0, a1);
    }
  }
  // The two flat cut faces.
  for (const [p, n] of [[0, [0, 0, -1]], [angle, [-Math.sin(angle), 0, Math.cos(angle)]]] as [number, number[]][]) {
    const c0 = b.vert(0, -0.5, 0, n[0], n[1], n[2]);
    const c1 = b.vert(0, 0.5, 0, n[0], n[1], n[2]);
    const e0 = b.vert(Math.cos(p), -0.5, Math.sin(p), n[0], n[1], n[2]);
    const e1 = b.vert(Math.cos(p), 0.5, Math.sin(p), n[0], n[1], n[2]);
    if (p === 0) {
      b.tri(c0, e1, e0);
      b.tri(c0, c1, e1);
    } else {
      b.tri(c0, e0, e1);
      b.tri(c0, e1, c1);
    }
  }
  return b.build();
}

function capRing(b: Builder, segments: number, y: number, dir: 1 | -1) {
  const center = b.vert(0, y, 0, 0, dir, 0);
  const first = b.v.length / 6;
  for (let j = 0; j <= segments; j++) {
    const phi = (j / segments) * Math.PI * 2;
    b.vert(Math.cos(phi), y, Math.sin(phi), 0, dir, 0);
  }
  for (let j = 0; j < segments; j++) {
    if (dir > 0) b.tri(center, first + j + 1, first + j);
    else b.tri(center, first + j, first + j + 1);
  }
}

/**
 * Unit box with rounded edges and corners (a superellipsoid, |x|^n + |y|^n + |z|^n = 1),
 * spanning [-0.5, 0.5]. Lower `n` is rounder; ~4 reads as a soft-cornered box.
 */
export function roundBox(n = 4, res = 10): MeshData {
  const b = new Builder();
  const faces = [
    { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
    { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
    { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
    { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
    { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
    { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
  ];
  for (const f of faces) {
    const first = b.v.length / 6;
    for (let i = 0; i <= res; i++)
      for (let j = 0; j <= res; j++) {
        const a = (i / res) * 2 - 1, c = (j / res) * 2 - 1;
        const d = [0, 1, 2].map((k) => f.n[k] + a * f.u[k] + c * f.v[k]);
        const len = Math.hypot(d[0], d[1], d[2]);
        const dir = d.map((x) => x / len);
        const r = Math.pow(dir.reduce((s, x) => s + Math.pow(Math.abs(x), n), 0), -1 / n);
        const p = dir.map((x) => x * r);
        const g = p.map((x) => Math.sign(x) * Math.pow(Math.abs(x), n - 1));
        const gl = Math.hypot(g[0], g[1], g[2]) || 1;
        b.vert(p[0] * 0.5, p[1] * 0.5, p[2] * 0.5, g[0] / gl, g[1] / gl, g[2] / gl);
      }
    for (let i = 0; i < res; i++)
      for (let j = 0; j < res; j++) {
        const a = first + i * (res + 1) + j;
        const c = a + res + 1;
        b.tri(a, c, c + 1);
        b.tri(a, c + 1, a + 1);
      }
  }
  return b.build();
}

/**
 * Square plate [-0.5, 0.5]² in the XY plane, z in [-0.5, 0.5], with a round hole of radius
 * `ratio` through it (the hole's inside surface is included; the plate's outer edges are not,
 * since it's meant to sit flush inside a wall opening).
 */
export function holePlate(ratio = 0.35, segments = 32): MeshData {
  const b = new Builder();
  const ring = (z: number, nz: number) => {
    const inner: number[] = [], outer: number[] = [];
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      const k = 0.5 / Math.max(Math.abs(c), Math.abs(s));
      inner.push(b.vert(c * ratio, s * ratio, z, 0, 0, nz));
      outer.push(b.vert(c * k, s * k, z, 0, 0, nz));
    }
    return { inner, outer };
  };
  const front = ring(0.5, 1);
  const back = ring(-0.5, -1);
  for (let i = 0; i < segments; i++) {
    b.tri(front.inner[i], front.outer[i], front.outer[i + 1]);
    b.tri(front.inner[i], front.outer[i + 1], front.inner[i + 1]);
    b.tri(back.inner[i], back.outer[i + 1], back.outer[i]);
    b.tri(back.inner[i], back.inner[i + 1], back.outer[i + 1]);
  }
  // Inside of the hole, facing the axis.
  const f: number[] = [], k: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const c = Math.cos(a), s = Math.sin(a);
    f.push(b.vert(c * ratio, s * ratio, 0.5, -c, -s, 0));
    k.push(b.vert(c * ratio, s * ratio, -0.5, -c, -s, 0));
  }
  for (let i = 0; i < segments; i++) {
    b.tri(f[i], f[i + 1], k[i + 1]);
    b.tri(f[i], k[i + 1], k[i]);
  }
  return b.build();
}

/** Hollow cylinder along y (radius 1, inner radius `inner`, y in [-0.5, 0.5]) with annular caps. */
export function tube(inner = 0.5, segments = 32): MeshData {
  const b = new Builder();
  const oBot: number[] = [], oTop: number[] = [], iBot: number[] = [], iTop: number[] = [];
  for (let j = 0; j <= segments; j++) {
    const a = (j / segments) * Math.PI * 2;
    const c = Math.cos(a), s = Math.sin(a);
    oBot.push(b.vert(c, -0.5, s, c, 0, s));
    oTop.push(b.vert(c, 0.5, s, c, 0, s));
    iBot.push(b.vert(c * inner, -0.5, s * inner, -c, 0, -s));
    iTop.push(b.vert(c * inner, 0.5, s * inner, -c, 0, -s));
  }
  const capTop = { o: [] as number[], i: [] as number[] }, capBot = { o: [] as number[], i: [] as number[] };
  for (let j = 0; j <= segments; j++) {
    const a = (j / segments) * Math.PI * 2;
    const c = Math.cos(a), s = Math.sin(a);
    capTop.o.push(b.vert(c, 0.5, s, 0, 1, 0));
    capTop.i.push(b.vert(c * inner, 0.5, s * inner, 0, 1, 0));
    capBot.o.push(b.vert(c, -0.5, s, 0, -1, 0));
    capBot.i.push(b.vert(c * inner, -0.5, s * inner, 0, -1, 0));
  }
  for (let j = 0; j < segments; j++) {
    b.tri(oBot[j], oTop[j], oBot[j + 1]);
    b.tri(oTop[j], oTop[j + 1], oBot[j + 1]);
    b.tri(iBot[j], iBot[j + 1], iTop[j]);
    b.tri(iTop[j], iBot[j + 1], iTop[j + 1]);
    b.tri(capTop.i[j], capTop.o[j + 1], capTop.o[j]);
    b.tri(capTop.i[j], capTop.i[j + 1], capTop.o[j + 1]);
    b.tri(capBot.i[j], capBot.o[j], capBot.o[j + 1]);
    b.tri(capBot.i[j], capBot.o[j + 1], capBot.i[j + 1]);
  }
  return b.build();
}
