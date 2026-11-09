# Drives the real app UI (www/) in headless Chrome to exercise the v1.1 tools.
import os, sys, threading, http.server, functools, json, subprocess
from playwright.sync_api import sync_playwright
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = os.environ.get('PS_OUT', '/workspace/portrait-app-samples') + '/premium'
FX = ROOT + '/tests/fixtures'; PH = '/workspace/photo-inputs'
os.makedirs(OUT, exist_ok=True)
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.js': 'text/javascript'}
threading.Thread(target=lambda: http.server.ThreadingHTTPServer(('127.0.0.1', 8767), functools.partial(Q, directory=ROOT + '/www')).serve_forever(), daemon=True).start()
errors, report = [], {}
only = sys.argv[1:] 
def want(k): return not only or k in only
with sync_playwright() as p:
    b = p.chromium.launch(channel='chrome', headless=True, args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
    ctx = b.new_context(viewport={'width': 360, 'height': 800}, device_scale_factor=2, is_mobile=True, has_touch=True, accept_downloads=True)
    pg = ctx.new_page()
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.on('dialog', lambda d: d.accept('Hello Pedro' if d.type == 'prompt' else None))
    pg.add_init_script('window.PS_FORCE_CPU = true; localStorage.clear()')
    pg.goto('http://127.0.0.1:8767/index.html'); pg.wait_for_function('window.PS_PREMIUM', timeout=30000)
    def open_photo(path):
        pg.set_input_files('#filePhoto', path); pg.wait_for_timeout(300)
        pg.wait_for_selector('#busy.hidden', state='attached', timeout=90000); pg.wait_for_timeout(600)
    def reset(): pg.evaluate("() => { const s = window.PS; const keep = s.params; for (const k of Object.keys(keep)) delete keep[k]; }"); pg.click('#btnReset'); pg.wait_for_timeout(200)
    def save(name):
        with pg.expect_download(timeout=120000) as dl: pg.click('#btnSave')
        dl.value.save_as(f'{OUT}/{name}'); return name
    def shot(name): pg.screenshot(path=f'{OUT}/{name}')
    def tab(t): pg.click(f'.tab[data-t="{t}"]'); pg.wait_for_timeout(300)
    open_photo(f'{PH}/photo-5.jpg')
    if want('bg'):
        tab('background'); pg.click('.seg button[data-v="transparent"]'); pg.wait_for_timeout(400); shot('ui-backdrop-remove.png')
        report['bg_png'] = save('photo-5-background-removed.png')
        pg.click('.seg button[data-v="studio"]'); pg.wait_for_timeout(300); report['bg_studio'] = save('photo-5-studio-backdrop.jpg')
        pg.click('.seg button[data-v="none"]'); pg.evaluate('PS.params.portrait.enabled = true')
    if want('relight'):
        tab('relight'); pg.evaluate("Object.assign(PS_PREMIUM.fx().relight, {enabled:true, x:0.3, y:0.75, intensity:0.8, ambient:0.4})"); pg.mouse.click(150, 260); pg.wait_for_timeout(400)
        shot('ui-relight.png'); report['relight'] = save('photo-5-relight.jpg'); pg.evaluate("PS_PREMIUM.fx().relight.enabled=false")
    if want('retouch'):
        tab('retouch'); pg.evaluate("Object.assign(PS_PREMIUM.fx().retouch, {smooth:0.8, eyes:0.6, teeth:0.6})")
        pg.evaluate("PS_PREMIUM.ensureFeatures()"); pg.wait_for_function('PS_PREMIUM.stage.featReady === true', timeout=120000)
        report['faces'] = True; report['retouch'] = save('photo-5-retouch.jpg'); pg.evaluate("Object.assign(PS_PREMIUM.fx().retouch, {smooth:0, eyes:0, teeth:0})")
    if want('text'):
        tab('text'); pg.click('#txAdd'); pg.wait_for_timeout(200); pg.click('.btn[data-e="✨"]'); pg.wait_for_timeout(200)
        tab('effects'); pg.click('.seg button[data-v="amber"]'); pg.evaluate("PS_PREMIUM.ov().leak.amount=0.7; PS_PREMIUM.ov().dust=0.5"); pg.wait_for_timeout(300)
        shot('ui-text-leak.png'); report['text'] = save('photo-5-text-sticker-leak.jpg')
        pg.evaluate("Object.assign(PS_PREMIUM.ov(), {items:[], dust:0}); PS_PREMIUM.ov().leak.id='none'")
    if want('lut'):
        tab('looks'); 
        with pg.expect_file_chooser() as fc: pg.click('#lutImp')
        fc.value.set_files(f'{FX}/sepia.cube'); pg.wait_for_timeout(600)
        report['lut'] = save('photo-5-cube-lut-sepia.jpg'); pg.click('#mlSave'); pg.wait_for_timeout(200)
        report['mylooks'] = pg.evaluate("JSON.parse(localStorage.getItem('ps.mylooks')).length")
        with pg.expect_download() as dl: pg.click('#lutExp')
        dl.value.save_as(f'{OUT}/exported-look.cube'); pg.click('#lutOff'); pg.wait_for_timeout(200)
    if want('erase'):
        tab('erase')
        # paint over the potted plant bottom-left (normalised coords)
        pg.evaluate("""() => { const c = document.getElementById('canvas'); const r = c.getBoundingClientRect();
          const ev = (t, u, v) => c.dispatchEvent(new PointerEvent(t, { clientX: r.left + u * r.width, clientY: r.top + v * r.height, pointerId: 1, bubbles: true }));
          ev('pointerdown', 0.07, 0.85); for (let i = 0; i <= 10; i++) ev('pointermove', 0.07 + i * 0.006, 0.85); ev('pointerup', 0.13, 0.85);
          ev('pointerdown', 0.2, 0.84); for (let i = 0; i <= 10; i++) ev('pointermove', 0.2 + i * 0.006, 0.84); ev('pointerup', 0.26, 0.84); }""")
        pg.evaluate("document.querySelector('#panelBody input[type=range]').value=0.12; document.querySelector('#panelBody input[type=range]').dispatchEvent(new Event('input'))")
        shot('ui-erase-marks.png'); pg.click('#erGo'); pg.wait_for_timeout(3000)
        report['erase'] = save('photo-5-erased-plant.jpg')
    if want('restore'):
        open_photo(f'{FX}/old-photo.jpg'); tab('restore'); pg.click("#rsGo"); pg.wait_for_timeout(5000)
        report['restore'] = save('old-photo-restored-colourised.jpg'); subprocess.run(['cp', f'{FX}/old-photo.jpg', f'{OUT}/old-photo-before.jpg'])
        pg.evaluate("PS_PREMIUM.fx().restore.colorize=0")
    if want('sky'):
        open_photo(f'{FX}/sky-scene.jpg'); tab('sky'); pg.click('.btn[data-id="sunset"]'); pg.wait_for_timeout(800)
        report['sky_ready'] = pg.evaluate('PS_PREMIUM.stage.skyReady'); report['sky'] = save('sky-scene-sunset.jpg')
        subprocess.run(['cp', f'{FX}/sky-scene.jpg', f'{OUT}/sky-scene-before.jpg']); pg.evaluate("PS_PREMIUM.fx().sky.enabled=false")
    if want('batch'):
        pg.evaluate("PS.params.look.id='cinematic'")
        pg.click('#btnOpen'); pg.wait_for_timeout(200)
        names = []
        def ondl(d): fn = f'batch-{len(names)+1}.jpg'; d.save_as(f'{OUT}/{fn}'); names.append(fn)
        pg.on('download', ondl)
        with pg.expect_file_chooser() as fc: pg.click('[data-x="batch"]')
        fc.value.set_files([f'{PH}/photo-1.jpg', f'{PH}/photo-2.jpg', f'{PH}/photo-4.jpg'])
        pg.wait_for_function("document.getElementById('btStat') && /saved/.test(document.getElementById('btStat').textContent)", timeout=180000)
        pg.wait_for_timeout(1000); report['batch'] = names; report['batch_stat'] = pg.inner_text('#btStat'); pg.remove_listener('download', ondl)
        pg.click('#btStop'); pg.evaluate("PS.params.look.id='none'")
    if want('video'):
        pg.set_input_files('#fileVideo', f'{FX}/shaky.mp4'); pg.wait_for_timeout(4000)
        tab('text'); pg.click('#txAdd'); pg.wait_for_timeout(200)
        pg.click('#btnSave'); pg.wait_for_timeout(400)
        pg.click('.seg button[data-v="0.6"]'); pg.click('.seg button[data-v="lr"]')
        shot('ui-video-premium-export.png')
        with pg.expect_download(timeout=300000) as dl: pg.click('#vxGo')
        dl.value.save_as(f'{OUT}/shaky-stabilised-focusshift-text.mp4'); report['video_stat'] = pg.inner_text('#vxStat')
    b.close()
report['errors'] = errors[:20]
print(json.dumps(report, indent=1))
