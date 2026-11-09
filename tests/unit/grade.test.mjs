import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultParams, resolveGrade, gradePixel, LOOKS, shapeMask, computeOutputSize, computeVideoSize, avcCodecFor, videoBitrate, srgbToLinear, linearToSrgb, wbGains, formatEta } from '../../www/js/grade.js';

const close = (a, b, eps = 1 / 255) => a.every((v, i) => Math.abs(v - b[i]) <= eps);

test('neutral params leave pixels unchanged', () => {
  const g = resolveGrade(defaultParams());
  for (const c of [[0, 0, 0], [1, 1, 1], [0.2, 0.5, 0.8], [0.9, 0.1, 0.4]]) assert.ok(close(gradePixel(c, g), c), String(c));
});

test('sRGB transfer round-trips', () => {
  for (let v = 0; v <= 1; v += 0.05) assert.ok(Math.abs(linearToSrgb(srgbToLinear(v)) - v) < 1e-9);
});

test('+1 EV doubles linear light', () => {
  const p = defaultParams(); p.adjust.exposure = 1;
  const out = gradePixel([0.3, 0.3, 0.3], resolveGrade(p));
  assert.ok(Math.abs(srgbToLinear(out[0]) - 2 * srgbToLinear(0.3)) < 0.01);
});

test('warm temperature raises red and lowers blue', () => {
  const p = defaultParams(); p.adjust.temperature = 0.8;
  const out = gradePixel([0.5, 0.5, 0.5], resolveGrade(p));
  assert.ok(out[0] > 0.5 && out[2] < 0.5);
  assert.deepEqual(wbGains(0, 0), [1, 1, 1]);
});

test('B&W looks give neutral grey', () => {
  for (const id of ['bw', 'bw-noir']) {
    const p = defaultParams(); p.look.id = id;
    const o = gradePixel([0.8, 0.3, 0.1], resolveGrade(p));
    assert.ok(Math.abs(o[0] - o[1]) < 1e-6 && Math.abs(o[1] - o[2]) < 1e-6, id);
  }
});

test('saturation -1 removes colour; contrast pushes away from mid grey', () => {
  const p = defaultParams(); p.adjust.saturation = -1;
  const o = gradePixel([0.9, 0.2, 0.2], resolveGrade(p));
  assert.ok(Math.abs(o[0] - o[1]) < 1e-6);
  const q = defaultParams(); q.adjust.contrast = 0.5;
  const g = resolveGrade(q);
  assert.ok(gradePixel([0.8, 0.8, 0.8], g)[0] > 0.8 && gradePixel([0.2, 0.2, 0.2], g)[0] < 0.2);
});

test('every look stays in range and intensity 0 is identity', () => {
  for (const l of LOOKS) {
    const p = defaultParams(); p.look.id = l.id;
    for (const c of [[0, 0, 0], [1, 1, 1], [0.5, 0.2, 0.7]]) gradePixel(c, resolveGrade(p)).forEach((v) => assert.ok(v >= 0 && v <= 1));
    p.look.intensity = 0;
    assert.ok(close(gradePixel([0.4, 0.5, 0.6], resolveGrade(p)), [0.4, 0.5, 0.6]), l.id);
  }
  assert.equal(new Set(LOOKS.map((l) => l.id)).size, LOOKS.length);
});

test('vignette darkens corners only', () => {
  const p = defaultParams(); p.effects.vignette = 1; const g = resolveGrade(p);
  assert.ok(close(gradePixel([0.5, 0.5, 0.5], g, [0.5, 0.5]), [0.5, 0.5, 0.5]));
  assert.ok(gradePixel([0.5, 0.5, 0.5], g, [0, 0])[0] < 0.3);
});

test('portrait mask shaping: focus widens subject, ends saturate', () => {
  assert.equal(shapeMask(0, 0, 0.3), 0); assert.equal(shapeMask(1, 0, 0.3), 1);
  assert.ok(shapeMask(0.4, 1, 0.1) > shapeMask(0.4, 0, 0.1));
  assert.ok(shapeMask(0.45, 0, 0) < shapeMask(0.55, 0, 0));
});

test('photo output sizes', () => {
  assert.deepEqual(computeOutputSize(1600, 1200, 'orig'), { width: 1600, height: 1200, factor: 1 });
  assert.equal(computeOutputSize(1600, 1200, '2x').width, 3200);
  assert.equal(computeOutputSize(1600, 1200, '4k').width, 3840);
  assert.equal(computeOutputSize(3000, 2000, '2x').width, 3840);
  const big = computeOutputSize(8160, 6120, 'orig', 8192, 24e6);
  assert.ok(big.width * big.height <= 24e6 && big.width < 8160);
  assert.ok(computeOutputSize(5000, 4000, 'orig', 4096).width <= 4096);
});

test('video sizes are even and capped', () => {
  assert.deepEqual(computeVideoSize(1920, 1080, 720, 1280), { width: 1280, height: 720 });
  assert.deepEqual(computeVideoSize(1080, 1920, 720, 1280), { width: 720, height: 1280 });
  assert.deepEqual(computeVideoSize(641, 359, 720), { width: 642, height: 360 });
  const o = computeVideoSize(3840, 2160, 0, 3840); assert.equal(o.width, 3840);
});

test('codec level and bitrate', () => {
  assert.equal(avcCodecFor(1280, 720, 30), 'avc1.42001f');
  assert.equal(avcCodecFor(1920, 1080, 30), 'avc1.4d0028');
  assert.equal(avcCodecFor(3840, 2160, 30), 'avc1.640033');
  assert.ok(videoBitrate(1280, 720, 30) >= 2e6 && videoBitrate(3840, 2160, 60) <= 16e6);
  assert.equal(formatEta(75), '1m 15s'); assert.equal(formatEta(9), '9s');
});
