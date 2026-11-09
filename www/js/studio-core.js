// Video Studio pure logic (no DOM): timeline maths, speed curves, keyframes,
// beat detection, captions grouping, audio DSP. Unit-tested in Node.

export const SPEED_CURVES = {
  none: null,
  montage: [[0, 1], [0.25, 3], [0.5, 0.4], [0.75, 3], [1, 1]],
  hero: [[0, 1.5], [0.4, 1.5], [0.5, 0.25], [0.65, 0.25], [0.75, 1.5], [1, 1.5]],
  bullet: [[0, 2], [0.45, 2], [0.5, 0.2], [0.7, 0.2], [0.75, 2], [1, 2]],
  flashIn: [[0, 4], [0.3, 4], [0.6, 1], [1, 1]],
  flashOut: [[0, 1], [0.4, 1], [0.7, 4], [1, 4]],
  jumpCut: [[0, 1], [0.48, 1], [0.5, 6], [0.55, 6], [0.57, 1], [1, 1]],
};

export function curveAt(points, u) {
  if (!points) return 1;
  for (let i = 1; i < points.length; i++) {
    if (u <= points[i][0]) { const [u0, s0] = points[i - 1], [u1, s1] = points[i]; const k = (u - u0) / Math.max(1e-9, u1 - u0); const e = k * k * (3 - 2 * k); return s0 + (s1 - s0) * e; }
  }
  return points[points.length - 1][1];
}

// Builds a lookup table that maps clip output time -> source time.
export function buildTimeMap(clip, steps = 256) {
  const len = Math.max(0.01, clip.out - clip.in);
  if (clip.freeze) return { duration: clip.freeze, map: () => clip.in };
  const pts = SPEED_CURVES[clip.curve || 'none'];
  const base = clip.speed || 1;
  if (!pts) {
    const d = len / base;
    return { duration: d, map: (t) => { const u = Math.min(1, Math.max(0, t / d)); return clip.reverse ? clip.out - u * len : clip.in + u * len; } };
  }
  const outT = new Float64Array(steps + 1); let acc = 0;
  for (let i = 1; i <= steps; i++) { const u = (i - 0.5) / steps; acc += (len / steps) / (base * curveAt(pts, u)); outT[i] = acc; }
  const d = acc;
  return {
    duration: d,
    map: (t) => {
      t = Math.min(d, Math.max(0, t));
      let lo = 0, hi = steps; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (outT[m] < t) lo = m; else hi = m; }
      const k = (t - outT[lo]) / Math.max(1e-9, outT[hi] - outT[lo]);
      const u = (lo + k) / steps;
      return clip.reverse ? clip.out - u * len : clip.in + u * len;
    },
  };
}

// Places main-track clips on the timeline (transitions overlap the previous clip).
export function layoutClips(clips) {
  let t = 0; const out = [];
  clips.forEach((c, i) => {
    const tm = buildTimeMap(c);
    const tr = i > 0 && c.transition && c.transition.type !== 'none' ? Math.min(c.transition.dur || 0.5, tm.duration * 0.45, out[i - 1].duration * 0.45) : 0;
    const start = Math.max(0, t - tr);
    out.push({ clip: c, start, duration: tm.duration, end: start + tm.duration, map: tm.map, trans: tr, index: i });
    t = start + tm.duration;
  });
  return { items: out, duration: t };
}

export function projectDuration(p) {
  const l = layoutClips(p.clips);
  let d = l.duration;
  for (const x of [...(p.layers || []), ...(p.texts || []), ...(p.audios || [])]) d = Math.max(d, x.start + x.dur);
  return d;
}

// Which main-track items are visible at time T (1 or 2 during a transition).
export function activeAt(layout, T) {
  const res = [];
  for (const it of layout.items) if (T >= it.start - 1e-6 && T < it.end - 1e-6) res.push(it);
  if (!res.length && layout.items.length && T >= layout.duration - 1e-6) res.push(layout.items[layout.items.length - 1]);
  return res;
}

// Splits clip at timeline time T; returns new clips array.
export function splitAt(clips, T, newId) {
  const l = layoutClips(clips);
  const it = l.items.find((x) => T > x.start + 0.05 && T < x.end - 0.05);
  if (!it || it.clip.freeze) return null;
  const c = it.clip; const src = it.map(T - it.start);
  const a = { ...c, transition: c.transition }, b = { ...c, id: newId(), transition: { type: 'none', dur: 0.5 } };
  if (c.reverse) { a.in = src; b.out = src; } else { a.out = src; b.in = src; }
  if (c.curve && c.curve !== 'none') { a.curve = 'none'; b.curve = 'none'; }
  const arr = clips.slice(); arr.splice(it.index, 1, a, b); return arr;
}

// Keyframe interpolation for overlays and text (times relative to item start).
export const KF_PROPS = ['x', 'y', 'scale', 'rot', 'opacity'];
export function evalKeyframes(item, t) {
  const base = {}; KF_PROPS.forEach((k) => (base[k] = item[k] ?? (k === 'scale' || k === 'opacity' ? 1 : k === 'rot' ? 0 : 0.5)));
  const kf = (item.keyframes || []).slice().sort((a, b) => a.t - b.t);
  if (!kf.length) return base;
  if (t <= kf[0].t) return { ...base, ...pick(kf[0]) };
  if (t >= kf[kf.length - 1].t) return { ...base, ...pick(kf[kf.length - 1]) };
  for (let i = 1; i < kf.length; i++) if (t <= kf[i].t) {
    const a = kf[i - 1], b = kf[i]; const k = (t - a.t) / Math.max(1e-9, b.t - a.t); const e = k * k * (3 - 2 * k);
    const r = { ...base }; KF_PROPS.forEach((p) => { const va = a[p] ?? base[p], vb = b[p] ?? base[p]; r[p] = va + (vb - va) * e; }); return r;
  }
  return base;
}
const pick = (k) => { const o = {}; KF_PROPS.forEach((p) => { if (k[p] != null) o[p] = k[p]; }); return o; };

// Text entry/exit animation -> {alpha, scale, dx, dy, chars}
export function textAnim(anim, t, dur, len) {
  const inT = Math.min(0.4, dur / 3), outT = Math.min(0.3, dur / 4);
  const kin = Math.min(1, t / inT), kout = Math.min(1, (dur - t) / outT);
  const ease = (k) => 1 - Math.pow(1 - Math.max(0, k), 3);
  switch (anim) {
    case 'fade': return { alpha: Math.min(kin, kout), scale: 1, dx: 0, dy: 0, chars: len };
    case 'pop': { const s = kin < 1 ? 0.4 + 0.75 * ease(kin) - 0.15 * Math.sin(kin * Math.PI) : 1; return { alpha: Math.min(1, kin * 2, kout), scale: s, dx: 0, dy: 0, chars: len }; }
    case 'slide': return { alpha: Math.min(kin, kout), scale: 1, dx: 0, dy: (1 - ease(kin)) * 0.08, chars: len };
    case 'typewriter': return { alpha: kout, scale: 1, dx: 0, dy: 0, chars: Math.min(len, Math.floor((t / Math.max(0.3, dur * 0.6)) * len) + 1) };
    default: return { alpha: 1, scale: 1, dx: 0, dy: 0, chars: len };
  }
}

// Caption lines: group words into short lines (<= maxWords, <= maxChars, pause breaks).
export function groupWords(words, maxWords = 4, maxChars = 22) {
  const lines = []; let cur = [];
  for (const w of words) {
    const text = cur.map((x) => x.text).join(' ');
    const gap = cur.length ? w.start - cur[cur.length - 1].end : 0;
    if (cur.length && (cur.length >= maxWords || text.length + w.text.length + 1 > maxChars || gap > 0.6)) { lines.push(cur); cur = []; }
    cur.push(w);
  }
  if (cur.length) lines.push(cur);
  return lines.map((ws) => ({ words: ws, start: ws[0].start, end: ws[ws.length - 1].end }));
}

// Spread chunk-level timestamps into word-level ones (fallback when the model gives chunks only).
export function chunksToWords(chunks) {
  const words = [];
  for (const c of chunks) {
    const parts = String(c.text).trim().split(/\s+/).filter(Boolean); if (!parts.length) continue;
    const [s, e] = c.timestamp; const end = e ?? s + parts.length * 0.35; const total = parts.reduce((a, p) => a + p.length + 1, 0); let t = s;
    for (const p of parts) { const d = (end - s) * (p.length + 1) / total; words.push({ text: p, start: t, end: t + d }); t += d; }
  }
  return words;
}

// ---------- audio DSP ----------
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let j = 0; j < len / 2; j++) { const a = i + j, b = a + len / 2; const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr; re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi; const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t; } }
  }
}

// Beat tracking: spectral-flux onsets -> tempo by autocorrelation -> beat grid.
export function detectBeats(samples, sr) {
  const N = 1024, H = 512, frames = Math.floor((samples.length - N) / H);
  if (frames < 8) return { bpm: 0, beats: [] };
  const flux = new Float32Array(frames); let prev = new Float32Array(N / 2);
  const re = new Float32Array(N), im = new Float32Array(N);
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < N; i++) { re[i] = samples[f * H + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N)); im[i] = 0; }
    fft(re, im); let s = 0; const mag = new Float32Array(N / 2);
    for (let k = 1; k < N / 2; k++) { mag[k] = Math.log1p(Math.hypot(re[k], im[k]) * 10); const d = mag[k] - prev[k]; if (d > 0) s += d; }
    flux[f] = s; prev = mag;
  }
  // normalise + local mean removal
  const w = 8, on = new Float32Array(frames);
  for (let f = 0; f < frames; f++) { let m = 0, n = 0; for (let k = Math.max(0, f - w); k <= Math.min(frames - 1, f + w); k++) { m += flux[k]; n++; } on[f] = Math.max(0, flux[f] - m / n); }
  const fps = sr / H; let best = 0, bestLag = 0;
  for (let bpm = 70; bpm <= 180; bpm += 0.5) {
    const lag = fps * 60 / bpm; let s = 0;
    for (let f = 0; f + lag * 4 < frames; f += 2) s += on[f] * (interp(on, f + lag) + interp(on, f + 2 * lag) * 0.5 + interp(on, f + 4 * lag) * 0.25);
    s *= 1 + 0.08 * Math.exp(-Math.pow((bpm - 120) / 40, 2)); // gentle prior around 120
    if (s > best) { best = s; bestLag = lag; }
  }
  if (!bestLag) return { bpm: 0, beats: [] };
  let bestPhase = 0, bestPS = -1;
  for (let ph = 0; ph < bestLag; ph += 0.5) { let s = 0; for (let f = ph; f < frames; f += bestLag) s += interp(on, f); if (s > bestPS) { bestPS = s; bestPhase = ph; } }
  const beats = []; for (let f = bestPhase; f < frames; f += bestLag) beats.push((f * H + N / 2) / sr);
  return { bpm: Math.round(fps * 60 / bestLag * 10) / 10, beats };
}
function interp(a, x) { const i = Math.floor(x), k = x - i; if (i < 0 || i + 1 >= a.length) return 0; return a[i] * (1 - k) + a[i + 1] * k; }

// Re-cuts the clip material so every cut lands on a beat.
export function beatCut(clips, beats, every = 2, newId) {
  if (beats.length < 2 || !clips.length) return clips;
  const out = []; let ci = 0, srcPos = clips[0].in;
  for (let b = 0; b + every < beats.length && ci < clips.length; b += every) {
    const dur = beats[b + every] - beats[b];
    const c = clips[ci]; const avail = (c.out - srcPos) / (c.speed || 1);
    if (avail < dur * 0.5) { ci++; if (ci >= clips.length) break; srcPos = clips[ci].in; b -= every; continue; }
    const take = Math.min(dur, avail) * (c.speed || 1);
    out.push({ ...c, id: newId(), in: srcPos, out: srcPos + take, curve: 'none', reverse: false, freeze: 0, transition: { type: out.length ? (c.transition && c.transition.type !== 'none' ? c.transition.type : 'none') : 'none', dur: 0.15 } });
    srcPos += take;
    if (c.out - srcPos < 0.2) { ci++; if (ci < clips.length) srcPos = clips[ci].in; }
  }
  return out.length ? out : clips;
}

// Granular pitch shift that keeps duration (factor > 1 = higher voice).
export function pitchShift(x, factor, sr) {
  const win = Math.round(sr * 0.04), hop = win >> 2, out = new Float32Array(x.length), norm = new Float32Array(x.length);
  const w = new Float32Array(win); for (let i = 0; i < win; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / win);
  for (let pos = 0; pos + win < x.length; pos += hop) {
    for (let i = 0; i < win; i++) { const s = pos + i * factor; const j = Math.floor(s); if (j + 1 >= x.length) break; const k = s - j; const v = x[j] * (1 - k) + x[j + 1] * k; out[pos + i] += v * w[i]; norm[pos + i] += w[i]; }
  }
  for (let i = 0; i < out.length; i++) out[i] = norm[i] > 1e-3 ? out[i] / norm[i] : 0;
  return out;
}

// Simple noise reduction: estimate the noise floor from the quietest frames and
// apply a smooth downward expander (gate). Combined with high/low-pass in the mixer.
export function denoiseGate(x, sr, amount = 0.8) {
  const F = Math.round(sr * 0.02), n = Math.floor(x.length / F); if (n < 4) return x;
  const rms = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let k = 0; k < F; k++) { const v = x[i * F + k]; s += v * v; } rms[i] = Math.sqrt(s / F); }
  const sorted = Array.from(rms).sort((a, b) => a - b); const floor = sorted[Math.floor(n * 0.1)] + 1e-6;
  const out = new Float32Array(x.length); let g = 1;
  for (let i = 0; i < n; i++) {
    const r = rms[i] / floor; const target = r > 3 ? 1 : r < 1.5 ? 1 - amount : 1 - amount + amount * ((r - 1.5) / 1.5);
    for (let k = 0; k < F; k++) { g += (target - g) * (target > g ? 0.02 : 0.002); out[i * F + k] = x[i * F + k] * g; }
  }
  return out;
}

export function encodeWav(channels, sr) {
  const n = channels[0].length, ch = channels.length, buf = new ArrayBuffer(44 + n * ch * 2), v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n * ch * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * ch * 2, true);
  let o = 44; for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { const s = Math.max(-1, Math.min(1, channels[c][i])); v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2; }
  return new Uint8Array(buf);
}

export function bitrateForSize(mb, seconds, audioKbps = 128) {
  if (!mb || !seconds) return 0;
  return Math.max(300e3, Math.round((mb * 8e6) / seconds - audioKbps * 1000));
}
