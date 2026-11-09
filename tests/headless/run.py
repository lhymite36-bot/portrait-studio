# Headless end-to-end check: real MediaPipe segmentation + WebGL pipeline +
# WebCodecs video export in Google Chrome. Writes samples to /workspace/portrait-app-samples.
import base64, json, os, subprocess, sys, threading, http.server, functools, time
from playwright.sync_api import sync_playwright
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = os.environ.get('PS_OUT', '/workspace/portrait-app-samples')
PHOTOS = os.environ.get('PS_PHOTOS', '/workspace/photo-inputs')
os.makedirs(OUT, exist_ok=True)
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.js': 'text/javascript'}
def serve():
    h = functools.partial(Q, directory='/')
    s = http.server.ThreadingHTTPServer(('127.0.0.1', 8765), h); s.serve_forever()
threading.Thread(target=serve, daemon=True).start()
def save(name, data_url):
    open(os.path.join(OUT, name), 'wb').write(base64.b64decode(data_url.split(',', 1)[1]))
report = {}
with sync_playwright() as p:
    b = p.chromium.launch(channel='chrome', headless=True, args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
    pg = b.new_page()
    logs = []
    pg.on('console', lambda m: logs.append(m.text))
    pg.on('pageerror', lambda e: logs.append('PAGEERROR ' + str(e)))
    pg.goto(f'http://127.0.0.1:8765{ROOT}/tests/headless/harness.html')
    pg.wait_for_function('window.READY === true', timeout=60000)
    only = sys.argv[1] if len(sys.argv) > 1 else 'all'
    if only in ('all', 'parity'):
        report['parity'] = pg.evaluate('T.parity()')
    if only in ('all', 'photo'):
        cases = [
            ('photo-5', {'portrait': {'blur': 0.6}, 'look': {'id': 'none'}}, 'portrait'),
            ('photo-1', {'portrait': {'blur': 0.6}, 'look': {'id': 'cinematic'}}, 'portrait-cinematic'),
            ('photo-2', {'portrait': {'blur': 0.7}, 'look': {'id': 'vibrant'}}, 'portrait-vibrant'),
            ('photo-3', {'portrait': {'blur': 0.5}, 'look': {'id': 'bw'}}, 'portrait-bw'),
            ('photo-4', {'portrait': {'blur': 0.55}, 'look': {'id': 'teal-orange'}, 'effects': {'vignette': 0.4, 'grain': 0.3}}, 'portrait-tealorange'),
            ('photo-5', {'portrait': {'enabled': False}, 'enhance': {'sharpen': 0.6, 'denoise': 0.4, 'clarity': 0.3}, 'scale': 2}, 'enhanced-2x'),
        ]
        report['photos'] = []
        for src, mods, tag in cases:
            url = f'http://127.0.0.1:8765{PHOTOS}/{src}.jpg'
            r = pg.evaluate('([u,m]) => T.photo(u,m)', [url, mods])
            save(f'{src}-{tag}.jpg', r['img']); save(f'{src}-mask.png', r['mask'])
            subprocess.run(['cp', f'{PHOTOS}/{src}.jpg', f'{OUT}/{src}-before.jpg'])
            report['photos'].append({'out': f'{src}-{tag}.jpg', 'w': r['w'], 'h': r['h'], 'segMs': round(r['tSeg']), 'renderMs': round(r['tRender'])})
    if only in ('all', 'video'):
        report['video'] = []
        for fx, kw in [('clip.mp4', {}), ('clip-fast.mp4', {'look': 'vibrant'}), ('clip-rot.mp4', {}), ('clip.mp4', {'slowmo': 2})]:
            url = f'http://127.0.0.1:8765{ROOT}/tests/fixtures/{fx}'
            r = pg.evaluate('([u,o]) => T.video(u,o)', [url, kw])
            name = f"video-{fx.replace('.mp4','')}{'-slowmo2x' if kw.get('slowmo') else ''}-out.mp4"
            open(os.path.join(OUT, name), 'wb').write(base64.b64decode(r.pop('b64')))
            probe = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_name,width,height,nb_frames,duration', '-of', 'compact', os.path.join(OUT, name)], capture_output=True, text=True).stdout.strip()
            r['ffprobe'] = probe; r['out'] = name
            report['video'].append(r)
        report['cancel'] = pg.evaluate(f"T.cancelTest('http://127.0.0.1:8765{ROOT}/tests/fixtures/clip.mp4')")
    report['console'] = [l for l in logs if 'PAGEERROR' in l or 'rror' in l][:20]
    b.close()
print(json.dumps(report, indent=1))
