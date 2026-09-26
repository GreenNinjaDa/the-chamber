import sceneCode from '../shaders/scene.wgsl?raw';
import shadowCode from '../shaders/shadow.wgsl?raw';
import { box, cone, cylinder, holePlate, roundBox, sphere, tube, wedge, type MeshData } from './meshes';
import {
  add, lookAt, multiply, normalMatrix, normalize, ortho, scale,
  type Mat4, type Vec3,
} from './math';

export type MeshName = 'box' | 'sphere' | 'cylinder' | 'cone' | 'roundbox' | 'bevelbox' | 'holeplate' | 'tube' | 'wedge';

/** Surface patterns understood by scene.wgsl. */
export const Pattern = {
  plain: 0,
  panels: 1,
  dartboard: 2,
  blob: 3,
  emissive: 4,
  skin: 5,
  sky: 6,
  portal: 7,
  lava: 8,
  rock: 9,
} as const;

export interface DrawItem {
  mesh: MeshName;
  model: Mat4;
  color: ArrayLike<number>;
  pattern?: number;
  /** Pattern parameter: panel size for `panels`, opacity for `blob`. */
  param?: number;
  spec?: number;
  /** 0..1 pulsing glow for the thing under the crosshair. */
  highlight?: number;
  /** World-space box outside which a decal (Pattern.blob) isn't drawn. */
  clip?: { min: Vec3; max: Vec3 };
  /** Set false to keep the item out of the shadow map. */
  shadow?: boolean;
}

export interface Environment {
  sunDir: Vec3;
  /**
   * Set when the "sun" is really a glowing surface below (lava): its height. Light then shines up
   * from it (point sunDir downward), fades with height above it, and casts very soft shadows.
   */
  lightFromBelow?: number;
  /** A point light (e.g. a torch): position, colour, and the range it fades out over (m). No shadows. */
  pointLight?: { pos: Vec3; color: Vec3; range: number };
  sunColor: Vec3;
  skyColor: Vec3;
  groundColor: Vec3;
  fogColor: Vec3;
  fogDensity: number;
}

export interface CameraView {
  pos: Vec3;
  view: Mat4;
  proj: Mat4;
}

interface GpuMesh {
  vb: GPUBuffer;
  ib: GPUBuffer;
  count: number;
}

const MAX_DRAWS = 4096;
/** Hole radius of the 'holeplate' mesh relative to its side, and inner radius of the 'tube' mesh. */
export const HOLE_PLATE_RATIO = 0.35;
export const TUBE_INNER_RATIO = 0.5;
const OBJ_STRIDE = 256; // bytes, satisfies minUniformBufferOffsetAlignment
const OBJ_FLOATS = OBJ_STRIDE / 4;
/** Size of the Object struct in scene.wgsl. */
const OBJ_BYTES = 192;
const SHADOW_SIZE = 4096;
const MSAA = 4;
const DEPTH_FORMAT: GPUTextureFormat = 'depth24plus';

// Region of the world covered by the sun's shadow map.
const SHADOW_CENTER: Vec3 = [0, 15, -20];
const SHADOW_EXTENT = 88;

export class Renderer {
  readonly device: GPUDevice;
  private context: GPUCanvasContext;
  private format: GPUTextureFormat;
  private meshes: Record<MeshName, GpuMesh>;
  private frameBuffer: GPUBuffer;
  private objBuffer: GPUBuffer;
  private frameData = new Float32Array(64);
  private objData = new Float32Array(MAX_DRAWS * OBJ_FLOATS);
  private mainPipeline: GPURenderPipeline;
  private shadowPipeline: GPURenderPipeline;
  private mainFrameBG: GPUBindGroup;
  private shadowFrameBG: GPUBindGroup;
  private objBG: GPUBindGroup;
  private shadowView: GPUTextureView;
  private msaaTexture: GPUTexture | null = null;
  private depthTexture: GPUTexture | null = null;

  static async create(canvas: HTMLCanvasElement): Promise<Renderer> {
    if (!navigator.gpu) throw new Error('WebGPU is not available. Use a recent Chrome or Edge.');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter found.');
    const device = await adapter.requestDevice();
    return new Renderer(canvas, device);
  }

  private constructor(private canvas: HTMLCanvasElement, device: GPUDevice) {
    this.device = device;
    this.context = canvas.getContext('webgpu')!;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device, format: this.format, alphaMode: 'opaque' });

    this.meshes = {
      box: this.upload(box()),
      sphere: this.upload(sphere()),
      cylinder: this.upload(cylinder()),
      cone: this.upload(cone()),
      roundbox: this.upload(roundBox()),
      bevelbox: this.upload(roundBox(12)),
      holeplate: this.upload(holePlate(HOLE_PLATE_RATIO)),
      tube: this.upload(tube(TUBE_INNER_RATIO)),
      wedge: this.upload(wedge()),
    };

    this.frameBuffer = device.createBuffer({
      size: this.frameData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.objBuffer = device.createBuffer({
      size: MAX_DRAWS * OBJ_STRIDE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const shadowTexture = device.createTexture({
      size: [SHADOW_SIZE, SHADOW_SIZE],
      format: 'depth32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.shadowView = shadowTexture.createView();

    const frameLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'comparison' } },
      ],
    });
    const shadowFrameLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: {} }],
    });
    const objLayout = device.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { hasDynamicOffset: true, minBindingSize: OBJ_BYTES },
      }],
    });

    this.mainFrameBG = device.createBindGroup({
      layout: frameLayout,
      entries: [
        { binding: 0, resource: { buffer: this.frameBuffer } },
        { binding: 1, resource: this.shadowView },
        { binding: 2, resource: device.createSampler({ compare: 'less', magFilter: 'linear', minFilter: 'linear' }) },
      ],
    });
    this.shadowFrameBG = device.createBindGroup({
      layout: shadowFrameLayout,
      entries: [{ binding: 0, resource: { buffer: this.frameBuffer } }],
    });
    this.objBG = device.createBindGroup({
      layout: objLayout,
      entries: [{ binding: 0, resource: { buffer: this.objBuffer, size: OBJ_BYTES } }],
    });

    const sceneModule = device.createShaderModule({ code: sceneCode });
    this.mainPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [frameLayout, objLayout] }),
      vertex: {
        module: sceneModule,
        entryPoint: 'vs',
        buffers: [{
          arrayStride: 24,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },
            { shaderLocation: 1, offset: 12, format: 'float32x3' },
          ],
        }],
      },
      fragment: { module: sceneModule, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list', cullMode: 'back' },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'less' },
      // Alpha-to-coverage gives cheap soft transparency (used by Pattern.blob).
      multisample: { count: MSAA, alphaToCoverageEnabled: true },
    });

    const shadowModule = device.createShaderModule({ code: shadowCode });
    this.shadowPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [shadowFrameLayout, objLayout] }),
      vertex: {
        module: shadowModule,
        entryPoint: 'vs',
        buffers: [{ arrayStride: 24, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: {
        format: 'depth32float',
        depthWriteEnabled: true,
        depthCompare: 'less',
        depthBias: 2,
        depthBiasSlopeScale: 2,
      },
    });
  }

  private upload(data: MeshData): GpuMesh {
    const vb = this.device.createBuffer({
      size: data.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(vb, 0, data.vertices);
    // Pad index data to a multiple of 4 bytes for writeBuffer.
    const padded = new Uint16Array(Math.ceil(data.indices.length / 2) * 2);
    padded.set(data.indices);
    const ib = this.device.createBuffer({
      size: padded.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(ib, 0, padded);
    return { vb, ib, count: data.indices.length };
  }

  get aspect() {
    return this.canvas.width / Math.max(1, this.canvas.height);
  }

  private resize() {
    const dpr = Math.min(window.devicePixelRatio, 2);
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width === w && this.canvas.height === h && this.msaaTexture) return;
    this.canvas.width = w;
    this.canvas.height = h;
    this.msaaTexture?.destroy();
    this.depthTexture?.destroy();
    this.msaaTexture = this.device.createTexture({
      size: [w, h],
      format: this.format,
      sampleCount: MSAA,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.depthTexture = this.device.createTexture({
      size: [w, h],
      format: DEPTH_FORMAT,
      sampleCount: MSAA,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  render(draws: DrawItem[], cam: CameraView, env: Environment, time: number) {
    this.resize();
    const device = this.device;
    const n = Math.min(draws.length, MAX_DRAWS);

    const od = this.objData;
    for (let i = 0; i < n; i++) {
      const d = draws[i];
      const o = i * OBJ_FLOATS;
      od.set(d.model, o);
      od.set(normalMatrix(d.model), o + 16);
      od[o + 32] = d.color[0];
      od[o + 33] = d.color[1];
      od[o + 34] = d.color[2];
      od[o + 35] = 1;
      od[o + 36] = d.pattern ?? Pattern.plain;
      od[o + 37] = d.param ?? 0;
      od[o + 38] = d.spec ?? 0.08;
      od[o + 39] = d.highlight ?? 0;
      const clip = d.clip;
      od[o + 40] = clip ? clip.min[0] : 0;
      od[o + 41] = clip ? clip.min[1] : 0;
      od[o + 42] = clip ? clip.min[2] : 0;
      od[o + 43] = clip ? 1 : 0;
      od[o + 44] = clip ? clip.max[0] : 0;
      od[o + 45] = clip ? clip.max[1] : 0;
      od[o + 46] = clip ? clip.max[2] : 0;
      od[o + 47] = 0;
    }
    device.queue.writeBuffer(this.objBuffer, 0, od, 0, n * OBJ_FLOATS);

    const sunDir = normalize(env.sunDir);
    const lightUp: Vec3 = Math.abs(sunDir[1]) > 0.95 ? [0, 0, 1] : [0, 1, 0];
    const lightView = lookAt(add(SHADOW_CENTER, scale(sunDir, 220)), SHADOW_CENTER, lightUp);
    const lightProj = ortho(-SHADOW_EXTENT, SHADOW_EXTENT, -SHADOW_EXTENT, SHADOW_EXTENT, 1, 480);
    const f = this.frameData;
    f.set(multiply(cam.proj, cam.view), 0);
    f.set(multiply(lightProj, lightView), 16);
    f.set([...sunDir, env.lightFromBelow ?? -1e4], 32);
    f.set([...env.sunColor, 0], 36);
    f.set([...env.skyColor, 0], 40);
    f.set([...env.groundColor, 0], 44);
    f.set([...env.fogColor, env.fogDensity], 48);
    f.set([...cam.pos, time], 52);
    const point = env.pointLight;
    f.set(point ? [...point.pos, point.range] : [0, 0, 0, 0], 56);
    f.set(point ? [...point.color, 0] : [0, 0, 0, 0], 60);
    device.queue.writeBuffer(this.frameBuffer, 0, f);

    const encoder = device.createCommandEncoder();

    const sp = encoder.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view: this.shadowView,
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    sp.setPipeline(this.shadowPipeline);
    sp.setBindGroup(0, this.shadowFrameBG);
    for (let i = 0; i < n; i++) {
      if (draws[i].shadow === false) continue;
      this.drawMesh(sp, draws[i].mesh, i);
    }
    sp.end();

    const mp = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.msaaTexture!.createView(),
        resolveTarget: this.context.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: 'discard',
      }],
      depthStencilAttachment: {
        view: this.depthTexture!.createView(),
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'discard',
      },
    });
    mp.setPipeline(this.mainPipeline);
    mp.setBindGroup(0, this.mainFrameBG);
    for (let i = 0; i < n; i++) this.drawMesh(mp, draws[i].mesh, i);
    mp.end();

    device.queue.submit([encoder.finish()]);
  }

  private drawMesh(pass: GPURenderPassEncoder, name: MeshName, index: number) {
    const m = this.meshes[name];
    pass.setBindGroup(1, this.objBG, [index * OBJ_STRIDE]);
    pass.setVertexBuffer(0, m.vb);
    pass.setIndexBuffer(m.ib, 'uint16');
    pass.drawIndexed(m.count);
  }
}
