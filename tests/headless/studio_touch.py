# Touch-emulated Video Studio checks on a phone viewport:
#  1. playing the timeline shows real, changing frames (WebCodecs path, and the <video>
#     fallback with PS_NO_WC_PREVIEW) and a poster frame when paused;
#  2. a clip can be deleted by tap+Delete bar, by long-press menu and by the toolbar trash.
# Picked files are "revocable" (Android grant expiry simulation from revoked.py).
import os, sys, threading, http.server, functools, json, time, hashlib
from playwright.sync_api import sync_playwright
sys.path.insert(0, os.path.dirname(__file__))
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
WWW = ROOT + '/www'; FX = ROOT + '/tests/fixtures'; OUT = '/workspace/portrait-app-samples/studio-touch'; os.makedirs(OUT, exist_ok=True)
REVOKE = open(os.path.join(os.path.dirname(__file__), 'revoked.py')).read().split('REVOKE = r"""')[1].split('"""')[0]
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.js': 'text/javascript'}
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Q, directory=WWW)); port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
SAMPLE = "(() => { const c = document.getElementById('stPreview'); const x = c.getContext('2d'); const d = x.getImageData(0, 0, c.width, c.height).data; let lit = 0, sum = 0, h = 0; for (let i = 0; i < d.length; i += 4 * 37) { const v = d[i] + d[i + 1] + d[i + 2]; sum += v; if (v > 45) lit++; h = (h * 31 + (d[i] >> 3)) | 0; } const n = d.length / (4 * 37); return { lit: lit / n, mean: sum / n / 3, hash: h }; })()"
res = {}
def run(variant, init):
    out = {}; errors = []
    with sync_playwright() as p:
        b = p.chromium.launch(channel='chrome', headless=True, args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'])
        ctx = b.new_context(viewport={'width': 360, 'height': 800}, device_scale_factor=2, is_mobile=True, has_touch=True)
        pg = ctx.new_page(); pg.on('pageerror', lambda e: errors.append(str(e)[:200]))
        pg.add_init_script('window.PS_FORCE_CPU = true; localStorage.clear();' + init + REVOKE)
        pg.goto(f'http://127.0.0.1:{port}/index.html'); pg.wait_for_function('window.PS_STUDIO', timeout=30000)
        cdp = ctx.new_cdp_session(pg)
        def center(sel):
            pg.locator(sel).first.evaluate("e => e.scrollIntoView({block: 'nearest', inline: 'center'})"); pg.wait_for_timeout(250)
            bb = pg.locator(sel).first.bounding_box(); return bb['x'] + bb['width'] / 2, bb['y'] + bb['height'] / 2
        def tap(sel): x, y = center(sel); pg.touchscreen.tap(x, y); pg.wait_for_timeout(350)
        def long_press(sel, ms=700):
            x, y = center(sel)
            cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': x, 'y': y}]}); pg.wait_for_timeout(ms)
            cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []}); pg.wait_for_timeout(400)
        def add(files):
            with pg.expect_file_chooser() as fc: tap('#stTools button:text-is("+ Video")')
            fc.value.set_files(files); pg.wait_for_function(f'PS_STUDIO.P.clips.length >= {len(files)}', timeout=60000); pg.wait_for_timeout(1500)
        tap('.empty-actions button:has-text("Studio")'); pg.wait_for_selector('#studio')
        add([f'{FX}/clip.mp4', f'{FX}/speech.mp4'])
        pg.wait_for_timeout(1500)
        out['poster_at_start'] = pg.evaluate(SAMPLE)
        # --- play preview ---
        tap('#stPlay'); samples = []
        for i in range(6): pg.wait_for_timeout(700); samples.append(pg.evaluate(SAMPLE))
        pg.screenshot(path=f'{OUT}/{variant}-playing.png')
        tap('#stPlay'); pg.wait_for_timeout(1500)
        out['poster_paused'] = pg.evaluate(SAMPLE); out['T_after_play'] = round(pg.evaluate('PS_STUDIO.T'), 2)
        out['play_frames_lit'] = [round(s['lit'], 2) for s in samples]; out['play_distinct_frames'] = len({s['hash'] for s in samples})
        out['frame_paths'] = pg.evaluate('PS_STUDIO.E.frameDiag')
        pg.screenshot(path=f'{OUT}/{variant}-paused.png')
        # --- delete: tap + Delete bar ---
        n0 = pg.evaluate('PS_STUDIO.P.clips.length')
        tap('.blk.v >> nth=0'); out['selected_by_tap'] = pg.evaluate('PS_STUDIO.sel() && PS_STUDIO.sel().kind')
        out['delete_bar_visible'] = pg.is_visible('#stDelete'); pg.screenshot(path=f'{OUT}/{variant}-selected.png')
        tap('#stDelete'); out['after_bar_delete'] = [n0, pg.evaluate('PS_STUDIO.P.clips.length')]
        # --- long-press menu ---
        long_press('.blk.v >> nth=0'); out['longpress_menu'] = pg.is_visible('#sheetCard [data-a="delete"]')
        pg.screenshot(path=f'{OUT}/{variant}-longpress.png')
        if out['longpress_menu']: tap('#sheetCard [data-a="delete"]')
        out['after_longpress_delete'] = pg.evaluate('PS_STUDIO.P.clips.length')
        # --- toolbar trash ---
        add([f'{FX}/clip-fast.mp4']); out['before_trash'] = pg.evaluate('PS_STUDIO.P.clips.length')
        tap('.blk.v >> nth=0'); pg.evaluate("document.getElementById('stTools').scrollLeft = 0"); tap('#stTools button.trash')
        out['after_trash_delete'] = pg.evaluate('PS_STUDIO.P.clips.length')
        out['blocked_reads_of_originals'] = pg.evaluate('window.__revokedReads')
        b.close()
    out['errors'] = errors; return out
res['webcodecs'] = run('wc', '')
res['video_fallback'] = run('videoel', 'window.PS_NO_WC_PREVIEW = true;')
print(json.dumps(res, indent=1))
bad = []
for k, r in res.items():
    if min(r['play_frames_lit']) < 0.2: bad.append(f'{k}: blank frame while playing {r["play_frames_lit"]}')
    if r['play_distinct_frames'] < 4: bad.append(f'{k}: frames not changing')
    if r['poster_paused']['lit'] < 0.2: bad.append(f'{k}: no poster frame when paused')
    if r['after_bar_delete'][1] != r['after_bar_delete'][0] - 1: bad.append(f'{k}: Delete bar did not delete')
    if not r['longpress_menu'] or r['after_longpress_delete'] != 0: bad.append(f'{k}: long-press delete failed')
    if r['after_trash_delete'] != r['before_trash'] - 1: bad.append(f'{k}: toolbar trash failed')
    if r['errors']: bad.append(f'{k}: page errors {r["errors"]}')
for k, path in (('webcodecs', 'wc'), ('video_fallback', 'video')):
    if res[k]['frame_paths'][path] == 0: bad.append(f'{k}: expected {path} frames')
print('FAIL' if bad else 'PASS', bad)
sys.exit(1 if bad else 0)
