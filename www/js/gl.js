// Portrait Studio GPU pipeline (WebGL2). Passes:
//  1. blur pyramid of the source (small, for clarity + glow + guide)
//  2. enhance: bicubic upscale + edge-aware denoise + unsharp sharpen + clarity
//  3. mask refine: joint-bilateral upsampling of the low-res person mask
//  4. bokeh: golden-angle disc blur of the background only (no subject bleed)
//  5. final: composite, colour grade, glow, vignette, grain, before/after split
import { resolveGrade } from './grade.js';

const VS = `#version 300 es
in vec2 p; out vec2 uv;
void main(){ uv = p*0.5+0.5; gl_Position = vec4(p,0.,1.); }`;

const FS_COPY = `#version 300 es
precision highp float; in vec2 uv; out vec4 o;
uniform sampler2D t; uniform mat2 rot; uniform float flip; uniform vec2 shift; uniform float zoom;
void main(){ vec2 q = rot*((uv-0.5)/max(zoom,1e-3) + shift)+0.5; if(flip>0.5) q.y = 1.0-q.y; o = texture(t, q); }`;

const FS_BLUR = `#version 300 es
precision highp float; in vec2 uv; out vec4 o;
uniform sampler2D t; uniform vec2 dir;
void main(){
  vec4 s = texture(t,uv)*0.227027;
  s += (texture(t,uv+dir*1.3846153846)+texture(t,uv-dir*1.3846153846))*0.3162162162;
  s += (texture(t,uv+dir*3.2307692308)+texture(t,uv-dir*3.2307692308))*0.0702702703;
  o = s; }`;

const FS_ENH = `#version 300 es
precision highp float; in vec2 uv; out vec4 o;
uniform sampler2D src; uniform sampler2D blurT; uniform vec2 srcSize;
uniform float sharpen, denoise, clarity;
vec4 cubic(float v){ vec4 n=vec4(1.,2.,3.,4.)-v; vec4 s=n*n*n; float x=s.x; float y=s.y-4.*s.x; float z=s.z-4.*s.y+6.*s.x; float w=6.-x-y-z; return vec4(x,y,z,w)*(1./6.); }
vec3 bicubic(vec2 tc){
  vec2 ts = 1.0/srcSize; tc = tc*srcSize-0.5; vec2 f = fract(tc); tc -= f;
  vec4 xc = cubic(f.x), yc = cubic(f.y);
  vec4 c = tc.xxyy + vec2(-0.5,1.5).xyxy; vec4 s = vec4(xc.xz+xc.yw, yc.xz+yc.yw);
  vec4 off = (c + vec4(xc.yw, yc.yw)/s)*ts.xxyy;
  vec3 s0=texture(src,off.xz).rgb, s1=texture(src,off.yz).rgb, s2=texture(src,off.xw).rgb, s3=texture(src,off.yw).rgb;
  float sx = s.x/(s.x+s.y), sy = s.z/(s.z+s.w);
  return mix(mix(s3,s2,sx), mix(s1,s0,sx), sy);
}
float L(vec3 c){ return dot(c, vec3(0.2126,0.7152,0.0722)); }
void main(){
  vec2 ts = 1.0/srcSize;
  vec3 c = bicubic(uv);
  // edge-aware 3x3 denoise in source texel space
  vec3 acc = c; float wsum = 1.0; vec3 g = c*4.0; 
  float rs = mix(0.02, 0.12, denoise);
  for(int j=-1;j<=1;j++) for(int i=-1;i<=1;i++){
    if(i==0 && j==0) continue;
    vec3 s = texture(src, uv+vec2(float(i),float(j))*ts).rgb;
    float d = length(s-c); float w = exp(-d*d/(2.0*rs*rs)) * (abs(i)+abs(j)==2 ? 0.5 : 0.8);
    acc += s*w; wsum += w;
    g += s * (abs(i)+abs(j)==2 ? 1.0 : 2.0);
  }
  vec3 den = mix(c, acc/wsum, denoise);
  vec3 gauss = g/16.0;
  vec3 detail = c - gauss;
  float edge = clamp(length(detail)*6.0, 0.0, 1.0);
  vec3 outc = den + detail * sharpen * 1.6 * (0.35 + 0.65*edge);
  vec3 big = texture(blurT, uv).rgb;
  float y = L(outc);
  float mid = 1.0 - abs(y-0.5)*2.0;
  outc += (outc - big) * clarity * 0.6 * mid;
  o = vec4(clamp(outc,0.,1.), 1.);
}`;

const FS_MASK = `#version 300 es
precision highp float; in vec2 uv; out vec4 o;
uniform sampler2D mask; uniform sampler2D guide; uniform vec2 maskSize; uniform vec2 mShift; uniform float mZoom;
void main(){
  vec3 gc = texture(guide, uv).rgb;
  vec2 muv = (uv-0.5)/max(mZoom,1e-3) + mShift + 0.5; // follow video stabilisation
  vec2 mt = 1.0/maskSize;
  vec2 base = (floor(muv*maskSize-0.5)+0.5)*mt;
  float acc=0., ws=0.;
  for(int j=-2;j<=2;j++) for(int i=-2;i<=2;i++){
    vec2 q = base + vec2(float(i),float(j))*mt;
    vec2 dd = (q-muv)*maskSize;
    float sw = exp(-dot(dd,dd)/4.5);
    vec3 gq = textureLod(guide, (q-mShift-0.5)*max(mZoom,1e-3)+0.5, 3.0).rgb;
    vec3 df = gq-gc; float rw = exp(-dot(df,df)/(2.0*0.09*0.09));
    float w = sw*rw + 1e-4*sw;
    acc += texture(mask,q).r*w; ws += w;
  }
  o = vec4(acc/ws, 0., 0., 1.);
}`;

const FS_BOKEH = `#version 300 es
precision highp float; in vec2 uv; out vec4 o;
uniform sampler2D img; uniform sampler2D mask; uniform vec2 size; uniform float radius, boost, focus, feather; uniform int N;
float shapeM(float m){ float t=0.5-focus*0.4; float f=0.02+feather*0.3; return smoothstep(t-f,t+f,m); }
float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233)))*43758.5453); }
void main(){
  if(radius < 0.5){ o = texture(img, uv); return; }
  float lod = max(0.0, log2(radius*1.8/sqrt(float(N))));
  float ga = 2.39996323; float rot = hash(uv*size)*6.2831;
  vec3 acc = vec3(0.); float ws = 0.;
  for(int i=0;i<160;i++){
    if(i>=N) break;
    float r = sqrt((float(i)+0.5)/float(N))*radius;
    float a = float(i)*ga + rot;
    vec2 q = uv + vec2(cos(a),sin(a))*r/size;
    vec3 c = textureLod(img, q, lod).rgb;
    float bg = 1.0 - shapeM(texture(mask, q).r);
    float l = dot(c, vec3(0.2126,0.7152,0.0722));
    float w = bg * (1.0 + boost*8.0*pow(l, 6.0)) + 1e-4;
    acc += c*w; ws += w;
  }
  o = vec4(acc/ws, 1.);
}`;

const FS_FINAL = `#version 300 es
precision highp float; in vec2 uv; out vec4 o;
uniform sampler2D enh, bokeh, mask, blurT, orig; uniform vec2 size;
uniform float portrait, focus, feather, split, seed, focusX, focusSel;
uniform float exposure, contrast, highlights, shadows, saturation, vibrance, fade, glow, vignette, grain, monoAmt;
uniform vec3 wb, lift, gam, gain, splitShadow, splitHigh, mono;
float shapeM(float m){ float t=0.5-focus*0.4; float f=0.02+feather*0.3; return smoothstep(t-f,t+f,m); }
float toLin(float v){ return v<=0.04045 ? v/12.92 : pow((v+0.055)/1.055, 2.4); }
float toS(float v){ v=max(v,0.); return v<=0.0031308 ? v*12.92 : 1.055*pow(v,1./2.4)-0.055; }
vec3 lin(vec3 c){ return vec3(toLin(c.r),toLin(c.g),toLin(c.b)); }
vec3 srgb(vec3 c){ return vec3(toS(c.r),toS(c.g),toS(c.b)); }
float L(vec3 c){ return dot(c, vec3(0.2126,0.7152,0.0722)); }
float hash(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*0.1031); p3 += dot(p3, p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
vec3 grade(vec3 c){
  c = lin(c) * exp2(exposure) * wb;
  c = clamp(srgb(c), 0., 1.);
  float Y = L(c); float ws=(1.-Y)*(1.-Y), wh=Y*Y;
  c = clamp(c + shadows*0.3*ws + highlights*0.3*wh, 0., 1.);
  c = clamp((c-0.5)*(1.+contrast)+0.5, 0., 1.);
  c = clamp(pow(clamp(gain*(c + lift*(1.-c)),0.,1.), 1./gam), 0., 1.);
  Y = L(c); float s2=(1.-Y)*(1.-Y), h2=Y*Y;
  c = clamp(c + splitShadow*s2 + splitHigh*h2, 0., 1.);
  Y = L(c);
  float mx=max(c.r,max(c.g,c.b)), mn=min(c.r,min(c.g,c.b));
  float sat=(1.+saturation)*(1.+vibrance*(1.-(mx-mn)));
  c = clamp(Y+(c-Y)*sat, 0., 1.);
  c = mix(c, vec3(dot(c,mono)), monoAmt);
  c = c*(1.-0.18*fade)+0.09*fade;
  return c;
}
void main(){
  vec3 e = texture(enh, uv).rgb;
  vec3 c = e;
  if(portrait > 0.5){
    float m = shapeM(texture(mask, uv).r);
    if(focusSel > 0.0){ float dx = (uv.x - focusX); m *= mix(1.0, exp(-dx*dx/(2.0*0.11*0.11)), focusSel); }
    c = mix(texture(bokeh, uv).rgb, e, m);
  }
  c = grade(c);
  if(glow > 0.0){
    vec3 b = texture(blurT, uv).rgb;
    vec3 bright = max(b - 0.55, 0.0) * 2.2;
    c = 1.0 - (1.0-c)*(1.0 - bright*glow);
  }
  vec2 d = uv-0.5; float dist = length(d)*1.4142;
  c *= 1.0 - vignette*0.75*smoothstep(0.35, 1.05, dist);
  if(grain > 0.0){
    float n = hash(uv*size + seed*97.0) - 0.5;
    float Y = L(c); c += n * grain * 0.16 * (1.0 - abs(Y-0.5));
  }
  c = clamp(c, 0., 1.);
  if(uv.x < split){ c = texture(orig, uv).rgb; }
  if(split > 0.0 && split < 1.0 && abs(uv.x - split) < 1.5/size.x) c = vec3(1.);
  o = vec4(c, 1.);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('Shader: ' + gl.getShaderInfoLog(s));
  return s;
}

export class Pipeline {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, premultipliedAlpha: false, antialias: false });
    if (!gl) throw new Error('WebGL2 is not available on this device.');
    this.gl = gl;
    this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.progs = {};
    for (const [k, fs] of Object.entries({ copy: FS_COPY, blur: FS_BLUR, enh: FS_ENH, mask: FS_MASK, bokeh: FS_BOKEH, final: FS_FINAL })) {
      const p = gl.createProgram();
      gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VS));
      gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
      gl.bindAttribLocation(p, 0, 'p');
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Link: ' + gl.getProgramInfoLog(p));
      p.u = {};
      const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); p.u[info.name] = gl.getUniformLocation(p, info.name); }
      this.progs[k] = p;
    }
    this.srcTex = this.tex(); this.maskTex = this.tex(); this.origTex = null;
    this.targets = {};
    this.srcW = 0; this.srcH = 0; this.rotation = 0;
    this.maskW = 0; this.maskH = 0;
  }

  tex(filter) {
    const gl = this.gl; const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter || gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  target(name, w, h, opts = {}) {
    const gl = this.gl;
    let t = this.targets[name];
    if (t && t.w === w && t.h === h) return t;
    if (t) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); }
    const tex = this.tex(opts.mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    if (opts.r8) gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    t = { tex, fb, w, h, mip: !!opts.mip };
    this.targets[name] = t;
    return t;
  }

  // source: ImageBitmap | HTMLCanvasElement | HTMLVideoElement | VideoFrame
  // rotation: clockwise degrees needed to display the source upright.
  setSource(source, w, h, rotation = 0) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    // Upload without UNPACK_FLIP_Y (ignored for ImageBitmap); flip in the shader instead.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
    this.rawW = w; this.rawH = h; this.rotation = rotation;
    const swap = rotation === 90 || rotation === 270;
    this.srcW = swap ? h : w; this.srcH = swap ? w : h;
    // Normalise orientation into an upright texture so every later pass is simple.
    const up = this.target('upright', this.srcW, this.srcH);
    this.draw('copy', up, (p) => {
      const a = (rotation * Math.PI) / 180, c = Math.round(Math.cos(a)), s = Math.round(Math.sin(a));
      gl.uniformMatrix2fv(p.u.rot, false, [c, s, -s, c]);
      gl.uniform1f(p.u.flip, 1);
      const st = this.stab || { x: 0, y: 0, zoom: 1 };
      gl.uniform2f(p.u.shift, st.x, st.y); gl.uniform1f(p.u.zoom, st.zoom);
      this.bind(p, 't', 0, this.srcTex);
    });
    this.sourceVersion = (this.sourceVersion || 0) + 1;
  }

  // mask: Uint8Array person probability (0..255), row 0 = top.
  setMask(data, w, h) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    // flip rows so v=0 is the bottom like the rest of the textures
    const flipped = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) flipped.set(data.subarray((h - 1 - y) * w, (h - y) * w), y * w);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, flipped);
    this.maskW = w; this.maskH = h; this.hasMask = true;
  }

  maskXform(p) {
    const st = this.stab || { x: 0, y: 0, zoom: 1 };
    this.gl.uniform2f(p.u.mShift, st.x, st.y); this.gl.uniform1f(p.u.mZoom, st.zoom);
  }

  bind(p, name, unit, tex) {
    const gl = this.gl; gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(p.u[name], unit);
  }

  draw(prog, target, setup) {
    const gl = this.gl; const p = this.progs[prog];
    gl.useProgram(p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    const w = target ? target.w : this.canvas.width, h = target ? target.h : this.canvas.height;
    gl.viewport(0, 0, w, h);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    setup(p, w, h);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (target && target.mip) { gl.bindTexture(gl.TEXTURE_2D, target.tex); gl.generateMipmap(gl.TEXTURE_2D); }
  }

  // Render the whole pipeline to the canvas at outW x outH.
  render(params, outW, outH, opts = {}) {
    const gl = this.gl;
    if (this.canvas.width !== outW) this.canvas.width = outW;
    if (this.canvas.height !== outH) this.canvas.height = outH;
    const up = this.targets.upright;
    // 1. small blur of the source
    const bs = Math.min(1, 384 / Math.max(this.srcW, this.srcH));
    const bw = Math.max(8, Math.round(this.srcW * bs)), bh = Math.max(8, Math.round(this.srcH * bs));
    const b1 = this.target('blur1', bw, bh), b2 = this.target('blur2', bw, bh);
    this.draw('copy', b1, (p) => { gl.uniformMatrix2fv(p.u.rot, false, [1, 0, 0, 1]); gl.uniform1f(p.u.flip, 0); gl.uniform2f(p.u.shift, 0, 0); gl.uniform1f(p.u.zoom, 1); this.bind(p, 't', 0, up.tex); });
    for (let i = 0; i < 2; i++) {
      this.draw('blur', b2, (p) => { this.bind(p, 't', 0, b1.tex); gl.uniform2f(p.u.dir, (2 + i) / bw, 0); });
      this.draw('blur', b1, (p) => { this.bind(p, 't', 0, b2.tex); gl.uniform2f(p.u.dir, 0, (2 + i) / bh); });
    }
    // 2. enhance at output resolution
    const en = params.enhance;
    const enh = this.target('enh', outW, outH, { mip: true });
    this.draw('enh', enh, (p) => {
      this.bind(p, 'src', 0, up.tex); this.bind(p, 'blurT', 1, b1.tex);
      gl.uniform2f(p.u.srcSize, this.srcW, this.srcH);
      gl.uniform1f(p.u.sharpen, en.sharpen); gl.uniform1f(p.u.denoise, en.denoise); gl.uniform1f(p.u.clarity, en.clarity);
    });
    const pr = params.portrait;
    const usePortrait = pr.enabled && this.hasMask;
    let maskT = null, bok = null;
    if (usePortrait) {
      // 3. refine mask (half-res is plenty after bilateral upsampling)
      const mw = Math.max(2, Math.round(outW / 2)), mh = Math.max(2, Math.round(outH / 2));
      maskT = this.target('mref', mw, mh, { r8: true });
      this.draw('mask', maskT, (p) => {
        this.bind(p, 'mask', 0, this.maskTex); this.bind(p, 'guide', 1, enh.tex);
        gl.uniform2f(p.u.maskSize, this.maskW, this.maskH); this.maskXform(p);
      });
      // 4. bokeh at half resolution
      bok = this.target('bokeh', mw, mh);
      const radius = pr.blur * 0.045 * Math.min(mw, mh) * 2.2;
      this.draw('bokeh', bok, (p) => {
        this.bind(p, 'img', 0, enh.tex); this.bind(p, 'mask', 1, maskT.tex);
        gl.uniform2f(p.u.size, mw, mh); gl.uniform1f(p.u.radius, radius);
        gl.uniform1f(p.u.boost, pr.bokeh); gl.uniform1f(p.u.focus, pr.focus); gl.uniform1f(p.u.feather, pr.feather);
        gl.uniform1i(p.u.N, opts.quality === 'high' ? 140 : opts.quality === 'low' ? 40 : 80);
      });
    }
    // optional post stage (premium tools): needs the refined mask even without blur
    const post = opts.post && opts.post.active ? opts.post : null;
    if (post && !maskT && this.hasMask) {
      const mw = Math.max(2, Math.round(outW / 2)), mh = Math.max(2, Math.round(outH / 2));
      maskT = this.target('mref', mw, mh, { r8: true });
      this.draw('mask', maskT, (p) => { this.bind(p, 'mask', 0, this.maskTex); this.bind(p, 'guide', 1, enh.tex); gl.uniform2f(p.u.maskSize, this.maskW, this.maskH); this.maskXform(p); });
    }
    const graded = post ? this.target('graded', outW, outH) : null;
    this.lastMaskT = maskT; this.lastEnh = enh;
    // 5. final
    const g = resolveGrade(params);
    this.draw('final', graded, (p) => {
      this.bind(p, 'enh', 0, enh.tex);
      this.bind(p, 'bokeh', 1, bok ? bok.tex : enh.tex);
      this.bind(p, 'mask', 2, maskT ? maskT.tex : this.maskTex);
      this.bind(p, 'blurT', 3, b1.tex);
      this.bind(p, 'orig', 4, up.tex);
      gl.uniform2f(p.u.size, outW, outH);
      gl.uniform1f(p.u.portrait, usePortrait ? 1 : 0);
      gl.uniform1f(p.u.focus, pr.focus); gl.uniform1f(p.u.feather, pr.feather);
      gl.uniform1f(p.u.focusX, pr.focusX ?? 0.5); gl.uniform1f(p.u.focusSel, pr.focusSel || 0);
      gl.uniform1f(p.u.split, opts.split || 0);
      gl.uniform1f(p.u.seed, opts.seed || 0);
      for (const k of ['exposure', 'contrast', 'highlights', 'shadows', 'saturation', 'vibrance', 'fade', 'glow', 'vignette', 'grain', 'monoAmt']) gl.uniform1f(p.u[k], g[k]);
      gl.uniform3fv(p.u.wb, g.wb); gl.uniform3fv(p.u.lift, g.lift); gl.uniform3fv(p.u.gam, g.gamma); gl.uniform3fv(p.u.gain, g.gain);
      gl.uniform3fv(p.u.splitShadow, g.splitShadow); gl.uniform3fv(p.u.splitHigh, g.splitHigh); gl.uniform3fv(p.u.mono, g.mono);
    });
    if (post) post.run(this, { graded, enh, maskT, blur: b1, up, outW, outH, split: opts.split || 0 });
  }

  // Lets add-on stages register their own programs.
  program(name, fs) {
    if (this.progs[name]) return this.progs[name];
    const gl = this.gl; const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VS)); gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'p'); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Link: ' + gl.getProgramInfoLog(p));
    p.u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); p.u[info.name] = gl.getUniformLocation(p, info.name); }
    this.progs[name] = p; return p;
  }

  readPixels() {
    const gl = this.gl, w = this.canvas.width, h = this.canvas.height;
    const px = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px; // bottom-up rows
  }
}
