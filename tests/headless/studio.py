# Drives the Video Studio UI in headless Chrome: multi-clip edit, transitions, PiP + chroma key,
# keyframed text, Whisper captions, music + beat sync, templates, freeze/reverse/speed, exports.
import os, sys, threading, http.server, functools, json, time
from playwright.sync_api import sync_playwright
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = os.environ.get('PS_OUT', '/workspace/portrait-app-samples') + '/studio'
FX = ROOT + '/tests/fixtures'
os.makedirs(OUT, exist_ok=True)
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.js': 'text/javascript'}
threading.Thread(target=lambda: http.server.ThreadingHTTPServer(('127.0.0.1', 8768), functools.partial(Q, directory=ROOT + '/www')).serve_forever(), daemon=True).start()
only = sys.argv[1:]
def want(k): return not only or k in only
errors, report = [], {}
with sync_playwright() as p:
    b = p.chromium.launch(channel='chrome', headless=True, args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'])
    ctx = b.new_context(viewport={'width': 360, 'height': 800}, device_scale_factor=2, is_mobile=True, has_touch=True, accept_downloads=True)
    pg = ctx.new_page()
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.on('console', lambda m: m.type == 'error' and print('console:', m.text[:300]))
    prompts = []
    pg.on('dialog', lambda d: d.accept(prompts.pop(0) if prompts else 'Hello Pedro') if d.type == 'prompt' else d.accept())
    pg.add_init_script('window.PS_FORCE_CPU = true; localStorage.clear()')
    pg.goto('http://127.0.0.1:8768/index.html'); pg.wait_for_function('window.PS_STUDIO', timeout=30000)
    def shot(n): pg.screenshot(path=f'{OUT}/{n}')
    def tool(label): pg.click(f'#stTools button:text-is("{label}")'); pg.wait_for_timeout(300)
    def add_files(label, files):
        with pg.expect_file_chooser() as fc: tool(label)
        fc.value.set_files(files); pg.wait_for_function(f'PS_STUDIO.P.clips.length + PS_STUDIO.P.layers.length + PS_STUDIO.P.audios.length >= {len(files)}', timeout=60000); pg.wait_for_timeout(800)
    def export(name, res='720', fps='30', size='0', timeout=900000):
        pg.click('#stExport'); pg.wait_for_timeout(300)
        for v in (res, fps, size): pg.click(f'#exOpts .seg button[data-v="{v}"]')
        t = time.time()
        with pg.expect_download(timeout=timeout) as dl: pg.click('#exGo')
        dl.value.save_as(f'{OUT}/{name}'); pg.wait_for_timeout(300)
        info = pg.evaluate('PS_STUDIO.lastExport'); info['wall_s'] = round(time.time() - t, 1); info['stat'] = pg.inner_text('#exStat')
        shot('ui-export-' + name.replace('.mp4', '.png')); pg.click('#exClose'); pg.wait_for_timeout(200); return info
    def clear(): pg.evaluate("() => { const P = PS_STUDIO.P; P.clips.length = 0; P.layers.length = 0; P.texts.length = 0; P.audios.length = 0; P.captions = null; P.letterbox = false; P.useLook = false; PS_STUDIO.select(null); PS_STUDIO.setT(0); }")

    pg.click('.empty-actions button:has-text("Studio")'); pg.wait_for_selector('#studio'); pg.wait_for_timeout(500)
    shot('ui-studio-empty.png')

    if want('edit'):
        add_files('+ Video', [f'{FX}/clip.mp4', f'{FX}/speech.mp4'])
        # glitch transition into clip 2 via the props panel
        pg.evaluate("PS_STUDIO.select('clip', PS_STUDIO.P.clips[1].id)"); pg.wait_for_timeout(300)
        pg.click('#stProps .seg button[data-v="glitch"]')
        pg.evaluate("PS_STUDIO.select(null)")
        # green-screen overlay as a circle PiP with chroma key + keyframed motion
        pg.evaluate("PS_STUDIO.setT(0.5)"); pg.wait_for_timeout(200)
        add_files('+ Overlay', [f'{FX}/green.mp4'])
        pg.click('#stProps .switch:has-text("Green screen") .toggle'); pg.wait_for_timeout(200)
        pg.click('#stProps .seg button[data-v="circle"]')
        pg.evaluate("() => { const L = PS_STUDIO.P.layers[0]; L.keyframes = [{t:0, x:0.25, y:0.3, scale:0.5, rot:0, opacity:1}, {t:3, x:0.75, y:0.3, scale:0.8, rot:20, opacity:1}]; }")
        # title text with pop animation (prompt answers 'Hello Pedro')
        pg.evaluate("PS_STUDIO.setT(0)"); prompts.append('Hello Pedro'); tool('+ Text')
        pg.click('#stProps .seg button[data-v="pop"]'); pg.evaluate("PS_STUDIO.select(null)")
        # music at low volume
        tool('+ Music'); pg.click('[data-m="lofi"]'); pg.wait_for_function('PS_STUDIO.P.audios.length >= 1', timeout=60000)
        pg.evaluate("PS_STUDIO.P.audios[0].volume = 0.15")
        # Auto captions with Whisper
        if want('captions') or not only:
            tool('Captions'); pg.click('#capLang .seg button[data-v="english"]'); t = time.time(); pg.click('#capGo')
            pg.wait_for_function('PS_STUDIO.P.captions && PS_STUDIO.P.captions.words.length > 3', timeout=600000)
            report['captions'] = {'words': pg.evaluate("PS_STUDIO.P.captions.words.map(w => w.text).join(' ')"), 'seconds': round(time.time() - t, 1)}
            pg.click('#stProps .seg button[data-v="karaoke"]')
        pg.evaluate("() => { const P = PS_STUDIO.P; const sp = PS_STUDIO.E.sources; void sp; PS_STUDIO.setT(5.2); }"); pg.wait_for_timeout(2500); shot('ui-studio-edit.png')
        pg.evaluate("PS_STUDIO.setT(2.95)"); pg.wait_for_timeout(2500); shot('ui-studio-transition.png')
        report['edit'] = export('studio-edit-captions-pip-720p.mp4')

    if want('fx'):
        clear()
        add_files('+ Video', [f'{FX}/clip.mp4'])
        pg.evaluate("PS_STUDIO.select('clip', PS_STUDIO.P.clips[0].id)"); pg.wait_for_timeout(200)
        pg.click('#stProps .switch:has-text("Face zoom") .toggle'); pg.click('#stProps .switch:has-text("Glow outline") .toggle')
        pg.click('#stProps .seg button[data-v="robot"]')
        pg.evaluate("PS_STUDIO.setT(1.0)"); tool('Freeze')
        pg.evaluate("PS_STUDIO.select('clip', PS_STUDIO.P.clips[PS_STUDIO.P.clips.length-1].id)"); tool('Reverse')
        pg.evaluate("PS_STUDIO.select('clip', PS_STUDIO.P.clips[0].id)"); pg.wait_for_timeout(200); pg.click('#stProps .seg button[data-v="hero"]')
        tool('+ SFX'); pg.click('[data-s="whoosh"]'); pg.wait_for_timeout(500)
        pg.evaluate("PS_STUDIO.select(null); PS_STUDIO.setT(1.6)"); pg.wait_for_timeout(2500); shot('ui-studio-glow-freeze.png')
        report['fx_clips'] = pg.evaluate("PS_STUDIO.P.clips.map(c => ({freeze:c.freeze, reverse:c.reverse, curve:c.curve, glow:!!c.glow, faceZoom:!!c.faceZoom}))")
        report['fx'] = export('studio-facezoom-glow-freeze-reverse-1080p.mp4', res='1080')

    if want('beat'):
        clear()
        add_files('+ Video', [f'{FX}/clip.mp4', f'{FX}/shaky.mp4', f'{FX}/clip-rot.mp4'])
        tool('Templates'); pg.click('[data-t="montage"]')
        pg.wait_for_function("PS_STUDIO.P.clips.length > 3 && PS_STUDIO.P.audios.length > 0", timeout=60000); pg.wait_for_timeout(1500)
        report['beat'] = {'cuts': pg.evaluate('PS_STUDIO.P.clips.length'), 'bpm_track': pg.evaluate('PS_STUDIO.P.audios[0].bpm'), 'toast': pg.inner_text('#toast')}
        pg.evaluate("PS_STUDIO.setT(1)"); pg.wait_for_timeout(2500); shot('ui-studio-montage.png')
        report['montage'] = export('studio-template-beat-montage-size8MB.mp4', size='8')

    if want('reframe'):
        clear(); pg.evaluate("PS_STUDIO.P.aspect = '9:16'; PS_STUDIO.P.reframe = true")
        add_files('+ Video', [f'{FX}/clip-fast.mp4'])
        tool('Templates'); pg.click('[data-t="cinematic"]'); pg.wait_for_timeout(2500)
        report['cinematic'] = export('studio-template-cinematic-16x9.mp4')
        clear(); pg.evaluate("PS_STUDIO.P.aspect = '9:16'"); add_files('+ Video', [f'{FX}/clip-fast.mp4'])
        report['reframe'] = export('studio-autoreframe-9x16-60fps.mp4', fps='60')
        tool('Extract audio') if False else None
    report['errors'] = errors
    print(json.dumps(report, indent=1))
    b.close()
