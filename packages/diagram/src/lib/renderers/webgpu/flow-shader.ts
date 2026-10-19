// Each instance covers one routed segment. Distance along the whole edge keeps
// the pulse continuous through corners without scanning every edge per pixel.
export const flowShader = /* wgsl */ `
struct Segment {
  endpoints: vec4f,
  // Distance from edge start, segment length, edge length, reverse direction.
  travel: vec4f,
  // Reveal start/end, edge declaration index, opacity.
  reveal: vec4f,
};
@group(0) @binding(0) var<storage, read> segments: array<Segment>;
@group(0) @binding(1) var<uniform> bounds: vec4f;
@group(0) @binding(2) var<uniform> tint: vec4f;
@group(0) @binding(3) var<uniform> time: f32;
@group(0) @binding(4) var<uniform> progress: f32;
@group(0) @binding(5) var<uniform> playhead: f32;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) local: vec2f,
  @location(1) @interpolate(flat) travel: vec4f,
  @location(2) @interpolate(flat) reveal: vec4f,
};

@vertex fn vertex(@builtin(vertex_index) vertexIndex: u32,
                  @builtin(instance_index) instanceIndex: u32) -> VertexOutput {
  let corners = array<vec2f, 6>(
    vec2f(0, -1), vec2f(1, -1), vec2f(0, 1),
    vec2f(0, 1), vec2f(1, -1), vec2f(1, 1)
  );
  let s = segments[instanceIndex];
  let corner = corners[vertexIndex];
  let direction = (s.endpoints.zw - s.endpoints.xy) / s.travel.y;
  let normal = vec2f(-direction.y, direction.x);
  let local = vec2f(corner.x * s.travel.y, corner.y * 10.0);
  let point = s.endpoints.xy + direction * local.x + normal * local.y;
  let uv = (point - bounds.xy) / bounds.zw;
  var output: VertexOutput;
  output.position = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0, 1);
  output.local = local;
  output.travel = s.travel;
  output.reveal = s.reveal;
  return output;
}

@fragment fn fragment(input: VertexOutput) -> @location(0) vec4f {
  let distance = input.travel.x + input.local.x;
  let revealed = clamp((progress - input.reveal.x) /
                      (input.reveal.y - input.reveal.x), 0.0, 1.0);
  if (revealed <= 0.0 || distance > revealed * input.travel.z) { discard; }
  let position = select(distance, input.travel.z - distance, input.travel.w > 0.5);
  var phase = fract(time * 0.32 + input.reveal.z * 0.23 + 0.15);
  var head = phase * (input.travel.z + 70.0);
  if (playhead >= 0.0) {
    phase = fract(playhead);
    if (floor(playhead) != input.reveal.z || phase == 0.0) { discard; }
    head = phase * input.travel.z;
  }
  let behind = head - position;
  let trail = smoothstep(-3.0, 2.0, behind) * (1.0 - smoothstep(0.0, 65.0, behind));
  let core = exp(-input.local.y * input.local.y / 2.5);
  let glow = exp(-input.local.y * input.local.y / 28.0) * 0.32;
  let alpha = clamp((core + glow) * trail * input.reveal.w * tint.a, 0.0, 1.0);
  return vec4f(tint.rgb * alpha, alpha);
}
`;
