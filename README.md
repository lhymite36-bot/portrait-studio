# Portrait Studio

Free, offline Android app for **portrait blur**, **quality boost**, **effects** and **colour grading** on photos and videos.
Everything runs on the phone: no accounts, no paid APIs, no watermark.

## Features (v1.0.0)
- **Portrait blur** for photos and videos: on-device person segmentation (MediaPipe selfie models), edge-aware mask refinement, disc-shaped bokeh that never smears the person into the background. Controls: blur, focus, edge softness, bokeh lights.
- **Quality**: bicubic upscaling (Original, 2× up to 4K, or 4K), edge-aware denoise, sharpen, clarity. No generative changes to faces.
- **Looks**: 14 grading presets (Cinematic, Teal & Orange, Warm Glow, Moody, B&W, Noir, Film, Nightglow Vibrant, Cool Blue, Golden Hour, Pastel, Matte, Neon Night) with intensity.
- **Adjust**: exposure, contrast, highlights, shadows, saturation, vibrance, temperature, tint.
- **Effects**: glow, vignette, grain, fade.
- Live preview, hold-to-compare and a before/after split slider.
- Photo import from gallery or camera; saves full resolution JPEG to *Pictures/PortraitStudio*.
- Video: frame-by-frame export to MP4 (H.264) with the original sound copied untouched, progress bar, ETA and Cancel; 720p / 1080p / original; slow motion 2× / 4× with frame blending. Saved to *Movies/PortraitStudio*.

## Premium tools (v1.1.0)
Backdrop remove/swap (transparent PNG, studio, colour, photo), sky replacement, skin/eyes/teeth retouch and tap-to-heal, movable relight, object eraser, old-photo restore + colourise, text and stickers, light leaks and film dust, .cube LUT import/export, My looks, batch editing, video stabilise and focus shift. See docs/release-notes/v1.1.0.md.

## Video Studio (v1.2.0)
CapCut-style timeline: multi-track editing (trim/split/merge/reorder), transitions, keyframes, speed curves, freeze/reverse, Whisper auto captions, text animations, CC0 music/SFX, beat sync, voice effects, noise reduction, Android TTS, chroma key, PiP with blend modes and shape masks, face zoom, glow outline, auto reframe 16:9→9:16, templates, export up to 4K/60 with file-size control. See docs/release-notes/v1.2.0.md and v1.2.1.md (import/preview/delete fixes).

## AI models (downloaded on first use, cached)
LaMa (Apache-2.0) and MI-GAN (MIT) for the eraser, DDColor-tiny (Apache-2.0) for colourise, Depth Anything V2 small (Apache-2.0) for 3D relight. Bundled: MediaPipe selfie models (Apache-2.0) and U²-Net-p (Apache-2.0) for portrait detection.

## Build
```
npm ci && npm test && npm run sync
cd android && ./gradlew assembleRelease
```
GitHub Actions builds the APK on every push and publishes a release for `v*` tags.

## Tests
- `npm test`: unit tests for the colour pipeline, mask shaping, sizing and codec selection.
- `python tests/headless/run.py`: real MediaPipe segmentation + WebGL + WebCodecs export in headless Chrome, GPU/CPU grading parity.
- `python tests/headless/ui.py`: UI smoke test at a phone-sized viewport.
- `python tests/headless/premium.py`: drives every v1.1 tool.
- `python tests/headless/studio.py`: drives the Video Studio (captions, PiP + chroma, templates, beat sync, freeze/reverse, exports).
