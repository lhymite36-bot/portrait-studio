// Frame-by-frame video export: MP4 demux (mp4box) -> WebCodecs VideoDecoder ->
// GPU pipeline -> VideoEncoder (H.264) -> MP4 mux with the original audio copied
// bit-for-bit (no re-encode). Designed to stream from the File so long clips do
// not need to fit in memory.
import { Muxer, ArrayBufferTarget } from '../vendor/mp4-muxer.mjs';
import { computeVideoSize, videoBitrate, avcCodecFor } from './grade.js';
import { VideoSegmenter } from './seg.js';
import { estimateShift } from './motion.js';

const MP4Box = () => globalThis.MP4Box;

async function readBytes(file, start, end) {
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

// Walk top-level boxes using only small header reads.
export async function scanBoxes(file) {
  const boxes = []; let pos = 0;
  while (pos + 8 <= file.size && boxes.length < 1000) {
    const h = await readBytes(file, pos, Math.min(file.size, pos + 16));
    const dv = new DataView(h.buffer);
    let size = dv.getUint32(0);
    const type = String.fromCharCode(h[4], h[5], h[6], h[7]);
    if (size === 1) size = Number(dv.getBigUint64(8));
    else if (size === 0) size = file.size - pos;
    if (size < 8) break;
    boxes.push({ type, start: pos, size });
    pos += size;
  }
  return boxes;
}

export async function demux(file) {
  const boxes = await scanBoxes(file);
  const moov = boxes.find((b) => b.type === 'moov');
  if (!moov) throw new Error('This video is not a standard MP4/MOV (no moov box). Try a clip recorded by the phone camera.');
  if (moov.size > 200e6) throw new Error('Video index is too large.');
  const mp4 = MP4Box().createFile(false);
  const ready = new Promise((res, rej) => { mp4.onReady = res; mp4.onError = rej; });
  // Feed only ftyp+moov as one contiguous buffer: sample offsets in the index
  // are absolute, so the (large) mdat never has to be read here.
  const parts = [];
  for (const b of boxes.filter((x) => x.type === 'ftyp' || x.type === 'moov')) parts.push(await readBytes(file, b.start, b.start + b.size));
  const joined = new Uint8Array(parts.reduce((a, x) => a + x.length, 0));
  let o = 0; for (const x of parts) { joined.set(x, o); o += x.length; }
  const buf = joined.buffer; buf.fileStart = 0;
  mp4.appendBuffer(buf);
  mp4.flush();
  const info = await Promise.race([ready, new Promise((_, r) => setTimeout(() => r(new Error('Could not read video header')), 8000))]);
  const vt = info.videoTracks[0];
  if (!vt) throw new Error('No video track found.');
  const at = info.audioTracks[0] || null;
  const vtrak = mp4.getTrackById(vt.id);
  const atrak = at ? mp4.getTrackById(at.id) : null;
  const m = vt.matrix || [65536, 0, 0, 0, 65536, 0, 0, 0, 1073741824];
  const toNum = (x) => (x | 0) / 65536;
  let rot = Math.round((Math.atan2(toNum(m[1]), toNum(m[0])) * 180) / Math.PI);
  rot = ((rot % 360) + 360) % 360;
  rot = [0, 90, 180, 270].reduce((a, b) => (Math.abs(b - rot) < Math.abs(a - rot) ? b : a), 0);
  const timescale = vtrak.mdia.mdhd.timescale;
  const samples = vtrak.samples;
  const duration = samples.length ? (samples[samples.length - 1].cts + samples[samples.length - 1].duration) / timescale : 0;
  const durs = samples.map((x) => x.duration).filter((x) => x > 0).sort((a, b) => a - b);
  const med = durs.length ? durs[durs.length >> 1] : timescale / 30;
  const fps = Math.min(120, Math.max(1, timescale / med));
  return {
    mp4, info, vt, at, vtrak, atrak, rotation: rot, timescale, samples, fps, duration,
    width: vt.video ? vt.video.width : vt.track_width, height: vt.video ? vt.video.height : vt.track_height,
    codec: vt.codec,
  };
}

function videoDescription(trak) {
  const DS = globalThis.DataStream;
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
    if (box) {
      const stream = new DS(undefined, 0, DS.BIG_ENDIAN);
      box.write(stream);
      return new Uint8Array(stream.buffer, 8);
    }
  }
  return undefined;
}

function audioConfig(d) {
  if (!d.at) return null;
  const entry = d.atrak.mdia.minf.stbl.stsd.entries[0];
  const codec = d.at.codec || '';
  const sampleRate = d.at.audio.sample_rate, numberOfChannels = d.at.audio.channel_count;
  if (codec.startsWith('mp4a')) {
    let dsi = null;
    try { dsi = entry.esds.esd.descs[0].descs[0].data; } catch (e) { /* ignore */ }
    return { muxCodec: 'aac', decoderConfig: { codec: codec === 'mp4a' ? 'mp4a.40.2' : codec, sampleRate, numberOfChannels, description: dsi ? new Uint8Array(dsi) : undefined }, sampleRate, numberOfChannels };
  }
  if (codec.startsWith('Opus') || codec.startsWith('opus')) {
    return { muxCodec: 'opus', decoderConfig: { codec: 'opus', sampleRate, numberOfChannels }, sampleRate, numberOfChannels };
  }
  return null; // e.g. AMR / PCM: exported without audio, reported to the user
}

class SampleReader {
  constructor(file) { this.file = file; this.start = 0; this.buf = null; }
  async get(s) {
    const end = s.offset + s.size;
    if (!this.buf || s.offset < this.start || end > this.start + this.buf.length) {
      this.start = s.offset;
      this.buf = await readBytes(this.file, s.offset, Math.min(this.file.size, Math.max(end, s.offset + 4 * 1024 * 1024)));
    }
    return this.buf.subarray(s.offset - this.start, end - this.start);
  }
}

// Draw a frame upright into a small canvas for the segmenter.
export function drawUpright(ctx, frame, w, h, rot) {
  const c = ctx.canvas;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((rot * Math.PI) / 180);
  const swap = rot === 90 || rot === 270;
  const dw = swap ? c.height : c.width, dh = swap ? c.width : c.height;
  ctx.drawImage(frame, -dw / 2, -dh / 2, dw, dh);
}

export async function probeEncoder(width, height, fps) {
  const tries = [avcCodecFor(width, height, fps), 'avc1.640028', 'avc1.4d0028', 'avc1.42001f'];
  for (const codec of tries) {
    for (const hardwareAcceleration of ['prefer-hardware', 'no-preference', 'prefer-software']) {
      const cfg = { codec, width, height, bitrate: videoBitrate(width, height, fps), framerate: fps, hardwareAcceleration, avc: { format: 'avc' } };
      try { const r = await VideoEncoder.isConfigSupported(cfg); if (r.supported) return r.config; } catch (e) { /* next */ }
    }
  }
  return null;
}

/**
 * opts: { file, params, pipeline, shortSide (720|1080|0), maskKind ('fast'|'quality'),
 *         onProgress({done,total,fps,eta,stage}), signal, maxSeconds, frameHook(ctx) }
 */
export async function exportVideo(opts) {
  if (!('VideoEncoder' in globalThis) || !('VideoDecoder' in globalThis)) throw new Error('This phone\u2019s WebView does not support WebCodecs. Update "Android System WebView" from the Play Store.');
  const d = await demux(opts.file);
  const maxS = opts.maxSeconds || 600;
  const swap = d.rotation === 90 || d.rotation === 270;
  const upW = swap ? d.height : d.width, upH = swap ? d.width : d.height;
  const fpsIn = Math.min(60, Math.round(d.fps) || 30);
  const slow = Math.max(1, opts.slowmo || 1);
  const { width, height } = computeVideoSize(upW, upH, opts.shortSide ?? 720, opts.maxLong || (opts.shortSide >= 1080 ? 1920 : opts.shortSide === 0 ? 3840 : 1280));
  const encCfg = await probeEncoder(width, height, fpsIn);
  if (!encCfg) throw new Error(`H.264 encoding at ${width}x${height} is not supported on this device. Try 720p.`);
  const decCfg = { codec: d.codec, codedWidth: d.width, codedHeight: d.height, description: videoDescription(d.vtrak) };
  const decSup = await VideoDecoder.isConfigSupported(decCfg).catch(() => ({ supported: false }));
  if (!decSup.supported) throw new Error(`This phone cannot decode the clip's codec (${d.codec}).`);

  const ac = slow === 1 ? audioConfig(d) : null;
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width, height },
    audio: ac ? { codec: ac.muxCodec, numberOfChannels: ac.numberOfChannels, sampleRate: ac.sampleRate } : undefined,
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  });

  let encErr = null;
  const encoder = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { encErr = e; } });
  encoder.configure(encCfg);

  const frames = []; let decErr = null; let wake = null;
  const decoder = new VideoDecoder({ output: (f) => { frames.push(f); if (wake) { wake(); wake = null; } }, error: (e) => { decErr = e; if (wake) wake(); } });
  decoder.configure(decCfg);

  const needMask = opts.params.portrait.enabled || (opts.renderOpts && opts.renderOpts.post && opts.renderOpts.post.active);
  const seg = needMask ? new VideoSegmenter(opts.maskKind === 'fast' ? 'fast' : 'quality') : null;
  if (seg) await seg.init();
  const segCanvas = document.createElement('canvas');
  const segScale = Math.min(1, 768 / Math.max(upW, upH));
  segCanvas.width = Math.max(16, Math.round(upW * segScale)); segCanvas.height = Math.max(16, Math.round(upH * segScale));
  const segCtx = segCanvas.getContext('2d', { willReadFrequently: false });

  const stab = opts.stabilize ? new Stabilizer(d, upW, upH, opts.stabilize) : null;
  const reader = new SampleReader(opts.file);
  const samples = d.samples.filter((s) => s.cts / d.timescale < maxS);
  const total = samples.length;
  let fed = 0, done = 0; const t0 = performance.now();
  const frameDurUs = Math.round(1e6 / fpsIn);
  let lastMaskTs = -1;
  const pipe = opts.pipeline;
  const aborted = () => opts.signal && opts.signal.aborted;
  let prevPixels = null;

  const feed = async () => {
    while (fed < total && decoder.decodeQueueSize < 3 && frames.length < 3) {
      const s = samples[fed++];
      const data = await reader.get(s);
      decoder.decode(new EncodedVideoChunk({ type: s.is_sync ? 'key' : 'delta', timestamp: Math.round((s.cts * 1e6) / d.timescale), duration: Math.round((s.duration * 1e6) / d.timescale), data }));
    }
    if (fed >= total && !feed.flushed) { feed.flushed = true; decoder.flush().then(() => { feed.flushDone = true; if (wake) { wake(); wake = null; } }).catch(() => {}); }
  };

  let outIndex = 0;
  let outCanvas = pipe.canvas;
  const encodeCanvas = async (ts) => {
    while (encoder.encodeQueueSize > 3) await new Promise((r) => setTimeout(r, 4));
    const vf = new VideoFrame(outCanvas, { timestamp: ts, duration: frameDurUs });
    encoder.encode(vf, { keyFrame: outIndex % Math.round(fpsIn * 2) === 0 });
    vf.close(); outIndex++;
  };

  try {
    let tsBase = null;
    while (done < total) {
      if (aborted()) throw new DOMException('Cancelled', 'AbortError');
      if (decErr) throw decErr; if (encErr) throw encErr;
      await feed();
      if (!frames.length) {
        if (feed.flushDone) break;
        await new Promise((r) => { wake = r; setTimeout(r, 50); });
        continue;
      }
      frames.sort((a, b) => a.timestamp - b.timestamp);
      const f = frames.shift();
      if (tsBase === null) tsBase = f.timestamp;
      if (stab) { stab.update(f); pipe.stab = stab.transform(); }
      pipe.setSource(f, f.displayWidth, f.displayHeight, d.rotation);
      if (seg) {
        const every = opts.maskEvery || (opts.maskKind === 'balanced' ? 3 : 1);
        if (done % every === 0 || lastMaskTs < 0) {
          drawUpright(segCtx, f, d.width, d.height, d.rotation);
          const ms = Math.max(lastMaskTs + 1, Math.round((f.timestamp - tsBase) / 1000));
          const m = await seg.segment(segCanvas, ms, opts.maskSmooth ?? 0.45);
          lastMaskTs = ms;
          pipe.setMask(m.data, m.width, m.height);
        }
      }
      const fts = f.timestamp - tsBase;
      if (opts.beforeRender) {
        let drawn = !!seg && (done % (opts.maskEvery || (opts.maskKind === 'balanced' ? 3 : 1)) === 0);
        await opts.beforeRender(() => { if (!drawn) { drawUpright(segCtx, f, d.width, d.height, d.rotation); drawn = true; } return segCanvas; }, fts / 1e6, done);
      }
      f.close();
      const params = opts.paramsAt ? opts.paramsAt(fts / 1e6) : opts.params;
      pipe.render(params, width, height, Object.assign({ quality: opts.quality || 'low', seed: done % 64 }, opts.renderOpts || {}));
      outCanvas = (opts.frameHook && opts.frameHook(pipe, fts / 1e6, width, height)) || pipe.canvas;
      if (slow > 1) {
        // slow motion: blend between consecutive processed frames
        const cur = outCanvas;
        if (!prevPixels) { prevPixels = document.createElement('canvas'); prevPixels.width = width; prevPixels.height = height; prevPixels.ctx = prevPixels.getContext('2d'); prevPixels.has = false; }
        if (!exportVideo.blend) { exportVideo.blend = document.createElement('canvas'); }
        const bc = exportVideo.blend; bc.width = width; bc.height = height; const bctx = bc.getContext('2d');
        if (prevPixels.has) {
          for (let k = 1; k < slow; k++) {
            bctx.globalAlpha = 1; bctx.drawImage(prevPixels, 0, 0);
            bctx.globalAlpha = k / slow; bctx.drawImage(cur, 0, 0); bctx.globalAlpha = 1;
            while (encoder.encodeQueueSize > 3) await new Promise((r) => setTimeout(r, 4));
            const vf = new VideoFrame(bc, { timestamp: outIndex * frameDurUs, duration: frameDurUs });
            encoder.encode(vf, { keyFrame: outIndex % Math.round(fpsIn * 2) === 0 }); vf.close(); outIndex++;
          }
        }
        await encodeCanvas(outIndex * frameDurUs);
        prevPixels.ctx.drawImage(cur, 0, 0); prevPixels.has = true;
      } else {
        await encodeCanvas(fts);
      }
      done++;
      const el = (performance.now() - t0) / 1000;
      const fpsP = done / Math.max(0.001, el);
      if (opts.onProgress && (done % 2 === 0 || done === total)) opts.onProgress({ done, total, fps: fpsP, eta: (total - done) / fpsP, stage: 'video' });
      if (done % 8 === 0) await new Promise((r) => setTimeout(r, 0)); // keep UI responsive
    }
    await encoder.flush();
    if (encErr) throw encErr;
    // copy original audio untouched
    let audioNote = null;
    if (ac) {
      const ar = new SampleReader(opts.file);
      const ats = d.atrak.mdia.mdhd.timescale;
      let first = true;
      for (const s of d.atrak.samples) {
        if (aborted()) throw new DOMException('Cancelled', 'AbortError');
        if (s.cts / ats >= maxS) break;
        const data = await ar.get(s);
        muxer.addAudioChunkRaw(new Uint8Array(data), 'key', Math.round((s.cts * 1e6) / ats), Math.round((s.duration * 1e6) / ats), first ? { decoderConfig: ac.decoderConfig } : undefined);
        first = false;
      }
    } else if (d.at) audioNote = slow > 1 ? 'Slow motion exports without sound.' : `Audio codec ${d.at.codec} can't be copied; exported without sound.`;
    muxer.finalize();
    const blob = new Blob([muxer.target.buffer], { type: 'video/mp4' });
    return { blob, width, height, frames: outIndex, seconds: (performance.now() - t0) / 1000, audio: !!ac, audioNote, sourceFps: fpsIn, rotation: d.rotation, truncated: samples.length < d.samples.length };
  } finally {
    pipe.stab = null;
    frames.forEach((f) => f.close());
    try { decoder.close(); } catch (e) { /* closed */ }
    try { encoder.close(); } catch (e) { /* closed */ }
  }
}

// Online video stabiliser: estimates global translation between consecutive
// frames on a small grey copy (coarse-to-fine block matching), low-pass filters
// the camera path and shifts + slightly zooms each frame to cancel the shake.
export class Stabilizer {
  constructor(d, upW, upH, strength = 1) {
    this.d = d; this.W = 160; this.H = Math.max(16, Math.round(160 * upH / upW));
    this.c = document.createElement('canvas'); this.c.width = this.W; this.c.height = this.H;
    this.ctx = this.c.getContext('2d', { willReadFrequently: true });
    this.prev = null; this.path = [0, 0]; this.smooth = [0, 0];
    this.alpha = 0.9 + 0.07 * Math.min(1, strength); this.zoom = 1.08 + 0.04 * Math.min(1, strength);
    this.maxShift = (this.zoom - 1) / (2 * this.zoom);
  }
  gray() {
    const px = this.ctx.getImageData(0, 0, this.W, this.H).data;
    const g = new Float32Array(this.W * this.H);
    for (let i = 0; i < g.length; i++) g[i] = px[i * 4] * 0.3 + px[i * 4 + 1] * 0.59 + px[i * 4 + 2] * 0.11;
    return g;
  }
  update(frame) {
    drawUpright(this.ctx, frame, 0, 0, this.d.rotation);
    const g = this.gray();
    if (this.prev) {
      const [dx, dy] = estimateShift(this.prev, g, this.W, this.H, 8);
      this.path[0] += dx; this.path[1] += dy;
    }
    this.prev = g;
    this.smooth[0] = this.alpha * this.smooth[0] + (1 - this.alpha) * this.path[0];
    this.smooth[1] = this.alpha * this.smooth[1] + (1 - this.alpha) * this.path[1];
  }
  transform() {
    // correction in upright UV units (GL v axis points up, image rows point down)
    const cx = (this.path[0] - this.smooth[0]) / this.W, cy = (this.path[1] - this.smooth[1]) / this.H;
    const m = this.maxShift;
    return { x: Math.max(-m, Math.min(m, cx)), y: Math.max(-m, Math.min(m, -cy)), zoom: this.zoom };
  }
}


// ---------- random-access decoded frames (Video Studio preview + export) ----------
// Decodes with WebCodecs straight from the app's private copy of the file, so it does not
// depend on the <video> element (which can stay blank in some Android WebViews when seeking
// a paused video). Sequential playback is cheap; jumps restart from the previous keyframe.
export class FrameSource {
  static async open(file) {
    if (!('VideoDecoder' in globalThis)) throw new Error('no WebCodecs');
    const d = await demux(file);
    const cfg = { codec: d.codec, codedWidth: d.width, codedHeight: d.height, description: videoDescription(d.vtrak), optimizeForLatency: true };
    const sup = await VideoDecoder.isConfigSupported(cfg).catch(() => ({ supported: false }));
    if (!sup.supported) throw new Error('codec not supported: ' + d.codec);
    return new FrameSource(file, d, cfg);
  }
  constructor(file, d, cfg) {
    this.file = file; this.d = d; this.cfg = cfg; this.ts = d.timescale;
    this.samples = d.samples; // decode order
    const swap = d.rotation === 90 || d.rotation === 270;
    this.width = swap ? d.height : d.width; this.height = swap ? d.width : d.height;
    this.canvas = document.createElement('canvas'); this.canvas.width = this.width; this.canvas.height = this.height;
    this.ctx = this.canvas.getContext('2d');
    this.frameDur = 1e6 / (d.fps || 30);
    this.q = []; this.cur = null; this.dec = null; this.next = 0; this.maxFed = -1; this.ended = false; this.reader = new SampleReader(file); this.err = null;
    this.firstPts = Math.min(...d.samples.slice(0, 32).map((s) => s.cts)) / this.ts * 1e6;
  }
  makeDecoder() {
    if (this.dec) { try { this.dec.close(); } catch (e) { /* closed */ } }
    this.q.forEach((f) => f.close()); this.q = [];
    this.err = null;
    this.dec = new VideoDecoder({ output: (f) => { this.q.push(f); this.q.sort((a, b) => a.timestamp - b.timestamp); if (this.wake) { this.wake(); this.wake = null; } }, error: (e) => { this.err = e; if (this.wake) { this.wake(); this.wake = null; } } });
    this.dec.configure(this.cfg); this.ended = false;
  }
  seekIndex(T) { // decode-order index of the keyframe at or before presentation time T (us)
    let k = 0;
    for (let i = 0; i < this.samples.length; i++) { const s = this.samples[i]; if (s.cts / this.ts * 1e6 > T + 1) break; if (s.is_sync) k = i; }
    return k;
  }
  async feed() {
    const s = this.samples[this.next++];
    const data = await this.reader.get(s);
    this.dec.decode(new EncodedVideoChunk({ type: s.is_sync ? 'key' : 'delta', timestamp: Math.round(s.cts / this.ts * 1e6), duration: Math.round(s.duration / this.ts * 1e6), data }));
    this.maxFed = Math.max(this.maxFed, s.cts / this.ts * 1e6);
  }
  wait(ms) { return new Promise((r) => { const t = setTimeout(r, ms); this.wake = () => { clearTimeout(t); r(); }; }); }
  // Returns an upright canvas with the frame shown at time t (seconds).
  async frameAt(t) {
    const T = Math.max(this.firstPts, t * 1e6);
    const curTs = this.cur ? this.cur.timestamp : -Infinity;
    if (!this.dec || this.err || T < curTs - 1 || T > Math.max(this.maxFed, curTs) + 1.5e6) {
      this.makeDecoder(); this.next = this.seekIndex(T); this.maxFed = -1;
      if (this.cur) { this.cur.close(); this.cur = null; }
    }
    const deadline = performance.now() + 8000;
    for (;;) {
      if (this.err) throw this.err;
      let best = null;
      while (this.q.length && this.q[0].timestamp <= T + this.frameDur * 0.5) { if (best) best.close(); best = this.q.shift(); }
      if (best) { if (this.cur) this.cur.close(); this.cur = best; }
      if (this.q.length || (this.ended && !this.dec.decodeQueueSize)) break;
      if (performance.now() > deadline) throw new Error('decoder stalled');
      if (this.next < this.samples.length) {
        await this.feed();
        if (this.dec.decodeQueueSize > 6) await this.wait(10);
      } else if (!this.ended) { await this.dec.flush().catch((e) => { this.err = e; }); this.ended = true; }
      else await this.wait(10);
    }
    if (!this.cur) { if (this.q.length) { this.cur = this.q.shift(); } else throw new Error('no frame'); }
    drawUpright(this.ctx, this.cur, this.width, this.height, this.d.rotation);
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    return this.canvas;
  }
  close() { try { if (this.dec) this.dec.close(); } catch (e) { /* closed */ } this.q.forEach((f) => f.close()); this.q = []; if (this.cur) this.cur.close(); this.cur = null; }
}
