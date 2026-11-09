import test from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../../www/js/studio-core.js';

let n = 0; const id = () => 'x' + (++n);
const clip = (o = {}) => ({ id: id(), in: 0, out: 4, speed: 1, curve: 'none', transition: { type: 'none', dur: 0.5 }, ...o });

test('time map: speed, reverse, freeze, curves', () => {
  assert.equal(S.buildTimeMap(clip({ speed: 2 })).duration, 2);
  const r = S.buildTimeMap(clip({ reverse: true })); assert.equal(r.map(0), 4); assert.equal(r.map(4), 0);
  assert.equal(S.buildTimeMap(clip({ freeze: 2, in: 1.5 })).duration, 2);
  const m = S.buildTimeMap(clip({ curve: 'montage' })); assert.ok(m.duration > 0.5 && m.duration < 8);
  let prev = -1; for (let t = 0; t <= m.duration; t += m.duration / 50) { const s = m.map(t); assert.ok(s >= prev - 1e-9); prev = s; }
  assert.ok(Math.abs(m.map(m.duration) - 4) < 1e-6);
});

test('layout with transitions overlaps and activeAt returns both', () => {
  const l = S.layoutClips([clip(), clip({ transition: { type: 'fade', dur: 0.5 } })]);
  assert.equal(l.items[1].start, 3.5); assert.equal(l.duration, 7.5);
  assert.equal(S.activeAt(l, 3.7).length, 2); assert.equal(S.activeAt(l, 1).length, 1);
});

test('split keeps total duration', () => {
  const c = [clip(), clip()]; const r = S.splitAt(c, 1.5, id);
  assert.equal(r.length, 3); assert.equal(S.layoutClips(r).duration, 8); assert.equal(r[0].out, 1.5); assert.equal(r[1].in, 1.5);
  assert.equal(S.splitAt(c, 0.01, id), null);
});

test('keyframes interpolate', () => {
  const it = { x: 0.5, keyframes: [{ t: 0, x: 0 }, { t: 2, x: 1 }] };
  assert.equal(S.evalKeyframes(it, -1).x, 0); assert.equal(S.evalKeyframes(it, 1).x, 0.5); assert.equal(S.evalKeyframes(it, 5).x, 1);
  assert.equal(S.evalKeyframes({}, 0).scale, 1);
});

test('caption grouping and chunk splitting', () => {
  const w = S.chunksToWords([{ text: ' hello there my good friend', timestamp: [0, 2] }, { text: 'again', timestamp: [3, 3.4] }]);
  assert.equal(w.length, 6); assert.ok(w[4].end <= 2.0001);
  const g = S.groupWords(w); assert.ok(g.length >= 2); assert.equal(g[g.length - 1].words[0].text, 'again');
});

test('beat detection finds 120 BPM click track and beat cut', () => {
  const sr = 22050, secs = 12, x = new Float32Array(sr * secs);
  for (let b = 0; b < secs * 2; b++) { const o = Math.round(b * 0.5 * sr); for (let i = 0; i < 800 && o + i < x.length; i++) x[o + i] += Math.sin(i * 0.3) * Math.exp(-i / 150); }
  const { bpm, beats } = S.detectBeats(x, sr);
  assert.ok(Math.abs(bpm - 120) < 2 || Math.abs(bpm - 60) < 1, 'bpm ' + bpm);
  assert.ok(beats.length > 10);
  const cut = S.beatCut([clip({ out: 10 })], [0, 0.5, 1, 1.5, 2, 2.5, 3], 2, id);
  assert.equal(cut.length, 3); cut.forEach((c) => assert.ok(Math.abs(c.out - c.in - 1) < 1e-9));
});

test('dsp: pitch shift keeps length, gate attenuates noise, wav, bitrate', () => {
  const sr = 16000, x = new Float32Array(sr).map((_, i) => Math.sin(i * 0.1));
  assert.equal(S.pitchShift(x, 1.5, sr).length, x.length);
  const noisy = new Float32Array(sr * 2).map((_, i) => (i > sr ? Math.sin(i * 0.05) * 0.8 : 0) + (Math.random() - 0.5) * 0.01);
  const g = S.denoiseGate(noisy, sr, 0.9); const e = (a, s, l) => a.slice(s, s + l).reduce((q, v) => q + v * v, 0);
  assert.ok(e(g, 2000, 8000) < e(noisy, 2000, 8000) * 0.3);
  const w = S.encodeWav([x, x], sr); assert.equal(w.length, 44 + x.length * 4); assert.equal(String.fromCharCode(...w.slice(0, 4)), 'RIFF');
  assert.equal(S.bitrateForSize(8, 64), 872000);
  assert.ok(S.textAnim('typewriter', 0.1, 3, 10).chars < 10);
});

test('Lab round trip used by the AI colouriser', async () => {
  const { rgb2lab, lab2rgb } = await import('../../www/js/ai.js');
  for (const c of [[0.2, 0.5, 0.8], [1, 1, 1], [0, 0, 0], [0.9, 0.3, 0.1]]) {
    const [L, a, b] = rgb2lab(...c); const r = lab2rgb(L, a, b);
    r.forEach((v, i) => assert.ok(Math.abs(v - c[i]) < 2e-3, `${c} -> ${r}`));
  }
  const [L, a, b] = rgb2lab(0.5, 0.5, 0.5); assert.ok(Math.abs(a) < 0.01 && Math.abs(b) < 0.01 && Math.abs(L - 53.39) < 0.1);
});
