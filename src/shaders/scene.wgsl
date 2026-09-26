struct Frame {
  viewProj: mat4x4f,
  lightViewProj: mat4x4f,
  sunDir: vec4f,      // xyz: direction toward the sun; w: height of a glowing surface lighting from below (-1e4: none)
  sunColor: vec4f,
  skyColor: vec4f,
  groundColor: vec4f,
  fogColor: vec4f,    // w: fog density
  camPos: vec4f,      // w: time
  pointPos: vec4f,    // a point light (torch): xyz position, w: range (0: none)
  pointColor: vec4f,
};

struct Object {
  model: mat4x4f,
  normalMat: mat4x4f,
  color: vec4f,
  params: vec4f,      // x: pattern, y: pattern parameter, z: specular strength, w: highlight
  clipMin: vec4f,     // world-space clip box for decals; w > 0.5 enables it
  clipMax: vec4f,
};

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var shadowMap: texture_depth_2d;
@group(0) @binding(2) var shadowSampler: sampler_comparison;
@group(1) @binding(0) var<uniform> obj: Object;

// Pattern ids (keep in sync with Pattern in renderer.ts).
const PAT_PANELS = 1;
/** Half-width (m) of the sun's shadow map; must match SHADOW_EXTENT in renderer.ts. */
const SHADOW_EXTENT = 88.0;
const PAT_DARTBOARD = 2;
const PAT_BLOB = 3;
const PAT_EMISSIVE = 4;
const PAT_SKIN = 5;
const PAT_SKY = 6;
const PAT_PORTAL = 7;
const PAT_LAVA = 8;
const PAT_ROCK = 9;

struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) worldPos: vec3f,
  @location(1) normal: vec3f,
  @location(2) localPos: vec3f,
  @location(3) localNormal: vec3f,
};

@vertex
fn vs(@location(0) position: vec3f, @location(1) normal: vec3f) -> VsOut {
  let world = obj.model * vec4f(position, 1.0);
  var out: VsOut;
  out.pos = frame.viewProj * world;
  out.worldPos = world.xyz;
  out.normal = (obj.normalMat * vec4f(normal, 0.0)).xyz;
  out.localPos = position;
  out.localNormal = normal;
  return out;
}

fn hash2(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}

fn tonemap(c: vec3f) -> vec3f {
  // ACES filmic approximation, then gamma for the non-sRGB swapchain.
  let m = clamp((c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
  return pow(m, vec3f(1.0 / 2.2));
}

fn shadowFactor(worldPos: vec3f, n: vec3f) -> f32 {
  let lp = frame.lightViewProj * vec4f(worldPos + n * 0.06, 1.0);
  let ndc = lp.xyz / lp.w;
  let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || ndc.z > 1.0) {
    return 1.0;
  }
  if (frame.sunDir.w > -1000.0) {
    return areaShadow(uv, ndc.z, max(worldPos.y - frame.sunDir.w, 0.0));
  }
  let texel = 1.0 / f32(textureDimensions(shadowMap).x);
  var sum = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let o = vec2f(f32(x), f32(y)) * texel * 1.5;
      sum += textureSampleCompareLevel(shadowMap, shadowSampler, uv + o, ndc.z - 0.0003);
    }
  }
  return sum / 9.0;
}

// Lit from a whole glowing surface rather than a point: sample the shadow map over a wide disc
// that grows with height above the surface, so things far above an occluder only get a soft,
// faint darkening instead of a crisp silhouette.
fn areaShadow(uv: vec2f, depth: f32, above: f32) -> f32 {
  let radius = (0.2 + above * 0.05) / (2.0 * SHADOW_EXTENT); // metres -> shadow-map uv
  var sum = 0.0;
  for (var k = 0; k < 32; k++) {
    let fk = f32(k);
    let r = sqrt((fk + 0.5) / 32.0) * radius;
    let a = fk * 2.39996; // golden angle: an even spread over the disc
    sum += textureSampleCompareLevel(shadowMap, shadowSampler, uv + vec2f(cos(a), sin(a)) * r, depth - 0.0003);
  }
  // Only ever a gentle shading: the rest of the glowing surface still lights around the occluder.
  return mix(1.0, sum / 32.0, 0.5);
}

// Test-chamber panels: a world-space grid with dark seams.
fn panelColor(base: vec3f, worldPos: vec3f, n: vec3f, size: f32) -> vec3f {
  var uv = worldPos.xy;
  let an = abs(n);
  if (an.y > 0.5) {
    uv = worldPos.xz;
  } else if (an.x > 0.5) {
    uv = worldPos.zy;
  }
  let cell = uv / size;
  let f = fract(cell);
  let edge = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y));
  let aa = fwidth(edge);
  let seam = smoothstep(0.012 - aa, 0.012 + aa, edge);
  let variation = 0.95 + 0.07 * hash2(floor(cell));
  return base * mix(0.45, 1.0, seam) * variation;
}

// Standard dartboard on the top face of the unit cylinder (scoring area = 0.8 of the radius).
fn dartboardColor(lp: vec3f, ln: vec3f) -> vec3f {
  let red = vec3f(0.75, 0.06, 0.05);
  let green = vec3f(0.04, 0.42, 0.14);
  if (ln.y < 0.5) {
    return vec3f(0.12, 0.08, 0.05);
  }
  let r = length(lp.xz) / 0.8 * 170.0;
  if (r > 170.0) {
    return vec3f(0.05, 0.05, 0.05);
  }
  if (r < 6.35) {
    return red;
  }
  if (r < 15.9) {
    return green;
  }
  let a = atan2(lp.z, lp.x) / 6.2831853 * 20.0 + 0.5;
  let isEven = (i32(floor(a + 20.0)) % 2) == 0;
  if ((r > 99.0 && r < 107.0) || r > 162.0) {
    return select(green, red, isEven);
  }
  return select(vec3f(0.9, 0.84, 0.66), vec3f(0.04, 0.04, 0.04), isEven);
}

fn vnoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = hash2(i);
  let b = hash2(i + vec2f(1.0, 0.0));
  let c = hash2(i + vec2f(0.0, 1.0));
  let d = hash2(i + vec2f(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Swirling purple liquid on the caps of the unit cylinder (a thin disc).
fn portalColor(lp: vec3f, ln: vec3f, t: f32) -> vec3f {
  if (abs(ln.y) < 0.5) {
    return vec3f(0.2, 0.03, 0.35); // the disc's thin edge
  }
  let p = lp.xz;
  let r = length(p);
  let a = atan2(p.y, p.x);
  // Swirl faster toward the centre, then domain-warp noise so it churns like a liquid.
  let swirl = a + t * 0.9 + (1.0 - r) * 3.5;
  let q = vec2f(cos(swirl), sin(swirl)) * r * 3.0;
  let w = vec2f(vnoise(q + vec2f(t * 0.6, 0.0)), vnoise(q + vec2f(5.2, -t * 0.5)));
  let n = vnoise(q * 1.7 + w * 2.5 + vec2f(t * 0.3, -t * 0.2));
  let ripple = 0.5 + 0.5 * sin(r * 22.0 - t * 5.0 + n * 6.0);
  var col = mix(vec3f(0.09, 0.0, 0.22), vec3f(0.62, 0.12, 1.25), smoothstep(0.3, 0.95, n * 0.8 + ripple * 0.35));
  col += vec3f(0.9, 0.35, 1.5) * pow(1.0 - r, 3.0) * 0.7; // glowing core
  col += vec3f(0.8, 0.2, 1.3) * smoothstep(0.8, 1.0, r) * 1.1; // bright lip
  return col;
}

// Rock: grainy mottling with darker cracks, in the object's own space (so it turns with it).
// `grain` sets the feature size per unit of the mesh.
fn rockNoise(p: vec3f) -> f32 {
  return (vnoise(p.xy) + vnoise(p.yz + vec2f(3.1, 7.3)) + vnoise(p.zx + vec2f(5.7, 1.9))) / 3.0;
}

fn rockColor(base: vec3f, lp: vec3f, grain: f32) -> vec3f {
  let p = lp * grain * 3.0;
  let broad = rockNoise(p);
  let fine = rockNoise(p * 4.3 + vec3f(11.0));
  var col = base * (0.62 + 0.55 * broad + 0.25 * (fine - 0.5));
  // Cracks: thin dark lines where a noise field crosses its middle.
  let crack = rockNoise(p * 1.7 + vec3f(23.0));
  col *= 0.55 + 0.45 * smoothstep(0.0, 0.05, abs(crack - 0.5));
  // A few light flecks.
  col += vec3f(0.08) * smoothstep(0.78, 0.9, fine);
  return col;
}

// Molten rock in world space: dark crust drifting over glowing orange, slowly churning.
// `molten` (a thing turned to lava rather than a pool): hotter, finer, and varying with height too.
fn lavaColor(wp: vec3f, t: f32, goo: f32, molten: f32) -> vec3f {
  let p = (wp.xz + vec2f(wp.y * 0.8, -wp.y * 0.55) * molten) * (0.32 + molten * 0.5);
  let w = vec2f(vnoise(p + vec2f(t * 0.05, 1.7)), vnoise(p * 1.3 + vec2f(4.1, t * 0.04)));
  let n = vnoise(p * 1.6 + w * 2.2 + vec2f(t * 0.03, -t * 0.02));
  let n2 = vnoise(p * 4.5 + w * 3.0 - vec2f(t * 0.07, t * 0.05));
  let heat = smoothstep(0.38 - molten * 0.1, 0.8 - molten * 0.14, n * 0.7 + n2 * 0.3);
  // Lava, or (goo > 0.5) toxic green goo: the same churning noise in other colours.
  let crust = mix(vec3f(0.07, 0.025, 0.015), vec3f(0.02, 0.07, 0.02), goo);
  let hot = mix(
    mix(vec3f(1.5, 0.3, 0.03), vec3f(2.6, 1.25, 0.25), smoothstep(0.75 + molten * 0.15, 1.0, heat)),
    mix(vec3f(0.25, 1.1, 0.08), vec3f(0.9, 2.2, 0.35), smoothstep(0.75, 1.0, heat)),
    goo,
  );
  return mix(crust, hot, heat);
}

// Pool water (PAT_LAVA param 3): a see-through surface with wind ripples, the sky reflected at
// grazing angles, sun glints and a caustic shimmer. Alpha: the object's opacity, more at grazing angles.
fn waterRipple(p: vec2f, t: f32) -> f32 {
  return vnoise(p * 0.9 + vec2f(t * 0.3, t * 0.17)) * 0.6 + vnoise(p * 2.3 - vec2f(t * 0.45, -t * 0.28)) * 0.4;
}

fn waterColor(wp: vec3f, t: f32) -> vec4f {
  let e = 0.06;
  let h0 = waterRipple(wp.xz, t);
  let hx = waterRipple(wp.xz + vec2f(e, 0.0), t);
  let hz = waterRipple(wp.xz + vec2f(0.0, e), t);
  let n = normalize(vec3f(-(hx - h0) / e * 0.22, 1.0, -(hz - h0) / e * 0.22));
  let v = normalize(frame.camPos.xyz - wp);
  let l = normalize(frame.sunDir.xyz);
  let fres = 0.03 + 0.97 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
  let body = vec3f(0.03, 0.36, 0.52) * (frame.sunColor.rgb * max(l.y, 0.0) * 0.5 + frame.skyColor.rgb * 1.2);
  let refl = skyColor(reflect(-v, n));
  let glint = pow(max(dot(n, normalize(l + v)), 0.0), 260.0) * 2.5;
  let shimmer = pow(1.0 - abs(vnoise(wp.xz * 1.4 + vec2f(t * 0.35, -t * 0.25) + n.xz * 3.0) - 0.5) * 2.0, 12.0);
  let col = mix(body, refl, fres * 0.8) + frame.sunColor.rgb * glint + vec3f(0.35, 0.6, 0.65) * shimmer * 0.35;
  return vec4f(col, clamp(obj.color.a + fres * 0.6, 0.0, 1.0));
}

// Rippling light on a pool's floor and walls (panels with a negative size parameter).
fn caustics(p: vec2f, t: f32) -> f32 {
  let w = vnoise(p * 0.8 + vec2f(t * 0.25, -t * 0.2));
  let a = vnoise(p * 1.9 + vec2f(w * 2.0 + t * 0.4, -t * 0.3));
  let b = vnoise(p * 2.6 - vec2f(t * 0.35, w * 1.5 - t * 0.25));
  let r = 1.0 - abs(a - 0.5) * 2.0;
  let s = 1.0 - abs(b - 0.5) * 2.0;
  return pow(r, 7.0) * 0.8 + pow(s, 9.0) * 0.6;
}

fn skyColor(dir: vec3f) -> vec3f {
  let l = normalize(frame.sunDir.xyz);
  let t = clamp(dir.y, 0.0, 1.0);
  var col = mix(frame.fogColor.rgb, frame.skyColor.rgb * 1.6, pow(t, 0.45));
  let s = max(dot(dir, l), 0.0);
  col += frame.sunColor.rgb * (pow(s, 900.0) * 8.0 + pow(s, 10.0) * 0.12);
  return col;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  let pattern = i32(obj.params.x);
  let camPos = frame.camPos.xyz;

  if (pattern == PAT_SKY) {
    return vec4f(tonemap(skyColor(normalize(in.worldPos - camPos))), 1.0);
  }
  if (pattern == PAT_PORTAL) {
    return vec4f(tonemap(portalColor(in.localPos, in.localNormal, frame.camPos.w)), 1.0);
  }
  if (pattern == PAT_LAVA) {
    // Parameter: 0 lava, 1 green goo, 2 a thing turned molten (see lavaColor), 3 pool water.
    let kind = obj.params.y;
    if (kind > 2.5) {
      let w = waterColor(in.worldPos, frame.camPos.w);
      return vec4f(tonemap(w.rgb), w.a);
    }
    let goo = select(0.0, 1.0, abs(kind - 1.0) < 0.5);
    return vec4f(tonemap(lavaColor(in.worldPos, frame.camPos.w, goo, step(1.5, kind))), 1.0);
  }
  if (pattern == PAT_EMISSIVE) {
    // Unlit glow (lights, explosion flashes); values above 1 bloom into white through the tonemap.
    return vec4f(tonemap(obj.color.rgb), obj.color.a);
  }
  if (pattern == PAT_BLOB) {
    // Soft disk (alpha-to-coverage): contact shadows and scorch marks. Decals are clipped to
    // their surface's box so they never hang off an edge.
    let r = length(in.localPos.xz);
    var alpha = obj.params.y * (1.0 - r * r);
    if (obj.clipMin.w > 0.5 && (any(in.worldPos < obj.clipMin.xyz) || any(in.worldPos > obj.clipMax.xyz))) {
      alpha = 0.0;
    }
    return vec4f(tonemap(obj.color.rgb), alpha);
  }

  let n = normalize(in.normal);
  var albedo = obj.color.rgb;
  if (pattern == PAT_PANELS) {
    albedo = panelColor(albedo, in.worldPos, n, abs(obj.params.y));
  } else if (pattern == PAT_DARTBOARD) {
    albedo = dartboardColor(in.localPos, in.localNormal);
  } else if (pattern == PAT_ROCK) {
    albedo = rockColor(albedo, in.localPos, obj.params.y);
  }

  let l = normalize(frame.sunDir.xyz);
  var ndl = dot(n, l);
  if (pattern == PAT_SKIN) {
    ndl = (ndl + 0.35) / 1.35; // soft wrap lighting
  }
  ndl = max(ndl, 0.0);
  if (frame.sunDir.w > -1000.0) {
    // A glowing plane below, not a beam: facing down gets it all, walls half, facing up none.
    ndl = (1.0 - n.y) * 0.5;
  }
  var sh = shadowFactor(in.worldPos, n);
  var groundLight = frame.groundColor.rgb;
  if (frame.sunDir.w > -1000.0) {
    // Lit from a glowing surface below: brightest near it, fading with height above it.
    let above = max(in.worldPos.y - frame.sunDir.w, 0.0);
    let falloff = 1.0 / (1.0 + above * above * 0.05);
    sh *= falloff;
    groundLight *= falloff;
  }
  let hemi = mix(groundLight, frame.skyColor.rgb, n.y * 0.5 + 0.5);
  var pointLight = vec3f(0.0);
  if (frame.pointPos.w > 0.0) {
    let toLight = frame.pointPos.xyz - in.worldPos;
    let d = length(toLight);
    let fade = clamp(1.0 - d / frame.pointPos.w, 0.0, 1.0);
    pointLight = frame.pointColor.rgb * max(dot(n, toLight / max(d, 0.0001)), 0.0) * fade * fade / (1.0 + d * d * 0.08);
  }
  let v = normalize(camPos - in.worldPos);
  let h = normalize(l + v);
  let spec = pow(max(dot(n, h), 0.0), 48.0) * obj.params.z * step(0.0, dot(n, l));
  var col = albedo * (frame.sunColor.rgb * ndl * sh + hemi + pointLight) + frame.sunColor.rgb * spec * sh;
  if (pattern == PAT_PANELS && obj.params.y < 0.0) {
    // Underwater tiles: light rippling through the surface above.
    let cp = in.worldPos.xz + vec2f(in.worldPos.y * 0.7, -in.worldPos.y * 0.5);
    col += albedo * frame.sunColor.rgb * caustics(cp, frame.camPos.w) * (0.35 + 0.65 * sh) * 0.55;
  }
  if (obj.params.w > 0.0) {
    // Pulsing glow on whatever the crosshair is targeting.
    let pulse = 0.65 + 0.35 * sin(frame.camPos.w * 6.0);
    col += (albedo * 0.5 + vec3f(0.08, 0.07, 0.03)) * obj.params.w * pulse;
  }

  let dist = length(camPos - in.worldPos);
  let fog = 1.0 - exp(-dist * frame.fogColor.w);
  col = mix(col, frame.fogColor.rgb, fog);
  return vec4f(tonemap(col), obj.color.a); // a < 1: see-through (alpha-to-coverage)
}
