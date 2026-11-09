// Premium tools (v1.1): retouch, relight, background remove/swap, sky, eraser,
// old photo restore + colourise, text/stickers/light leaks/dust, custom LUTs,
// my looks, batch editing, and video stabilise / focus shift.
import { TABS, hooks, renderTabs, renderPanel, slider, toggle, segmented, hint, toast, requestRender, onParamChange, openSheet, closeSheet, getState, getPipe, renderFullPhoto, canvasBlob, stamp, persist, loadPhoto } from './app.js';
import { FxStage, fxDefaults, fxActive, parseCube, bakeCube } from './fx.js';
import { inpaint, dilate, detectScratches, autoLevels, isMostlyGrey, detectSky, drawSky, SKIES, drawOverlays, hasOverlays, STICKERS, FONTS, LEAKS, faceFeatures, featureCanvas } from './tools.js';
import { segmentImage } from './seg.js';
import { inpaintAI, colorizeAI, depthNormalsAI, AI_MODELS } from './ai.js';
import { resolveGrade, gradePixel, defaultParams } from './grade.js';
import { saveToGallery } from './native.js';

const S = getState(), pipe = getPipe();
const stage = new FxStage(pipe);
const $ = (id) => document.getElementById(id);
const canvas = $('canvas');
const fx = () => (S.params.fx || (S.params.fx = fxDefaults()));
const ov = () => (S.params.overlays || (S.params.overlays = { items: [], leak: { id: 'none', amount: 0.6 }, dust: 0 }));
let bgLoaded = false, mode = null, selected = -1;

// ---------- post + overlays wiring ----------
hooks.post = () => {
  const f = JSON.parse(JSON.stringify(fx()));
  if (f.bg.mode === 'image' && !bgLoaded) f.bg.mode = 'none';
  return stage.opts(f);
};
hooks.exportFormat = () => (fx().bg.mode === 'transparent' ? 'image/png' : 'image/jpeg');
const ovc = document.createElement('canvas'); ovc.id = 'ov';
ovc.style.cssText = 'position:absolute;pointer-events:none;border-radius:12px';
$('view').appendChild(ovc);
hooks.afterRender.push((p, info) => {
  if (!info.preview) return;
  const r = canvas.getBoundingClientRect(), v = $('view').getBoundingClientRect();
  Object.assign(ovc.style, { left: r.left - v.left + 'px', top: r.top - v.top + 'px', width: r.width + 'px', height: r.height + 'px' });
  if (ovc.width !== canvas.width || ovc.height !== canvas.height) { ovc.width = canvas.width; ovc.height = canvas.height; }
  const x = ovc.getContext('2d'); x.clearRect(0, 0, ovc.width, ovc.height);
  if (!S.compare) drawOverlays(x, ovc.width, ovc.height, ov(), info.t || 0);
  if (mode === 'erase' && strokes.length) drawStrokes(x, ovc.width, ovc.height, 'rgba(255,60,90,0.55)');
  if (mode === 'relight' && fx().relight.enabled) { const r2 = fx().relight; x.strokeStyle = '#fff'; x.lineWidth = 2; x.setLineDash([6, 6]); x.beginPath(); x.arc(r2.x * ovc.width, (1 - r2.y) * ovc.height, 18, 0, 7); x.stroke(); x.setLineDash([]); }
  if (mode === 'text' && selected >= 0 && ov().items[selected]) { const it = ov().items[selected]; x.strokeStyle = '#22d3ee'; x.lineWidth = 2; const sz = it.size * Math.min(ovc.width, ovc.height); x.strokeRect(it.x * ovc.width - sz, it.y * ovc.height - sz * 0.7, sz * 2, sz * 1.4); }
  canvas.style.background = fx().bg.mode === 'transparent' ? 'repeating-conic-gradient(#2a2d3a 0 25%, #1a1c26 0 50%) 0 0/20px 20px' : '#000';
});
hooks.photoExport.push((src, out) => {
  if (!hasOverlays(ov())) return null;
  const c = document.createElement('canvas'); c.width = out.width; c.height = out.height;
  const x = c.getContext('2d'); x.drawImage(src, 0, 0); drawOverlays(x, c.width, c.height, ov(), 0); return c;
});

hooks.sourceChanged.push((kind) => {
  stage.skyReady = false; stage.featReady = false; stage.depthReady = false; strokes = []; undoImg = null; S.edit = null;
  if (kind === 'photo' && fx().sky.enabled) enableSky();
  if (kind === 'photo' && (fx().retouch.eyes > 0 || fx().retouch.teeth > 0)) ensureFeatures();
});

// ---------- tabs ----------
const I = (d) => `<svg viewBox="0 0 24 24">${d}</svg>`;
TABS.push(
  { id: 'retouch', label: 'Retouch', icon: I('<circle cx="12" cy="10" r="6"/><path d="M9 9h.01M15 9h.01M9.5 13c1.5 1.2 3.5 1.2 5 0"/><path d="M7 21l2-5M17 21l-2-5"/>'), render: panelRetouch },
  { id: 'relight', label: 'Relight', icon: I('<circle cx="12" cy="10" r="4"/><path d="M12 2v2M4.9 4.9l1.4 1.4M2 12h2M19.1 4.9l-1.4 1.4M22 12h-2M9 18h6M10 21h4"/>'), render: panelRelight },
  { id: 'background', label: 'Backdrop', icon: I('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="12" cy="11" r="3"/><path d="M7 20c1-3 3-4 5-4s4 1 5 4"/>'), render: panelBackground },
  { id: 'sky', label: 'Sky', icon: I('<path d="M6 16a4 4 0 0 1 .5-8 5 5 0 0 1 9.5 1.5A3.5 3.5 0 0 1 17 16z"/><path d="M4 20h16"/>'), render: panelSky },
  { id: 'erase', label: 'Erase', icon: I('<path d="M16 3l5 5-11 11H5v-5z"/><path d="M4 21h16"/>'), render: panelErase },
  { id: 'restore', label: 'Restore', icon: I('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>'), render: panelRestore },
  { id: 'text', label: 'Text', icon: I('<path d="M4 6V4h16v2M12 4v16M9 20h6"/>'), render: panelText },
);
renderTabs();
const prevPanel = renderPanel;
// set interaction mode depending on the open tab
const tabsEl = $('tabs');
const syncMode = () => { mode = ({ erase: 'erase', relight: 'relight', text: 'text', retouch: 'blemish' })[S.tab] || null; requestRender(); };
tabsEl.addEventListener('click', () => setTimeout(syncMode, 0));
syncMode();

function needPhoto(el) { if (S.kind !== 'photo') { hint(el, S.kind === 'video' ? 'This tool works on photos. Open a photo to use it.' : 'Open a photo first.'); return false; } return true; }

function panelRetouch(el) {
  const r = fx().retouch;
  slider(el, 'Smooth skin', () => r.smooth, (v) => (r.smooth = v), 0, 1);
  slider(el, 'Brighten eyes', () => r.eyes, (v) => { r.eyes = v; if (v > 0) ensureFeatures(); }, 0, 1);
  slider(el, 'Whiten teeth', () => r.teeth, (v) => { r.teeth = v; if (v > 0) ensureFeatures(); }, 0, 1);
  hint(el, 'Tap a spot or blemish on the photo to heal it. Eyes/teeth need a one-time 3.7 MB face model download.');
}
let featBusy = false;
async function ensureFeatures() {
  if (stage.featReady || featBusy || S.kind !== 'photo') return;
  featBusy = true;
  try {
    toast('Finding faces…');
    const src = S.edit || S.bitmap;
    const faces = await faceFeatures(src, (f) => toast(`Downloading face model ${Math.round(f * 100)}%`));
    const W = Math.min(1024, src.width), H = Math.round(W * src.height / src.width);
    stage.upload('feat', featureCanvas(faces, W, H)); stage.featReady = faces.length > 0;
    toast(faces.length ? `${faces.length} face${faces.length > 1 ? 's' : ''} found` : 'No faces found');
    requestRender();
  } catch (e) { toast('Face model unavailable: ' + e.message, 4000); }
  featBusy = false;
}

function panelRelight(el) {
  const r = fx().relight;
  toggle(el, 'Light', () => r.enabled, (v) => { r.enabled = v; if (v && r.depth !== false) ensureDepth(); });
  toggle(el, '3D light (AI depth, ' + AI_MODELS.depth.mb + ' MB once)', () => r.depth !== false, (v) => { r.depth = v; if (v && r.enabled) ensureDepth(); });
  slider(el, 'Intensity', () => r.intensity, (v) => (r.intensity = v), 0, 1);
  slider(el, 'Size', () => r.radius, (v) => (r.radius = v), 0, 1);
  slider(el, 'Warmth', () => r.warmth, (v) => (r.warmth = v), 0, 1);
  slider(el, 'Darken back', () => r.ambient, (v) => (r.ambient = v), 0, 1);
  hint(el, 'Drag on the photo to move the light.');
}

function panelBackground(el) {
  const b = fx().bg;
  segmented(el, [['none', 'Original'], ['transparent', 'Remove'], ['studio', 'Studio'], ['color', 'Colour'], ['image', 'Photo']], () => b.mode, (v) => { b.mode = v; if (v === 'image' && !bgLoaded) pickBg(); if (v !== 'none') S.params.portrait.enabled = S.params.portrait.enabled && v === 'none'; });
  const sw = document.createElement('div'); sw.className = 'btnrow';
  const pairs = [['#3a3f5c', '#0b0c12'], ['#f4f4f6', '#b9bcc8'], ['#ffffff', '#ffffff'], ['#000000', '#000000'], ['#ff7eb3', '#7c5cff'], ['#22d3ee', '#0b3b8c'], ['#ffd27a', '#ff6a3d'], ['#2ecc71', '#0e5c3a']];
  sw.innerHTML = pairs.map(([a, c], i) => `<button class="btn" data-i="${i}" style="width:38px;height:38px;padding:0;background:linear-gradient(${a},${c})"></button>`).join('') + '<button class="btn" id="bgPick">Choose photo…</button>';
  sw.querySelectorAll('[data-i]').forEach((x) => x.onclick = () => { const [a, c] = pairs[+x.dataset.i]; b.c1 = a; b.c2 = c; if (b.mode === 'none' || b.mode === 'transparent' || b.mode === 'image') b.mode = 'studio'; persist(); renderPanel(); onParamChange(); });
  el.appendChild(sw); sw.querySelector('#bgPick').onclick = pickBg;
  hint(el, 'Remove saves a transparent PNG. Backdrops keep the person and replace everything else.');
}
function pickBg() {
  const i = document.createElement('input'); i.type = 'file'; i.accept = 'image/*';
  i.onchange = async () => { if (!i.files[0]) return; const bm = await createImageBitmap(i.files[0]); const c = document.createElement('canvas'); const s = Math.min(1, 2048 / Math.max(bm.width, bm.height)); c.width = Math.round(bm.width * s); c.height = Math.round(bm.height * s); c.getContext('2d').drawImage(bm, 0, 0, c.width, c.height); stage.upload('bg', c); bgLoaded = true; fx().bg.mode = 'image'; persist(); renderPanel(); onParamChange(); };
  i.click();
}

function panelSky(el) {
  if (!needPhoto(el)) return;
  const s = fx().sky;
  toggle(el, 'Replace sky', () => s.enabled, (v) => { s.enabled = v; if (v) enableSky(); });
  const chips = document.createElement('div'); chips.className = 'btnrow';
  chips.innerHTML = SKIES.map((k) => `<button class="btn ${s.preset === k.id ? 'primary' : ''}" data-id="${k.id}">${k.name}</button>`).join('') + '<button class="btn" id="skyPick">Your photo…</button>';
  chips.querySelectorAll('[data-id]').forEach((b) => b.onclick = () => { s.preset = b.dataset.id; s.enabled = true; stage.upload('sky', drawSky(s.preset)); enableSky(); persist(); renderPanel(); });
  chips.querySelector('#skyPick').onclick = () => { const i = document.createElement('input'); i.type = 'file'; i.accept = 'image/*'; i.onchange = async () => { if (!i.files[0]) return; const bm = await createImageBitmap(i.files[0]); const c = document.createElement('canvas'); c.width = 1024; c.height = Math.round(1024 * bm.height / bm.width); c.getContext('2d').drawImage(bm, 0, 0, c.width, c.height); stage.upload('sky', c); s.preset = 'custom'; s.enabled = true; enableSky(true); }; i.click(); };
  el.appendChild(chips);
  slider(el, 'Blend', () => s.amount, (v) => (s.amount = v), 0, 1);
  hint(el, 'Works best on daytime photos with clear open sky at the top.');
}
function enableSky(keepTex) {
  const src = S.edit || S.bitmap; if (!src) return;
  const r = detectSky(src, S.mask);
  if (!r.canvas || r.coverage < 0.02) { stage.skyReady = false; toast('No clear sky found in this photo'); requestRender(); return; }
  stage.upload('skyMask', r.canvas);
  if (!keepTex && fx().sky.preset !== 'custom') stage.upload('sky', drawSky(fx().sky.preset));
  stage.skyReady = true; requestRender();
}

// ---------- source editing (erase / heal / restore) ----------
let strokes = [], brush = 0.05, undoImg = null;
function editCanvas() {
  if (!S.edit) { const c = document.createElement('canvas'); c.width = S.bitmap.width; c.height = S.bitmap.height; c.getContext('2d', { willReadFrequently: true }).drawImage(S.bitmap, 0, 0); S.edit = c; }
  return S.edit;
}
function commitEdit() {
  const c = S.edit; S.bitmap = c; pipe.setSource(c, c.width, c.height, 0); requestRender();
  // refresh the person mask so erased objects and repaired photos segment cleanly
  segmentImage(c, 'quality').then((m) => { S.mask = m; pipe.setMask(m.data, m.width, m.height); requestRender(); }).catch(() => {});
}
function saveUndo() { const c = editCanvas(); undoImg = c.getContext('2d').getImageData(0, 0, c.width, c.height); }
function drawStrokes(x, w, h, color) {
  x.strokeStyle = color; x.fillStyle = color; x.lineCap = 'round'; x.lineJoin = 'round';
  for (const st of strokes) { x.lineWidth = st.r * 2 * Math.min(w, h); x.beginPath(); st.pts.forEach((p, i) => (i ? x.lineTo(p[0] * w, p[1] * h) : x.moveTo(p[0] * w, p[1] * h))); if (st.pts.length === 1) x.lineTo(st.pts[0][0] * w + 0.1, st.pts[0][1] * h); x.stroke(); }
}
async function applyFill(maskCanvas, label) {
  const c = editCanvas(); const ctx = c.getContext('2d', { willReadFrequently: true });
  const md = maskCanvas.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  const m = new Uint8Array(c.width * c.height); for (let i = 0; i < m.length; i++) m[i] = md[i * 4 + 3] > 20 ? 1 : 0;
  saveUndo(); const img = ctx.getImageData(0, 0, c.width, c.height);
  $('busy').classList.remove('hidden'); $('busyText').textContent = label; await new Promise((r) => setTimeout(r, 30));
  let n = 0, engine = 'classical';
  try { const r = await inpaintAI(img.data, m, c.width, c.height, aiProgress); n = r.pixels; engine = r.engine; }
  catch (e) { console.warn('AI eraser unavailable, using classical fill', e); $('busyText').textContent = label; await new Promise((r) => setTimeout(r, 30)); n = inpaint(img.data, m, c.width, c.height); toast('AI eraser unavailable here (' + (e.message || e).slice(0, 80) + '); used classic fill', 5000); }
  ctx.putImageData(img, 0, 0); $('busy').classList.add('hidden');
  S.lastEraseEngine = engine; commitEdit(); return n;
}
function aiProgress(p) {
  const t = $('busyText'); if (!t) return;
  if (p.stage === 'download') t.textContent = `Downloading ${p.model} (${p.mb} MB, once) ${Math.round(p.f * 100)}%`;
  else if (p.stage === 'load') t.textContent = `Loading ${p.model}…`;
  else t.textContent = `${p.model} working… (can take a minute)`;
}
const busyOn = (txt) => { $('busy').classList.remove('hidden'); $('busyText').textContent = txt; return new Promise((r) => setTimeout(r, 30)); };
const busyOff = () => $('busy').classList.add('hidden');
async function aiColorize() {
  const c = editCanvas(); saveUndo(); await busyOn('Colourising…');
  try {
    const r = await colorizeAI(c, aiProgress); c.getContext('2d').drawImage(r.canvas, 0, 0); fx().restore.colorize = 0; S.lastColorEngine = r.engine;
    busyOff(); persist(); commitEdit(); renderPanel(); toast('Colourised with AI (DDColor)'); return true;
  } catch (e) {
    console.warn('AI colourise unavailable', e); busyOff(); fx().restore.colorize = 0.7; S.lastColorEngine = 'classical'; persist(); onParamChange(); renderPanel();
    toast('AI colourise unavailable here (' + (e.message || e).slice(0, 80) + '); used basic tint', 5000); return false;
  }
}
async function ensureDepth() {
  if (stage.depthReady || S.kind !== 'photo' || depthBusy) return;
  depthBusy = true; await busyOn('3D light: reading depth…');
  try { const src = S.edit || S.bitmap; const r = await depthNormalsAI(src, aiProgress); stage.upload('normal', r.canvas); stage.depthReady = true; S.lastDepthEngine = r.engine; }
  catch (e) { console.warn('depth unavailable', e); fx().relight.depth = false; toast('3D light unavailable here; using soft light', 4000); }
  depthBusy = false; busyOff(); requestRender();
}
let depthBusy = false;
function panelErase(el) {
  if (!needPhoto(el)) return;
  slider(el, 'Brush size', () => brush, (v) => (brush = v), 0.01, 0.15, 0.005, (v) => Math.round(v * 100));
  const row = document.createElement('div'); row.className = 'btnrow';
  row.innerHTML = '<button class="btn primary" id="erGo">Erase marked</button><button class="btn" id="erClear">Clear marks</button><button class="btn" id="erUndo">Undo</button>';
  el.appendChild(row);
  row.querySelector('#erGo').onclick = async () => {
    if (!strokes.length) { toast('Paint over what you want to remove'); return; }
    const c = editCanvas(); const mc = document.createElement('canvas'); mc.width = c.width; mc.height = c.height;
    drawStrokes(mc.getContext('2d'), c.width, c.height, '#f00'); strokes = [];
    await applyFill(mc, 'Erasing…'); toast('Erased. Tap Undo to revert.');
  };
  row.querySelector('#erClear').onclick = () => { strokes = []; requestRender(); };
  row.querySelector('#erUndo').onclick = undo;
  hint(el, 'Paint over people or objects, then tap Erase. Uses the LaMa AI eraser (' + AI_MODELS.lama.mb + ' MB download once); falls back to MI-GAN, then a classic fill, only if it crashes.');
}
function undo() { if (!undoImg) { toast('Nothing to undo'); return; } const c = editCanvas(); c.getContext('2d').putImageData(undoImg, 0, 0); undoImg = null; commitEdit(); toast('Undone'); }

function panelRestore(el) {
  if (!needPhoto(el)) return;
  const row = document.createElement('div'); row.className = 'btnrow';
  row.innerHTML = '<button class="btn primary" id="rsGo">Restore old photo</button><button class="btn" id="rsColor">AI colourise</button><button class="btn" id="rsUndo">Undo</button>';
  el.appendChild(row);
  slider(el, 'Colourise', () => fx().restore.colorize, (v) => (fx().restore.colorize = v), 0, 1);
  row.querySelector('#rsGo').onclick = async () => {
    const c = editCanvas(); const ctx = c.getContext('2d', { willReadFrequently: true });
    saveUndo(); const img = ctx.getImageData(0, 0, c.width, c.height);
    $('busy').classList.remove('hidden'); $('busyText').textContent = 'Repairing scratches…'; await new Promise((r) => setTimeout(r, 30));
    const grey = isMostlyGrey(img.data, c.width, c.height);
    const sc = dilate(detectScratches(img.data, c.width, c.height, 0.5), c.width, c.height, 1);
    let marked = 0; for (const v of sc) marked += v;
    if (marked < c.width * c.height * 0.08) inpaint(img.data, sc, c.width, c.height);
    autoLevels(img.data, c.width, c.height, 0.85);
    ctx.putImageData(img, 0, 0); $('busy').classList.add('hidden');
    const e = S.params.enhance; e.denoise = Math.max(e.denoise, 0.55); e.sharpen = Math.max(e.sharpen, 0.45); e.clarity = Math.max(e.clarity, 0.2);
    S.params.portrait.enabled = false; // restoration, not bokeh: turn blur back on in Portrait if wanted
    persist(); commitEdit(); renderPanel();
    toast(`Restored: ${marked < c.width * c.height * 0.08 ? Math.round(marked) + ' scratch pixels fixed, ' : ''}levels, denoise and sharpen`, 4000);
    if (grey) await aiColorize();
  };
  row.querySelector('#rsColor').onclick = aiColorize;
  row.querySelector('#rsUndo').onclick = undo;
  hint(el, 'Fixes dust and thin scratches, faded contrast and noise. Black and white photos are colourised with AI (DDColor, ' + AI_MODELS.ddcolor.mb + ' MB download once). The slider adds a basic tint instead.');
}

// ---------- text & stickers ----------
function panelText(el) {
  const o = ov();
  const row = document.createElement('div'); row.className = 'btnrow';
  row.innerHTML = '<button class="btn primary" id="txAdd">+ Text</button>' + STICKERS.map((e) => `<button class="btn" data-e="${e}" style="padding:6px 8px;font-size:18px">${e}</button>`).join('');
  el.appendChild(row);
  row.querySelector('#txAdd').onclick = () => { const t = prompt('Text', 'Your text'); if (!t) return; o.items.push({ type: 'text', text: t, x: 0.5, y: 0.82, size: 0.07, color: '#ffffff', font: 'sans' }); selected = o.items.length - 1; persist(); renderPanel(); requestRender(); };
  row.querySelectorAll('[data-e]').forEach((b) => b.onclick = () => { o.items.push({ type: 'sticker', emoji: b.dataset.e, x: 0.5, y: 0.4, size: 0.12 }); selected = o.items.length - 1; persist(); renderPanel(); requestRender(); });
  const it = o.items[selected];
  if (it) {
    slider(el, 'Size', () => it.size, (v) => (it.size = v), 0.02, 0.3, 0.005, (v) => Math.round(v * 100));
    slider(el, 'Rotate', () => it.rot || 0, (v) => (it.rot = v), -45, 45, 1, (v) => v + '°');
    if (it.type === 'text') {
      segmented(el, FONTS.map((f) => [f.id, f.name]), () => it.font, (v) => (it.font = v));
      const cr = document.createElement('div'); cr.className = 'btnrow';
      const cols = ['#ffffff', '#000000', '#ffd54a', '#ff4f8b', '#22d3ee', '#7c5cff', '#2ecc71'];
      cr.innerHTML = cols.map((c) => `<button class="btn" data-c="${c}" style="width:32px;height:32px;padding:0;background:${c}"></button>`).join('') + '<button class="btn" id="txGlow">Glow</button><button class="btn" id="txBox">Box</button><button class="btn" id="txEdit">Edit</button>';
      cr.querySelectorAll('[data-c]').forEach((b) => b.onclick = () => { it.color = b.dataset.c; persist(); requestRender(); });
      cr.querySelector('#txGlow').onclick = () => { it.glow = !it.glow; persist(); requestRender(); };
      cr.querySelector('#txBox').onclick = () => { it.bg = it.bg ? null : 'rgba(0,0,0,0.55)'; persist(); requestRender(); };
      cr.querySelector('#txEdit').onclick = () => { const t = prompt('Text', it.text); if (t != null) { it.text = t; persist(); requestRender(); } };
      el.appendChild(cr);
    }
    const dr = document.createElement('div'); dr.className = 'btnrow'; dr.innerHTML = '<button class="btn danger" id="txDel">Delete</button>'; el.appendChild(dr);
    dr.querySelector('#txDel').onclick = () => { o.items.splice(selected, 1); selected = -1; persist(); renderPanel(); requestRender(); };
  }
  hint(el, 'Drag text and stickers on the picture to move them. Tap one to select it.');
}

// light leaks + dust in Effects
hooks.effectsExtra = (el) => {
  const o = ov();
  const r = document.createElement('div'); r.className = 'seg';
  segmented(el, LEAKS.map((l) => [l.id, l.name]), () => o.leak.id, (v) => (o.leak.id = v));
  slider(el, 'Light leak', () => o.leak.amount, (v) => (o.leak.amount = v), 0, 1);
  slider(el, 'Film dust', () => o.dust, (v) => (o.dust = v), 0, 1);
};

// ---------- canvas interaction ----------
const toUV = (e) => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]; };
let drag = null;
canvas.addEventListener('pointerdown', async (e) => {
  if (!S.kind || S.split) return;
  const [u, v] = toUV(e);
  if (mode === 'erase' && S.kind === 'photo') { strokes.push({ r: brush / 2, pts: [[u, v]] }); drag = 'erase'; }
  else if (mode === 'relight') { const r = fx().relight; r.enabled = true; r.x = u; r.y = 1 - v; drag = 'light'; onParamChange(); if (r.depth !== false) ensureDepth(); }
  else if (mode === 'text') {
    const o = ov(); selected = -1;
    o.items.forEach((it, i) => { const d = Math.hypot((it.x - u) * canvas.width / Math.min(canvas.width, canvas.height), (it.y - v) * canvas.height / Math.min(canvas.width, canvas.height)); if (d < Math.max(0.06, it.size)) selected = i; });
    drag = selected >= 0 ? 'item' : null; renderPanel(); requestRender();
  } else if (mode === 'blemish' && S.kind === 'photo') {
    const c = editCanvas(); const mc = document.createElement('canvas'); mc.width = c.width; mc.height = c.height;
    const x = mc.getContext('2d'); x.fillStyle = '#f00'; x.beginPath(); x.arc(u * c.width, v * c.height, Math.min(c.width, c.height) * 0.012, 0, 7); x.fill();
    await applyFill(mc, 'Healing…');
  }
  if (drag) canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return; const [u, v] = toUV(e);
  if (drag === 'erase') strokes[strokes.length - 1].pts.push([u, v]);
  else if (drag === 'light') { const r = fx().relight; r.x = u; r.y = 1 - v; }
  else if (drag === 'item') { const it = ov().items[selected]; it.x = Math.min(1, Math.max(0, u)); it.y = Math.min(1, Math.max(0, v)); }
  onParamChange();
});
canvas.addEventListener('pointerup', () => { if (drag) persist(); drag = null; });

// ---------- my looks + LUTs ----------
const loadJSON = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') || d; } catch (e) { return d; } };
const myLooks = () => loadJSON('ps.mylooks', []);
const luts = () => loadJSON('ps.luts', []);
hooks.looksExtra = (el) => {
  const box = document.createElement('div');
  const ml = myLooks(), lt = luts();
  box.innerHTML = `<div class="hint" style="margin-top:6px">My looks</div><div class="btnrow">${ml.map((l, i) => `<button class="btn" data-ml="${i}">${esc(l.name)}</button>`).join('')}<button class="btn primary" id="mlSave">+ Save current</button></div>
  <div class="hint">LUTs (.cube)</div><div class="btnrow">${lt.map((l, i) => `<button class="btn ${fx().lut.id === l.id ? 'primary' : ''}" data-lut="${i}">${esc(l.name)}</button>`).join('')}<button class="btn" id="lutImp">Import .cube…</button>${fx().lut.id ? '<button class="btn" id="lutOff">LUT off</button>' : ''}<button class="btn" id="lutExp">Export my look as .cube</button></div>`;
  el.appendChild(box);
  if (fx().lut.id) slider(el, 'LUT amount', () => fx().lut.amount, (v) => (fx().lut.amount = v), 0, 1);
  box.querySelectorAll('[data-ml]').forEach((b) => b.onclick = () => { const l = ml[+b.dataset.ml]; Object.assign(S.params, JSON.parse(JSON.stringify(l.params))); persist(); renderPanel(); onParamChange(); toast('Applied ' + l.name); });
  box.querySelectorAll('[data-ml]').forEach((b) => b.oncontextmenu = (e) => { e.preventDefault(); if (confirm('Delete this look?')) { ml.splice(+b.dataset.ml, 1); localStorage.setItem('ps.mylooks', JSON.stringify(ml)); renderPanel(); } });
  box.querySelector('#mlSave').onclick = () => { const name = prompt('Name your look', 'My look ' + (ml.length + 1)); if (!name) return; ml.push({ name, params: { adjust: S.params.adjust, effects: S.params.effects, look: S.params.look, enhance: S.params.enhance } }); localStorage.setItem('ps.mylooks', JSON.stringify(ml)); renderPanel(); toast('Saved'); };
  box.querySelectorAll('[data-lut]').forEach((b) => b.onclick = () => { const l = lt[+b.dataset.lut]; stage.setLut({ size: l.size, data: Uint8Array.from(atob(l.data), (c) => c.charCodeAt(0)) }); fx().lut.id = l.id; persist(); renderPanel(); onParamChange(); });
  box.querySelector('#lutImp').onclick = importLut;
  const off = box.querySelector('#lutOff'); if (off) off.onclick = () => { fx().lut.id = null; persist(); renderPanel(); onParamChange(); };
  box.querySelector('#lutExp').onclick = async () => {
    const g = resolveGrade(S.params); g.vignette = 0;
    const txt = bakeCube((c) => gradePixel(c, g), 33, 'Portrait Studio');
    const r = await saveToGallery(new Blob([txt], { type: 'text/plain' }), `PortraitStudio_look_${stamp()}.cube`);
    toast('Saved .cube to ' + r.where);
  };
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
function importLut() {
  const i = document.createElement('input'); i.type = 'file'; i.accept = '.cube,text/plain,*/*';
  i.onchange = async () => {
    const f = i.files[0]; if (!f) return;
    try {
      const lut = parseCube(await f.text());
      let bin = ''; for (let k = 0; k < lut.data.length; k += 0x8000) bin += String.fromCharCode.apply(null, lut.data.subarray(k, k + 0x8000));
      const list = luts(); const id = 'lut' + Date.now();
      list.push({ id, name: f.name.replace(/\.cube$/i, '').slice(0, 24), size: lut.size, data: btoa(bin) });
      try { localStorage.setItem('ps.luts', JSON.stringify(list)); } catch (e) { toast('Storage full: LUT applied but not saved'); }
      stage.setLut(lut); fx().lut.id = id; persist(); renderPanel(); onParamChange(); toast(`LUT loaded (${lut.size}³)`);
    } catch (e) { toast('Bad .cube file: ' + e.message, 4000); }
  };
  i.click();
}
// restore last LUT on boot
(() => { const id = fx().lut.id; if (!id) return; const l = luts().find((x) => x.id === id); if (l) stage.setLut({ size: l.size, data: Uint8Array.from(atob(l.data), (c) => c.charCodeAt(0)) }); else fx().lut.id = null; })();

// ---------- batch ----------
hooks.openMenu.push({ id: 'batch', label: 'Batch edit photos', icon: I('<rect x="3" y="7" width="13" height="13" rx="2"/><path d="M7 3h12a2 2 0 0 1 2 2v12"/>'), run: batch });
function batch() {
  const i = document.createElement('input'); i.type = 'file'; i.accept = 'image/*'; i.multiple = true;
  i.onchange = () => i.files.length && runBatch([...i.files]);
  i.click();
}
async function runBatch(files) {
  const ac = { stop: false };
  openSheet(`<h2>Batch edit</h2><div class="hint">Applying your current settings to ${files.length} photos and saving each to the gallery.</div>
    <div class="progress"><i id="btBar"></i></div><div class="stat"><span id="btStat">Starting…</span><span id="btN"></span></div>
    <div class="btnrow" style="margin-top:14px"><button class="btn danger" id="btStop">Stop</button></div>`);
  $('btStop').onclick = () => { ac.stop = true; };
  const keep = { bitmap: S.bitmap, mask: S.mask, edit: S.edit, kind: S.kind };
  let ok = 0;
  for (let k = 0; k < files.length && !ac.stop; k++) {
    $('btStat').textContent = `Photo ${k + 1}: ${files[k].name}`; $('btN').textContent = `${k}/${files.length}`;
    try {
      const bm = await createImageBitmap(files[k], { imageOrientation: 'from-image' });
      const m = await segmentImage(bm, 'quality');
      S.bitmap = bm; S.mask = m; S.edit = null; S.kind = 'photo';
      pipe.setSource(bm, bm.width, bm.height, 0); pipe.setMask(m.data, m.width, m.height);
      const skyWas = stage.skyReady; const featWas = stage.featReady;
      if (fx().sky.enabled) { const r = detectSky(bm, m); if (r.canvas && r.coverage > 0.02) { stage.upload('skyMask', r.canvas); stage.skyReady = true; } else stage.skyReady = false; }
      stage.featReady = false;
      const out = await renderFullPhoto();
      const fmt = hooks.exportFormat();
      const blob = await canvasBlob(fmt, 0.95, out.canvas);
      await saveToGallery(blob, `PortraitStudio_batch_${stamp()}_${k + 1}.${fmt === 'image/png' ? 'png' : 'jpg'}`);
      bm.close(); ok++; stage.skyReady = skyWas; stage.featReady = featWas;
    } catch (e) { console.error(e); toast(`Skipped ${files[k].name}: ${e.message}`); }
    $('btBar').style.width = ((k + 1) / files.length * 100) + '%';
    await new Promise((r) => setTimeout(r, 0));
  }
  $('btStat').textContent = `${ok} of ${files.length} saved to the gallery`; $('btN').textContent = '';
  $('btStop').textContent = 'Close'; $('btStop').className = 'btn'; $('btStop').onclick = closeSheet;
  Object.assign(S, keep);
  if (S.kind === 'photo' && S.bitmap) { const src = S.edit || S.bitmap; pipe.setSource(src, src.width, src.height, 0); if (S.mask) pipe.setMask(S.mask.data, S.mask.width, S.mask.height); if (fx().sky.enabled) enableSky(true); requestRender(); }
}

// ---------- video: stabilise, focus shift, post + overlays per frame ----------
hooks.videoExportOptions = (o, opts) => {
  opts.stab = opts.stab || '0'; opts.focus = opts.focus || 'off';
  segmented(o, [['0', 'No stabilise'], ['0.6', 'Stabilise'], ['1', 'Stabilise strong']], () => opts.stab, (v) => (opts.stab = v));
  segmented(o, [['off', 'Focus: all people'], ['lr', 'Focus shift L→R'], ['rl', 'Focus shift R→L']], () => opts.focus, (v) => (opts.focus = v));
};
hooks.beforeExport.push((opts) => {
  const post = hooks.post();
  opts.renderOpts = post.active ? { post } : {};
  opts.stabilize = +opts.stab || 0;
  const dur = S.videoInfo ? S.videoInfo.duration : 10;
  if (opts.focus && opts.focus !== 'off') {
    const base = JSON.parse(JSON.stringify(S.params));
    opts.paramsAt = (t) => {
      const k = Math.min(1, Math.max(0, (t / dur - 0.35) / 0.3)); const e = k * k * (3 - 2 * k);
      const a = opts.focus === 'lr' ? 0.3 : 0.7, b = opts.focus === 'lr' ? 0.7 : 0.3;
      base.portrait.focusSel = 1; base.portrait.focusX = a + (b - a) * e; base.portrait.enabled = true;
      return base;
    };
  } else opts.paramsAt = null;
  if (hasOverlays(ov())) {
    const c = document.createElement('canvas'); const o2 = JSON.parse(JSON.stringify(ov()));
    opts.frameHook = (p, t, w, h) => { if (c.width !== w || c.height !== h) { c.width = w; c.height = h; } const x = c.getContext('2d'); x.drawImage(p.canvas, 0, 0); drawOverlays(x, w, h, o2, t); return c; };
  } else opts.frameHook = null;
});

renderPanel();
window.PS_PREMIUM = { aiColorize, ensureDepth, stage, fx, ov, enableSky, ensureFeatures, runBatch, undo, applyFill, editCanvas };
