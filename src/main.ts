import shaderCode from './shaders/scene.wgsl?raw';
import { lookAt, multiply, perspective, rotationY } from './math';

function showError(message: string) {
  const el = document.getElementById('error')!;
  el.textContent = message;
  el.style.display = 'grid';
}

// Unit cube: 6 faces x 4 verts, interleaved position (3) + normal (3).
function cubeMesh() {
  const faces = [
    { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
    { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
    { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
    { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
    { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
    { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
  ];
  const verts: number[] = [];
  const indices: number[] = [];
  faces.forEach(({ n, u, v }, f) => {
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      verts.push(
        (n[0] + a * u[0] + b * v[0]) * 0.5,
        (n[1] + a * u[1] + b * v[1]) * 0.5,
        (n[2] + a * u[2] + b * v[2]) * 0.5,
        ...n,
      );
    }
    const o = f * 4;
    indices.push(o, o + 1, o + 2, o, o + 2, o + 3);
  });
  return { verts: new Float32Array(verts), indices: new Uint16Array(indices) };
}

async function main() {
  if (!navigator.gpu) return showError('WebGPU is not available. Use a recent Chrome or Edge.');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) return showError('No WebGPU adapter found.');
  const device = await adapter.requestDevice();
  device.lost.then((info) => showError(`GPU device lost: ${info.message}`));

  const canvas = document.getElementById('gfx') as HTMLCanvasElement;
  const context = canvas.getContext('webgpu')!;
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });

  const mesh = cubeMesh();
  const vertexBuffer = device.createBuffer({
    size: mesh.verts.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(vertexBuffer, 0, mesh.verts);
  const indexBuffer = device.createBuffer({
    size: mesh.indices.byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(indexBuffer, 0, mesh.indices);

  const uniformBuffer = device.createBuffer({
    size: 16 * 4 * 2 + 16 * 2,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const module = device.createShaderModule({ code: shaderCode });
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: {
      module,
      entryPoint: 'vs',
      buffers: [{
        arrayStride: 24,
        attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x3' },
          { shaderLocation: 1, offset: 12, format: 'float32x3' },
        ],
      }],
    },
    fragment: { module, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list', cullMode: 'back' },
    depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
  });

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
  });

  let depthTexture: GPUTexture | null = null;
  function resize() {
    const dpr = Math.min(window.devicePixelRatio, 2);
    const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width === w && canvas.height === h && depthTexture) return;
    canvas.width = w;
    canvas.height = h;
    depthTexture?.destroy();
    depthTexture = device.createTexture({
      size: [w, h],
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  const uniforms = new Float32Array(16 * 2 + 8);
  function frame(ms: number) {
    resize();
    const t = ms / 1000;
    const proj = perspective(Math.PI / 4, canvas.width / canvas.height, 0.1, 100);
    const view = lookAt([2.2, 1.6, 2.8], [0, 0, 0], [0, 1, 0]);
    uniforms.set(multiply(proj, view), 0);
    uniforms.set(rotationY(t * 0.6), 16);
    uniforms.set([0.5, 0.9, 0.3, 0], 32);
    uniforms.set([t, 0, 0, 0], 36);
    device.queue.writeBuffer(uniformBuffer, 0, uniforms);

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: context.getCurrentTexture().createView(),
        clearValue: { r: 0.05, g: 0.07, b: 0.1, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
      depthStencilAttachment: {
        view: depthTexture!.createView(),
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.setVertexBuffer(0, vertexBuffer);
    pass.setIndexBuffer(indexBuffer, 'uint16');
    pass.drawIndexed(mesh.indices.length);
    pass.end();
    device.queue.submit([encoder.finish()]);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

main().catch((e) => showError(String(e)));
