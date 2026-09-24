struct Frame {
  viewProj: mat4x4f,
  lightViewProj: mat4x4f,
  sunDir: vec4f,      // xyz: direction toward the sun
  sunColor: vec4f,
  skyColor: vec4f,
  groundColor: vec4f,
  fogColor: vec4f,    // w: fog density
  camPos: vec4f,      // w: time
};

struct Object {
  model: mat4x4f,
  normalMat: mat4x4f,
  color: vec4f,
  params: vec4f,      // x: pattern, y: pattern parameter, z: specular strength
};

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var shadowMap: texture_depth_2d;
@group(0) @binding(2) var shadowSampler: sampler_comparison;
@group(1) @binding(0) var<uniform> obj: Object;

// Pattern ids (keep in sync with Pattern in renderer.ts).
const PAT_PANELS = 1;
const PAT_DARTBOARD = 2;
const PAT_BLOB = 3;
const PAT_SKIN = 5;
const PAT_SKY = 6;

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
  if (pattern == PAT_BLOB) {
    // Soft disk (alpha-to-coverage), used as a contact shadow under the giant's hand.
    let r = length(in.localPos.xz);
    let alpha = obj.params.y * (1.0 - r * r);
    return vec4f(tonemap(obj.color.rgb), alpha);
  }

  let n = normalize(in.normal);
  var albedo = obj.color.rgb;
  if (pattern == PAT_PANELS) {
    albedo = panelColor(albedo, in.worldPos, n, obj.params.y);
  } else if (pattern == PAT_DARTBOARD) {
    albedo = dartboardColor(in.localPos, in.localNormal);
  }

  let l = normalize(frame.sunDir.xyz);
  var ndl = dot(n, l);
  if (pattern == PAT_SKIN) {
    ndl = (ndl + 0.35) / 1.35; // soft wrap lighting
  }
  ndl = max(ndl, 0.0);
  let sh = shadowFactor(in.worldPos, n);
  let hemi = mix(frame.groundColor.rgb, frame.skyColor.rgb, n.y * 0.5 + 0.5);
  let v = normalize(camPos - in.worldPos);
  let h = normalize(l + v);
  let spec = pow(max(dot(n, h), 0.0), 48.0) * obj.params.z * step(0.0, dot(n, l));
  var col = albedo * (frame.sunColor.rgb * ndl * sh + hemi) + frame.sunColor.rgb * spec * sh;

  let dist = length(camPos - in.worldPos);
  let fog = 1.0 - exp(-dist * frame.fogColor.w);
  col = mix(col, frame.fogColor.rgb, fog);
  return vec4f(tonemap(col), 1.0);
}
