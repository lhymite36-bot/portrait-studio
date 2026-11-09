# Simulates Android revoking the read grant on picked files: every File from an <input>
# can be read exactly once (its size in bytes); any later read throws NotReadableError and
# object URLs / createImageBitmap on it fail. The app must copy the file on import and work
# only from the copy. Usage: revoked.py [www_dir]
import os, sys, threading, http.server, functools, json
from playwright.sync_api import sync_playwright
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
WWW = sys.argv[1] if len(sys.argv) > 1 else ROOT + '/www'
FX = ROOT + '/tests/fixtures'; OUT = '/workspace/portrait-app-samples/revoked'; os.makedirs(OUT, exist_ok=True)
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.js': 'text/javascript'}
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Q, directory=WWW)); port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
REVOKE = r"""
(() => {
  const budget = new WeakMap(), parent = new WeakMap(); window.__revokedReads = 0;
  const NRE = () => new DOMException('The requested file could not be read, typically due to permission problems that have occurred after a reference to a file was acquired.', 'NotReadableError');
  const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files');
  Object.defineProperty(HTMLInputElement.prototype, 'files', { configurable: true, get() { const fl = desc.get.call(this); if (fl) for (const f of fl) if (!budget.has(f)) budget.set(f, f.size); return fl; } });
  const root = (b) => { let r = b; while (parent.has(r)) r = parent.get(r); return budget.has(r) ? r : null; };
  const slice = Blob.prototype.slice; Blob.prototype.slice = function (...a) { const s = slice.apply(this, a); const r = root(this); if (r) parent.set(s, r); return s; };
  const take = (b, n) => { const r = root(b); if (!r) return true; const left = budget.get(r); if (left < n || left <= 0 && n >= 0) { window.__revokedReads++; return false; } budget.set(r, left - n); return true; };
  for (const m of ['arrayBuffer', 'text', 'bytes']) { const o = Blob.prototype[m]; if (!o) continue; Blob.prototype[m] = function () { if (!take(this, this.size)) return Promise.reject(NRE()); return o.call(this); }; }
  const st = Blob.prototype.stream; Blob.prototype.stream = function () { if (!take(this, this.size)) throw NRE(); return st.call(this); };
  const cou = URL.createObjectURL; URL.createObjectURL = function (b) { if (root(b)) { window.__revokedReads++; throw NRE(); } return cou.call(URL, b); };
  const cib = window.createImageBitmap; window.createImageBitmap = function (b, ...a) { if (b instanceof Blob && root(b)) { if (!take(b, b.size)) return Promise.reject(NRE()); } return cib.call(window, b, ...a); };
  const FR = FileReader.prototype.readAsArrayBuffer; FileReader.prototype.readAsArrayBuffer = function (b) { if (!take(b, b.size)) throw NRE(); return FR.call(this, b); };
})();
"""
res = {}; errors = []
with sync_playwright() as p:
    b = p.chromium.launch(channel='chrome', headless=True, args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
    ctx = b.new_context(viewport={'width': 360, 'height': 800}, device_scale_factor=2, is_mobile=True, has_touch=True, accept_downloads=True)
    pg = ctx.new_page(); pg.on('pageerror', lambda e: errors.append(str(e)[:200]))
    pg.add_init_script('window.PS_FORCE_CPU = true; localStorage.clear();' + REVOKE)
    pg.goto(f'http://127.0.0.1:{port}/index.html'); pg.wait_for_timeout(1500)
    # 1. video: pick, wait (grant would expire), export Original / Best
    pg.set_input_files('#fileVideo', f'{FX}/clip.mp4'); pg.wait_for_timeout(1000)
    pg.wait_for_selector('#busy.hidden', state='attached', timeout=120000); pg.wait_for_timeout(2500)
    pg.click('#btnSave'); pg.wait_for_timeout(500)
    for v in ['orig', 'quality', '1', '0', 'off']:
        el = pg.query_selector(f'#sheetCard .seg button[data-v="{v}"]')
        if el: el.click()
    try:
        with pg.expect_download(timeout=400000) as dl: pg.click('#vxGo')
        dl.value.save_as(f'{OUT}/video-export-after-revoke.mp4'); res['video'] = pg.inner_text('#vxStat')
    except Exception as e: res['video'] = 'FAILED: ' + (pg.inner_text('#vxStat') if pg.query_selector('#vxStat') else str(e)[:200])
    pg.evaluate("document.getElementById('sheet').classList.add('hidden')")
    # 2. photo
    pg.set_input_files('#filePhoto', '/workspace/photo-inputs/photo-5.jpg'); pg.wait_for_timeout(800)
    pg.wait_for_selector('#busy.hidden', state='attached', timeout=120000); pg.wait_for_timeout(1500)
    res['photo_mask'] = pg.evaluate("(async () => { const s = (await import('./js/app.js')).getState(); return !!s.mask && s.kind === 'photo'; })()")
    try:
        with pg.expect_download(timeout=120000) as dl: pg.click('#btnSave')
        dl.value.save_as(f'{OUT}/photo-after-revoke.jpg'); res['photo'] = 'saved'
    except Exception as e: res['photo'] = 'FAILED ' + str(e)[:120]
    # 3. Video Studio: two clips + music file, export
    pg.evaluate("document.querySelector('[data-open]') && 0"); pg.evaluate("window.PS_STUDIO || 0")
    pg.click('#btnOpen'); pg.wait_for_timeout(300); pg.click('[data-x="studio"]'); pg.wait_for_selector('#studio'); pg.wait_for_timeout(400)
    with pg.expect_file_chooser() as fc: pg.click('#stTools button:text-is("+ Video")')
    fc.value.set_files([f'{FX}/clip-fast.mp4', f'{FX}/speech.mp4'])
    try:
        pg.wait_for_function('PS_STUDIO.P.clips.length >= 2', timeout=60000); pg.wait_for_timeout(1500)
        pg.click('#stExport'); pg.wait_for_timeout(300)
        with pg.expect_download(timeout=600000) as dl: pg.click('#exGo')
        dl.value.save_as(f'{OUT}/studio-after-revoke.mp4'); res['studio'] = pg.inner_text('#exStat')
    except Exception as e: res['studio'] = 'FAILED ' + str(e)[:200]
    res['blocked_reads_of_originals'] = pg.evaluate('window.__revokedReads')
    res['copies'] = pg.evaluate('window.PS_STASH_DIAG || null')
    b.close()
res['errors'] = errors
print(json.dumps(res, indent=1))
