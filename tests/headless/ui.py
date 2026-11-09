# UI smoke test at a Galaxy A05-like viewport (720x1600 @ 2x -> 360x800 CSS px).
import os, sys, threading, http.server, functools, json
from playwright.sync_api import sync_playwright
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = os.environ.get('PS_OUT', '/workspace/portrait-app-samples')
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.js': 'text/javascript'}
threading.Thread(target=lambda: http.server.ThreadingHTTPServer(('127.0.0.1', 8766), functools.partial(Q, directory=ROOT + '/www')).serve_forever(), daemon=True).start()
errors = []
with sync_playwright() as p:
    b = p.chromium.launch(channel='chrome', headless=True, args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
    ctx = b.new_context(viewport={'width': 360, 'height': 800}, device_scale_factor=2, is_mobile=True, has_touch=True)
    pg = ctx.new_page()
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.on('console', lambda m: m.type == 'error' and errors.append(m.text))
    pg.add_init_script('window.PS_FORCE_CPU = true')
    pg.goto('http://127.0.0.1:8766/index.html')
    pg.wait_for_timeout(800)
    pg.screenshot(path=f'{OUT}/ui-home.png')
    pg.set_input_files('#filePhoto', '/workspace/photo-inputs/photo-5.jpg')
    pg.wait_for_selector('#busy.hidden', state='attached', timeout=60000)
    pg.wait_for_timeout(1500)
    pg.screenshot(path=f'{OUT}/ui-portrait.png')
    for tab in sys.argv[1:] or ['looks', 'adjust', 'enhance', 'effects']:
        pg.click(f'.tab[data-t="{tab}"]'); pg.wait_for_timeout(500)
        if tab == 'looks': pg.click('.chip[data-id="teal-orange"]'); pg.wait_for_timeout(600)
        pg.screenshot(path=f'{OUT}/ui-{tab}.png')
    pg.click('#btnSplit'); pg.wait_for_timeout(500); pg.screenshot(path=f'{OUT}/ui-split.png')
    with pg.expect_download(timeout=60000) as dl:
        pg.click('#btnSave')
    d = dl.value; d.save_as(f'{OUT}/ui-saved-photo.jpg')
    pg.set_input_files('#fileVideo', ROOT + '/tests/fixtures/clip.mp4')
    pg.wait_for_timeout(4000)
    pg.screenshot(path=f'{OUT}/ui-video.png')
    pg.click('#btnSave'); pg.wait_for_timeout(500)
    with pg.expect_download(timeout=180000) as dl:
        pg.click('#vxGo')
    dl.value.save_as(f'{OUT}/ui-saved-video.mp4')
    pg.wait_for_timeout(500)
    pg.screenshot(path=f'{OUT}/ui-video-export.png')
    b.close()
print(json.dumps({'errors': errors[:20]}, indent=1))
