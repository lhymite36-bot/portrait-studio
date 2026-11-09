// Video Studio UI: multi-track timeline editor (CapCut-style) on top of studio-engine.
import { hooks, toast, openSheet, closeSheet, slider, toggle, segmented, hint, getState, getPipe, stamp, requestRender, fitPreview, videoPreviewFrame } from './app.js';
import * as E from './studio-engine.js';
import { layoutClips, projectDuration, splitAt, SPEED_CURVES, detectBeats, beatCut, encodeWav, KF_PROPS, evalKeyframes } from './studio-core.js';
import { saveToGallery, keepAwake } from './native.js';
import { formatEta } from './grade.js';
import { FONTS, STICKERS } from './tools.js';

const $ = (id) => document.getElementById(id);
let seq = 0; const nid = () => 'i' + (++seq) + Math.random().toString(36).slice(2, 6);
const P = { aspect: '9:16', clips: [], layers: [], texts: [], audios: [], captions: null, reframe: true, useLook: false, bg: '#000', letterbox: false };
let T = 0, PX = 60, sel = null, playing = false, root = null, rendering = false, pendingRender = false, previewAudio = null, audioDirty = true;
window.PS_STUDIO = { P, get T() { return T; }, setT: (t) => setTime(t), add: addMedia, E, render: () => renderPreview(), sel: () => sel, select: (k, id) => select(k, id), refresh: () => refresh() };

const ICON = '<svg viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20M7 5v5M12 5v5M17 5v5"/></svg>';
hooks.openMenu.push({ id: 'studio', label: 'Video Studio (timeline editor)', icon: ICON, run: openStudio });
const emptyActions = document.querySelector('.empty-actions');
if (emptyActions) { const b = document.createElement('button'); b.className = 'big'; b.innerHTML = ICON + 'Studio'; b.onclick = openStudio; emptyActions.appendChild(b); }

function openStudio() {
  if (root) { root.classList.remove('hidden'); refresh(); return; }
  root = document.createElement('div'); root.id = 'studio';
  root.innerHTML = `
  <div class="stop"><button class="pill" id="stClose">‹ Back</button><div class="grow" id="stDur">0:00</div><button class="pill primary" id="stExport">Export</button></div>
  <div id="stPreviewWrap"><canvas id="stPreview" width="360" height="640"></canvas></div>
  <div class="sttrans">
    <button class="round small" id="stPlay"><svg viewBox="0 0 24 24"><path d="M8 5l11 7-11 7z"/></svg></button>
    <span class="sttime" id="stTime">0:00.0</span><span style="flex:1"></span>
    <select id="stAspect"><option>9:16</option><option>16:9</option><option>1:1</option><option>4:5</option><option value="source">Original</option></select>
    <button class="round small" id="stZoomOut">−</button><button class="round small" id="stZoomIn">+</button>
  </div>
  <div class="sttools" id="stTools"></div>
  <div id="stTimeline"><div id="stInner"></div><div id="stPlayhead"></div></div>
  <div id="stProps"></div>`;
  document.body.appendChild(root);
  $('stClose').onclick = () => { stop(); root.classList.add('hidden'); restoreEditor(); };
  $('stExport').onclick = exportSheet;
  $('stPlay').onclick = () => (playing ? stop() : play());
  $('stAspect').onchange = (e) => { P.aspect = e.target.value; refresh(); };
  $('stZoomIn').onclick = () => { PX = Math.min(240, PX * 1.5); refresh(); };
  $('stZoomOut').onclick = () => { PX = Math.max(10, PX / 1.5); refresh(); };
  $('stTimeline').addEventListener('scroll', () => { if (!playing) { T = $('stTimeline').scrollLeft / PX; placeHead(); schedule(); } });
  const tools = [
    ['+ Video', () => pick('video/*,image/*', true, async (fs) => { for (const f of fs) await addMedia(f, 'clip'); }), 'hot'],
    ['+ Overlay', () => pick('video/*,image/*', false, (fs) => addMedia(fs[0], 'layer'))],
    ['+ Text', addText], ['+ Sticker', addSticker], ['+ Music', musicSheet], ['+ SFX', sfxSheet], ['+ Voice (TTS)', addTts],
    ['Captions', captionsSheet], ['Beat sync', beatSync], ['Templates', templatesSheet],
    ['Split', doSplit], ['Duplicate', doDuplicate], ['Delete', doDelete], ['Freeze', doFreeze], ['Reverse', doReverse],
    ['◀ Move', () => move(-1)], ['Move ▶', () => move(1)], ['Keyframe', addKeyframe], ['Extract audio', extractAudio],
  ];
  $('stTools').innerHTML = tools.map(([l, , c], i) => `<button data-i="${i}" class="${c || ''}">${l}</button>`).join('');
  $('stTools').querySelectorAll('button').forEach((b) => b.onclick = () => tools[+b.dataset.i][1]());
  refresh();
}

function pick(accept, multiple, cb) { const i = document.createElement('input'); i.type = 'file'; i.accept = accept; i.multiple = multiple; i.onchange = () => i.files.length && cb([...i.files]); i.click(); }

export async function addMedia(file, where = 'clip') {
  try {
    toast('Adding ' + (file.name || 'media') + '…');
    const s = await E.addSource(file);
    if (s.kind === 'audio') { P.audios.push({ id: nid(), srcId: s.id, start: T, dur: Math.min(s.duration, 600), in: 0, volume: 0.8, name: s.name, fade: true }); }
    else if (where === 'layer') { P.layers.push({ id: nid(), srcId: s.id, start: T, dur: s.kind === 'image' ? 3 : Math.min(s.duration, 10), in: 0, x: 0.72, y: 0.25, scale: 0.7, rot: 0, opacity: 1, blend: 'source-over', shape: 'rounded', name: s.name, _slot: P.layers.length }); select('layer', P.layers[P.layers.length - 1].id); }
    else { P.clips.push({ id: nid(), srcId: s.id, in: 0, out: s.kind === 'image' ? 3 : s.duration, speed: 1, curve: 'none', reverse: false, freeze: 0, transition: { type: P.clips.length ? 'fade' : 'none', dur: 0.4 }, volume: 1, voice: 'none', name: s.name }); }
    audioDirty = true; refresh(); return s;
  } catch (e) { console.error(e); toast('Could not add: ' + e.message, 4000); }
}

// ---------- timeline ----------
function refresh(withProps = true) {
  if (!root) return;
  const layout = layoutClips(P.clips); const dur = projectDuration(P);
  $('stDur').textContent = fmt(dur, false) + (P.clips.length ? ` · ${P.clips.length} clip${P.clips.length > 1 ? 's' : ''}` : '');
  const tl = $('stTimeline'); const pad = tl.clientWidth / 2 || 180;
  const inner = $('stInner'); inner.style.cssText = `position:relative;height:100%;width:${pad * 2 + Math.max(dur, 5) * PX}px`;
  const lane = (y, label) => `<div class="lbl" style="position:absolute;top:${y - 13}px;left:6px">${label}</div>`;
  let h = lane(18, 'VIDEO') + lane(62, 'OVERLAY') + lane(106, 'TEXT · CAPTIONS') + lane(150, 'AUDIO');
  const blk = (cls, kind, id, start, d, y, text, extra = '') => `<div class="blk ${cls} ${sel && sel.id === id ? 'sel' : ''}" data-k="${kind}" data-id="${id}" style="left:${pad + start * PX}px;width:${Math.max(8, d * PX)}px;top:${y}px">${extra}${esc(text)}<span class="h l"></span><span class="h r"></span></div>`;
  layout.items.forEach((it) => { const c = it.clip; h += blk('v', 'clip', c.id, it.start, it.duration, 4, (c.freeze ? '❄ ' : '') + (c.reverse ? '⟲ ' : '') + (c.speed !== 1 || c.curve !== 'none' ? `${c.curve !== 'none' ? c.curve : c.speed + '×'} ` : '') + (c.name || ''), it.trans ? '<span class="tr"></span>' : ''); });
  P.layers.forEach((l) => (h += blk('o', 'layer', l.id, l.start, l.dur, 48, (l.keyframes && l.keyframes.length ? '◆ ' : '') + (l.name || 'overlay'))));
  P.texts.forEach((x) => (h += blk('t', 'text', x.id, x.start, x.dur, 92, (x.keyframes && x.keyframes.length ? '◆ ' : '') + x.text)));
  if (P.captions && P.captions.words && P.captions.words.length) { const w = P.captions.words; h += blk('c', 'captions', 'captions', w[0].start, w[w.length - 1].end - w[0].start, 92, '💬 Captions'); }
  P.audios.forEach((a) => (h += blk('a', 'audio', a.id, a.start, a.dur, 136, '♪ ' + (a.name || 'audio'))));
  inner.innerHTML = h;
  inner.querySelectorAll('.blk').forEach(bindBlock);
  const cv = $('stPreview'); const o = E.outputSize(P, 360); if (cv.width !== o.width || cv.height !== o.height) { cv.width = o.width; cv.height = o.height; }
  tl.scrollLeft = T * PX; placeHead(); if (withProps) renderProps(); schedule();
}
function placeHead() { const tl = $('stTimeline'); $('stPlayhead').style.left = (tl.scrollLeft + tl.clientWidth / 2) + 'px'; $('stTime').textContent = fmt(T, true); }
function setTime(t) { T = Math.max(0, t); $('stTimeline').scrollLeft = T * PX; placeHead(); schedule(); }
const fmt = (t, tenth) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}${tenth ? '.' + Math.floor((t * 10) % 10) : ''}`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function findItem(kind, id) {
  if (kind === 'clip') return P.clips.find((c) => c.id === id);
  if (kind === 'layer') return P.layers.find((c) => c.id === id);
  if (kind === 'text') return P.texts.find((c) => c.id === id);
  if (kind === 'audio') return P.audios.find((c) => c.id === id);
  if (kind === 'captions') return P.captions;
  return null;
}
function select(kind, id) { sel = kind ? { kind, id } : null; refresh(); }

function bindBlock(el) {
  const kind = el.dataset.k, id = el.dataset.id;
  el.addEventListener('pointerdown', (e) => {
    const handle = e.target.classList.contains('h') ? (e.target.classList.contains('l') ? 'l' : 'r') : null;
    if (!sel || sel.id !== id) { select(kind, id); return; }
    const it = findItem(kind, id); if (!it || kind === 'captions') return;
    e.preventDefault(); e.stopPropagation(); el.setPointerCapture(e.pointerId);
    const x0 = e.clientX; const snap = JSON.parse(JSON.stringify(it));
    const src = it.srcId ? E.sources.get(it.srcId) : null;
    const mv = (ev) => {
      const dt = (ev.clientX - x0) / PX;
      if (kind === 'clip') {
        const sp = it.speed || 1;
        if (handle === 'l') it.in = Math.min(snap.out - 0.1, Math.max(0, snap.in + dt * sp));
        else if (handle === 'r') it.out = Math.max(snap.in + 0.1, Math.min(src ? src.duration : 1e9, snap.out + dt * sp));
        if (it.freeze && handle === 'r') it.freeze = Math.max(0.2, snap.freeze + dt);
      } else {
        if (handle === 'l') { const ns = Math.max(0, Math.min(snap.start + snap.dur - 0.1, snap.start + dt)); it.dur = snap.dur - (ns - snap.start); it.start = ns; if (it.in != null) it.in = Math.max(0, (snap.in || 0) + (ns - snap.start)); }
        else if (handle === 'r') it.dur = Math.max(0.1, snap.dur + dt);
        else it.start = Math.max(0, snap.start + dt);
      }
      audioDirty = true; refreshSoon();
    };
    const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); refresh(); };
    el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up);
  });
}
let rs = 0; function refreshSoon() { if (!rs) rs = requestAnimationFrame(() => { rs = 0; refresh(false); }); }

// ---------- preview ----------
const S = getState(); const pipe = getPipe();
let prs = E.newRenderState();
function renderOpts(preview) { return { pipe, params: S.params, post: hooks.post ? hooks.post() : null, preview, rs: prs, overlayHook: overlay }; }
function overlay(ctx, W, H) { if (P.letterbox) { ctx.fillStyle = '#000'; const b = H * 0.11; ctx.fillRect(0, 0, W, b); ctx.fillRect(0, H - b, W, b); } }
function schedule() { if (rendering) { pendingRender = true; return; } renderPreview(); }
async function renderPreview() {
  if (!root) return; rendering = true;
  try { await E.renderFrame(P, T, $('stPreview'), renderOpts(true)); } catch (e) { console.warn(e); }
  rendering = false; if (pendingRender) { pendingRender = false; renderPreview(); }
}
async function play() {
  playing = true; $('stPlay').innerHTML = '<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';
  const dur = projectDuration(P); if (T >= dur - 0.05) T = 0;
  try {
    if (audioDirty || !previewAudio) { toast('Preparing audio…', 1200); const [L, R] = await E.mixAudio(P, dur); const ctx = new AudioContext(); const b = ctx.createBuffer(2, L.length, 48000); b.copyToChannel(L, 0); b.copyToChannel(R, 1); previewAudio = { ctx, b }; audioDirty = false; }
    const src = previewAudio.ctx.createBufferSource(); src.buffer = previewAudio.b; src.connect(previewAudio.ctx.destination); src.start(0, T); previewAudio.node = src;
  } catch (e) { console.warn('preview audio', e); }
  const t0 = performance.now() - T * 1000;
  while (playing) {
    T = (performance.now() - t0) / 1000; if (T >= dur) { T = dur; break; }
    $('stTimeline').scrollLeft = T * PX; placeHead();
    try { await E.renderFrame(P, T, $('stPreview'), renderOpts(true)); } catch (e) { console.warn(e); }
    await new Promise((r) => requestAnimationFrame(r));
  }
  stop();
}
function stop() { playing = false; if (previewAudio && previewAudio.node) { try { previewAudio.node.stop(); } catch (e) { /* stopped */ } previewAudio.node = null; } if ($('stPlay')) $('stPlay').innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5l11 7-11 7z"/></svg>'; }

// ---------- edit operations ----------
function doSplit() {
  if (sel && sel.kind !== 'clip') { const it = findItem(sel.kind, sel.id); if (it && T > it.start + 0.05 && T < it.start + it.dur - 0.05) { const b = { ...JSON.parse(JSON.stringify(it)), id: nid(), start: T, dur: it.start + it.dur - T, in: (it.in || 0) + (T - it.start) }; it.dur = T - it.start; const arr = sel.kind === 'layer' ? P.layers : sel.kind === 'text' ? P.texts : P.audios; arr.push(b); audioDirty = true; refresh(); return; } }
  const r = splitAt(P.clips, T, nid); if (!r) { toast('Move the playhead inside a clip to split'); return; }
  P.clips = r; audioDirty = true; refresh(); toast('Split');
}
function selList() { return !sel ? null : sel.kind === 'clip' ? P.clips : sel.kind === 'layer' ? P.layers : sel.kind === 'text' ? P.texts : sel.kind === 'audio' ? P.audios : null; }
function doDuplicate() { const arr = selList(); if (!arr) { toast('Select something first'); return; } const i = arr.findIndex((x) => x.id === sel.id); const c = { ...JSON.parse(JSON.stringify(arr[i])), id: nid() }; if (sel.kind === 'clip') arr.splice(i + 1, 0, c); else { c.start = arr[i].start + arr[i].dur; arr.push(c); } audioDirty = true; select(sel.kind, c.id); }
function doDelete() { if (sel && sel.kind === 'captions') { P.captions = null; select(null); return; } const arr = selList(); if (!arr) { toast('Select something first'); return; } const i = arr.findIndex((x) => x.id === sel.id); arr.splice(i, 1); audioDirty = true; select(null); }
function doFreeze() {
  const l = layoutClips(P.clips); const it = l.items.find((x) => T >= x.start && T < x.end); if (!it) { toast('Put the playhead on a clip'); return; }
  const src = it.map(T - it.start); let arr = splitAt(P.clips, T, nid) || P.clips.slice();
  const idx = arr.findIndex((c) => c.id === it.clip.id) + 1;
  arr.splice(idx, 0, { ...it.clip, id: nid(), freeze: 2, in: src, out: src + 0.04, reverse: false, curve: 'none', speed: 1, transition: { type: 'none', dur: 0.3 }, name: 'Freeze' });
  P.clips = arr; audioDirty = true; refresh(); toast('Freeze frame added (2s)');
}
function doReverse() { if (!sel || sel.kind !== 'clip') { toast('Select a video clip'); return; } const c = findItem('clip', sel.id); c.reverse = !c.reverse; audioDirty = true; refresh(); }
function move(d) { if (!sel || sel.kind !== 'clip') { toast('Select a video clip'); return; } const i = P.clips.findIndex((c) => c.id === sel.id); const j = i + d; if (j < 0 || j >= P.clips.length) return; [P.clips[i], P.clips[j]] = [P.clips[j], P.clips[i]]; audioDirty = true; refresh(); }
function addText(text) {
  const t = typeof text === 'string' ? text : prompt('Text', 'Your title'); if (!t) return;
  P.texts.push({ id: nid(), text: t, start: T, dur: 3, x: 0.5, y: 0.2, size: 0.08, color: '#ffffff', font: 'sans', anim: 'pop', scale: 1, rot: 0, opacity: 1 });
  select('text', P.texts[P.texts.length - 1].id);
}
function addSticker() {
  openSheet(`<h2>Sticker</h2><div class="btnrow">${STICKERS.map((e) => `<button class="btn" data-e="${e}" style="font-size:24px">${e}</button>`).join('')}</div>`);
  $('sheetCard').querySelectorAll('[data-e]').forEach((b) => b.onclick = () => { closeSheet(); P.texts.push({ id: nid(), text: b.dataset.e, start: T, dur: 3, x: 0.5, y: 0.5, size: 0.14, color: '#fff', font: 'sans', anim: 'pop', scale: 1, rot: 0, opacity: 1 }); select('text', P.texts[P.texts.length - 1].id); });
}
function addKeyframe() {
  if (!sel || (sel.kind !== 'layer' && sel.kind !== 'text')) { toast('Select an overlay or text, then tap Keyframe'); return; }
  const it = findItem(sel.kind, sel.id); const t = T - it.start; if (t < 0 || t > it.dur) { toast('Move the playhead over the selected item'); return; }
  const cur = evalKeyframes(it, t); it.keyframes = (it.keyframes || []).filter((k) => Math.abs(k.t - t) > 0.05);
  it.keyframes.push({ t, ...cur }); it.keyframes.sort((a, b) => a.t - b.t);
  toast(`Keyframe ${it.keyframes.length} at ${t.toFixed(1)}s. Move the playhead, change position/size, tap Keyframe again.`, 3500); refresh();
}
async function extractAudio() {
  const c = sel && sel.kind === 'clip' ? findItem('clip', sel.id) : P.clips[0]; if (!c) { toast('Add a video first'); return; }
  const s = E.sources.get(c.srcId); const b = await E.sourceAudio(s); if (!b) { toast('This clip has no sound'); return; }
  const wav = encodeWav([b.getChannelData(0), b.getChannelData(Math.min(1, b.numberOfChannels - 1))], b.sampleRate);
  const r = await saveToGallery(new Blob([wav], { type: 'audio/wav' }), `PortraitStudio_audio_${stamp()}.wav`);
  const g = E.addGeneratedSource('Audio of ' + (c.name || 'clip'), b); P.audios.push({ id: nid(), srcId: g.id, start: layoutClips(P.clips).items.find((x) => x.clip.id === c.id).start, dur: b.duration, in: c.in, volume: 1, name: g.name }); c.volume = 0; audioDirty = true;
  refresh(); toast('Audio saved to ' + r.where + ' and detached to the audio track');
}

// ---------- music / sfx / tts ----------
function musicSheet() {
  openSheet(`<h2>Music</h2><div class="hint">Royalty-free tracks generated on your phone (CC0, free to post anywhere), or use your own.</div>
  <div class="menu">${E.MUSIC.map((m) => `<button data-m="${m.id}">♪ ${m.name} · ${m.bpm} BPM</button>`).join('')}<button data-m="file">📁 From your phone…</button></div>`);
  $('sheetCard').querySelectorAll('[data-m]').forEach((b) => b.onclick = async () => {
    closeSheet();
    if (b.dataset.m === 'file') { pick('audio/*', false, (fs) => addMedia(fs[0])); return; }
    toast('Making music…'); const dur = Math.min(600, layoutClips(P.clips).duration || 30);
    const buf = await E.makeMusic(b.dataset.m, dur); const m = E.MUSIC.find((x) => x.id === b.dataset.m);
    const s = E.addGeneratedSource(m.name, buf); P.audios.push({ id: nid(), srcId: s.id, start: 0, dur, in: 0, volume: 0.6, name: m.name, fade: true, bpm: m.bpm }); audioDirty = true; refresh();
  });
}
function sfxSheet() {
  openSheet(`<h2>Sound effects</h2><div class="btnrow">${E.SFX.map((m) => `<button class="btn" data-s="${m.id}">${m.name}</button>`).join('')}</div>`);
  $('sheetCard').querySelectorAll('[data-s]').forEach((b) => b.onclick = async () => { closeSheet(); const buf = await E.makeSfx(b.dataset.s); const s = E.addGeneratedSource(b.textContent, buf); P.audios.push({ id: nid(), srcId: s.id, start: T, dur: buf.duration, in: 0, volume: 0.9, name: b.textContent }); audioDirty = true; refresh(); });
}
async function addTts() {
  const p = globalThis.Capacitor && Capacitor.Plugins && Capacitor.Plugins.NativeTts;
  const text = prompt('What should the voice say?', 'Welcome to my video'); if (!text) return;
  if (!p) { toast('Text-to-speech uses the Android app (phone voice engine).', 4000); return; }
  try {
    toast('Speaking…'); const r = await p.synthesize({ text, rate: 1, pitch: 1 });
    const bytes = Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0));
    const buf = await new AudioContext().decodeAudioData(bytes.buffer);
    const s = E.addGeneratedSource('Voice: ' + text.slice(0, 18), buf); P.audios.push({ id: nid(), srcId: s.id, start: T, dur: buf.duration, in: 0, volume: 1, name: s.name }); audioDirty = true; refresh();
  } catch (e) { toast('TTS failed: ' + e.message, 4000); }
}

// ---------- captions ----------
function captionsSheet() {
  if (!P.clips.length) { toast('Add a video with speech first'); return; }
  openSheet(`<h2>Auto captions</h2><div class="hint">Speech recognition runs on your phone (Whisper tiny). First use downloads about 40 MB, then it's cached. Slow on budget phones: about 1–2× the clip length.</div>
  <div id="capLang"></div><div class="progress"><i id="capBar"></i></div><div class="stat"><span id="capStat">Ready</span></div>
  <div class="btnrow" style="margin-top:12px"><button class="btn primary" id="capGo">Generate captions</button><button class="btn" id="capClose">Close</button></div>`);
  let lang = 'auto'; segmented($('capLang'), [['auto', 'Auto'], ['english', 'English'], ['hindi', 'Hindi']], () => lang, (v) => (lang = v));
  $('capClose').onclick = closeSheet;
  $('capGo').onclick = async () => {
    $('capGo').disabled = true;
    try {
      const r = await E.transcribe(P, (e) => { if (e.stage === 'download') { $('capStat').textContent = `Downloading model… ${Math.round(e.f * 100)}%`; $('capBar').style.width = (e.f * 100) + '%'; } else { $('capStat').textContent = 'Listening…'; $('capBar').style.width = '100%'; } }, lang);
      P.captions = { words: r.words, style: 'pop', color: '#ffd54a', y: 0.78, size: 0.075, upper: false };
      $('capStat').textContent = `${r.words.length} words captioned`; closeSheet(); select('captions', 'captions');
    } catch (e) { console.error(e); $('capStat').textContent = 'Failed: ' + e.message; }
    $('capGo').disabled = false;
  };
}

// ---------- beat sync ----------
async function beatSync() {
  const a = (sel && sel.kind === 'audio' && findItem('audio', sel.id)) || P.audios[0];
  if (!a) { toast('Add music first (+ Music), then Beat sync'); return; }
  if (!P.clips.length) { toast('Add some clips first'); return; }
  const s = E.sources.get(a.srcId); const b = s.audio; toast('Finding the beat…');
  await new Promise((r) => setTimeout(r, 20));
  const ch = b.getChannelData(0); const off = Math.round((a.in || 0) * b.sampleRate); const n = Math.min(ch.length - off, Math.round(a.dur * b.sampleRate));
  const { bpm, beats } = detectBeats(ch.subarray(off, off + n), b.sampleRate);
  if (!beats.length) { toast('No clear beat found'); return; }
  const every = bpm > 120 ? 4 : 2;
  const shifted = beats.map((t) => t + a.start);
  if (shifted[0] > 0.05) shifted.unshift(0);
  P.clips = beatCut(P.clips, shifted, every, nid); audioDirty = true; refresh();
  toast(`${Math.round(bpm)} BPM · ${P.clips.length} cuts on the beat`, 3500);
}

// ---------- templates ----------
const TEMPLATES = [
  { id: 'montage', name: 'Beat Montage', desc: 'Fast cuts on the beat, zoom/whip/glitch transitions, vibrant look', run: async () => { await ensureMusic('pop'); await beatSync(); P.clips.forEach((c, i) => (c.transition = { type: i ? ['zoom', 'whip', 'glitch'][i % 3] : 'none', dur: 0.2 })); setLook('vibrant'); addText('MONTAGE'); P.texts[P.texts.length - 1].start = 0; } },
  { id: 'cinematic', name: 'Cinematic Trailer', desc: '16:9, letterbox, slower motion, fades, film look, pulse music', run: async () => { P.aspect = '16:9'; P.letterbox = true; P.clips.forEach((c, i) => { c.speed = 0.8; c.transition = { type: i ? 'fade' : 'none', dur: 0.8 }; }); setLook('cinematic'); await ensureMusic('cine'); addText('COMING SOON'); Object.assign(P.texts[P.texts.length - 1], { anim: 'fade', start: 0.3, font: 'serif', size: 0.06, y: 0.5 }); } },
  { id: 'glowup', name: 'Glow Up', desc: 'B&W before, glitch, colourful after with neon outline', run: async () => { if (P.clips.length === 1) P.clips = splitAt(P.clips, layoutClips(P.clips).duration / 2, nid) || P.clips; setLook('none'); P.clips.forEach((c, i) => { c.glow = i ? '#22d3ee' : null; c.transition = { type: i ? 'glitch' : 'none', dur: 0.35 }; }); await addSfxAt('riser', Math.max(0, layoutClips(P.clips).items[1] ? layoutClips(P.clips).items[1].start - 2 : 0)); } },
  { id: 'vlog', name: 'Vlog Day', desc: '9:16, warm look, soft lo-fi, karaoke captions', run: async () => { P.aspect = '9:16'; P.reframe = true; setLook('warm'); await ensureMusic('lofi', 0.25); P.clips.forEach((c, i) => (c.transition = { type: i ? 'slide' : 'none', dur: 0.35 })); toast('Tip: tap Captions to add karaoke subtitles', 3500); } },
  { id: 'punch', name: 'Zoom Punch', desc: 'Face zoom on every clip, flash-in speed ramps, pop SFX on cuts', run: async () => { const l = layoutClips(P.clips); P.clips.forEach((c) => { c.faceZoom = true; c.curve = 'flashIn'; }); for (const it of layoutClips(P.clips).items.slice(1)) await addSfxAt('pop', it.start); void l; } },
  { id: 'neon', name: 'Neon Night', desc: 'Neon grade, glow outline, synthwave', run: async () => { setLook('cyber'); P.clips.forEach((c) => (c.glow = '#ff4fd8')); await ensureMusic('synth'); } },
];
function setLook(id) { P.useLook = id !== 'none'; S.params.look.id = id; S.params.look.intensity = 1; S.params.portrait.enabled = false; }
async function ensureMusic(id, vol = 0.6) { if (P.audios.some((a) => a.bpm)) return; const dur = layoutClips(P.clips).duration || 30; const buf = await E.makeMusic(id, dur); const m = E.MUSIC.find((x) => x.id === id); const s = E.addGeneratedSource(m.name, buf); P.audios.push({ id: nid(), srcId: s.id, start: 0, dur, in: 0, volume: vol, name: m.name, fade: true, bpm: m.bpm }); }
async function addSfxAt(id, t) { const buf = await E.makeSfx(id); const s = E.addGeneratedSource(id, buf); P.audios.push({ id: nid(), srcId: s.id, start: t, dur: buf.duration, in: 0, volume: 0.8, name: id }); }
function templatesSheet() {
  if (!P.clips.length) { toast('Add your clips first, then pick a template'); return; }
  openSheet(`<h2>Templates</h2><div class="menu">${TEMPLATES.map((t) => `<button data-t="${t.id}"><div style="text-align:left"><div>${t.name}</div><div class="hint" style="margin:2px 0 0">${t.desc}</div></div></button>`).join('')}</div>`);
  $('sheetCard').querySelectorAll('[data-t]').forEach((b) => b.onclick = async () => { closeSheet(); const t = TEMPLATES.find((x) => x.id === b.dataset.t); toast('Applying ' + t.name + '…'); await t.run(); audioDirty = true; refresh(); toast(t.name + ' applied'); });
}
window.PS_STUDIO.templates = TEMPLATES;

// ---------- properties ----------
function renderProps() {
  const el = $('stProps'); el.innerHTML = '';
  if (!sel) { projectProps(el); return; }
  const it = findItem(sel.kind, sel.id); if (!it) { sel = null; projectProps(el); return; }
  const ch = () => { audioDirty = true; refreshSoon(); };
  const wrapSet = (fn) => (v) => { fn(v); ch(); };
  if (sel.kind === 'clip') {
    hint(el, `Clip · ${it.name || ''}`);
    if (!it.freeze) {
      slider(el, 'Speed', () => it.speed, wrapSet((v) => (it.speed = v)), 0.25, 4, 0.05, (v) => v.toFixed(2) + '×');
      segmented(el, Object.keys(SPEED_CURVES).map((k) => [k, k === 'none' ? 'Constant' : k[0].toUpperCase() + k.slice(1)]), () => it.curve || 'none', wrapSet((v) => (it.curve = v)));
    } else slider(el, 'Freeze length', () => it.freeze, wrapSet((v) => (it.freeze = v)), 0.3, 6, 0.1, (v) => v.toFixed(1) + 's');
    segmented(el, [['none', 'No transition'], ['fade', 'Fade'], ['zoom', 'Zoom'], ['whip', 'Whip'], ['glitch', 'Glitch'], ['slide', 'Slide']], () => it.transition.type, wrapSet((v) => (it.transition.type = v)));
    slider(el, 'Transition', () => it.transition.dur, wrapSet((v) => (it.transition.dur = v)), 0.1, 1.5, 0.05, (v) => v.toFixed(2) + 's');
    slider(el, 'Volume', () => it.volume ?? 1, wrapSet((v) => (it.volume = v)), 0, 2, 0.05);
    segmented(el, [['none', 'Voice: normal'], ['chipmunk', 'Chipmunk'], ['deep', 'Deep'], ['robot', 'Robot'], ['echo', 'Echo'], ['telephone', 'Phone']], () => it.voice || 'none', wrapSet((v) => (it.voice = v)));
    toggle(el, 'Reduce noise', () => !!it.denoise, wrapSet((v) => (it.denoise = v)));
    toggle(el, 'Face zoom (punch in)', () => !!it.faceZoom, wrapSet((v) => (it.faceZoom = v)));
    toggle(el, 'Glow outline', () => !!it.glow, wrapSet((v) => (it.glow = v ? '#22d3ee' : null)));
    chromaProps(el, it, ch);
  } else if (sel.kind === 'layer') {
    hint(el, 'Overlay / picture-in-picture. Drag on the timeline to move; use Keyframe to animate.');
    transformProps(el, it, ch);
    segmented(el, [['source-over', 'Normal'], ['screen', 'Screen'], ['multiply', 'Multiply'], ['overlay', 'Overlay'], ['lighten', 'Lighten'], ['difference', 'Difference']], () => it.blend, wrapSet((v) => (it.blend = v)));
    segmented(el, [['none', 'Rect'], ['rounded', 'Rounded'], ['circle', 'Circle'], ['heart', 'Heart'], ['star', 'Star']], () => it.shape || 'none', wrapSet((v) => (it.shape = v)));
    toggle(el, 'White border', () => !!it.border, wrapSet((v) => (it.border = v ? '#ffffff' : null)));
    chromaProps(el, it, ch);
  } else if (sel.kind === 'text') {
    const row = document.createElement('div'); row.className = 'btnrow'; row.innerHTML = '<button class="btn" id="tEdit">Edit text</button>'; el.appendChild(row);
    row.querySelector('#tEdit').onclick = () => { const t = prompt('Text', it.text); if (t != null) { it.text = t; refresh(); } };
    transformProps(el, it, ch);
    slider(el, 'Size', () => it.size, wrapSet((v) => (it.size = v)), 0.03, 0.25, 0.005, (v) => Math.round(v * 100));
    segmented(el, [['none', 'Static'], ['fade', 'Fade'], ['pop', 'Pop'], ['slide', 'Slide up'], ['typewriter', 'Typewriter']], () => it.anim, wrapSet((v) => (it.anim = v)));
    segmented(el, FONTS.map((f) => [f.id, f.name]), () => it.font, wrapSet((v) => (it.font = v)));
    const cr = document.createElement('div'); cr.className = 'btnrow';
    cr.innerHTML = ['#ffffff', '#000000', '#ffd54a', '#ff4f8b', '#22d3ee', '#7c5cff', '#2ecc71'].map((c) => `<button class="btn" data-c="${c}" style="width:30px;height:30px;padding:0;background:${c}"></button>`).join('') + '<button class="btn" id="tGlow">Glow</button><button class="btn" id="tBox">Box</button><button class="btn" id="tStroke">Outline</button>';
    cr.querySelectorAll('[data-c]').forEach((b) => b.onclick = () => { it.color = b.dataset.c; ch(); });
    cr.querySelector('#tGlow').onclick = () => { it.glow = !it.glow; ch(); }; cr.querySelector('#tBox').onclick = () => { it.box = it.box ? null : 'rgba(0,0,0,.55)'; ch(); }; cr.querySelector('#tStroke').onclick = () => { it.stroke = it.stroke ? null : '#000'; ch(); };
    el.appendChild(cr);
  } else if (sel.kind === 'audio') {
    hint(el, `Audio · ${it.name || ''}`);
    slider(el, 'Volume', () => it.volume, wrapSet((v) => (it.volume = v)), 0, 2, 0.05);
    toggle(el, 'Fade in/out', () => !!it.fade, wrapSet((v) => (it.fade = v)));
    segmented(el, [['none', 'Normal'], ['chipmunk', 'Chipmunk'], ['deep', 'Deep'], ['robot', 'Robot'], ['echo', 'Echo'], ['telephone', 'Phone']], () => it.voice || 'none', wrapSet((v) => (it.voice = v)));
    toggle(el, 'Reduce noise', () => !!it.denoise, wrapSet((v) => (it.denoise = v)));
  } else if (sel.kind === 'captions') {
    segmented(el, E.CAPTION_STYLES.map((s) => [s.id, s.name]), () => it.style, wrapSet((v) => (it.style = v)));
    slider(el, 'Position', () => it.y, wrapSet((v) => (it.y = v)), 0.1, 0.92);
    slider(el, 'Size', () => it.size, wrapSet((v) => (it.size = v)), 0.04, 0.14, 0.005, (v) => Math.round(v * 100));
    toggle(el, 'ALL CAPS', () => !!it.upper, wrapSet((v) => (it.upper = v)));
    const row = document.createElement('div'); row.className = 'btnrow'; row.innerHTML = '<button class="btn" id="cEdit">Edit words</button>'; el.appendChild(row);
    row.querySelector('#cEdit').onclick = () => { const t = prompt('Fix the caption text (same number of words keeps timing):', it.words.map((w) => w.text).join(' ')); if (t == null) return; const ws = t.trim().split(/\s+/); if (ws.length === it.words.length) ws.forEach((w, i) => (it.words[i].text = w)); else { const s = it.words[0].start, e = it.words[it.words.length - 1].end; it.words = ws.map((w, i) => ({ text: w, start: s + (e - s) * i / ws.length, end: s + (e - s) * (i + 1) / ws.length })); } it._lines = null; ch(); };
  }
  const dn = document.createElement('div'); dn.className = 'btnrow'; dn.innerHTML = '<button class="btn" id="stDesel">Done</button>'; el.appendChild(dn);
  dn.querySelector('#stDesel').onclick = () => select(null);
}
function transformProps(el, it, ch) {
  const t = Math.max(0, Math.min(it.dur, T - it.start)); const live = evalKeyframes(it, t);
  const set = (k) => (v) => { if (it.keyframes && it.keyframes.length) { const kf = it.keyframes.find((x) => Math.abs(x.t - t) < 0.06); if (kf) kf[k] = v; else it[k] = v; } else it[k] = v; ch(); };
  slider(el, 'X', () => live.x, set('x'), 0, 1); slider(el, 'Y', () => live.y, set('y'), 0, 1);
  slider(el, 'Scale', () => live.scale, set('scale'), 0.1, 3, 0.01, (v) => v.toFixed(2));
  slider(el, 'Rotate', () => live.rot, set('rot'), -180, 180, 1, (v) => v + '°');
  slider(el, 'Opacity', () => live.opacity, set('opacity'), 0, 1);
  if (it.keyframes && it.keyframes.length) { const r = document.createElement('div'); r.className = 'btnrow'; r.innerHTML = `<span class="hint">${it.keyframes.length} keyframes</span><button class="btn" id="kfClr">Clear keyframes</button>`; el.appendChild(r); r.querySelector('#kfClr').onclick = () => { it.keyframes = []; ch(); refresh(); }; }
  void KF_PROPS;
}
function chromaProps(el, it, ch) {
  toggle(el, 'Green screen (chroma key)', () => !!it.chroma, (v) => { it.chroma = v ? { color: '#00ff00', similarity: 0.4, smooth: 0.3 } : null; ch(); renderProps(); });
  if (it.chroma) {
    const r = document.createElement('div'); r.className = 'btnrow';
    r.innerHTML = [['#00ff00', 'Green'], ['#0047bb', 'Blue'], ['#ffffff', 'White'], ['#000000', 'Black']].map(([c, n]) => `<button class="btn" data-c="${c}">${n}</button>`).join('');
    r.querySelectorAll('[data-c]').forEach((b) => b.onclick = () => { it.chroma.color = b.dataset.c; ch(); }); el.appendChild(r);
    slider(el, 'Key strength', () => it.chroma.similarity, (v) => { it.chroma.similarity = v; ch(); }, 0, 1);
    slider(el, 'Edge smooth', () => it.chroma.smooth, (v) => { it.chroma.smooth = v; ch(); }, 0, 1);
  }
}
function projectProps(el) {
  hint(el, P.clips.length ? 'Tap a block on the timeline to edit it. Drag a selected block to move it; drag its edges to trim.' : 'Tap + Video to add clips (videos or photos). Add several to merge them into one video.');
  toggle(el, 'Auto reframe (keep people centred)', () => P.reframe, (v) => { P.reframe = v; schedule(); });
  toggle(el, 'Apply my Portrait Studio look', () => P.useLook, (v) => { P.useLook = v; schedule(); });
  toggle(el, 'Cinema bars', () => P.letterbox, (v) => { P.letterbox = v; schedule(); });
}

// ---------- export ----------
function exportSheet() {
  stop();
  const dur = projectDuration(P); if (!dur) { toast('Add a clip first'); return; }
  const o = { res: '720', fps: '30', size: '0' };
  openSheet(`<h2>Export video</h2><div class="hint" id="exInfo"></div><div id="exOpts"></div>
    <div class="progress"><i id="exBar"></i></div><div class="stat"><span id="exStat">Ready · no watermark</span><span id="exEta"></span></div>
    <div class="btnrow" style="margin-top:12px"><button class="btn primary" id="exGo">Export MP4</button><button class="btn" id="exClose">Close</button></div>`);
  const info = () => { const s = E.outputSize(P, +o.res); const mb = +o.size || Math.round((s.width * s.height * +o.fps * 0.14 / 8e6 * dur + 0.016 * dur) * 10) / 10; $('exInfo').textContent = `${s.width}×${s.height} · ${o.fps} fps · ${fmt(dur)} · ≈ ${mb} MB`; };
  segmented($('exOpts'), [['720', '720p'], ['1080', '1080p'], ['1440', '2K'], ['2160', '4K']], () => o.res, (v) => { o.res = v; info(); });
  segmented($('exOpts'), [['24', '24 fps'], ['30', '30 fps'], ['60', '60 fps']], () => o.fps, (v) => { o.fps = v; info(); });
  segmented($('exOpts'), [['0', 'Auto size'], ['8', '≤ 8 MB'], ['16', '≤ 16 MB'], ['50', '≤ 50 MB']], () => o.size, (v) => { o.size = v; info(); });
  hint($('exOpts'), '4K / 60 fps only if your phone\u2019s encoder supports it; budget phones: 720p or 1080p at 30 fps.');
  info();
  let ac = null;
  $('exClose').onclick = () => { if (ac) ac.abort(); closeSheet(); };
  $('exGo').onclick = async () => {
    if (ac) { ac.abort(); return; }
    ac = new AbortController(); $('exGo').textContent = 'Cancel'; $('exGo').className = 'btn danger'; await keepAwake(true);
    try {
      const r = await E.exportProject(P, { shortSide: +o.res, fps: +o.fps, sizeMB: +o.size, signal: ac.signal, pipe, params: S.params, post: hooks.post ? hooks.post() : null, overlayHook: overlay,
        onProgress: (p) => { if (p.stage === 'audio') { $('exStat').textContent = 'Mixing sound…'; return; } $('exBar').style.width = (100 * p.done / p.total).toFixed(1) + '%'; $('exStat').textContent = `Frame ${p.done}/${p.total} · ${p.fps.toFixed(1)} fps`; $('exEta').textContent = 'ETA ' + formatEta(p.eta); } });
      $('exStat').textContent = 'Saving…';
      const s = await saveToGallery(r.blob, `PortraitStudio_edit_${stamp()}.mp4`);
      $('exBar').style.width = '100%'; $('exStat').textContent = `Saved ${r.width}×${r.height} ${r.fps}fps (${(r.blob.size / 1e6).toFixed(1)} MB) to ${s.where}`; $('exEta').textContent = r.audio ? 'with sound' : 'no sound';
      window.PS_STUDIO.lastExport = { ...r, blob: undefined, size: r.blob.size };
    } catch (e) { console.error(e); $('exStat').textContent = e.name === 'AbortError' ? 'Cancelled' : 'Failed: ' + e.message; $('exEta').textContent = ''; }
    ac = null; await keepAwake(false); const g = $('exGo'); if (g) { g.textContent = 'Export MP4'; g.className = 'btn primary'; }
  };
}

// The studio shares the GPU pipeline with the photo/video editor; put the editor's picture back.
function restoreEditor() {
  try {
    if (S.kind === 'photo' && S.bitmap) { pipe.setSource(S.bitmap, S.bitmap.width, S.bitmap.height, 0); if (S.mask) pipe.setMask(S.mask.data, S.mask.width, S.mask.height); fitPreview(S.bitmap.width, S.bitmap.height); requestRender(); }
    else if (S.kind === 'video') { const v = document.getElementById('video'); fitPreview(v.videoWidth, v.videoHeight); videoPreviewFrame(true); }
  } catch (e) { console.warn('restore editor', e); }
}
