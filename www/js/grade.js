// Portrait Studio: shared parameter model, look presets and a CPU reference
// implementation of the colour pipeline. The GLSL in gl.js mirrors these
// functions; tests/unit checks the maths and tests/headless checks GPU parity.

export const DEFAULTS = Object.freeze({
  portrait: { enabled: true, blur: 0.55, focus: 0, feather: 0.35, bokeh: 0.5 },
  enhance: { sharpen: 0.35, denoise: 0.25, clarity: 0.15, scale: 'orig' },
  adjust: {
    exposure: 0, contrast: 0, highlights: 0, shadows: 0,
    saturation: 0, vibrance: 0, temperature: 0, tint: 0,
  },
  effects: { vignette: 0, grain: 0, fade: 0, glow: 0 },
  look: { id: 'none', intensity: 1 },
});

export function defaultParams() {
  return JSON.parse(JSON.stringify(DEFAULTS));
}

// Each look is parametric (lift/gamma/gain + split toning + saturation/contrast
// + optional mono mixer), which behaves like a 3D LUT without shipping LUT files.
const L = (o) => Object.assign({
  lift: [0, 0, 0], gamma: [1, 1, 1], gain: [1, 1, 1],
  splitShadow: [0, 0, 0], splitHigh: [0, 0, 0],
  sat: 0, contrast: 0, mono: null, fade: 0, glow: 0,
}, o);

export const LOOKS = [
  { id: 'none', name: 'Original', look: L({}) },
  { id: 'cinematic', name: 'Cinematic', look: L({ lift: [0.01, 0.02, 0.04], gamma: [1.0, 1.0, 1.02], gain: [1.03, 1.0, 0.95], splitShadow: [-0.03, 0.0, 0.05], splitHigh: [0.05, 0.02, -0.03], sat: -0.08, contrast: 0.12 }) },
  { id: 'teal-orange', name: 'Teal & Orange', look: L({ splitShadow: [-0.06, 0.02, 0.08], splitHigh: [0.09, 0.03, -0.06], sat: 0.1, contrast: 0.1 }) },
  { id: 'warm', name: 'Warm Glow', look: L({ gain: [1.07, 1.02, 0.9], lift: [0.02, 0.01, 0], splitHigh: [0.04, 0.02, -0.02], sat: 0.06, glow: 0.15 }) },
  { id: 'moody', name: 'Moody', look: L({ lift: [0.0, 0.01, 0.02], gamma: [0.92, 0.95, 0.97], gain: [0.95, 0.96, 1.0], splitShadow: [-0.02, 0.0, 0.04], sat: -0.22, contrast: 0.16 }) },
  { id: 'bw', name: 'B&W', look: L({ mono: [0.30, 0.59, 0.11], contrast: 0.12 }) },
  { id: 'bw-noir', name: 'Noir', look: L({ mono: [0.45, 0.45, 0.10], contrast: 0.35, gamma: [0.92, 0.92, 0.92] }) },
  { id: 'film', name: 'Film', look: L({ lift: [0.04, 0.035, 0.03], gain: [0.98, 0.97, 0.93], splitShadow: [0.0, 0.02, 0.03], splitHigh: [0.04, 0.02, -0.01], sat: -0.1, contrast: -0.04, fade: 0.25 }) },
  { id: 'vibrant', name: 'Nightglow Vibrant', look: L({ lift: [0.0, 0.01, 0.05], splitShadow: [-0.03, 0.0, 0.09], splitHigh: [0.03, 0.01, 0.0], sat: 0.38, contrast: 0.14, glow: 0.35 }) },
  { id: 'cool', name: 'Cool Blue', look: L({ gain: [0.93, 0.99, 1.08], splitShadow: [-0.02, 0.0, 0.05], sat: -0.04 }) },
  { id: 'golden', name: 'Golden Hour', look: L({ gain: [1.1, 1.0, 0.82], splitShadow: [0.02, 0.0, -0.03], splitHigh: [0.06, 0.03, -0.04], sat: 0.12, glow: 0.2 }) },
  { id: 'pastel', name: 'Pastel', look: L({ lift: [0.06, 0.06, 0.07], sat: -0.15, contrast: -0.18, splitHigh: [0.02, 0.0, 0.03] }) },
  { id: 'faded', name: 'Matte', look: L({ lift: [0.07, 0.07, 0.07], contrast: -0.1, sat: -0.05, fade: 0.2 }) },
  { id: 'cyber', name: 'Neon Night', look: L({ splitShadow: [0.05, -0.02, 0.1], splitHigh: [-0.04, 0.05, 0.06], sat: 0.25, contrast: 0.18, glow: 0.3 }) },
];

export function getLook(id) {
  return (LOOKS.find((l) => l.id === id) || LOOKS[0]).look;
}

export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const smoothstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
export const luma = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
export const srgbToLinear = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
export const linearToSrgb = (v) => { v = Math.max(v, 0); return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055; };

// White balance gains used by both CPU and GPU paths.
export function wbGains(temperature, tint) {
  return [1 + 0.22 * temperature + 0.06 * tint, 1 - 0.14 * tint, 1 - 0.22 * temperature + 0.06 * tint];
}

// Maps user portrait controls onto the refined person mask.
export function shapeMask(m, focus, feather) {
  const t = 0.5 - focus * 0.4;
  const f = 0.02 + feather * 0.3;
  return smoothstep(t - f, t + f, m);
}

// Flatten params into the numbers the shader needs (also used by the CPU ref).
export function resolveGrade(params) {
  const a = params.adjust, e = params.effects;
  const k = params.look.intensity;
  const lk = getLook(params.look.id);
  const mix = (x, y) => x + (y - x) * k;
  const mix3 = (x, y) => [mix(x[0], y[0]), mix(x[1], y[1]), mix(x[2], y[2])];
  return {
    exposure: a.exposure,
    wb: wbGains(a.temperature, a.tint),
    contrast: a.contrast + lk.contrast * k,
    highlights: a.highlights, shadows: a.shadows,
    saturation: a.saturation + lk.sat * k, vibrance: a.vibrance,
    lift: mix3([0, 0, 0], lk.lift), gamma: mix3([1, 1, 1], lk.gamma), gain: mix3([1, 1, 1], lk.gain),
    splitShadow: lk.splitShadow.map((v) => v * k), splitHigh: lk.splitHigh.map((v) => v * k),
    mono: lk.mono ? lk.mono : [0, 0, 0], monoAmt: lk.mono ? k : 0,
    fade: clamp01(e.fade + lk.fade * k), glow: clamp01(e.glow + lk.glow * k),
    vignette: e.vignette, grain: e.grain,
  };
}

// CPU reference of the per-pixel grade (without glow / grain, which depend on
// neighbourhood and noise). Input and output are sRGB 0..1.
export function gradePixel(rgb, g, uv = [0.5, 0.5]) {
  let c = rgb.map(srgbToLinear);
  const ex = Math.pow(2, g.exposure);
  c = c.map((v, i) => v * ex * g.wb[i]);
  c = c.map(linearToSrgb).map(clamp01);
  let Y = luma(c);
  const ws = (1 - Y) * (1 - Y), wh = Y * Y;
  c = c.map((v) => clamp01(v + g.shadows * 0.3 * ws + g.highlights * 0.3 * wh));
  c = c.map((v) => clamp01((v - 0.5) * (1 + g.contrast) + 0.5));
  c = c.map((v, i) => clamp01(Math.pow(clamp01(g.gain[i] * (v + g.lift[i] * (1 - v))), 1 / g.gamma[i])));
  Y = luma(c);
  const s2 = (1 - Y) * (1 - Y), h2 = Y * Y;
  c = c.map((v, i) => clamp01(v + g.splitShadow[i] * s2 + g.splitHigh[i] * h2));
  Y = luma(c);
  const mx = Math.max(...c), mn = Math.min(...c);
  const vib = 1 + g.vibrance * (1 - (mx - mn));
  const sat = (1 + g.saturation) * vib;
  c = c.map((v) => clamp01(Y + (v - Y) * sat));
  const m = g.mono[0] * c[0] + g.mono[1] * c[1] + g.mono[2] * c[2];
  c = c.map((v) => v + (m - v) * g.monoAmt);
  c = c.map((v) => v * (1 - 0.18 * g.fade) + 0.09 * g.fade);
  const dx = uv[0] - 0.5, dy = uv[1] - 0.5;
  const d = Math.sqrt(dx * dx + dy * dy) * 1.4142;
  const vig = 1 - g.vignette * 0.75 * smoothstep(0.35, 1.05, d);
  return c.map((v) => clamp01(v * vig));
}

// Output size for photos. scale: 'orig' | '2x' | '4k'. Caps by GPU texture size
// and a pixel budget so budget phones do not run out of memory.
export function computeOutputSize(w, h, scale, maxTex = 8192, maxPixels = 24e6) {
  let f = 1;
  const long = Math.max(w, h);
  if (scale === '2x') f = Math.min(2, Math.max(1, 3840 / long));
  else if (scale === '4k') f = Math.max(1, 3840 / long);
  let W = Math.round(w * f), H = Math.round(h * f);
  const limit = Math.min(maxTex, 16384);
  const s = Math.min(1, limit / Math.max(W, H), Math.sqrt(maxPixels / (W * H)));
  if (s < 1) { W = Math.floor(W * s); H = Math.floor(H * s); }
  return { width: W, height: H, factor: W / w };
}

// Video export size: target short side (720 / 1080 / 0 = original), even dims.
export function computeVideoSize(w, h, shortSide, maxLong = 1920) {
  let s = 1;
  const sh = Math.min(w, h);
  if (shortSide && sh > shortSide) s = shortSide / sh;
  if (Math.max(w, h) * s > maxLong) s = maxLong / Math.max(w, h);
  const even = (x) => Math.max(2, Math.round(x / 2) * 2);
  return { width: even(w * s), height: even(h * s) };
}

export function videoBitrate(w, h, fps) {
  return Math.round(Math.min(16e6, Math.max(2e6, w * h * Math.min(fps || 30, 60) * 0.14)));
}

// Picks an H.264 codec string whose level covers the frame size.
export function avcCodecFor(w, h, fps = 30) {
  const mbs = Math.ceil(w / 16) * Math.ceil(h / 16);
  const rate = mbs * fps;
  if (mbs <= 3600 && rate <= 108000) return 'avc1.42001f'; // L3.1 baseline
  if (mbs <= 8192 && rate <= 245760) return 'avc1.4d0028'; // L4.0 main
  if (mbs <= 8704 && rate <= 522240) return 'avc1.4d002a'; // L4.2
  return 'avc1.640033'; // L5.1 high
}

export function formatEta(sec) {
  if (!isFinite(sec) || sec < 0) return '…';
  sec = Math.round(sec);
  const m = Math.floor(sec / 60), s = sec % 60;
  return m ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}
