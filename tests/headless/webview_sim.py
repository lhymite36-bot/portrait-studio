# Imitates a budget Android WebView: no SharedArrayBuffer (no COOP/COEP), optional no wasm SIMD,
# capped wasm memory, huge camera photo (50 MP). Checks portrait detection still works and
# which segmentation engine was used. Usage: webview_sim.py [www_dir] [scenario...]
import os, sys, threading, http.server, functools, json
from playwright.sync_api import sync_playwright
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
WWW = sys.argv[1] if len(sys.argv) > 1 and os.path.isdir(sys.argv[1]) else ROOT + '/www'
only = [a for a in sys.argv[1:] if not os.path.isdir(a)]
BIG = os.environ.get('PS_BIG', '/tmp/big50mp.jpg')
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.js': 'text/javascript'}
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Q, directory=WWW)); port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
SIMD_PROBE = "WebAssembly.validate(new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11]))"
BASE = ['--disable-features=SharedArrayBuffer']
SCEN = {
  'webview': {'flags': BASE + ['--js-flags=--wasm-max-mem-pages=16384'], 'init': ''},
  'nosimd': {'flags': BASE + ['--js-flags=--no-experimental-wasm-simd --no-wasm-simd --wasm-max-mem-pages=16384'], 'init': ''},
  'lowmem': {'flags': BASE + ['--js-flags=--wasm-max-mem-pages=8192'], 'init': ''},
  'cpu-lowmem': {'flags': BASE + ['--js-flags=--wasm-max-mem-pages=8192'], 'init': 'window.PS_FORCE_CPU=true'},
  'nosimd-build': {'flags': BASE, 'init': "window.PS_SEG_SKIP=['mp-multiclass-cpu','mp-multiclass-gpu']"},
  'crash-recovery': {'flags': BASE + ['--js-flags=--wasm-max-mem-pages=8192'], 'init': 'window.PS_SEG_MAX=8192'},
  'cpu-broken': {'flags': BASE, 'init': "window.PS_SEG_SKIP=['mp-multiclass-cpu']"},
  'onnx-only': {'flags': BASE, 'init': "window.PS_SEG_SKIP=['mp-multiclass-cpu','mp-multiclass-gpu','mp-multiclass-nosimd','mp-selfie-cpu','mp-selfie-nosimd']"},
}
res = {}
with sync_playwright() as p:
    for name, sc in SCEN.items():
        if only and name not in only: continue
        b = p.chromium.launch(channel='chrome', headless=True, args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] + sc['flags'])
        ctx = b.new_context(viewport={'width': 360, 'height': 800}, device_scale_factor=2, is_mobile=True, has_touch=True)
        pg = ctx.new_page(); errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)[:200]))
        pg.add_init_script(sc['init'] + ";localStorage.clear()")
        pg.goto(f'http://127.0.0.1:{port}/index.html'); pg.wait_for_timeout(800)
        env = pg.evaluate(f"({{sab: typeof SharedArrayBuffer !== 'undefined', isolated: self.crossOriginIsolated, simd: {SIMD_PROBE}}})")
        pg.evaluate("() => { const t = document.getElementById('toast'); new MutationObserver(() => (window.__toasts = window.__toasts || []).push(t.textContent)).observe(t, {childList: true, characterData: true, subtree: true}); }")
        pg.set_input_files('#filePhoto', BIG); pg.wait_for_timeout(500)
        pg.wait_for_selector('#busy.hidden', state='attached', timeout=300000); pg.wait_for_timeout(800)
        toasts = pg.evaluate("window.__toasts || []"); diag = pg.evaluate("window.PS_SEG_DIAG || null")
        mask = pg.evaluate("(async () => { const m = await import('./js/app.js'); const s = m.getState(); return s.mask ? { w: s.mask.width, h: s.mask.height, person: Math.round(1000 * s.mask.data.reduce((a, v) => a + (v > 128), 0) / s.mask.data.length) / 1000, refined: !!s.mask.refined } : null; })()")
        shot = f'/workspace/portrait-app-samples/v111-{os.path.basename(WWW.rstrip("/"))}-{name}.png'
        pg.screenshot(path=shot)
        res[name] = {'env': env, 'toasts': list(dict.fromkeys(toasts))[-3:], 'diag': diag, 'mask': mask, 'errors': errs, 'shot': shot}
        b.close()
print(json.dumps(res, indent=1))
