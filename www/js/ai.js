// Full-quality on-device AI tools (ONNX Runtime Web, wasm). Models download once on first
// use and are cached on the phone. Each tool falls back to the next engine only if one
// fails to load or crashes.
//   Object eraser: LaMa (208 MB) -> MI-GAN (28 MB) -> classical fill
//   Colourise:     DDColor-tiny (135 MB) -> classical tint
//   3D relight:    Depth Anything V2 small (50 MB) -> flat light
import { cachedFetch, dilate } from './tools.js';

const HF = 'https://huggingface.co/';
export const AI_MODELS = {
  lama: { url: HF + 'Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx', mb: 208, name: 'LaMa eraser' },
  migan: { url: HF + 'andraniksargsyan/migan/resolve/main/migan_pipeline_v2.onnx', mb: 28, name: 'MI-GAN eraser' },
  ddcolor: { url: HF + 'edgetools/ddcolor/resolve/main/ddcolor-tiny-fp16.onnx', mb: 135, name: 'DDColor colouriser' },
  depth: { url: HF + 'onnx-community/depth-anything-v2-small/resolve/main/onnx/model_fp16.onnx', mb: 50, name: 'Depth Anything V2' },
};
export const aiDiag = { log: [] };
globalThis.PS_AI_DIAG = aiDiag;
const broken = new Set(globalThis.PS_AI_SKIP || []);
const URL_OVERRIDE = globalThis.PS_AI_URLS || {}; // tests point these at local copies

let ortP = null;
function getOrt() {
  if (!ortP) ortP = import('../vendor/ort/ort.wasm.min.mjs').then((ort) => { ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false; ort.env.wasm.wasmPaths = new URL('../vendor/ort/', import.meta.url).href; return ort; });
  return ortP;
}
// Only one big model in memory at a time (phones have little RAM).
let live = { id: null, s: null };
async function session(id, onProgress) {
  if (live.id === id) return live.s;
  if (live.s) { try { await live.s.release(); } catch (e) { /* ignore */ } live = { id: null, s: null }; }
  const ort = await getOrt(); const m = AI_MODELS[id];
  const bytes = await cachedFetch(URL_OVERRIDE[id] || m.url, (f) => onProgress && onProgress({ stage: 'download', model: m.name, mb: m.mb, f }));
  if (onProgress) onProgress({ stage: 'load', model: m.name });
  const s = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  live = { id, s }; return s;
}
async function tryEngines(ids, fn) {
  const errs = [];
  for (const id of ids) {
    if (broken.has(id)) continue;
    try { const r = await fn(id); aiDiag.log.push({ id, ok: true }); return { engine: id, result: r }; } catch (e) {
      console.warn('AI engine failed', id, e); broken.add(id); errs.push(id + ': ' + (e.message || e)); aiDiag.log.push({ id, ok: false, error: String(e.message || e).slice(0, 200) });
      if (live.id === id) { try { await live.s.release(); } catch (_) { /* aborted */ } live = { id: null, s: null }; }
    }
  }
  const err = new Error(errs.join(' | ') || 'no engine'); err.engines = errs; throw err;
}
export const modelsCached = async (id) => { try { const c = await caches.open('ps-models-v1'); return !!(await c.match(URL_OVERRIDE[id] || AI_MODELS[id].url)); } catch (e) { return false; } };

const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
const ctx2d = (c) => c.getContext('2d', { willReadFrequently: true });

// ---------- object eraser ----------
// rgba: Uint8ClampedArray (w*h*4) edited in place; mask: Uint8Array 0/1 of the area to remove.
export async function inpaintAI(rgba, mask, w, h, onProgress) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return { engine: 'none', pixels: 0 };
  const grow = Math.max(3, Math.round(Math.max(w, h) / 300));
  const dm = dilate(mask, w, h, grow);
  // square crop with plenty of context around the hole
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1; let side = Math.max(256, Math.round(Math.max(bw, bh) * 2.2));
  side = Math.min(side, Math.max(w, h));
  const cw = Math.min(w, side), ch = Math.min(h, side);
  const cx0 = Math.max(0, Math.min(w - cw, Math.round((x0 + x1) / 2 - cw / 2))), cy0 = Math.max(0, Math.min(h - ch, Math.round((y0 + y1) / 2 - ch / 2)));
  const full = canvas(w, h); ctx2d(full).putImageData(new ImageData(rgba, w, h), 0, 0);
  const N = 512; const ic = canvas(N, N); const ix = ctx2d(ic); ix.imageSmoothingQuality = 'high'; ix.drawImage(full, cx0, cy0, cw, ch, 0, 0, N, N);
  const px = ix.getImageData(0, 0, N, N).data;
  const mk = new Uint8Array(N * N);
  for (let y = 0; y < N; y++) { const sy = cy0 + Math.min(ch - 1, Math.floor(y * ch / N)); for (let x = 0; x < N; x++) { const sx = cx0 + Math.min(cw - 1, Math.floor(x * cw / N)); mk[y * N + x] = dm[sy * w + sx]; } }
  const r = await tryEngines(['lama', 'migan'], async (id) => {
    const ort = await getOrt(); const s = await session(id, onProgress);
    if (onProgress) onProgress({ stage: 'run', model: AI_MODELS[id].name });
    if (id === 'lama') {
      const im = new Float32Array(3 * N * N), m = new Float32Array(N * N);
      for (let i = 0; i < N * N; i++) { for (let c = 0; c < 3; c++) im[c * N * N + i] = px[i * 4 + c] / 255; m[i] = mk[i]; }
      const o = await s.run({ image: new ort.Tensor('float32', im, [1, 3, N, N]), mask: new ort.Tensor('float32', m, [1, 1, N, N]) });
      const d = o.output.data; let mx = 0; for (let i = 0; i < 4096; i++) mx = Math.max(mx, d[i * 97 % d.length]);
      const k = mx > 2 ? 1 : 255; const out = new Uint8ClampedArray(N * N * 4);
      for (let i = 0; i < N * N; i++) { for (let c = 0; c < 3; c++) out[i * 4 + c] = d[c * N * N + i] * k; out[i * 4 + 3] = 255; }
      return out;
    }
    const im = new Uint8Array(3 * N * N), m = new Uint8Array(N * N);
    for (let i = 0; i < N * N; i++) { for (let c = 0; c < 3; c++) im[c * N * N + i] = px[i * 4 + c]; m[i] = mk[i] ? 0 : 255; }
    const o = await s.run({ image: new ort.Tensor('uint8', im, [1, 3, N, N]), mask: new ort.Tensor('uint8', m, [1, 1, N, N]) });
    const d = o.result.data; const out = new Uint8ClampedArray(N * N * 4);
    for (let i = 0; i < N * N; i++) { for (let c = 0; c < 3; c++) out[i * 4 + c] = d[c * N * N + i]; out[i * 4 + 3] = 255; }
    return out;
  });
  // scale the result back to the crop and paste only inside the (feathered) hole
  const oc = canvas(N, N); ctx2d(oc).putImageData(new ImageData(r.result, N, N), 0, 0);
  const bc = canvas(cw, ch); const bx = ctx2d(bc); bx.imageSmoothingQuality = 'high'; bx.drawImage(oc, 0, 0, cw, ch);
  const res = bx.getImageData(0, 0, cw, ch).data;
  const ring = dilate(dm, w, h, Math.max(2, grow >> 1)); let n = 0;
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const gi = (cy0 + y) * w + cx0 + x; const a = dm[gi] ? 1 : ring[gi] ? 0.5 : 0; if (!a) continue;
    const li = (y * cw + x) * 4; for (let c = 0; c < 3; c++) rgba[gi * 4 + c] = rgba[gi * 4 + c] * (1 - a) + res[li + c] * a; n++;
  }
  return { engine: r.engine, pixels: n };
}

// ---------- colourise (DDColor) ----------
const lin = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const enc = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
const Xn = 0.950456, Zn = 1.088754;
const fL = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
const fi = (t) => (t > 0.206893 ? t * t * t : (t - 16 / 116) / 7.787);
function rgb2lab(r, g, b) {
  r = lin(r); g = lin(g); b = lin(b);
  const X = (0.412453 * r + 0.357580 * g + 0.180423 * b) / Xn, Y = 0.212671 * r + 0.715160 * g + 0.072169 * b, Z = (0.019334 * r + 0.119193 * g + 0.950227 * b) / Zn;
  const L = Y > 0.008856 ? 116 * Math.cbrt(Y) - 16 : 903.3 * Y; return [L, 500 * (fL(X) - fL(Y)), 200 * (fL(Y) - fL(Z))];
}
function lab2rgb(L, a, b) {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const X = fi(fx) * Xn, Y = L > 7.9996 ? fy * fy * fy : L / 903.3, Z = fi(fz) * Zn;
  const r = 3.240479 * X - 1.537150 * Y - 0.498535 * Z, g = -0.969256 * X + 1.875992 * Y + 0.041556 * Z, bb = 0.055648 * X - 0.204043 * Y + 1.057311 * Z;
  return [enc(Math.max(0, Math.min(1, r))), enc(Math.max(0, Math.min(1, g))), enc(Math.max(0, Math.min(1, bb)))];
}
export { rgb2lab, lab2rgb };
// Returns a new canvas (same size) with AI colours and the original full-res luminance.
export async function colorizeAI(src, onProgress) {
  const w = src.width, h = src.height, N = 512;
  const r = await tryEngines(['ddcolor'], async (id) => {
    const ort = await getOrt(); const s = await session(id, onProgress);
    const ic = canvas(N, N); const ix = ctx2d(ic); ix.imageSmoothingQuality = 'high'; ix.drawImage(src, 0, 0, N, N);
    const px = ix.getImageData(0, 0, N, N).data; const t = new Float32Array(3 * N * N);
    for (let i = 0; i < N * N; i++) { const [L] = rgb2lab(px[i * 4] / 255, px[i * 4 + 1] / 255, px[i * 4 + 2] / 255); const [g] = lab2rgb(L, 0, 0); t[i] = t[N * N + i] = t[2 * N * N + i] = g; }
    if (onProgress) onProgress({ stage: 'run', model: AI_MODELS[id].name });
    const o = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', t, [1, 3, N, N]) });
    return o[s.outputNames[0]].data;
  });
  const ab = r.result; const out = canvas(w, h); const ox = ctx2d(out); ox.drawImage(src, 0, 0, w, h);
  const img = ox.getImageData(0, 0, w, h); const d = img.data;
  for (let y = 0; y < h; y++) {
    const fy = Math.min(N - 1.001, Math.max(0, (y + 0.5) * N / h - 0.5)); const y0 = Math.floor(fy), ky = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(N - 1.001, Math.max(0, (x + 0.5) * N / w - 0.5)); const x0 = Math.floor(fx), kx = fx - x0;
      const i00 = y0 * N + x0, i01 = i00 + 1, i10 = i00 + N, i11 = i10 + 1;
      const bil = (o) => (ab[o + i00] * (1 - kx) + ab[o + i01] * kx) * (1 - ky) + (ab[o + i10] * (1 - kx) + ab[o + i11] * kx) * ky;
      const p = (y * w + x) * 4; const [L] = rgb2lab(d[p] / 255, d[p + 1] / 255, d[p + 2] / 255);
      const [R, G, B] = lab2rgb(L, bil(0), bil(N * N)); d[p] = R * 255; d[p + 1] = G * 255; d[p + 2] = B * 255;
    }
  }
  ox.putImageData(img, 0, 0); return { engine: r.engine, canvas: out };
}

// ---------- depth -> normals for 3D relight ----------
// Returns a canvas: rgb = surface normal (uv space, y up), a = nearness (255 = close).
export async function depthNormalsAI(src, onProgress) {
  const w = src.width, h = src.height; const long = 518; const s0 = long / Math.max(w, h);
  const W = Math.max(14, Math.round(w * s0 / 14) * 14), H = Math.max(14, Math.round(h * s0 / 14) * 14);
  const r = await tryEngines(['depth'], async (id) => {
    const ort = await getOrt(); const s = await session(id, onProgress);
    const ic = canvas(W, H); const ix = ctx2d(ic); ix.imageSmoothingQuality = 'high'; ix.drawImage(src, 0, 0, W, H);
    const px = ix.getImageData(0, 0, W, H).data; const t = new Float32Array(3 * W * H); const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
    for (let i = 0; i < W * H; i++) for (let c = 0; c < 3; c++) t[c * W * H + i] = (px[i * 4 + c] / 255 - mean[c]) / std[c];
    if (onProgress) onProgress({ stage: 'run', model: AI_MODELS[id].name });
    const o = await s.run({ pixel_values: new ort.Tensor('float32', t, [1, 3, H, W]) });
    const out = o.predicted_depth; return { data: out.data, W: out.dims[2], H: out.dims[1] };
  });
  const { data, W: dw, H: dh } = r.result; let mn = Infinity, mx = -Infinity;
  for (const v of data) { if (v < mn) mn = v; if (v > mx) mx = v; }
  const D = new Float32Array(dw * dh); for (let i = 0; i < D.length; i++) D[i] = (data[i] - mn) / Math.max(1e-6, mx - mn);
  // light blur so normals are smooth
  const B = new Float32Array(D.length); const R = 2;
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) { let s = 0, n = 0; for (let j = -R; j <= R; j++) for (let i = -R; i <= R; i++) { const xx = Math.min(dw - 1, Math.max(0, x + i)), yy = Math.min(dh - 1, Math.max(0, y + j)); s += D[yy * dw + xx]; n++; } B[y * dw + x] = s / n; }
  const c = canvas(dw, dh); const cx = ctx2d(c); const img = cx.createImageData(dw, dh); const k = 6;
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
    const g = (xx, yy) => B[Math.min(dh - 1, Math.max(0, yy)) * dw + Math.min(dw - 1, Math.max(0, xx))];
    const dx = (g(x + 1, y) - g(x - 1, y)) * 0.5 * k * dw / 100, dyDown = (g(x, y + 1) - g(x, y - 1)) * 0.5 * k * dh / 100;
    let nx = -dx, ny = dyDown, nz = 1; const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l; // ny: uv space is y-up
    const p = (y * dw + x) * 4; img.data[p] = (nx * 0.5 + 0.5) * 255; img.data[p + 1] = (ny * 0.5 + 0.5) * 255; img.data[p + 2] = (nz * 0.5 + 0.5) * 255; img.data[p + 3] = B[y * dw + x] * 255;
  }
  cx.putImageData(img, 0, 0); return { engine: r.engine, canvas: c };
}
