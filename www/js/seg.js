// On-device person segmentation with MediaPipe Tasks (bundled, offline).
import { FilesetResolver, ImageSegmenter } from '../vendor/mediapipe/vision_bundle.mjs';

let fileset = null;
const cache = {};

export const MODELS = {
  quality: { file: 'models/selfie_multiclass_256x256.tflite', multiclass: true },
  fast: { file: 'models/selfie_segmenter.tflite', multiclass: false },
};

async function create(kind, mode) {
  const key = kind + ':' + mode;
  if (cache[key]) return cache[key];
  if (!fileset) fileset = await FilesetResolver.forVisionTasks(new URL('../vendor/mediapipe/wasm', import.meta.url).href);
  const m = MODELS[kind];
  const base = { modelAssetPath: new URL('../' + m.file, import.meta.url).href };
  let seg = null, lastErr;
  for (const delegate of (globalThis.PS_FORCE_CPU ? ['CPU'] : ['GPU', 'CPU'])) {
    try {
      seg = await ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { ...base, delegate }, runningMode: mode,
        outputCategoryMask: false, outputConfidenceMasks: true,
      });
      seg.delegate = delegate;
      break;
    } catch (e) { lastErr = e; }
  }
  if (!seg) throw lastErr || new Error('Segmenter failed to load');
  cache[key] = { seg, multiclass: m.multiclass, delegate: seg.delegate };
  return cache[key];
}

function toPersonMask(result, multiclass) {
  const masks = result.confidenceMasks;
  const m = masks[0];
  const w = m.width, h = m.height;
  const f = m.getAsFloat32Array();
  const out = new Uint8Array(w * h);
  if (multiclass) {
    for (let i = 0; i < f.length; i++) out[i] = Math.max(0, Math.min(255, Math.round((1 - f[i]) * 255)));
  } else {
    for (let i = 0; i < f.length; i++) out[i] = Math.max(0, Math.min(255, Math.round(f[i] * 255)));
  }
  // also expose face/skin probability for the multiclass model (classes: 0 bg,1 hair,2 body-skin,3 face-skin,4 clothes,5 others)
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

// Photo: high quality multiclass model.
export async function segmentImage(source, kind = 'quality') {
  const { seg, multiclass } = await create(kind, 'IMAGE');
  const r = seg.segment(source);
  return toPersonMask(r, multiclass);
}

// Video frames: fast model with temporal smoothing to stop flicker.
export class VideoSegmenter {
  constructor(kind = 'fast') { this.kind = kind; this.prev = null; }
  async init() { this.h = await create(this.kind, 'VIDEO'); return this.h.delegate; }
  segment(source, tsMs, smooth = 0.45) {
    // MediaPipe needs strictly increasing timestamps across the segmenter's whole life.
    this.h.clock = Math.max((this.h.clock || 0) + 1, (this.h.base || 0) + tsMs);
    if (tsMs === 0 || this.h.clock < (this.h.base || 0)) this.h.base = this.h.clock;
    const r = this.h.seg.segmentForVideo(source, this.h.clock);
    const m = toPersonMask(r, this.h.multiclass);
    if (this.prev && this.prev.length === m.data.length) {
      const a = 1 - smooth, p = this.prev, d = m.data;
      for (let i = 0; i < d.length; i++) d[i] = Math.round(d[i] * a + p[i] * smooth);
    }
    this.prev = m.data.slice();
    return m;
  }
  reset() { this.prev = null; }
}
