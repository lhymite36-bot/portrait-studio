// CPU-side image tools: inpainting (eraser / blemish / scratch repair), old
// photo auto-levels, sky detection, procedural skies, overlays (text, stickers,
// light leaks, film dust) and on-demand face landmarks.

// ---------- inpainting ----------
// Pyramid push-pull fill followed by detail transfer from a nearby clean patch.
// rgba: Uint8ClampedArray (w*h*4), mask: Uint8Array (w*h, >0 = fill).
export function inpaint(rgba, mask, w, h) {
  // work inside the bounding box + margin only
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return 0;
  const pad = Math.max(16, Math.round(Math.max(x1 - x0, y1 - y0) * 0.6));
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
  const W = x1 - x0 + 1, H = y1 - y0 + 1;
  const levels = [];
  let cur = { w: W, h: H, c: new Float32Array(W * H * 3), a: new Float32Array(W * H) };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const si = ((y + y0) * w + (x + x0)), di = y * W + x;
    const known = mask[si] ? 0 : 1; cur.a[di] = known;
    for (let k = 0; k < 3; k++) cur.c[di * 3 + k] = rgba[si * 4 + k] * known;
  }
  levels.push(cur);
  while (cur.w > 2 && cur.h > 2) {
    const nw = Math.ceil(cur.w / 2), nh = Math.ceil(cur.h / 2);
    const n = { w: nw, h: nh, c: new Float32Array(nw * nh * 3), a: new Float32Array(nw * nh) };
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      let a = 0; const c = [0, 0, 0];
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const sx = Math.min(cur.w - 1, x * 2 + dx), sy = Math.min(cur.h - 1, y * 2 + dy), i = sy * cur.w + sx;
        a += cur.a[i]; c[0] += cur.c[i * 3]; c[1] += cur.c[i * 3 + 1]; c[2] += cur.c[i * 3 + 2];
      }
      const i = y * nw + x; n.a[i] = a / 4; n.c[i * 3] = c[0] / 4; n.c[i * 3 + 1] = c[1] / 4; n.c[i * 3 + 2] = c[2] / 4;
    }
    levels.push(n); cur = n;
  }
  // pull: fill holes from coarser level (bilinear)
  for (let l = levels.length - 2; l >= 0; l--) {
    const f = levels[l], c = levels[l + 1];
    for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) {
      const i = y * f.w + x; const a = f.a[i];
      if (a >= 0.999) continue;
      const fx = Math.min(c.w - 1.001, Math.max(0, x / 2 - 0.25)), fy = Math.min(c.h - 1.001, Math.max(0, y / 2 - 0.25));
      const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
      const ix1 = Math.min(c.w - 1, ix + 1), iy1 = Math.min(c.h - 1, iy + 1);
      const idx = [iy * c.w + ix, iy * c.w + ix1, iy1 * c.w + ix, iy1 * c.w + ix1], wt = [(1 - tx) * (1 - ty), tx * (1 - ty), (1 - tx) * ty, tx * ty];
      let ca = 0; const cc = [0, 0, 0];
      for (let k = 0; k < 4; k++) { ca += c.a[idx[k]] * wt[k]; for (let j = 0; j < 3; j++) cc[j] += c.c[idx[k] * 3 + j] * wt[k]; }
      // normalised coarse colour fills the missing weight
      for (let j = 0; j < 3; j++) f.c[i * 3 + j] = f.c[i * 3 + j] + (1 - a) * (ca > 1e-6 ? cc[j] / ca : 0);
      f.a[i] = 1;
    }
  }
  const out = levels[0];
  // detail transfer: add high-frequency texture from the closest clean region in a ring around the hole
  const R = Math.max(4, Math.round(Math.max(x1 - x0 - 2 * pad, y1 - y0 - 2 * pad) * 0.6) + 6);
  let filled = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const si = (y + y0) * w + (x + x0); if (!mask[si]) continue;
    let detail = [0, 0, 0];
    for (const [ox, oy] of [[R, 0], [-R, 0], [0, R], [0, -R]]) {
      const sx = x + x0 + ox, sy = y + y0 + oy;
      if (sx < 1 || sy < 1 || sx >= w - 1 || sy >= h - 1 || mask[sy * w + sx]) continue;
      for (let k = 0; k < 3; k++) {
        const c = rgba[(sy * w + sx) * 4 + k];
        const avg = (rgba[(sy * w + sx - 1) * 4 + k] + rgba[(sy * w + sx + 1) * 4 + k] + rgba[((sy - 1) * w + sx) * 4 + k] + rgba[((sy + 1) * w + sx) * 4 + k]) / 4;
        detail[k] = (c - avg) * 0.8;
      }
      break;
    }
    const di = y * W + x;
    for (let k = 0; k < 3; k++) rgba[si * 4 + k] = Math.max(0, Math.min(255, out.c[di * 3 + k] + detail[k]));
    filled++;
  }
  return filled;
}

// Grows a binary mask by r pixels (box dilation, separable).
export function dilate(mask, w, h, r) {
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) { let run = -1e9; for (let x = 0; x < w; x++) { if (mask[y * w + x]) run = x; tmp[y * w + x] = x - run <= r ? 1 : 0; } run = 1e9; for (let x = w - 1; x >= 0; x--) { if (mask[y * w + x]) run = x; if (run - x <= r) tmp[y * w + x] = 1; } }
  for (let x = 0; x < w; x++) { let run = -1e9; for (let y = 0; y < h; y++) { if (tmp[y * w + x]) run = y; out[y * w + x] = y - run <= r ? 1 : 0; } run = 1e9; for (let y = h - 1; y >= 0; y--) { if (tmp[y * w + x]) run = y; if (run - y <= r) out[y * w + x] = 1; } }
  return out;
}

// ---------- old photo restore ----------
// Finds thin dust/scratch marks: pixels much brighter/darker than their 5x5 median.
export function detectScratches(rgba, w, h, sensitivity = 0.5) {
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = rgba[i * 4] * 0.3 + rgba[i * 4 + 1] * 0.59 + rgba[i * 4 + 2] * 0.11;
  const out = new Uint8Array(w * h); const thr = 40 - 25 * sensitivity; const win = [];
  for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
    win.length = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) win.push(g[(y + dy) * w + x + dx]);
    win.sort((a, b) => a - b);
    if (Math.abs(g[y * w + x] - win[12]) > thr) out[y * w + x] = 1;
  }
  // drop big blobs (real edges) by keeping only pixels with few marked neighbours in a 7x7 area relative to its area
  return out;
}

export function autoLevels(rgba, w, h, strength = 1) {
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  for (let i = 0; i < w * h; i++) for (let k = 0; k < 3; k++) hist[k][rgba[i * 4 + k]]++;
  const n = w * h, lo = [], hi = [];
  for (let k = 0; k < 3; k++) {
    let a = 0, l = 0, hh = 255;
    for (let v = 0; v < 256; v++) { a += hist[k][v]; if (a > n * 0.005) { l = v; break; } }
    a = 0; for (let v = 255; v >= 0; v--) { a += hist[k][v]; if (a > n * 0.005) { hh = v; break; } }
    lo.push(l); hi.push(Math.max(l + 10, hh));
  }
  for (let i = 0; i < w * h; i++) for (let k = 0; k < 3; k++) {
    const v = rgba[i * 4 + k]; const s = ((v - lo[k]) * 255) / (hi[k] - lo[k]);
    rgba[i * 4 + k] = Math.max(0, Math.min(255, v + (s - v) * strength));
  }
  return { lo, hi };
}

export function isMostlyGrey(rgba, w, h) {
  let s = 0, n = 0;
  for (let i = 0; i < w * h; i += 7) { const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2]; s += Math.max(r, g, b) - Math.min(r, g, b); n++; }
  return s / n < 12;
}

// ---------- sky ----------
// Classical sky segmentation: region-grow from the top edge over smooth,
// bright/bluish pixels that are not the person. Returns a soft mask canvas.
export function detectSky(source, personMask) {
  const W = 256, H = Math.max(16, Math.round(256 * source.height / source.width));
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(source, 0, 0, W, H);
  const px = ctx.getImageData(0, 0, W, H).data;
  const L = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) L[i] = px[i * 4] * 0.3 + px[i * 4 + 1] * 0.59 + px[i * 4 + 2] * 0.11;
  const grad = (i) => { const x = i % W, y = (i / W) | 0; if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) return 0; return Math.abs(L[i + 1] - L[i - 1]) + Math.abs(L[i + W] - L[i - W]); };
  const person = (x, y) => { if (!personMask) return 0; const mx = Math.floor(x / W * personMask.width), my = Math.floor(y / H * personMask.height); return personMask.data[my * personMask.width + mx] / 255; };
  const skyish = (i) => { const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2]; return (b >= r - 10 && L[i] > 70) || L[i] > 170; };
  const seen = new Uint8Array(W * H), out = new Uint8Array(W * H); const q = [];
  // seed with top row pixels that look like sky
  let sum = [0, 0, 0], cnt = 0;
  for (let x = 0; x < W; x++) { const i = x; if (skyish(i) && grad(i + W) < 24 && person(x, 0) < 0.4) { q.push(i); seen[i] = 1; } }
  if (q.length < W * 0.15) return { canvas: null, coverage: 0 };
  for (const i of q) { sum[0] += px[i * 4]; sum[1] += px[i * 4 + 1]; sum[2] += px[i * 4 + 2]; cnt++; }
  while (q.length) {
    const i = q.pop(); out[i] = 1;
    const mean = [sum[0] / cnt, sum[1] / cnt, sum[2] / cnt];
    const x = i % W, y = (i / W) | 0;
    for (const j of [i - 1, i + 1, i - W, i + W]) {
      if (j < 0 || j >= W * H || seen[j]) continue;
      const jx = j % W; if (Math.abs(jx - x) > 1) continue;
      seen[j] = 1;
      const d = Math.abs(px[j * 4] - mean[0]) + Math.abs(px[j * 4 + 1] - mean[1]) + Math.abs(px[j * 4 + 2] - mean[2]);
      if (grad(j) < 20 && d < 120 && person(jx, (j / W) | 0) < 0.4) { q.push(j); sum[0] += px[j * 4]; sum[1] += px[j * 4 + 1]; sum[2] += px[j * 4 + 2]; cnt++; }
    }
  }
  let n = 0; const id = ctx.createImageData(W, H);
  for (let i = 0; i < W * H; i++) { const v = out[i] ? 255 : 0; n += out[i]; id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = v; id.data[i * 4 + 3] = 255; }
  ctx.putImageData(id, 0, 0);
  const soft = document.createElement('canvas'); soft.width = W; soft.height = H;
  const sctx = soft.getContext('2d'); sctx.filter = 'blur(1.5px)'; sctx.drawImage(c, 0, 0);
  return { canvas: soft, coverage: n / (W * H) };
}

export const SKIES = [
  { id: 'sunset', name: 'Sunset' }, { id: 'blue', name: 'Blue sky' }, { id: 'clouds', name: 'Clouds' },
  { id: 'night', name: 'Starry night' }, { id: 'nightglow', name: 'Nightglow' }, { id: 'aurora', name: 'Aurora' },
];
export function drawSky(id, w = 1024, h = 768) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d');
  const grad = (stops) => { const g = x.createLinearGradient(0, 0, 0, h); stops.forEach(([o, col]) => g.addColorStop(o, col)); x.fillStyle = g; x.fillRect(0, 0, w, h); };
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const clouds = (n, col, sz) => { x.filter = `blur(${Math.round(w / 60)}px)`; for (let i = 0; i < n; i++) { x.fillStyle = col; x.beginPath(); x.ellipse(rnd() * w, rnd() * h * 0.7, sz * w * (0.5 + rnd()), sz * h * 0.35 * (0.5 + rnd()), 0, 0, 7); x.fill(); } x.filter = 'none'; };
  const stars = (n) => { for (let i = 0; i < n; i++) { const r = rnd() * 1.6 + 0.3; x.fillStyle = `rgba(255,255,255,${0.4 + rnd() * 0.6})`; x.beginPath(); x.arc(rnd() * w, rnd() * h * 0.85, r, 0, 7); x.fill(); } };
  if (id === 'sunset') { grad([[0, '#2b1c5a'], [0.45, '#d9567a'], [0.75, '#ff9a56'], [1, '#ffd38a']]); clouds(14, 'rgba(255,170,140,0.35)', 0.12); }
  else if (id === 'blue') { grad([[0, '#2f6fd6'], [0.6, '#79b4ef'], [1, '#d4ecff']]); clouds(6, 'rgba(255,255,255,0.5)', 0.1); }
  else if (id === 'clouds') { grad([[0, '#5d84c4'], [1, '#cfe3f7']]); clouds(30, 'rgba(255,255,255,0.65)', 0.14); }
  else if (id === 'night') { grad([[0, '#02030b'], [0.7, '#0b1640'], [1, '#1d2b63']]); stars(420); x.fillStyle = '#fff8e0'; x.shadowColor = '#fff3c4'; x.shadowBlur = 40; x.beginPath(); x.arc(w * 0.78, h * 0.2, w * 0.035, 0, 7); x.fill(); x.shadowBlur = 0; }
  else if (id === 'nightglow') { grad([[0, '#060a2a'], [0.55, '#142a7a'], [1, '#3a5bd8']]); stars(260); x.filter = `blur(${w / 25}px)`; x.fillStyle = 'rgba(255,120,200,0.35)'; x.beginPath(); x.arc(w * 0.3, h * 0.75, w * 0.25, 0, 7); x.fill(); x.fillStyle = 'rgba(80,220,255,0.3)'; x.beginPath(); x.arc(w * 0.75, h * 0.6, w * 0.22, 0, 7); x.fill(); x.filter = 'none'; }
  else if (id === 'aurora') { grad([[0, '#020611'], [1, '#0c2236']]); stars(200); x.filter = `blur(${w / 30}px)`; for (let i = 0; i < 5; i++) { x.strokeStyle = `rgba(${60 + i * 20},255,${170 - i * 15},0.35)`; x.lineWidth = h * 0.08; x.beginPath(); x.moveTo(0, h * (0.3 + i * 0.07)); x.bezierCurveTo(w * 0.3, h * (0.1 + i * 0.05), w * 0.6, h * (0.55 - i * 0.03), w, h * (0.25 + i * 0.06)); x.stroke(); } x.filter = 'none'; }
  return c;
}

// ---------- overlays ----------
export const STICKERS = ['✨', '❤️', '🔥', '⭐', '😎', '🌙', '🎉', '🌸', '💫', '🦋', '👑', '😂', '🥳', '💖', '🎬', '📸'];
export const FONTS = [
  { id: 'sans', css: '800 {s}px system-ui, sans-serif', name: 'Bold' },
  { id: 'serif', css: 'italic 700 {s}px Georgia, serif', name: 'Serif' },
  { id: 'mono', css: '700 {s}px ui-monospace, monospace', name: 'Mono' },
  { id: 'script', css: 'italic 400 {s}px "Brush Script MT", cursive', name: 'Script' },
];
export const LEAKS = [
  { id: 'none', name: 'None' }, { id: 'amber', name: 'Amber' }, { id: 'rose', name: 'Rose' }, { id: 'cyan', name: 'Cyan' }, { id: 'rainbow', name: 'Prism' },
];

function leakColors(id) {
  return { amber: ['255,150,40', '255,80,20'], rose: ['255,90,140', '255,40,80'], cyan: ['60,220,255', '40,120,255'], rainbow: ['255,80,80', '80,160,255'] }[id];
}

// Draws all overlays onto a 2D context of size w x h. t = seconds (video).
export function drawOverlays(ctx, w, h, ov, t = 0) {
  if (!ov) return;
  const s = Math.min(w, h) / 1000;
  if (ov.leak && ov.leak.id !== 'none' && ov.leak.amount > 0) {
    const [c1, c2] = leakColors(ov.leak.id);
    const ph = t * 0.6;
    ctx.save(); ctx.globalCompositeOperation = 'screen';
    const g = ctx.createRadialGradient(w * (0.1 + 0.08 * Math.sin(ph)), h * (0.15 + 0.05 * Math.cos(ph * 0.7)), 0, w * 0.1, h * 0.15, Math.max(w, h) * 0.7);
    g.addColorStop(0, `rgba(${c1},${0.75 * ov.leak.amount})`); g.addColorStop(0.45, `rgba(${c2},${0.35 * ov.leak.amount})`); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    const g2 = ctx.createLinearGradient(w, 0, w * 0.6, h * 0.4);
    g2.addColorStop(0, `rgba(${c2},${0.45 * ov.leak.amount})`); g2.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g2; ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }
  if (ov.dust > 0) {
    let seed = Math.floor(t * 12) * 7919 + 13; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    ctx.save(); ctx.globalCompositeOperation = 'screen';
    const n = Math.round(ov.dust * 90);
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = `rgba(255,250,235,${0.25 + rnd() * 0.5})`;
      const x = rnd() * w, y = rnd() * h, r = (0.6 + rnd() * 2.4) * s * 1.5;
      if (rnd() < 0.15) { ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = s; ctx.beginPath(); ctx.moveTo(x, y); ctx.quadraticCurveTo(x + rnd() * 40 * s, y + rnd() * 40 * s, x + rnd() * 60 * s, y + rnd() * 20 * s); ctx.stroke(); }
      else { ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill(); }
    }
    if (rnd() < ov.dust * 0.6) { ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.fillRect(rnd() * w, 0, Math.max(1, s * 1.2), h); }
    ctx.restore();
  }
  for (const it of ov.items || []) {
    if (it.from != null && (t < it.from || t > it.to)) continue;
    const size = it.size * 1000 * s;
    ctx.save(); ctx.translate(it.x * w, it.y * h); ctx.rotate((it.rot || 0) * Math.PI / 180);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    if (it.type === 'text') {
      const f = FONTS.find((x) => x.id === it.font) || FONTS[0];
      ctx.font = f.css.replace('{s}', Math.round(size));
      if (it.bg) { const m = ctx.measureText(it.text); ctx.fillStyle = it.bg; const pw = m.width + size * 0.6, ph = size * 1.3; ctx.beginPath(); ctx.roundRect(-pw / 2, -ph / 2, pw, ph, size * 0.3); ctx.fill(); }
      if (it.glow) { ctx.shadowColor = it.color; ctx.shadowBlur = size * 0.5; }
      else { ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = size * 0.15; ctx.shadowOffsetY = size * 0.05; }
      ctx.fillStyle = it.color || '#fff';
      const lines = String(it.text).split('\n');
      lines.forEach((ln, i) => ctx.fillText(ln, 0, (i - (lines.length - 1) / 2) * size * 1.15));
    } else {
      ctx.font = `${Math.round(size)}px "Noto Color Emoji", "Apple Color Emoji", sans-serif`;
      ctx.fillText(it.emoji, 0, 0);
    }
    ctx.restore();
  }
}
export function hasOverlays(ov) { return !!ov && ((ov.items && ov.items.length) || (ov.leak && ov.leak.id !== 'none' && ov.leak.amount > 0) || ov.dust > 0); }

// ---------- face landmarks (downloaded on first use, cached) ----------
const FACE_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
let faceLm = null;
export async function cachedFetch(url, onProgress) {
  let cache = null;
  try { cache = await caches.open('ps-models-v1'); const hit = await cache.match(url); if (hit) return new Uint8Array(await hit.arrayBuffer()); } catch (e) { cache = null; }
  const res = await fetch(url);
  if (!res.ok) throw new Error('Download failed (' + res.status + ')');
  const total = +res.headers.get('content-length') || 0; const reader = res.body.getReader(); const parts = []; let got = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); got += value.length; if (onProgress) onProgress(total ? got / total : 0); }
  const buf = new Uint8Array(got); let o = 0; for (const p of parts) { buf.set(p, o); o += p.length; }
  try { if (cache) await cache.put(url, new Response(buf.slice())); } catch (e) { /* quota */ }
  return buf;
}
export async function faceFeatures(source, onProgress) {
  const { FilesetResolver, FaceLandmarker } = await import('../vendor/mediapipe/vision_bundle.mjs');
  if (!faceLm) {
    const fs = await FilesetResolver.forVisionTasks(new URL('../vendor/mediapipe/wasm', import.meta.url).href);
    const buf = await cachedFetch(FACE_URL, onProgress);
    faceLm = await FaceLandmarker.createFromOptions(fs, { baseOptions: { modelAssetBuffer: buf, delegate: 'CPU' }, runningMode: 'IMAGE', numFaces: 4 });
  }
  let faces = faceLm.detect(source).faceLandmarks || [];
  // Group photos: faces are small, so also scan overlapping tiles and merge.
  const W = source.width, H = source.height, T = Math.round(Math.min(W, H) * 0.55);
  const tile = document.createElement('canvas'); tile.width = tile.height = 640;
  const tx = tile.getContext('2d');
  for (let y = 0; y + T <= H + 1; y += Math.round(T * 0.6)) for (let x = 0; x + T <= W + 1; x += Math.round(T * 0.6)) {
    tx.drawImage(source, x, y, T, T, 0, 0, 640, 640);
    for (const f of faceLm.detect(tile).faceLandmarks || []) {
      const g = f.map((p) => ({ x: (x + p.x * T) / W, y: (y + p.y * T) / H, z: p.z }));
      const n = g[1];
      if (!faces.some((o) => Math.hypot(o[1].x - n.x, o[1].y - n.y) < 0.03)) faces.push(g);
    }
  }
  return faces;
}
const LEFT_EYE = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
const RIGHT_EYE = [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398];
const INNER_LIPS = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191];
// Feature texture: red = eyes, green = inner mouth (teeth).
export function featureCanvas(faces, w, h) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d');
  x.fillStyle = '#000'; x.fillRect(0, 0, w, h); x.globalCompositeOperation = 'lighter';
  x.filter = `blur(${Math.max(1, Math.round(Math.min(w, h) / 400))}px)`;
  const poly = (f, idx, col) => { x.fillStyle = col; x.beginPath(); idx.forEach((k, i) => { const p = f[k]; i ? x.lineTo(p.x * w, p.y * h) : x.moveTo(p.x * w, p.y * h); }); x.closePath(); x.fill(); };
  for (const f of faces) { poly(f, LEFT_EYE, '#f00'); poly(f, RIGHT_EYE, '#f00'); poly(f, INNER_LIPS, '#0f0'); }
  return c;
}
