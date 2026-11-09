// On-device person segmentation, fully offline, with automatic fallbacks.
//
// Engines, best first. If one fails to load or crashes (WASM "Aborted()"), the next is used:
//   1. MediaPipe multiclass selfie model (hair/face/body/clothes) - SIMD wasm, CPU
//   2. same model, GPU delegate
//   3. same model, non-SIMD wasm (older WebViews)
//   4. MediaPipe selfie segmenter (smaller), SIMD then non-SIMD
//   5. ONNX Runtime Web + U^2-Net-p (completely separate engine)
// Input is resized before inference (the crash on phones was MediaPipe allocating
// full-resolution float masks for 12-50 MP photos: out of WASM memory -> Aborted()).
import { FilesetResolver, ImageSegmenter } from '../vendor/mediapipe/vision_bundle.mjs';

export const MODELS = {
  quality: { file: 'models/selfie_multiclass_256x256.tflite', multiclass: true },
  fast: { file: 'models/selfie_segmenter.tflite', multiclass: false },
  u2: { file: 'models/u2netp.onnx' },
};
const MAX_SIDE = { IMAGE: globalThis.PS_SEG_MAX || 1536, VIDEO: 768 };
const WASM = new URL('../vendor/mediapipe/wasm', import.meta.url).href;
const url = (f) => new URL('../' + f, import.meta.url).href;

const ENGINES = {
  quality: [
    { id: 'mp-multiclass-cpu', type: 'mp', model: 'quality', delegate: 'CPU', simd: 'auto' },
    { id: 'mp-multiclass-gpu', type: 'mp', model: 'quality', delegate: 'GPU', simd: 'auto' },
    { id: 'mp-multiclass-nosimd', type: 'mp', model: 'quality', delegate: 'CPU', simd: false },
    { id: 'mp-selfie-cpu', type: 'mp', model: 'fast', delegate: 'CPU', simd: 'auto' },
    { id: 'mp-selfie-nosimd', type: 'mp', model: 'fast', delegate: 'CPU', simd: false },
    { id: 'onnx-u2netp', type: 'onnx' },
  ],
};
ENGINES.fast = [ENGINES.quality[3], ENGINES.quality[4], ENGINES.quality[0], ENGINES.quality[2], ENGINES.quality[5]];

export const diag = { attempts: [], engine: {} };
globalThis.PS_SEG_DIAG = diag;
const failed = new Set(globalThis.PS_SEG_SKIP || []);
const cache = {};
const filesets = {};
const modelBytes = {};

async function fileset(simd) {
  const k = String(simd);
  if (filesets[k]) return filesets[k];
  if (simd === 'auto') filesets[k] = await FilesetResolver.forVisionTasks(WASM);
  else filesets[k] = { wasmLoaderPath: WASM + '/vision_wasm_nosimd_internal.js', wasmBinaryPath: WASM + '/vision_wasm_nosimd_internal.wasm' };
  return filesets[k];
}
async function bytes(file) {
  if (modelBytes[file]) return modelBytes[file];
  const r = await fetch(url(file));
  if (!r.ok) throw new Error(`model ${file} missing (HTTP ${r.status})`);
  const b = new Uint8Array(await r.arrayBuffer());
  if (b.length < 1000) throw new Error(`model ${file} is empty`);
  return (modelBytes[file] = b);
}
const msg = (e) => (e && (e.message || String(e)) || 'unknown error').slice(0, 160);

async function build(eng, mode) {
  if (eng.type === 'onnx') return buildOnnx();
  const fs = await fileset(eng.simd);
  const seg = await ImageSegmenter.createFromOptions(fs, {
    baseOptions: { modelAssetBuffer: await bytes(MODELS[eng.model].file), delegate: eng.delegate },
    runningMode: mode, outputCategoryMask: false, outputConfidenceMasks: true,
  });
  return { eng, seg, multiclass: MODELS[eng.model].multiclass, run: (img, ts) => toPersonMask(mode === 'VIDEO' ? seg.segmentForVideo(img, ts) : seg.segment(img), MODELS[eng.model].multiclass) };
}

// Returns a working engine handle for kind/mode, probing it once on a test image.
async function engine(kind, mode) {
  const key = kind + ':' + mode;
  if (cache[key]) return cache[key];
  const errs = [];
  for (const eng of ENGINES[kind]) {
    if (failed.has(eng.id)) continue;
    try {
      const h = await build(eng, mode);
      const probe = document.createElement('canvas'); probe.width = probe.height = 64;
      const pc = probe.getContext('2d'); pc.fillStyle = '#888'; pc.fillRect(0, 0, 64, 64);
      await h.run(probe, 1); h.clock = 1;
      diag.attempts.push({ engine: eng.id, mode, ok: true });
      diag.engine[key] = eng.id; cache[key] = h; return h;
    } catch (e) {
      console.warn('segmentation engine failed', eng.id, e);
      failed.add(eng.id); errs.push(`${eng.id}: ${msg(e)}`); diag.attempts.push({ engine: eng.id, mode, ok: false, error: msg(e) });
    }
  }
  const err = new Error('No segmentation engine works on this device. ' + errs.join(' | '));
  err.details = errs; throw err;
}

// Runs inference; if the engine crashes mid-way, drop it and retry with the next one.
async function run(kind, mode, img, ts) {
  for (let tries = 0; tries < 8; tries++) {
    if (tries && Math.max(...sizeOf(img)) > 1024) img = fit(img, 1024); // after a crash, also go smaller
    const h = await engine(kind, mode);
    try { return await h.run(img, ts); } catch (e) {
      console.warn('segmentation crashed, falling back', h.eng.id, e);
      failed.add(h.eng.id); diag.attempts.push({ engine: h.eng.id, mode, ok: false, error: 'run: ' + msg(e) });
      delete cache[kind + ':' + mode];
    }
  }
  throw new Error('Segmentation keeps failing on this device');
}

function sizeOf(s) { return [s.displayWidth || s.videoWidth || s.naturalWidth || s.width, s.displayHeight || s.videoHeight || s.naturalHeight || s.height]; }
// Resizes the input so the WASM heap never sees a 50 MP image.
function fit(source, maxSide, crop) {
  const [sw, sh] = sizeOf(source);
  const c = crop || { x: 0, y: 0, w: sw, h: sh };
  const s = Math.min(1, maxSide / Math.max(c.w, c.h));
  if (s === 1 && !crop && (source instanceof HTMLCanvasElement || source instanceof ImageBitmap)) return source;
  const cv = document.createElement('canvas'); cv.width = Math.max(16, Math.round(c.w * s)); cv.height = Math.max(16, Math.round(c.h * s));
  const ctx = cv.getContext('2d'); ctx.imageSmoothingQuality = 'high'; ctx.drawImage(source, c.x, c.y, c.w, c.h, 0, 0, cv.width, cv.height);
  return cv;
}

function toPersonMask(result, multiclass) {
  const masks = result.confidenceMasks;
  const m = masks[0];
  const w = m.width, h = m.height;
  const f = m.getAsFloat32Array();
  const out = new Uint8Array(w * h);
  if (multiclass) {
    // person = hair + body skin + face skin + clothes (excludes background and 'others')
    const oth = masks.length >= 6 ? masks[5].getAsFloat32Array() : null;
    for (let i = 0; i < f.length; i++) out[i] = Math.max(0, Math.min(255, Math.round((1 - f[i] - (oth ? oth[i] : 0)) * 255)));
  } else {
    for (let i = 0; i < f.length; i++) out[i] = Math.max(0, Math.min(255, Math.round(f[i] * 255)));
  }
  let face = null, hair = null;
  if (multiclass && masks.length >= 4) {
    const ff = masks[3].getAsFloat32Array(); face = new Uint8Array(w * h);
    for (let i = 0; i < ff.length; i++) face[i] = Math.round(Math.min(1, ff[i]) * 255);
    const hf = masks[1].getAsFloat32Array(); hair = new Uint8Array(w * h);
    for (let i = 0; i < hf.length; i++) hair[i] = Math.round(Math.min(1, hf[i]) * 255);
  }
  masks.forEach((x) => x.close());
  return { data: out, width: w, height: h, face, hair };
}

// ---------- ONNX Runtime fallback (U^2-Net-p, 320x320) ----------
let ortSession = null;
async function buildOnnx() {
  if (!ortSession) {
    const ort = await import('../vendor/ort/ort.wasm.min.mjs');
    ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = new URL('../vendor/ort/', import.meta.url).href;
    ortSession = { ort, s: await ort.InferenceSession.create(await bytes(MODELS.u2.file), { executionProviders: ['wasm'] }) };
  }
  const { ort, s } = ortSession; const N = 320;
  const cv = document.createElement('canvas'); cv.width = cv.height = N; const ctx = cv.getContext('2d', { willReadFrequently: true });
  return {
    eng: ENGINES.quality[5], multiclass: false,
    run: async (img) => {
      const [w, h] = sizeOf(img); ctx.drawImage(img, 0, 0, N, N);
      const px = ctx.getImageData(0, 0, N, N).data; const t = new Float32Array(3 * N * N);
      const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
      for (let i = 0; i < N * N; i++) for (let c = 0; c < 3; c++) t[c * N * N + i] = (px[i * 4 + c] / 255 - mean[c]) / std[c];
      const r = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', t, [1, 3, N, N]) });
      const o = r[s.outputNames[0]].data; let mn = Infinity, mx = -Infinity;
      for (const v of o) { if (v < mn) mn = v; if (v > mx) mx = v; }
      const small = new Uint8Array(N * N); const k = 255 / Math.max(1e-6, mx - mn);
      for (let i = 0; i < o.length; i++) small[i] = Math.round((o[i] - mn) * k);
      void w; void h; return { data: small, width: N, height: N, face: null, hair: null };
    },
  };
}

function bbox(m, thr = 128) {
  let x0 = m.width, y0 = m.height, x1 = -1, y1 = -1;
  for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) if (m.data[y * m.width + x] > thr) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return x1 < 0 ? null : { x0: x0 / m.width, y0: y0 / m.height, x1: (x1 + 1) / m.width, y1: (y1 + 1) / m.height };
}

// Photo: best model that works. Full-quality "refine" pass re-runs the model on a crop
// around the people so small/distant subjects get a sharper, higher-resolution mask.
export async function segmentImage(source, kind = 'quality', opts = {}) {
  const img = fit(source, MAX_SIDE.IMAGE);
  const m = await run(kind, 'IMAGE', img, 0);
  if (kind !== 'quality' || opts.refine === false) return m;
  const b = bbox(m); if (!b) return m;
  const bw = b.x1 - b.x0, bh = b.y1 - b.y0; if (bw * bh > 0.55) return m;
  const [sw, sh] = sizeOf(source); const pad = 0.12;
  const cx0 = Math.max(0, b.x0 - pad * Math.max(bw, 0.2)), cy0 = Math.max(0, b.y0 - pad * Math.max(bh, 0.2));
  const cx1 = Math.min(1, b.x1 + pad * Math.max(bw, 0.2)), cy1 = Math.min(1, b.y1 + pad * Math.max(bh, 0.2));
  try {
    const crop = { x: cx0 * sw, y: cy0 * sh, w: (cx1 - cx0) * sw, h: (cy1 - cy0) * sh };
    const r = await run(kind, 'IMAGE', fit(source, MAX_SIDE.IMAGE, crop), 0);
    const paste = (dst, src) => {
      if (!dst || !src) return;
      for (let y = 0; y < m.height; y++) {
        const v = (y + 0.5) / m.height; if (v < cy0 || v >= cy1) continue;
        const sy = Math.min(r.height - 1, Math.floor((v - cy0) / (cy1 - cy0) * r.height));
        for (let x = 0; x < m.width; x++) { const u = (x + 0.5) / m.width; if (u < cx0 || u >= cx1) continue; const sx = Math.min(r.width - 1, Math.floor((u - cx0) / (cx1 - cx0) * r.width)); dst[y * m.width + x] = src[sy * r.width + sx]; }
      }
    };
    paste(m.data, r.data); paste(m.face, r.face); paste(m.hair, r.hair); m.refined = true;
  } catch (e) { console.warn('refine pass skipped', e); }
  return m;
}

// Video frames with temporal smoothing to stop flicker.
export class VideoSegmenter {
  constructor(kind = 'fast') { this.kind = kind; this.prev = null; this.clock = 0; }
  async init() { const h = await engine(this.kind, 'VIDEO'); this.engine = h.eng.id; return h.eng.delegate || 'wasm'; }
  async segment(source, tsMs, smooth = 0.45) {
    // MediaPipe needs strictly increasing timestamps across the segmenter's whole life.
    const h = cache[this.kind + ':VIDEO'];
    const base = h ? (h.clock || 0) : 0;
    const ts = Math.max(base + 1, (this.base0 ?? (this.base0 = base)) + tsMs);
    const m = await run(this.kind, 'VIDEO', fit(source, MAX_SIDE.VIDEO), ts);
    const h2 = cache[this.kind + ':VIDEO']; if (h2) h2.clock = ts;
    if (this.prev && this.prev.length === m.data.length) {
      const a = 1 - smooth, p = this.prev, d = m.data;
      for (let i = 0; i < d.length; i++) d[i] = Math.round(d[i] * a + p[i] * smooth);
    }
    this.prev = m.data.slice();
    return m;
  }
  reset() { this.prev = null; }
}
