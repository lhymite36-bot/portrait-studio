// Video Studio engine: media sources, frame compositor (transitions, PiP,
// blend modes, shape masks, chroma key, text, captions, keyframes, reframe,
// face zoom, glow outline), audio mixer, generated music/SFX, captions (Whisper,
// downloaded on first use) and MP4 export (H.264 + AAC/Opus).
import { Muxer, ArrayBufferTarget } from '../vendor/mp4-muxer.mjs';
import { layoutClips, activeAt, projectDuration, evalKeyframes, textAnim, groupWords, chunksToWords, pitchShift, denoiseGate, bitrateForSize } from './studio-core.js';
import { videoBitrate } from './grade.js';
import { probeEncoder, demux, drawUpright } from './video.js';
import { segmentImage } from './seg.js';
import { FONTS } from './tools.js';

// ---------- sources ----------
export const sources = new Map();
let srcSeq = 0;
export async function addSource(file, kind) {
  const id = 's' + (++srcSeq) + '_' + Date.now().toString(36);
  const url = URL.createObjectURL(file);
  const s = { id, file, url, kind: kind || (file.type.startsWith('image') ? 'image' : file.type.startsWith('audio') ? 'audio' : 'video'), name: file.name || 'media', els: [] };
  if (s.kind === 'image') { s.bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }); s.w = s.bitmap.width; s.h = s.bitmap.height; s.duration = 3600; }
  else if (s.kind === 'video') {
    const el = makeVideo(url); await once(el, 'loadeddata', 15000);
    s.w = el.videoWidth; s.h = el.videoHeight; s.duration = el.duration; s.els.push(el);
    // Phones record portrait video as landscape + a rotation flag. If this browser does not
    // apply the flag when drawing, rotate the frames ourselves.
    try {
      const d = await demux(file);
      if (d.rotation && el.videoWidth === d.width && el.videoHeight === d.height) {
        s.rotation = d.rotation; if (d.rotation === 90 || d.rotation === 270) { s.w = el.videoHeight; s.h = el.videoWidth; }
      }
    } catch (e) { /* not an mp4 / no metadata */ }
  } else {
    s.audio = await decodeAudio(file); s.duration = s.audio.duration;
  }
  sources.set(id, s); return s;
}
export function addGeneratedSource(name, audioBuffer) {
  const id = 'g' + (++srcSeq) + '_' + Date.now().toString(36);
  const s = { id, kind: 'audio', name, audio: audioBuffer, duration: audioBuffer.duration, generated: true, els: [] };
  sources.set(id, s); return s;
}
function makeVideo(url) { const v = document.createElement('video'); v.src = url; v.muted = true; v.playsInline = true; v.preload = 'auto'; v.crossOrigin = 'anonymous'; return v; }
function once(el, ev, ms = 8000) { return new Promise((res, rej) => { const t = setTimeout(() => rej(new Error(ev + ' timeout')), ms); el.addEventListener(ev, () => { clearTimeout(t); res(); }, { once: true }); el.addEventListener('error', () => { clearTimeout(t); rej(new Error('Cannot play this file')); }, { once: true }); }); }
function element(src, slot) {
  while (src.els.length <= slot) src.els.push(makeVideo(src.url));
  return src.els[slot];
}
async function seek(el, t) {
  if (el.readyState < 2) await once(el, 'loadeddata', 15000);
  t = Math.max(0, Math.min((el.duration || 0) - 0.001, t));
  if (Math.abs(el.currentTime - t) < 0.0005 && !el.seeking) return;
  el.currentTime = t; await once(el, 'seeked', 8000);
}
let actx = null;
export async function decodeAudio(file) {
  actx = actx || new (globalThis.AudioContext || globalThis.webkitAudioContext)();
  return actx.decodeAudioData(await file.arrayBuffer());
}
export async function sourceAudio(s) {
  if (s.audio !== undefined) return s.audio;
  try { s.audio = await decodeAudio(s.file); } catch (e) { s.audio = null; }
  return s.audio;
}

function upright(src, el, key) {
  if (!src.rotation) return el;
  src.up = src.up || {}; const c = src.up[key] || (src.up[key] = document.createElement('canvas'));
  if (c.width !== src.w || c.height !== src.h) { c.width = src.w; c.height = src.h; }
  drawUpright(c.getContext('2d'), el, src.w, src.h, src.rotation); return c;
}

// ---------- compositor ----------
export function outputSize(p, shortSide = 720) {
  const first = p.clips[0] && sources.get(p.clips[0].srcId);
  const sw = first ? first.w : 1080, sh = first ? first.h : 1920;
  const ar = { '9:16': 9 / 16, '16:9': 16 / 9, '1:1': 1, '4:5': 4 / 5, '3:4': 3 / 4 }[p.aspect] || sw / sh;
  let w, h; if (ar < 1) { w = shortSide; h = shortSide / ar; } else { h = shortSide; w = shortSide * ar; }
  const even = (x) => Math.round(x / 2) * 2; return { width: even(w), height: even(h) };
}

const tmp = () => document.createElement('canvas');
const scratch = { a: tmp(), b: tmp(), key: tmp(), seg: tmp(), glow: tmp() };

// Per-render state for smoothing reframe / face zoom across frames.
export function newRenderState() { return { centers: {}, lastSeg: {} }; }

async function personInfo(src, el, rs, key, T, every) {
  const last = rs.lastSeg[key];
  if (last && Math.abs(T - last.T) < every) return last;
  const c = scratch.seg; c.width = 256; c.height = Math.max(16, Math.round(256 * (src.h / src.w)));
  c.getContext('2d').drawImage(el, 0, 0, c.width, c.height);
  let info = { T, cx: 0.5, cy: 0.4, top: 0.2, found: false, mask: null };
  try {
    const m = await segmentImage(c, 'fast');
    let sx = 0, sy = 0, n = 0, top = 1;
    for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) { const v = m.data[y * m.width + x]; if (v > 128) { sx += x; sy += y; n++; top = Math.min(top, y / m.height); } }
    if (n > m.data.length * 0.01) info = { T, cx: sx / n / m.width, cy: sy / n / m.height, top, found: true, mask: m };
    else info.mask = m;
  } catch (e) { /* no segmenter */ }
  rs.lastSeg[key] = info; return info;
}

function smooth(rs, key, v, k = 0.15) { const o = rs.centers[key]; const n = o == null ? v : o + (v - o) * k; rs.centers[key] = n; return n; }

// Draws a main-track clip frame into ctx covering w x h with reframe/face zoom.
async function drawClipFrame(ctx, it, T, w, h, p, rs, slot, opts) {
  const c = it.clip, src = sources.get(c.srcId); if (!src) return;
  let img, sw = src.w, sh = src.h;
  if (src.kind === 'image') img = src.bitmap;
  else { const el = element(src, slot); await seek(el, it.map(T - it.start)); img = upright(src, el, slot); }
  // cover-fit crop window
  const scale = Math.max(w / sw, h / sh);
  let cw = w / scale, ch = h / scale, cx = sw / 2, cy = sh / 2;
  const needInfo = (p.reframe && (sw / sh) > (w / h) * 1.15) || c.faceZoom || c.glow;
  let info = null;
  if (needInfo && src.kind !== 'image') info = await personInfo(src, img, rs, c.id + ':' + slot, T, opts.preview ? 0.25 : 0.1);
  if (p.reframe && info && info.found) cx = smooth(rs, 'rx' + c.id, info.cx * sw, opts.preview ? 0.5 : 0.12);
  if (c.faceZoom && info && info.found) {
    const k = Math.min(1, (T - it.start) / Math.max(0.3, it.duration * 0.6)); const z = 1 + 0.35 * k * k * (3 - 2 * k);
    cw /= z; ch /= z; cx = cx + (info.cx * sw - cx) * k; cy = cy + ((info.top + 0.12) * sh - cy) * k;
  }
  cx = Math.min(sw - cw / 2, Math.max(cw / 2, cx)); cy = Math.min(sh - ch / 2, Math.max(ch / 2, cy));
  let frame = img;
  if (c.chroma) { frame = chromaKey(img, sw, sh, c.chroma, Math.min(1, 960 / Math.max(sw, sh))); }
  ctx.drawImage(frame, cx - cw / 2, cy - ch / 2, cw, ch, 0, 0, w, h);
  if (c.glow && info && info.mask) drawGlow(ctx, info.mask, c.glow, frame, cx - cw / 2, cy - ch / 2, cw, ch, sw, sh, w, h);
}

// Glow outline: coloured, blurred person silhouette added around the person,
// then the person is redrawn on top so only the rim glows.
function drawGlow(ctx, m, color, frame, sx, sy, sw, sh, W, H, fullW, fullH) {
  const g = scratch.glow; g.width = m.width; g.height = m.height; const x = g.getContext('2d');
  const id = x.createImageData(m.width, m.height);
  for (let i = 0; i < m.data.length; i++) { id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = 255; id.data[i * 4 + 3] = m.data[i]; }
  x.putImageData(id, 0, 0);
  const fx = m.width / W, fy = m.height / H;
  const cut = scratch.cut || (scratch.cut = tmp()); cut.width = fullW; cut.height = fullH; const cx = cut.getContext('2d');
  cx.drawImage(frame, sx, sy, sw, sh, 0, 0, fullW, fullH); cx.globalCompositeOperation = 'destination-in'; cx.drawImage(g, sx * fx, sy * fy, sw * fx, sh * fy, 0, 0, fullW, fullH); cx.globalCompositeOperation = 'source-over';
  const col = scratch.col || (scratch.col = tmp()); col.width = m.width; col.height = m.height; const k = col.getContext('2d');
  k.clearRect(0, 0, col.width, col.height); k.drawImage(g, 0, 0); k.globalCompositeOperation = 'source-in'; k.fillStyle = color || '#22d3ee'; k.fillRect(0, 0, col.width, col.height); k.globalCompositeOperation = 'source-over';
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  for (const b of [0.035, 0.015]) { ctx.filter = `blur(${Math.max(2, Math.round(Math.min(fullW, fullH) * b))}px)`; ctx.drawImage(col, sx * fx, sy * fy, sw * fx, sh * fy, 0, 0, fullW, fullH); }
  ctx.restore();
  ctx.drawImage(cut, 0, 0);
}

// Green screen: returns a canvas with keyed alpha.
export function chromaKey(img, w, h, ck, s = 1) {
  const c = scratch.key; c.width = Math.max(2, Math.round(w * s)); c.height = Math.max(2, Math.round(h * s));
  const x = c.getContext('2d', { willReadFrequently: true }); x.clearRect(0, 0, c.width, c.height); x.drawImage(img, 0, 0, c.width, c.height);
  const d = x.getImageData(0, 0, c.width, c.height); const px = d.data;
  const kr = parseInt(ck.color.slice(1, 3), 16), kg = parseInt(ck.color.slice(3, 5), 16), kb = parseInt(ck.color.slice(5, 7), 16);
  const kcb = -0.1687 * kr - 0.3313 * kg + 0.5 * kb, kcr = 0.5 * kr - 0.4187 * kg - 0.0813 * kb;
  const sim = 20 + ck.similarity * 110, sm = 5 + ck.smooth * 60;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i], g = px[i + 1], b = px[i + 2];
    const cb = -0.1687 * r - 0.3313 * g + 0.5 * b, cr = 0.5 * r - 0.4187 * g - 0.0813 * b;
    const dist = Math.hypot(cb - kcb, cr - kcr);
    const a = Math.max(0, Math.min(1, (dist - sim) / sm));
    px[i + 3] = a * 255;
    if (a < 1 && a > 0 && kg > kr && kg > kb) px[i + 1] = Math.min(g, Math.max(r, b)); // spill suppression
  }
  x.putImageData(d, 0, 0); return c;
}

function transitionDraw(ctx, a, b, k, type, w, h, T) {
  const e = k * k * (3 - 2 * k);
  ctx.save();
  switch (type) {
    case 'fade': ctx.drawImage(a, 0, 0); ctx.globalAlpha = e; ctx.drawImage(b, 0, 0); break;
    case 'zoom': { ctx.drawImage(a, 0, 0); const z = 1.6 - 0.6 * e; ctx.globalAlpha = e; ctx.translate(w / 2, h / 2); ctx.scale(z, z); ctx.drawImage(b, -w / 2, -h / 2); break; }
    case 'slide': ctx.drawImage(a, -w * e, 0); ctx.drawImage(b, w * (1 - e), 0); break;
    case 'whip': {
      const off = w * e; ctx.filter = `blur(${Math.round(Math.sin(Math.PI * k) * w * 0.03)}px)`;
      ctx.drawImage(a, -off, 0); ctx.drawImage(b, w - off, 0); break;
    }
    case 'glitch': {
      ctx.drawImage(k < 0.5 ? a : b, 0, 0);
      const amp = Math.sin(Math.PI * k) * w * 0.04; let seed = Math.floor(T * 30) * 977 + 3; const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      for (let i = 0; i < 9; i++) { const y = r() * h, sh = h * (0.02 + r() * 0.08); ctx.drawImage(k < 0.5 ? b : a, 0, y, w, sh, (r() - 0.5) * amp * 2, y, w, sh); }
      ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.35 * Math.sin(Math.PI * k); ctx.drawImage(b, amp, 0); ctx.drawImage(a, -amp, 0); break;
    }
    default: ctx.drawImage(b, 0, 0);
  }
  ctx.restore();
}

function shapePath(ctx, shape, w, h) {
  ctx.beginPath();
  if (shape === 'circle') ctx.ellipse(0, 0, Math.min(w, h) / 2, Math.min(w, h) / 2, 0, 0, 7);
  else if (shape === 'rounded') ctx.roundRect(-w / 2, -h / 2, w, h, Math.min(w, h) * 0.18);
  else if (shape === 'heart') { const s = Math.min(w, h) / 2; ctx.moveTo(0, s * 0.9); ctx.bezierCurveTo(-s * 1.6, -s * 0.2, -s * 0.6, -s * 1.2, 0, -s * 0.45); ctx.bezierCurveTo(s * 0.6, -s * 1.2, s * 1.6, -s * 0.2, 0, s * 0.9); }
  else if (shape === 'star') { const R = Math.min(w, h) / 2, r = R * 0.45; for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r : R; i ? ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr) : ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr); } ctx.closePath(); }
  else ctx.rect(-w / 2, -h / 2, w, h);
}

async function drawLayer(ctx, L, T, W, H) {
  const src = sources.get(L.srcId); if (!src) return;
  const t = T - L.start; const k = evalKeyframes(L, t);
  let img = src.bitmap, sw = src.w, sh = src.h;
  if (src.kind === 'video') { const el = element(src, 2 + ((L._slot || 0) % 2)); await seek(el, (L.in || 0) + (t % Math.max(0.1, src.duration - (L.in || 0)))); img = upright(src, el, 'L' + L.id); }
  if (L.chroma) img = chromaKey(img, sw, sh, L.chroma, Math.min(1, 720 / Math.max(sw, sh)));
  const bw = W * 0.5 * k.scale, bh = bw * sh / sw;
  ctx.save(); ctx.globalAlpha = Math.max(0, Math.min(1, k.opacity)); ctx.globalCompositeOperation = L.blend || 'source-over';
  ctx.translate(k.x * W, k.y * H); ctx.rotate(k.rot * Math.PI / 180);
  if (L.shape && L.shape !== 'none') { shapePath(ctx, L.shape, bw, bh); ctx.clip(); }
  ctx.drawImage(img, -bw / 2, -bh / 2, bw, bh);
  if (L.border) { ctx.globalCompositeOperation = 'source-over'; ctx.lineWidth = Math.max(2, W * 0.006); ctx.strokeStyle = L.border; shapePath(ctx, L.shape || 'none', bw, bh); ctx.stroke(); }
  ctx.restore();
}

function drawText(ctx, X, T, W, H) {
  const t = T - X.start; const k = evalKeyframes(X, t); const a = textAnim(X.anim, t, X.dur, X.text.length);
  const size = (X.size || 0.07) * Math.min(W, H) * 1.4 * k.scale * a.scale;
  const f = FONTS.find((x) => x.id === X.font) || FONTS[0];
  ctx.save(); ctx.globalAlpha = Math.max(0, Math.min(1, a.alpha * k.opacity));
  ctx.translate((k.x + a.dx) * W, (k.y + a.dy) * H); ctx.rotate(k.rot * Math.PI / 180);
  ctx.font = f.css.replace('{s}', Math.round(size)); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const txt = X.text.slice(0, a.chars); const lines = txt.split('\n');
  if (X.box) { const m = Math.max(...lines.map((l) => ctx.measureText(l).width)); ctx.fillStyle = X.box; ctx.beginPath(); ctx.roundRect(-m / 2 - size * 0.3, -size * 0.65 * lines.length, m + size * 0.6, size * 1.3 * lines.length, size * 0.25); ctx.fill(); }
  if (X.glow) { ctx.shadowColor = X.color; ctx.shadowBlur = size * 0.6; } else { ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = size * 0.12; ctx.shadowOffsetY = size * 0.05; }
  if (X.stroke) { ctx.lineWidth = size * 0.12; ctx.strokeStyle = X.stroke; lines.forEach((l, i) => ctx.strokeText(l, 0, (i - (lines.length - 1) / 2) * size * 1.15)); }
  ctx.fillStyle = X.color || '#fff'; lines.forEach((l, i) => ctx.fillText(l, 0, (i - (lines.length - 1) / 2) * size * 1.15));
  ctx.restore();
}

export const CAPTION_STYLES = [
  { id: 'pop', name: 'Pop' }, { id: 'karaoke', name: 'Karaoke' }, { id: 'boxed', name: 'Boxed' }, { id: 'neon', name: 'Neon' }, { id: 'typewriter', name: 'Typewriter' },
];
function drawCaptions(ctx, cap, T, W, H) {
  if (!cap || !cap.words || !cap.words.length) return;
  const lines = cap._lines || (cap._lines = groupWords(cap.words));
  const line = lines.find((l) => T >= l.start - 0.05 && T <= l.end + 0.25); if (!line) return;
  const size = Math.min(W, H) * (cap.size || 0.075); const y = (cap.y ?? 0.78) * H;
  ctx.save(); ctx.font = `900 ${Math.round(size)}px system-ui, sans-serif`; ctx.textBaseline = 'middle';
  const words = line.words.map((w) => (cap.upper ? w.text.toUpperCase() : w.text));
  const widths = words.map((w) => ctx.measureText(w + ' ').width); const total = widths.reduce((a, b) => a + b, 0);
  let x = W / 2 - total / 2; const hi = cap.color || '#ffd54a';
  if (cap.style === 'boxed') { ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.beginPath(); ctx.roundRect(x - size * 0.4, y - size * 0.75, total + size * 0.5, size * 1.5, size * 0.3); ctx.fill(); }
  line.words.forEach((w, i) => {
    const on = T >= w.start && T < w.end + 0.02, past = T >= w.end;
    if (cap.style === 'typewriter' && T < w.start) { x += widths[i]; return; }
    let s = 1; if (cap.style === 'pop' && on) { const k = Math.min(1, (T - w.start) / 0.12); s = 1 + 0.25 * Math.sin(k * Math.PI); }
    ctx.save(); ctx.translate(x + widths[i] / 2, y); ctx.scale(s, s);
    ctx.lineWidth = size * 0.16; ctx.strokeStyle = '#000'; ctx.lineJoin = 'round';
    if (cap.style === 'neon') { ctx.shadowColor = hi; ctx.shadowBlur = size * (on ? 0.9 : 0.4); ctx.strokeStyle = 'rgba(0,0,0,0)'; }
    ctx.textAlign = 'center'; ctx.strokeText(words[i], 0, 0);
    ctx.fillStyle = (cap.style === 'karaoke' ? (past || on) : on) ? hi : '#fff';
    ctx.fillText(words[i], 0, 0); ctx.restore();
    x += widths[i];
  });
  ctx.restore();
}

/**
 * Renders the whole project at timeline time T into canvas `out` (w x h).
 * opts: { pipe, params, post, preview }
 */
export async function renderFrame(p, T, out, opts = {}) {
  const W = out.width, H = out.height; const ctx = out.getContext('2d');
  const rs = opts.rs || (opts.rs = newRenderState());
  const layout = opts.layout || layoutClips(p.clips);
  ctx.fillStyle = p.bg || '#000'; ctx.fillRect(0, 0, W, H);
  const act = activeAt(layout, T);
  const A = scratch.a, B = scratch.b; for (const c of [A, B]) if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
  const look = async (canvas) => {
    if (!p.useLook || !opts.pipe) return canvas;
    opts.pipe.setSource(canvas, W, H, 0);
    if (opts.params.portrait.enabled) { try { const m = await segmentImage(canvas, 'fast'); opts.pipe.setMask(m.data, m.width, m.height); } catch (e) { /* ignore */ } }
    opts.pipe.render(opts.params, W, H, { quality: 'low', post: opts.post });
    return opts.pipe.canvas;
  };
  if (act.length === 2 && act[1].trans > 0) {
    const [ia, ib] = act; const ax = A.getContext('2d'), bx = B.getContext('2d');
    ax.fillStyle = bx.fillStyle = p.bg || '#000'; ax.fillRect(0, 0, W, H); bx.fillRect(0, 0, W, H);
    await drawClipFrame(ax, ia, T, W, H, p, rs, ia.index % 2, opts);
    await drawClipFrame(bx, ib, T, W, H, p, rs, ib.index % 2, opts);
    const k = (T - ib.start) / ib.trans;
    const tmpc = scratch.seg2 || (scratch.seg2 = tmp()); tmpc.width = W; tmpc.height = H;
    transitionDraw(tmpc.getContext('2d'), A, B, Math.min(1, Math.max(0, k)), ib.clip.transition.type, W, H, T);
    ctx.drawImage(await look(tmpc), 0, 0);
  } else if (act.length) {
    const ax = A.getContext('2d'); ax.fillStyle = p.bg || '#000'; ax.fillRect(0, 0, W, H);
    await drawClipFrame(ax, act[0], T, W, H, p, rs, act[0].index % 2, opts);
    ctx.drawImage(await look(A), 0, 0);
  }
  for (const L of p.layers || []) if (T >= L.start && T < L.start + L.dur) await drawLayer(ctx, L, T, W, H);
  for (const X of p.texts || []) if (T >= X.start && T < X.start + X.dur) drawText(ctx, X, T, W, H);
  drawCaptions(ctx, p.captions, T, W, H);
  if (opts.overlayHook) opts.overlayHook(ctx, W, H, T);
}

// ---------- audio ----------
const SR = 48000;
function resampleByMap(buf, it, sr, ch) {
  const len = Math.ceil(it.duration * sr); const out = new Float32Array(len); const d = buf.getChannelData(Math.min(ch, buf.numberOfChannels - 1)); const bsr = buf.sampleRate;
  for (let i = 0; i < len; i++) { const s = it.map(i / sr) * bsr; const j = Math.floor(s); if (j < 0 || j + 1 >= d.length) continue; const k = s - j; out[i] = d[j] * (1 - k) + d[j + 1] * k; }
  return out;
}
export function voiceFx(x, type, sr) {
  if (type === 'chipmunk') return pitchShift(x, 1.6, sr);
  if (type === 'deep') return pitchShift(x, 0.72, sr);
  if (type === 'robot') { const o = new Float32Array(x.length); for (let i = 0; i < x.length; i++) o[i] = x[i] * Math.sin(2 * Math.PI * 55 * i / sr) * 1.6; return o; }
  if (type === 'echo') { const o = Float32Array.from(x); const D = Math.round(sr * 0.22); for (let i = D; i < o.length; i++) o[i] += o[i - D] * 0.45; return o; }
  if (type === 'telephone') { const o = new Float32Array(x.length); let lp = 0, hp = 0, prev = 0; for (let i = 0; i < x.length; i++) { lp += (x[i] - lp) * 0.35; hp = 0.92 * (hp + lp - prev); prev = lp; o[i] = Math.tanh(hp * 2.5) * 0.7; } return o; }
  return x;
}

export async function mixAudio(p, duration, onProgress) {
  const len = Math.max(1, Math.ceil(duration * SR)); const L = new Float32Array(len), R = new Float32Array(len);
  const add = (chs, start, gain, fadeIn = 0, fadeOut = 0) => {
    const o = Math.round(start * SR); const n = chs[0].length;
    for (let i = 0; i < n; i++) { const j = o + i; if (j < 0 || j >= len) continue; let g = gain; if (fadeIn && i < fadeIn * SR) g *= i / (fadeIn * SR); if (fadeOut && n - i < fadeOut * SR) g *= (n - i) / (fadeOut * SR); L[j] += chs[0][i] * g; R[j] += (chs[1] || chs[0])[i] * g; }
  };
  const layout = layoutClips(p.clips); let k = 0;
  for (const it of layout.items) {
    const c = it.clip; const src = sources.get(c.srcId); k++;
    if (!src || src.kind !== 'video' || c.freeze || (c.volume ?? 1) <= 0) continue;
    const buf = await sourceAudio(src); if (!buf) continue;
    let chs = [resampleByMap(buf, it, SR, 0), resampleByMap(buf, it, SR, 1)];
    if (c.denoise) chs = chs.map((x) => denoiseGate(hpLp(x, SR), SR, 0.85));
    if (c.voice && c.voice !== 'none') chs = chs.map((x) => voiceFx(x, c.voice, SR));
    add(chs, it.start, c.volume ?? 1, it.trans, 0.02);
    if (onProgress) onProgress(k / layout.items.length);
  }
  for (const a of p.audios || []) {
    const src = sources.get(a.srcId); if (!src || !src.audio) continue;
    const b = src.audio; const n = Math.ceil(a.dur * SR); const chs = [];
    for (let ch = 0; ch < 2; ch++) { const d = b.getChannelData(Math.min(ch, b.numberOfChannels - 1)); const o = new Float32Array(n); const r = b.sampleRate / SR; const off = (a.in || 0) * b.sampleRate; for (let i = 0; i < n; i++) { const s = off + i * r; const j = Math.floor(s) % d.length; o[i] = d[j]; } chs.push(o); }
    let out = chs; if (a.voice && a.voice !== 'none') out = out.map((x) => voiceFx(x, a.voice, SR)); if (a.denoise) out = out.map((x) => denoiseGate(hpLp(x, SR), SR, 0.85));
    add(out, a.start, a.volume ?? 1, a.fade ? 0.6 : 0.01, a.fade ? 1.2 : 0.02);
  }
  // soft limiter
  for (let i = 0; i < len; i++) { L[i] = Math.tanh(L[i] * 1.05); R[i] = Math.tanh(R[i] * 1.05); }
  return [L, R];
}
function hpLp(x, sr) { const o = new Float32Array(x.length); let hp = 0, prev = 0, lp = 0; const a = Math.exp(-2 * Math.PI * 90 / sr), b = 1 - Math.exp(-2 * Math.PI * 7500 / sr); for (let i = 0; i < x.length; i++) { hp = a * (hp + x[i] - prev); prev = x[i]; lp += (hp - lp) * b; o[i] = lp; } return o; }

async function pickAudioEncoder() {
  for (const codec of ['mp4a.40.2', 'opus']) {
    const cfg = { codec, sampleRate: SR, numberOfChannels: 2, bitrate: 128000 };
    try { if ((await AudioEncoder.isConfigSupported(cfg)).supported) return { cfg, mux: codec === 'opus' ? 'opus' : 'aac' }; } catch (e) { /* next */ }
  }
  return null;
}

// ---------- export ----------
export async function exportProject(p, o) {
  const duration = projectDuration(p);
  if (duration <= 0) throw new Error('Add a video or photo to the timeline first.');
  const fps = o.fps || 30; const { width, height } = outputSize(p, o.shortSide || 720);
  const enc = await probeEncoder(width, height, fps);
  if (!enc) throw new Error(`This phone can't encode ${width}×${height}. Pick a lower resolution.`);
  const vb = o.sizeMB ? bitrateForSize(o.sizeMB, duration) : videoBitrate(width, height, fps);
  enc.bitrate = vb;
  const aenc = await pickAudioEncoder();
  const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: 'avc', width, height }, audio: aenc ? { codec: aenc.mux, numberOfChannels: 2, sampleRate: SR } : undefined, fastStart: 'in-memory', firstTimestampBehavior: 'offset' });
  let err = null;
  const ve = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: (e) => (err = e) }); ve.configure(enc);
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const layout = layoutClips(p.clips); const opts = { pipe: o.pipe, params: o.params, post: o.post, layout, rs: newRenderState(), overlayHook: o.overlayHook };
  const total = Math.max(1, Math.round(duration * fps)); const t0 = performance.now();
  try {
    for (let i = 0; i < total; i++) {
      if (o.signal && o.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      if (err) throw err;
      const T = i / fps;
      await renderFrame(p, T, canvas, opts);
      while (ve.encodeQueueSize > 3) await new Promise((r) => setTimeout(r, 4));
      const vf = new VideoFrame(canvas, { timestamp: Math.round(T * 1e6), duration: Math.round(1e6 / fps) });
      ve.encode(vf, { keyFrame: i % (fps * 2) === 0 }); vf.close();
      if (o.onProgress && i % 3 === 0) { const el = (performance.now() - t0) / 1000; o.onProgress({ stage: 'video', done: i + 1, total, fps: (i + 1) / el, eta: (total - i - 1) / ((i + 1) / el) }); }
    }
    await ve.flush(); if (err) throw err;
    let audio = false;
    if (aenc) {
      if (o.onProgress) o.onProgress({ stage: 'audio', done: total, total, fps: 0, eta: 0 });
      const [Lc, Rc] = await mixAudio(p, duration);
      let aerr = null; const ae = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: (e) => (aerr = e) });
      ae.configure(aenc.cfg); const F = 1024;
      for (let i = 0; i < Lc.length; i += F) {
        const n = Math.min(F, Lc.length - i); const data = new Float32Array(n * 2); data.set(Lc.subarray(i, i + n), 0); data.set(Rc.subarray(i, i + n), n);
        const ad = new AudioData({ format: 'f32-planar', sampleRate: SR, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round(i / SR * 1e6), data });
        ae.encode(ad); ad.close();
        if (ae.encodeQueueSize > 20) await new Promise((r) => setTimeout(r, 1));
      }
      await ae.flush(); if (aerr) throw aerr; audio = true;
    }
    muxer.finalize();
    return { blob: new Blob([muxer.target.buffer], { type: 'video/mp4' }), width, height, fps, duration, frames: total, seconds: (performance.now() - t0) / 1000, audio, audioCodec: aenc ? aenc.mux : null, bitrate: vb };
  } finally { try { ve.close(); } catch (e) { /* closed */ } }
}

// ---------- generated, royalty-free (CC0) music + SFX ----------
export const MUSIC = [
  { id: 'lofi', name: 'Lo-fi Chill', bpm: 82 }, { id: 'pop', name: 'Upbeat Pop', bpm: 120 }, { id: 'trap', name: 'Trap Bounce', bpm: 140 },
  { id: 'cine', name: 'Cinematic Pulse', bpm: 96 }, { id: 'synth', name: 'Synthwave Drive', bpm: 110 }, { id: 'house', name: 'Deep House', bpm: 124 },
];
export const SFX = [
  { id: 'whoosh', name: 'Whoosh' }, { id: 'pop', name: 'Pop' }, { id: 'click', name: 'Click' }, { id: 'boom', name: 'Boom' },
  { id: 'riser', name: 'Riser' }, { id: 'ding', name: 'Ding' }, { id: 'shutter', name: 'Shutter' }, { id: 'swoosh', name: 'Swoosh' },
];
function noiseBuf(ctx, sec) { const b = ctx.createBuffer(1, Math.ceil(sec * ctx.sampleRate), ctx.sampleRate); const d = b.getChannelData(0); let s = 1; for (let i = 0; i < d.length; i++) { s = (s * 16807) % 2147483647; d[i] = s / 1073741823.5 - 1; } return b; }
export async function makeMusic(id, seconds = 30) {
  const m = MUSIC.find((x) => x.id === id) || MUSIC[0]; const ctx = new OfflineAudioContext(2, Math.ceil(seconds * SR), SR);
  const beat = 60 / m.bpm; const master = ctx.createGain(); master.gain.value = 0.55; master.connect(ctx.destination);
  const nb = noiseBuf(ctx, 1);
  const kick = (t, v = 1) => { const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.12); g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.35); o.connect(g).connect(master); o.start(t); o.stop(t + 0.4); };
  const hat = (t, v = 0.25) => { const s = ctx.createBufferSource(); s.buffer = nb; const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 7000; const g = ctx.createGain(); g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.05); s.connect(f).connect(g).connect(master); s.start(t); s.stop(t + 0.06); };
  const snare = (t, v = 0.5) => { const s = ctx.createBufferSource(); s.buffer = nb; const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1800; const g = ctx.createGain(); g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.18); s.connect(f).connect(g).connect(master); s.start(t); s.stop(t + 0.2); };
  const note = (t, f, d, type = 'sawtooth', v = 0.08, cut = 1800) => { const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = cut; const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(v, t + 0.02); g.gain.setValueAtTime(v, t + d * 0.7); g.gain.linearRampToValueAtTime(0, t + d); o.connect(lp).connect(g).connect(master); o.start(t); o.stop(t + d + 0.05); };
  const hz = (n) => 440 * Math.pow(2, (n - 69) / 12);
  const prog = { lofi: [[57, 60, 64, 67], [53, 57, 60, 64], [55, 59, 62, 65], [52, 55, 59, 62]], pop: [[60, 64, 67], [55, 59, 62], [57, 60, 64], [53, 57, 60]], trap: [[57, 60, 64], [57, 60, 64], [53, 57, 60], [55, 58, 62]], cine: [[50, 57, 62], [46, 53, 58], [53, 57, 60], [48, 55, 60]], synth: [[57, 64, 69], [53, 60, 65], [48, 55, 60], [55, 62, 67]], house: [[57, 60, 64, 67], [57, 60, 64, 67], [55, 59, 62, 65], [53, 57, 60, 64]] }[m.id];
  const bars = Math.ceil(seconds / (beat * 4));
  for (let b = 0; b < bars; b++) {
    const t0 = b * beat * 4; const ch = prog[b % prog.length];
    ch.forEach((n) => note(t0, hz(n), beat * 4, m.id === 'lofi' ? 'triangle' : 'sawtooth', m.id === 'cine' ? 0.05 : 0.04, m.id === 'synth' ? 2500 : 1400));
    note(t0, hz(ch[0] - 24), beat * 2, 'sine', 0.22, 400); note(t0 + beat * 2, hz(ch[0] - 24), beat * 2, 'sine', 0.22, 400);
    for (let q = 0; q < 4; q++) {
      const t = t0 + q * beat;
      if (m.id === 'house' || m.id === 'pop' || m.id === 'synth') kick(t);
      else if (m.id === 'trap') { if (q === 0 || q === 2) kick(t); if (q === 1) kick(t + beat * 0.75, 0.7); }
      else if (m.id === 'cine') { kick(t, q === 0 ? 1 : 0.5); }
      else if (q % 2 === 0) kick(t, 0.8);
      if (q === 1 || q === 3) snare(t, m.id === 'cine' ? 0.25 : 0.45);
      const hats = m.id === 'trap' ? 4 : 2; for (let h = 0; h < hats; h++) hat(t + h * beat / hats, m.id === 'lofi' ? 0.12 : 0.2);
      if (m.id === 'synth' || m.id === 'cine') note(t, hz(ch[(q + b) % ch.length] + 12), beat * 0.5, 'square', 0.03, 3000);
    }
  }
  return ctx.startRendering();
}
export async function makeSfx(id) {
  const dur = { riser: 2.2, boom: 1.5, whoosh: 0.7, swoosh: 0.5 }[id] || 0.5;
  const ctx = new OfflineAudioContext(2, Math.ceil(dur * SR), SR); const g = ctx.createGain(); g.connect(ctx.destination);
  const nb = noiseBuf(ctx, dur);
  if (id === 'whoosh' || id === 'swoosh' || id === 'riser') {
    const s = ctx.createBufferSource(); s.buffer = nb; const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = id === 'riser' ? 6 : 1.5;
    f.frequency.setValueAtTime(id === 'riser' ? 300 : 400, 0); f.frequency.exponentialRampToValueAtTime(id === 'riser' ? 6000 : 3500, dur * 0.8);
    g.gain.setValueAtTime(0.001, 0); g.gain.exponentialRampToValueAtTime(0.9, dur * (id === 'riser' ? 0.95 : 0.4)); g.gain.exponentialRampToValueAtTime(0.001, dur);
    s.connect(f).connect(g); s.start(0);
  } else if (id === 'boom') {
    const o = ctx.createOscillator(); o.frequency.setValueAtTime(90, 0); o.frequency.exponentialRampToValueAtTime(30, 1.2); g.gain.setValueAtTime(1, 0); g.gain.exponentialRampToValueAtTime(0.001, 1.5); o.connect(g); o.start(0);
    const s = ctx.createBufferSource(); s.buffer = nb; const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 900; const g2 = ctx.createGain(); g2.gain.setValueAtTime(0.6, 0); g2.gain.exponentialRampToValueAtTime(0.001, 0.4); s.connect(f).connect(g2).connect(ctx.destination); s.start(0);
  } else if (id === 'pop' || id === 'click') {
    const o = ctx.createOscillator(); o.frequency.setValueAtTime(id === 'pop' ? 900 : 2500, 0); o.frequency.exponentialRampToValueAtTime(id === 'pop' ? 200 : 1200, 0.06); g.gain.setValueAtTime(0.8, 0); g.gain.exponentialRampToValueAtTime(0.001, id === 'pop' ? 0.12 : 0.03); o.connect(g); o.start(0);
  } else if (id === 'ding') {
    [1, 2.76, 5.4].forEach((m, i) => { const o = ctx.createOscillator(); o.frequency.value = 1320 * m; const gg = ctx.createGain(); gg.gain.setValueAtTime(0.4 / (i + 1), 0); gg.gain.exponentialRampToValueAtTime(0.001, 0.5); o.connect(gg).connect(ctx.destination); o.start(0); });
  } else if (id === 'shutter') {
    [0, 0.07].forEach((t) => { const s = ctx.createBufferSource(); s.buffer = nb; const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 2500; const gg = ctx.createGain(); gg.gain.setValueAtTime(0.8, t); gg.gain.exponentialRampToValueAtTime(0.001, t + 0.05); s.connect(f).connect(gg).connect(ctx.destination); s.start(t, 0, 0.06); });
  }
  return ctx.startRendering();
}

// ---------- captions (Whisper, downloaded on first use) ----------
let asr = null;
export async function transcribe(p, onProgress, language) {
  const dur = projectDuration(p);
  const [Lc, Rc] = await mixAudio({ ...p, audios: [] }, dur);
  // 16 kHz mono for Whisper
  const n = Math.floor(Lc.length / 3); const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) mono[i] = (Lc[i * 3] + Rc[i * 3]) * 0.5;
  if (!asr) {
    const tf = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.1/dist/transformers.min.js');
    tf.env.allowLocalModels = false;
    asr = await tf.pipeline('automatic-speech-recognition', 'onnx-community/whisper-tiny_timestamped', {
      dtype: 'q8', device: 'wasm',
      progress_callback: (e) => { if (onProgress && e.status === 'progress' && e.total) onProgress({ stage: 'download', file: e.file, f: e.loaded / e.total }); },
    });
  }
  if (onProgress) onProgress({ stage: 'transcribe', f: 0 });
  const opts = { return_timestamps: 'word', chunk_length_s: 30, stride_length_s: 5 };
  if (language && language !== 'auto') opts.language = language;
  const r = await asr(mono, opts);
  let words = (r.chunks || []).map((c) => ({ text: String(c.text).trim(), start: c.timestamp[0], end: c.timestamp[1] ?? c.timestamp[0] + 0.3 })).filter((w) => w.text);
  if (!words.length && r.text) words = chunksToWords([{ text: r.text, timestamp: [0, dur] }]);
  return { text: r.text, words };
}
