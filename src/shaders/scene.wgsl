struct Uniforms {
  viewProj: mat4x4f,
  model: mat4x4f,
  sunDir: vec4f,
  time: vec4f,
};

@group(0) @binding(0) var<uniform> u: Uniforms;

struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) normal: vec3f,
  @location(1) worldPos: vec3f,
};

@vertex
fn vs(@location(0) position: vec3f, @location(1) normal: vec3f) -> VsOut {
  let world = u.model * vec4f(position, 1.0);
  var out: VsOut;
  out.pos = u.viewProj * world;
  out.normal = (u.model * vec4f(normal, 0.0)).xyz;
  out.worldPos = world.xyz;
  return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  let n = normalize(in.normal);
  let l = normalize(u.sunDir.xyz);
  let base = vec3f(0.95, 0.55, 0.25);
  let sky = mix(vec3f(0.08, 0.10, 0.14), vec3f(0.35, 0.55, 0.85), n.y * 0.5 + 0.5);
  let diffuse = max(dot(n, l), 0.0) * vec3f(1.0, 0.95, 0.85);
  let color = base * (diffuse + sky * 0.6);
  // Simple Reinhard tonemap + gamma.
  let mapped = color / (color + vec3f(1.0));
  return vec4f(pow(mapped, vec3f(1.0 / 2.2)) * 1.6, 1.0);
}
