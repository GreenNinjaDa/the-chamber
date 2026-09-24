// Depth-only pass from the sun. Structs must match scene.wgsl.
struct Frame {
  viewProj: mat4x4f,
  lightViewProj: mat4x4f,
  sunDir: vec4f,
  sunColor: vec4f,
  skyColor: vec4f,
  groundColor: vec4f,
  fogColor: vec4f,
  camPos: vec4f,
};

struct Object {
  model: mat4x4f,
  normalMat: mat4x4f,
  color: vec4f,
  params: vec4f,
};

@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var<uniform> obj: Object;

@vertex
fn vs(@location(0) position: vec3f) -> @builtin(position) vec4f {
  return frame.lightViewProj * obj.model * vec4f(position, 1.0);
}
