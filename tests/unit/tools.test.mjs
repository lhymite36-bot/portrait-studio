import test from 'node:test';
import assert from 'node:assert/strict';
import { inpaint, dilate, autoLevels, isMostlyGrey, detectScratches } from '../../www/js/tools.js';
import { parseCube, bakeCube, fxActive, fxDefaults } from '../../www/js/fx.js';
import { estimateShift } from '../../www/js/motion.js';

const img = (w, h, f) => { const a = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const c = f(x, y); a.set([c[0], c[1], c[2], 255], (y * w + x) * 4); } return a; };

test('inpaint removes a dark blob from a smooth gradient', () => {
  const w = 64, h = 48; const a = img(w, h, (x) => [x * 3, 100, 200 - x * 2]);
  const m = new Uint8Array(w * h);
  for (let y = 18; y < 30; y++) for (let x = 26; x < 38; x++) { m[y * w + x] = 1; a.set([0, 0, 0], (y * w + x) * 4); }
  const n = inpaint(a, m, w, h);
  assert.equal(n, 144);
  let err = 0; for (let y = 18; y < 30; y++) for (let x = 26; x < 38; x++) err = Math.max(err, Math.abs(a[(y * w + x) * 4] - x * 3), Math.abs(a[(y * w + x) * 4 + 1] - 100));
  assert.ok(err < 30, 'max error ' + err);
  assert.equal(inpaint(a, new Uint8Array(w * h), w, h), 0);
});

test('dilate grows a pixel into a square', () => {
  const w = 9, h = 9, m = new Uint8Array(w * h); m[4 * w + 4] = 1;
  const d = dilate(m, w, h, 2); let n = 0; for (const v of d) n += v; assert.equal(n, 25);
});

test('auto levels stretches a faded image; grey detection', () => {
  const w = 32, h = 32; const a = img(w, h, (x) => [80 + x * 2, 80 + x * 2, 80 + x * 2]);
  assert.ok(isMostlyGrey(a, w, h));
  autoLevels(a, w, h, 1);
  let mn = 255, mx = 0; for (let i = 0; i < w * h; i++) { mn = Math.min(mn, a[i * 4]); mx = Math.max(mx, a[i * 4]); }
  assert.ok(mn < 10 && mx > 245);
  assert.ok(!isMostlyGrey(img(8, 8, () => [255, 0, 0]), 8, 8));
});

test('scratch detector flags a thin bright line on a flat field', () => {
  const w = 40, h = 40; const a = img(w, h, (x) => (x === 20 ? [250, 250, 250] : [90, 90, 90]));
  const s = detectScratches(a, w, h, 0.5); let n = 0; for (const v of s) n += v;
  assert.ok(n >= 30 && n <= 40, String(n)); assert.equal(s[10 * w + 20], 1); assert.equal(s[10 * w + 10], 0);
});

test('.cube parse + bake round trip', () => {
  const txt = bakeCube((c) => [c[0], c[1] * 0.5, 1 - c[2]], 5);
  const l = parseCube(txt);
  assert.equal(l.size, 5); assert.equal(l.data.length, 125 * 3);
  // entry r=4,g=4,b=0 -> index (0*25+4*5+4)
  const i = (0 * 25 + 4 * 5 + 4) * 3; assert.deepEqual([...l.data.slice(i, i + 3)], [255, 128, 255]);
  assert.throws(() => parseCube('LUT_3D_SIZE 3\n0 0 0\n'));
  assert.throws(() => parseCube('LUT_1D_SIZE 16\n'));
  const withDomain = parseCube('# c\nTITLE "x"\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 2 2 2\nLUT_3D_SIZE 2\n' + Array(8).fill('2 1 0').join('\n'));
  assert.deepEqual([...withDomain.data.slice(0, 3)], [255, 128, 0]);
});

test('fxActive only when a premium tool is on', () => {
  const f = fxDefaults(); assert.equal(fxActive(f), false);
  f.retouch.smooth = 0.2; assert.equal(fxActive(f), true);
  const g = fxDefaults(); g.bg.mode = 'transparent'; assert.equal(fxActive(g), true);
});

test('motion estimate recovers a known shift', () => {
  const W = 80, H = 60; const tex = (x, y) => { const h = (i, j) => { const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5; return s - Math.floor(s); }; return 120 * h(Math.floor(x / 3), Math.floor(y / 3)) + 40 * h(x, y); };
  const a = new Float32Array(W * H), b = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { a[y * W + x] = tex(x, y); b[y * W + x] = tex(x - 3, y + 2); }
  assert.deepEqual(estimateShift(a, b, W, H, 8), [3, -2]);
});
