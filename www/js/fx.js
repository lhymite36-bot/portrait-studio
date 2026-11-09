// Premium post stage: background remove/swap, sky replacement, relight, skin
// retouch, eye/teeth brighten, colourise, custom .cube LUTs. Runs on the GPU
// after the main grade, so it works for photos and for every video frame.

export const FX_DEFAULTS = Object.freeze({
  bg: { mode: 'none', c1: '#2b2f45', c2: '#0b0c12' },
  sky: { enabled: false, preset: 'sunset', amount: 1 },
  relight: { enabled: false, x: 0.35, y: 0.7, radius: 0.35, intensity: 0.5, warmth: 0.4, ambient: 0.25 },
  retouch: { smooth: 0, eyes: 0, teeth: 0 },
  restore: { colorize: 0 },
  lut: { id: null, amount: 1 },
});
export const fxDefaults = () => JSON.parse(JSON.stringify(FX_DEFAULTS));

export function fxActive(fx) {
  return !!fx && (fx.bg.mode !== 'none' || fx.sky.enabled || fx.relight.enabled || fx.retouch.smooth > 0 || fx.retouch.eyes > 0 || fx.retouch.teeth > 0 || fx.restore.colorize > 0 || !!fx.lut.id);
}

const FS_POST = `#version 300 es
precision highp float; precision highp sampler3D; in vec2 uv; out vec4 o;
uniform sampler2D graded, enh, mask, bgTex, skyMask, skyTex, feat, orig; uniform sampler3D lut;
uniform int bgMode; uniform vec3 bg1, bg2; uniform vec2 bgScale; uniform float hasMask;
uniform float skyAmt, lutAmt, lutN, smoothAmt, eyesAmt, teethAmt, colorize;
uniform vec2 lightPos; uniform float lightR, lightI, lightWarm, ambient, relightOn, aspect, split;
float L(vec3 c){ return dot(c, vec3(0.2126,0.7152,0.0722)); }
float skinLike(vec3 c){
  float y = 0.299*c.r+0.587*c.g+0.114*c.b; float cb = 0.5-0.168736*c.r-0.331264*c.g+0.5*c.b; float cr = 0.5+0.5*c.r-0.418688*c.g-0.081312*c.b;
  float a = smoothstep(0.035,0.0,abs(cb-0.43)-0.06); float b = smoothstep(0.04,0.0,abs(cr-0.6)-0.07);
  return a*b*smoothstep(0.08,0.2,y);
}
void main(){
  vec3 c = texture(graded, uv).rgb;
  float m = hasMask > 0.5 ? smoothstep(0.3, 0.7, texture(mask, uv).r) : 1.0;
  if(smoothAmt > 0.0){
    vec3 e = texture(enh, uv).rgb;
    float sk = skinLike(e) * m;
    vec3 b1 = textureLod(enh, uv, 2.0).rgb, b2 = textureLod(enh, uv, 3.0).rgb;
    vec3 bl = mix(b1, b2, 0.5);
    vec3 d = bl - e; float w = exp(-dot(d,d)/0.006);
    c += (bl - e) * sk * smoothAmt * w;
  }
  vec4 f = texture(feat, uv);
  if(eyesAmt > 0.0){ c = mix(c, clamp(c*1.18 + 0.025, 0., 1.), f.r*eyesAmt); }
  if(teethAmt > 0.0){ float y = L(c); float t = f.g*teethAmt*smoothstep(0.25,0.6,y); c = mix(c, clamp(vec3(y)*1.12+0.04, 0., 1.), t*0.8); }
  if(colorize > 0.0){
    float y = L(c);
    vec3 ground = vec3(0.55,0.5,0.38), sky = vec3(0.52,0.66,0.86), skin = vec3(0.86,0.62,0.5), cloth = vec3(0.48,0.42,0.5);
    vec3 base = mix(ground, sky, smoothstep(0.45, 0.95, uv.y));
    vec3 pc = mix(cloth, skin, smoothstep(0.35, 0.8, skinLike(vec3(y)*vec3(1.08,0.92,0.82))+0.35));
    base = mix(base, pc, m);
    vec3 col = clamp(vec3(y) + (base - L(base)) * (0.35 + 0.5*(1.0-abs(y-0.5)*2.0)), 0., 1.);
    c = mix(c, col, colorize);
  }
  if(relightOn > 0.5){
    vec2 d = (uv - lightPos) * vec2(aspect, 1.0);
    float fall = exp(-dot(d,d) / (2.0*lightR*lightR));
    vec3 lc = mix(vec3(1.0), vec3(1.0,0.8,0.58), lightWarm);
    c *= 1.0 - ambient*0.6*(1.0-m);
    c = clamp(c + c*lc*fall*lightI*(0.35+0.65*m) + lc*fall*lightI*0.06*m, 0., 1.);
  }
  if(skyAmt > 0.0){
    float s = texture(skyMask, uv).r * (1.0 - m);
    vec3 sk = texture(skyTex, uv).rgb;
    c = mix(c, sk, s*skyAmt);
  }
  if(lutN > 1.5){
    vec3 q = clamp(c,0.,1.)*(lutN-1.0)/lutN + 0.5/lutN;
    c = mix(c, texture(lut, q).rgb, lutAmt);
  }
  float alpha = 1.0;
  if(bgMode == 1){ alpha = m; }
  else if(bgMode == 2){ c = mix(mix(bg2, bg1, uv.y), c, m); }
  else if(bgMode == 3){ float r = length((uv-vec2(0.5,0.62))*vec2(aspect,1.0)); c = mix(mix(bg1, bg2, smoothstep(0.0, 0.9, r)), c, m); }
  else if(bgMode == 4){ vec2 q = (uv-0.5)*bgScale+0.5; c = mix(texture(bgTex, q).rgb, c, m); }
  if(uv.x < split){ c = texture(orig, uv).rgb; alpha = 1.0; }
  o = vec4(c, alpha);
}`;

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

export class FxStage {
  constructor(pipe) {
    this.pipe = pipe; const gl = pipe.gl; this.gl = gl;
    this.prog = pipe.program('post', FS_POST);
    this.tex = { bg: pipe.tex(), skyMask: pipe.tex(), sky: pipe.tex(), feat: pipe.tex() };
    for (const k of ['skyMask', 'feat']) this.upload(k, blank());
    this.upload('sky', blank()); this.upload('bg', blank());
    this.lutTex = gl.createTexture(); this.lutN = 0;
    gl.bindTexture(gl.TEXTURE_3D, this.lutTex);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, 1, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    this.bgAspect = 1; this.fx = fxDefaults(); this.active = false;
    this.run = this.run.bind(this);
  }
  upload(name, canvas) {
    const gl = this.gl; gl.bindTexture(gl.TEXTURE_2D, this.tex[name]);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    if (name === 'bg') this.bgAspect = canvas.width / canvas.height;
  }
  setLut(lut) {
    const gl = this.gl;
    if (!lut) { this.lutN = 0; return; }
    const N = lut.size, px = new Uint8Array(N * N * N * 4);
    for (let i = 0; i < N * N * N; i++) { px[i * 4] = lut.data[i * 3]; px[i * 4 + 1] = lut.data[i * 3 + 1]; px[i * 4 + 2] = lut.data[i * 3 + 2]; px[i * 4 + 3] = 255; }
    gl.bindTexture(gl.TEXTURE_3D, this.lutTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, N, N, N, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_3D, k, v);
    this.lutN = N;
  }
  opts(fx) { this.fx = fx; this.active = fxActive(fx); return this; }
  run(pipe, t) {
    const gl = this.gl, fx = this.fx, p = this.prog;
    pipe.draw('post', null, () => {
      pipe.bind(p, 'graded', 0, t.graded.tex); pipe.bind(p, 'enh', 1, t.enh.tex);
      pipe.bind(p, 'mask', 2, t.maskT ? t.maskT.tex : pipe.maskTex);
      pipe.bind(p, 'bgTex', 3, this.tex.bg); pipe.bind(p, 'skyMask', 4, this.tex.skyMask); pipe.bind(p, 'skyTex', 5, this.tex.sky);
      pipe.bind(p, 'feat', 6, this.tex.feat); pipe.bind(p, 'orig', 7, t.up.tex);
      gl.activeTexture(gl.TEXTURE8); gl.bindTexture(gl.TEXTURE_3D, this.lutTex); gl.uniform1i(p.u.lut, 8);
      const mode = { none: 0, transparent: 1, color: 2, studio: 3, image: 4 }[fx.bg.mode] || 0;
      gl.uniform1i(p.u.bgMode, mode); gl.uniform3fv(p.u.bg1, hex(fx.bg.c1)); gl.uniform3fv(p.u.bg2, hex(fx.bg.c2));
      const ia = t.outW / t.outH, ba = this.bgAspect;
      gl.uniform2f(p.u.bgScale, ia > ba ? 1 : ia / ba, ia > ba ? ba / ia : 1);
      gl.uniform1f(p.u.hasMask, t.maskT ? 1 : 0);
      gl.uniform1f(p.u.skyAmt, fx.sky.enabled && this.skyReady ? fx.sky.amount : 0);
      gl.uniform1f(p.u.lutAmt, fx.lut.amount); gl.uniform1f(p.u.lutN, fx.lut.id ? this.lutN : 0);
      gl.uniform1f(p.u.smoothAmt, fx.retouch.smooth); gl.uniform1f(p.u.eyesAmt, this.featReady ? fx.retouch.eyes : 0); gl.uniform1f(p.u.teethAmt, this.featReady ? fx.retouch.teeth : 0);
      gl.uniform1f(p.u.colorize, fx.restore.colorize);
      const r = fx.relight;
      gl.uniform1f(p.u.relightOn, r.enabled ? 1 : 0); gl.uniform2f(p.u.lightPos, r.x, r.y);
      gl.uniform1f(p.u.lightR, 0.05 + r.radius * 0.5); gl.uniform1f(p.u.lightI, r.intensity * 1.2); gl.uniform1f(p.u.lightWarm, r.warmth); gl.uniform1f(p.u.ambient, r.ambient);
      gl.uniform1f(p.u.aspect, t.outW / t.outH); gl.uniform1f(p.u.split, t.split);
    });
  }
}
function blank() { const c = document.createElement('canvas'); c.width = c.height = 2; return c; }

// ---------- .cube LUT parsing ----------
export function parseCube(text) {
  let size = 0; const vals = []; let dmin = [0, 0, 0], dmax = [1, 1, 1];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const up = line.toUpperCase();
    if (up.startsWith('TITLE')) continue;
    if (up.startsWith('LUT_1D_SIZE')) throw new Error('1D LUTs are not supported; use a 3D .cube');
    if (up.startsWith('LUT_3D_SIZE')) { size = parseInt(line.split(/\s+/)[1], 10); continue; }
    if (up.startsWith('DOMAIN_MIN')) { dmin = line.split(/\s+/).slice(1).map(Number); continue; }
    if (up.startsWith('DOMAIN_MAX')) { dmax = line.split(/\s+/).slice(1).map(Number); continue; }
    if (/^[A-Z_]/.test(up)) continue;
    const parts = line.split(/\s+/).map(Number);
    if (parts.length >= 3 && parts.every((x) => isFinite(x))) vals.push(parts[0], parts[1], parts[2]);
  }
  if (size < 2 || size > 65) throw new Error('Missing or unsupported LUT_3D_SIZE');
  if (vals.length !== size * size * size * 3) throw new Error(`Expected ${size ** 3} entries, found ${vals.length / 3}`);
  const data = new Uint8Array(vals.length);
  for (let i = 0; i < vals.length; i++) { const c = i % 3; data[i] = Math.max(0, Math.min(255, Math.round(((vals[i] - dmin[c]) / (dmax[c] - dmin[c])) * 255))); }
  return { size, data };
}

// Bakes any per-pixel grade into a .cube so users can export their own look.
export function bakeCube(fn, size = 17, title = 'Portrait Studio look') {
  const lines = [`TITLE "${title}"`, `LUT_3D_SIZE ${size}`];
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) {
    const o = fn([r / (size - 1), g / (size - 1), b / (size - 1)]);
    lines.push(o.map((v) => v.toFixed(5)).join(' '));
  }
  return lines.join('\n') + '\n';
}
