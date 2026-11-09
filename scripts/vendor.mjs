// Copies runtime libraries into www/vendor so the app works fully offline.
import { cpSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
const nm = 'node_modules';
mkdirSync('www/vendor/mediapipe/wasm', { recursive: true });
copyFileSync(`${nm}/@mediapipe/tasks-vision/vision_bundle.mjs`, 'www/vendor/mediapipe/vision_bundle.mjs');
for (const f of ['vision_wasm_internal.js', 'vision_wasm_internal.wasm', 'vision_wasm_nosimd_internal.js', 'vision_wasm_nosimd_internal.wasm'])
  copyFileSync(`${nm}/@mediapipe/tasks-vision/wasm/${f}`, `www/vendor/mediapipe/wasm/${f}`);
mkdirSync('www/vendor/ort', { recursive: true });
for (const f of ['ort.wasm.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'])
  copyFileSync(`${nm}/onnxruntime-web/dist/${f}`, `www/vendor/ort/${f}`);
copyFileSync(`${nm}/mp4-muxer/build/mp4-muxer.mjs`, 'www/vendor/mp4-muxer.mjs');
copyFileSync(`${nm}/mp4box/dist/mp4box.all.min.js`, 'www/vendor/mp4box.all.min.js');
if (existsSync(`${nm}/@capacitor/core/dist/capacitor.js`)) copyFileSync(`${nm}/@capacitor/core/dist/capacitor.js`, 'www/capacitor.js');
console.log('vendored runtime libraries');
