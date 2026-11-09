// Portrait Studio UI controller.
import { Pipeline } from './gl.js';
import { segmentImage } from './seg.js';
import { defaultParams, LOOKS, computeOutputSize, formatEta } from './grade.js';
import { exportVideo, demux } from './video.js';
import { saveToGallery, keepAwake } from './native.js';

const $ = (id) => document.getElementById(id);
const canvas = $('canvas');
let pipe;
try { pipe = new Pipeline(canvas); } catch (e) { alert(e.message); }

const state = {
  kind: null,            // 'photo' | 'video'
  file: null, bitmap: null, mask: null,
  params: loadParams(), tab: 'portrait', split: 0, compare: false,
  previewW: 0, previewH: 0, videoInfo: null, playing: false,
};
window.PS = state; // handy for debugging / headless smoke tests

function loadParams() {
  try { const s = JSON.parse(localStorage.getItem('ps.params') || 'null'); if (s) return Object.assign(defaultParams(), s); } catch (e) { /* ignore */ }
  return defaultParams();
}
function persist() { try { localStorage.setItem('ps.params', JSON.stringify(state.params)); } catch (e) { /* ignore */ } }

export function toast(msg, ms = 2600) {
  const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), ms);
}
function busy(on, text) { $('busy').classList.toggle('hidden', !on); if (text) $('busyText').textContent = text; }

// ---------- rendering ----------
let raf = 0;
export function requestRender() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; renderPreview(); }); }

function fitPreview(w, h) {
  const st = $('stage').getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const s = Math.min((st.width - 12) / w, (st.height - 12) / h, 1e9);
  let W = Math.round(w * s * dpr), H = Math.round(h * s * dpr);
  const cap = 1280 / Math.max(W, H);
  if (cap < 1) { W = Math.round(W * cap); H = Math.round(H * cap); }
  state.previewW = Math.max(2, W); state.previewH = Math.max(2, H);
  canvas.style.width = Math.round(w * s) + 'px'; canvas.style.height = Math.round(h * s) + 'px';
}

function renderPreview() {
  if (!state.kind || !pipe) return;
  const split = state.compare ? 1 : state.split;
  pipe.render(state.params, state.previewW, state.previewH, { quality: state.playing ? 'low' : 'mid', split, post: hooks.post ? hooks.post() : null });
  hooks.afterRender.forEach((f) => f(pipe, { preview: true, t: state.kind === 'video' ? video.currentTime : 0 }));
}

// ---------- open files ----------
document.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openPicker(b.dataset.open)));
$('btnOpen').addEventListener('click', () => sheetMenu());
function openPicker(kind) { ({ photo: $('filePhoto'), camera: $('fileCamera'), video: $('fileVideo') })[kind].click(); }
$('filePhoto').addEventListener('change', (e) => e.target.files[0] && loadPhoto(e.target.files[0]));
$('fileCamera').addEventListener('change', (e) => e.target.files[0] && loadPhoto(e.target.files[0]));
$('fileVideo').addEventListener('change', (e) => e.target.files[0] && loadVideo(e.target.files[0]));

function sheetMenu() {
  openSheet(`<h2>Open</h2><div class="menu">
    <button data-k="photo"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="3"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-8 8"/></svg>Photo from gallery</button>
    <button data-k="camera"><svg viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>Take a photo</button>
    <button data-k="video"><svg viewBox="0 0 24 24"><rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3z"/></svg>Video from gallery</button>
    ${hooks.openMenu.map((m) => `<button data-x="${m.id}">${m.icon}${m.label}</button>`).join('')}
  </div>`);
  $('sheetCard').querySelectorAll('[data-k]').forEach((b) => b.onclick = () => { closeSheet(); openPicker(b.dataset.k); });
  $('sheetCard').querySelectorAll('[data-x]').forEach((b) => b.onclick = () => { closeSheet(); hooks.openMenu.find((m) => m.id === b.dataset.x).run(); });
}

export async function loadPhoto(file) {
  stopVideo();
  state.kind = 'photo'; state.file = file;
  showView(); busy(true, 'Loading photo…');
  try {
    let bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const lim = computeOutputSize(bmp.width, bmp.height, 'orig', pipe.maxTex);
    if (lim.width < bmp.width) { const b2 = await createImageBitmap(file, { imageOrientation: 'from-image', resizeWidth: lim.width, resizeHeight: lim.height, resizeQuality: 'high' }); bmp.close(); bmp = b2; toast('Large photo: working at ' + lim.width + '×' + lim.height); }
    state.bitmap = bmp;
    pipe.setSource(bmp, bmp.width, bmp.height, 0);
    fitPreview(bmp.width, bmp.height);
    busy(true, 'Finding people…');
    await setPhotoMask(bmp);
    hooks.sourceChanged.forEach((f) => f('photo'));
    enableEditing(); renderThumbs(); requestRender();
  } catch (e) { console.error(e); toast('Could not open photo: ' + e.message, 5000); }
  busy(false);
}

async function setPhotoMask(bmp) {
  try {
    const m = await segmentImage(bmp, 'quality');
    state.mask = m; pipe.setMask(m.data, m.width, m.height);
    if (!m.data.some((v) => v > 128)) toast('No person found; blur strength will apply to the whole photo edges.', 3500);
  } catch (e) { console.error(e); pipe.hasMask = false; toast('Portrait detection failed on this phone. Please report this: ' + e.message, 12000); }
}

const video = $('video');
async function loadVideo(file) {
  stopVideo();
  state.kind = 'video'; state.file = file; showView(); busy(true, 'Reading video…');
  try {
    state.videoInfo = await demux(file).catch((e) => { toast(e.message, 5000); return null; });
    video.src = URL.createObjectURL(file);
    await new Promise((res, rej) => { video.onloadeddata = res; video.onerror = () => rej(new Error('This video format cannot be played here.')); });
    fitPreview(video.videoWidth, video.videoHeight);
    $('videoBar').classList.remove('hidden');
    video.currentTime = Math.min(0.5, video.duration / 2);
    await new Promise((r) => (video.onseeked = r));
    await videoPreviewFrame(true);
    hooks.sourceChanged.forEach((f) => f('video'));
    enableEditing(); renderThumbs();
  } catch (e) { console.error(e); toast('Could not open video: ' + e.message, 5000); }
  busy(false);
}

const frameCanvas = document.createElement('canvas');
let segBusy = false;
async function videoPreviewFrame(withMask) {
  frameCanvas.width = state.previewW; frameCanvas.height = state.previewH;
  frameCanvas.getContext('2d').drawImage(video, 0, 0, frameCanvas.width, frameCanvas.height);
  pipe.setSource(frameCanvas, frameCanvas.width, frameCanvas.height, 0);
  if (withMask && state.params.portrait.enabled && !segBusy) {
    segBusy = true;
    try { const m = await segmentImage(frameCanvas, state.playing ? 'fast' : 'quality'); pipe.setMask(m.data, m.width, m.height); } catch (e) { console.warn(e); }
    segBusy = false;
  }
  renderPreview();
  $('vtime').textContent = fmtTime(video.currentTime);
  $('scrub').value = Math.round((video.currentTime / (video.duration || 1)) * 1000);
}
const fmtTime = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
$('scrub').addEventListener('input', (e) => { video.currentTime = (e.target.value / 1000) * (video.duration || 0); });
video.addEventListener('seeked', () => { if (!state.playing && state.kind === 'video') videoPreviewFrame(true); });
$('btnPlay').addEventListener('click', () => (state.playing ? stopVideo() : playVideo()));
function playVideo() {
  state.playing = true; video.play();
  const step = async () => { if (!state.playing) return; await videoPreviewFrame(true); if (!video.paused && !video.ended) video.requestVideoFrameCallback(step); else stopVideo(); };
  video.requestVideoFrameCallback(step);
}
function stopVideo() { state.playing = false; try { video.pause(); } catch (e) { /* noop */ } }

function showView() { $('empty').classList.add('hidden'); $('view').classList.remove('hidden'); $('videoBar').classList.toggle('hidden', state.kind !== 'video'); }
export function getState() { return state; }
export function getPipe() { return pipe; }
export { videoPreviewFrame, fitPreview, persist };
function enableEditing() { ['btnSave', 'btnCompare', 'btnSplit', 'btnReset'].forEach((id) => ($(id).disabled = false)); }

// ---------- compare ----------
const cmp = $('btnCompare');
const on = () => { state.compare = true; requestRender(); }, off = () => { state.compare = false; requestRender(); };
cmp.addEventListener('pointerdown', on); cmp.addEventListener('pointerup', off); cmp.addEventListener('pointerleave', off);
$('btnSplit').addEventListener('click', () => {
  state.split = state.split ? 0 : 0.5;
  $('btnSplit').classList.toggle('on', !!state.split);
  $('splitHandle').classList.toggle('hidden', !state.split); placeSplit(); requestRender();
});
function placeSplit() {
  const r = canvas.getBoundingClientRect(), v = $('view').getBoundingClientRect();
  const h = $('splitHandle'); h.style.left = (r.left - v.left + r.width * state.split) + 'px'; h.style.top = (r.top - v.top) + 'px'; h.style.height = r.height + 'px'; h.style.bottom = 'auto';
}
$('splitHandle').addEventListener('pointerdown', (e) => {
  e.target.setPointerCapture(e.pointerId);
  const move = (ev) => { const r = canvas.getBoundingClientRect(); state.split = Math.min(0.99, Math.max(0.01, (ev.clientX - r.left) / r.width)); placeSplit(); requestRender(); };
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
});
$('btnReset').addEventListener('click', () => { state.params = defaultParams(); persist(); renderPanel(); requestRender(); toast('Reset to defaults'); });
window.addEventListener('resize', () => { if (state.kind === 'photo' && state.bitmap) fitPreview(state.bitmap.width, state.bitmap.height); else if (state.kind === 'video') fitPreview(video.videoWidth, video.videoHeight); if (state.split) placeSplit(); requestRender(); });

// ---------- panels ----------
const ICON = {
  portrait: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/></svg>',
  enhance: '<svg viewBox="0 0 24 24"><path d="M12 3l2.5 5.5L20 11l-5.5 2.5L12 19l-2.5-5.5L4 11l5.5-2.5z"/></svg>',
  looks: '<svg viewBox="0 0 24 24"><circle cx="9" cy="9" r="5"/><circle cx="15" cy="9" r="5"/><circle cx="12" cy="15" r="5"/></svg>',
  adjust: '<svg viewBox="0 0 24 24"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/></svg>',
  effects: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/></svg>',
};
export const TABS = [
  { id: 'portrait', label: 'Portrait', icon: ICON.portrait, render: panelPortrait },
  { id: 'enhance', label: 'Quality', icon: ICON.enhance, render: panelEnhance },
  { id: 'looks', label: 'Looks', icon: ICON.looks, render: panelLooks },
  { id: 'adjust', label: 'Adjust', icon: ICON.adjust, render: panelAdjust },
  { id: 'effects', label: 'Effects', icon: ICON.effects, render: panelEffects },
];
export const hooks = { afterRender: [], sourceChanged: [], openMenu: [], beforeExport: [], photoExport: [] };

export function renderTabs() {
  $('tabs').innerHTML = TABS.map((t) => `<button class="tab ${t.id === state.tab ? 'on' : ''}" data-t="${t.id}">${t.icon}<span>${t.label}</span></button>`).join('');
  $('tabs').querySelectorAll('.tab').forEach((b) => b.onclick = () => { state.tab = b.dataset.t; renderTabs(); renderPanel(); });
}
export function renderPanel() {
  const t = TABS.find((x) => x.id === state.tab) || TABS[0];
  $('panelBody').innerHTML = '';
  t.render($('panelBody'));
}

export function slider(parent, label, get, set, min, max, step = 0.01, fmt) {
  const row = document.createElement('div'); row.className = 'row';
  row.innerHTML = `<label>${label}</label><input type="range" min="${min}" max="${max}" step="${step}"><output></output>`;
  const inp = row.querySelector('input'), out = row.querySelector('output');
  const show = () => { const v = +inp.value; out.textContent = fmt ? fmt(v) : (Math.round(v * 100)); inp.style.setProperty('--p', ((v - min) / (max - min)) * 100 + '%'); };
  inp.value = get(); show();
  inp.addEventListener('input', () => { set(+inp.value); show(); persist(); onParamChange(); });
  inp.addEventListener('dblclick', () => { inp.value = (min < 0 ? 0 : min); inp.dispatchEvent(new Event('input')); });
  parent.appendChild(row); return inp;
}
export function toggle(parent, label, get, set) {
  const row = document.createElement('div'); row.className = 'switch';
  row.innerHTML = `<span>${label}</span><button class="toggle ${get() ? 'on' : ''}"></button>`;
  const b = row.querySelector('button');
  b.onclick = () => { set(!get()); b.classList.toggle('on', get()); persist(); onParamChange(); };
  parent.appendChild(row); return b;
}
export function segmented(parent, options, get, set) {
  const row = document.createElement('div'); row.className = 'seg';
  row.innerHTML = options.map(([v, l]) => `<button data-v="${v}" class="${get() === v ? 'on' : ''}">${l}</button>`).join('');
  row.querySelectorAll('button').forEach((b) => b.onclick = () => { set(b.dataset.v); row.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); persist(); onParamChange(); });
  parent.appendChild(row); return row;
}
export function hint(parent, text) { const p = document.createElement('div'); p.className = 'hint'; p.textContent = text; parent.appendChild(p); }

export function onParamChange() {
  if (state.kind === 'video' && !state.playing) { videoPreviewFrame(false); return; }
  requestRender();
}

function panelPortrait(el) {
  const p = state.params.portrait;
  toggle(el, 'Portrait blur', () => p.enabled, (v) => { p.enabled = v; if (v && state.kind === 'video') videoPreviewFrame(true); });
  slider(el, 'Blur', () => p.blur, (v) => (p.blur = v), 0, 1);
  slider(el, 'Focus', () => p.focus, (v) => (p.focus = v), -1, 1, 0.01, (v) => (v > 0 ? '+' : '') + Math.round(v * 100));
  slider(el, 'Edge softness', () => p.feather, (v) => (p.feather = v), 0, 1);
  slider(el, 'Bokeh lights', () => p.bokeh, (v) => (p.bokeh = v), 0, 1);
  hint(el, 'Focus + keeps more around the person sharp; Focus − tightens the cut-out.');
}
function panelEnhance(el) {
  const e = state.params.enhance;
  if (state.kind !== 'video') segmented(el, [['orig', 'Original size'], ['2x', '2× (max 4K)'], ['4k', '4K']], () => e.scale, (v) => (e.scale = v));
  slider(el, 'Sharpen', () => e.sharpen, (v) => (e.sharpen = v), 0, 1);
  slider(el, 'Denoise', () => e.denoise, (v) => (e.denoise = v), 0, 1);
  slider(el, 'Clarity', () => e.clarity, (v) => (e.clarity = v), -1, 1);
  hint(el, 'Natural enhancement only: no AI-redrawn faces. Upscaling applies when you save.');
}
function panelLooks(el) {
  const chips = document.createElement('div'); chips.className = 'chips';
  const all = LOOKS.concat(hooks.extraLooks ? hooks.extraLooks() : []);
  chips.innerHTML = all.map((l) => `<button class="chip ${state.params.look.id === l.id ? 'on' : ''}" data-id="${l.id}"><div class="thumb" style="background-image:url(${thumbs[l.id] || ''})"></div>${l.name}</button>`).join('');
  chips.querySelectorAll('.chip').forEach((c) => c.onclick = () => { state.params.look.id = c.dataset.id; chips.querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', x === c)); persist(); onParamChange(); });
  el.appendChild(chips);
  slider(el, 'Intensity', () => state.params.look.intensity, (v) => (state.params.look.intensity = v), 0, 1);
  if (hooks.looksExtra) hooks.looksExtra(el);
}
function panelAdjust(el) {
  const a = state.params.adjust;
  slider(el, 'Exposure', () => a.exposure, (v) => (a.exposure = v), -2, 2, 0.01, (v) => v.toFixed(1));
  slider(el, 'Contrast', () => a.contrast, (v) => (a.contrast = v), -1, 1);
  slider(el, 'Highlights', () => a.highlights, (v) => (a.highlights = v), -1, 1);
  slider(el, 'Shadows', () => a.shadows, (v) => (a.shadows = v), -1, 1);
  slider(el, 'Saturation', () => a.saturation, (v) => (a.saturation = v), -1, 1);
  slider(el, 'Vibrance', () => a.vibrance, (v) => (a.vibrance = v), -1, 1);
  slider(el, 'Temperature', () => a.temperature, (v) => (a.temperature = v), -1, 1);
  slider(el, 'Tint', () => a.tint, (v) => (a.tint = v), -1, 1);
}
function panelEffects(el) {
  const f = state.params.effects;
  slider(el, 'Glow', () => f.glow, (v) => (f.glow = v), 0, 1);
  slider(el, 'Vignette', () => f.vignette, (v) => (f.vignette = v), 0, 1);
  slider(el, 'Grain', () => f.grain, (v) => (f.grain = v), 0, 1);
  slider(el, 'Fade', () => f.fade, (v) => (f.fade = v), 0, 1);
  if (hooks.effectsExtra) hooks.effectsExtra(el);
}

// Look thumbnails rendered with the real pipeline on the current image.
const thumbs = {};
export function renderThumbs() {
  if (!pipe || !state.kind) return;
  const tw = 120, th = Math.max(2, Math.round(120 * state.previewH / state.previewW));
  const all = LOOKS.concat(hooks.extraLooks ? hooks.extraLooks() : []);
  for (const l of all) {
    const p = JSON.parse(JSON.stringify(state.params)); p.look = { id: l.id, intensity: 1 };
    pipe.render(p, tw, th, { quality: 'low' });
    thumbs[l.id] = canvas.toDataURL('image/jpeg', 0.8);
  }
  renderPanel(); requestRender();
}

// ---------- sheets ----------
export function openSheet(html) { $('sheetCard').innerHTML = html; $('sheet').classList.remove('hidden'); }
export function closeSheet() { $('sheet').classList.add('hidden'); }
$('sheet').addEventListener('click', (e) => { if (e.target === $('sheet') && !exporting) closeSheet(); });

// ---------- save / export ----------
let exporting = null;
$('btnSave').addEventListener('click', () => (state.kind === 'photo' ? savePhoto() : videoExportSheet()));

export async function renderFullPhoto(params = state.params) {
  const bmp = state.bitmap;
  const out = computeOutputSize(bmp.width, bmp.height, params.enhance.scale, pipe.maxTex);
  pipe.render(params, out.width, out.height, { quality: 'high', split: 0, post: hooks.post ? hooks.post() : null });
  hooks.afterRender.forEach((f) => f(pipe, { preview: false }));
  let target = canvas;
  for (const f of hooks.photoExport) target = f(target, out) || target;
  out.canvas = target;
  return out;
}
export function canvasBlob(type = 'image/jpeg', q = 0.95, c = canvas) { return new Promise((r) => c.toBlob(r, type, q)); }

async function savePhoto() {
  busy(true, 'Rendering full resolution…');
  await new Promise((r) => setTimeout(r, 30));
  try {
    const out = await renderFullPhoto();
    const fmt = (hooks.exportFormat && hooks.exportFormat()) || 'image/jpeg';
    const blob = await canvasBlob(fmt, 0.95, out.canvas);
    if (!blob) throw new Error('Image is too large for this phone. Try Original size.');
    busy(true, 'Saving to gallery…');
    const name = `PortraitStudio_${stamp()}.${fmt === 'image/png' ? 'png' : 'jpg'}`;
    const r = await saveToGallery(blob, name);
    toast(`Saved ${out.width}×${out.height} to ${r.where}`);
  } catch (e) { console.error(e); toast('Save failed: ' + e.message, 5000); }
  busy(false); requestRender();
}
export const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

function videoExportSheet() {
  stopVideo();
  const info = state.videoInfo;
  const dur = info ? info.duration : video.duration;
  const opts = state.videoOpts || (state.videoOpts = { res: '720', mask: 'balanced', slowmo: '1' });
  openSheet(`<h2>Export video</h2>
    <div class="hint">${info ? `${info.width}×${info.height} · ${Math.round(info.fps)} fps · ${fmtTime(dur)}` : ''}</div>
    <div id="vxOpts"></div>
    <div class="progress"><i id="vxBar"></i></div>
    <div class="stat"><span id="vxStat">Ready</span><span id="vxEta"></span></div>
    <div class="btnrow" style="margin-top:14px"><button class="btn primary" id="vxGo">Export MP4</button><button class="btn" id="vxClose">Close</button></div>`);
  const o = $('vxOpts');
  segmented(o, [['720', '720p (fast)'], ['1080', '1080p'], ['0', 'Original']], () => opts.res, (v) => (opts.res = v));
  segmented(o, [['fast', 'Fast mask'], ['balanced', 'Balanced'], ['quality', 'Best (slow)']], () => opts.mask, (v) => (opts.mask = v));
  segmented(o, [['1', 'Normal speed'], ['2', 'Slow-mo 2×'], ['4', 'Slow-mo 4×']], () => opts.slowmo, (v) => (opts.slowmo = v));
  if (hooks.videoExportOptions) hooks.videoExportOptions(o, opts);
  hint(o, 'Keep the app open while exporting. Original sound is kept (normal speed).');
  $('vxClose').onclick = () => { if (exporting) exporting.abort(); closeSheet(); };
  $('vxGo').onclick = () => runVideoExport(opts);
}

async function runVideoExport(opts) {
  if (exporting) { exporting.abort(); return; }
  const ac = new AbortController(); exporting = ac;
  $('vxGo').textContent = 'Cancel'; $('vxGo').className = 'btn danger';
  await keepAwake(true);
  try {
    hooks.beforeExport.forEach((f) => f(opts));
    const r = await exportVideo({
      file: state.file, params: JSON.parse(JSON.stringify(state.params)), pipeline: pipe,
      shortSide: +opts.res, maskKind: opts.mask, slowmo: +opts.slowmo, signal: ac.signal,
      quality: opts.res === '720' ? 'low' : 'mid',
      paramsAt: opts.paramsAt, frameHook: opts.frameHook, renderOpts: opts.renderOpts, stabilize: opts.stabilize,
      onProgress: (p) => { $('vxBar').style.width = (100 * p.done / p.total).toFixed(1) + '%'; $('vxStat').textContent = `Frame ${p.done}/${p.total} · ${p.fps.toFixed(1)} fps`; $('vxEta').textContent = 'ETA ' + formatEta(p.eta); },
    });
    $('vxStat').textContent = 'Saving to gallery…';
    const s = await saveToGallery(r.blob, `PortraitStudio_${stamp()}.mp4`, (f) => ($('vxEta').textContent = Math.round(f * 100) + '%'));
    $('vxBar').style.width = '100%';
    $('vxStat').textContent = `Saved ${r.width}×${r.height} to ${s.where} in ${formatEta(r.seconds)}`;
    $('vxEta').textContent = r.audio ? 'with sound' : (r.audioNote || 'no sound track');
  } catch (e) {
    console.error(e);
    $('vxStat').textContent = e.name === 'AbortError' ? 'Cancelled' : 'Failed: ' + e.message;
    $('vxEta').textContent = '';
  }
  exporting = null; await keepAwake(false);
  const go = $('vxGo'); if (go) { go.textContent = 'Export MP4'; go.className = 'btn primary'; }
  if (state.kind === 'video') videoPreviewFrame(true);
}

// ---------- boot ----------
renderTabs(); renderPanel();
if (navigator.serviceWorker && location.protocol === 'https:' && !globalThis.Capacitor) { /* no SW: keep it simple */ }
import('./premium.js').then(() => import('./studio-ui.js')).catch((e) => console.warn('extra tools not loaded', e));
