// Private copies of picked files.
// Android hands the WebView a File that points at a temporary content:// grant. Reading it
// later (export after editing, a second pass for audio, a seek) can fail with
// NotReadableError once the grant is gone. So every picked file is copied once, straight
// away, into app-private storage (OPFS; in-memory as fallback), and only the copy is used.
const CHUNK = 4 * 1024 * 1024;
let dirP = null;
async function dir() {
  if (!dirP) dirP = (async () => {
    const root = await navigator.storage.getDirectory();
    const d = await root.getDirectoryHandle('imports', { create: true });
    return d;
  })().catch((e) => { dirP = null; throw e; });
  return dirP;
}
let seq = 0;
const keep = new Set();
export const stashDiag = { copies: [] };
globalThis.PS_STASH_DIAG = stashDiag;

// Reads the whole picked file once (with retries) and returns a re-readable File copy.
export async function stash(file, onProgress, purpose = 'media') {
  if (!file || file.__stashed) return file;
  if (cleanupP) await cleanupP;
  const name = file.name || 'media'; const type = file.type || guessType(name);
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const copy = (globalThis.PS_STASH_MODE !== 'memory' && navigator.storage && navigator.storage.getDirectory) ? await toOpfs(file, name, type, onProgress).catch((e) => { if (e && e.name === 'NotReadableError') throw e; console.warn('OPFS copy failed, using memory', e); return toMemory(file, name, type, onProgress); }) : await toMemory(file, name, type, onProgress);
      copy.__stashed = true; stashDiag.copies.push({ name, size: file.size, where: copy.__where, purpose });
      return copy;
    } catch (e) { lastErr = e; console.warn('copy attempt failed', attempt, e); await new Promise((r) => setTimeout(r, 250 * (attempt + 1))); }
  }
  const err = new Error(`Couldn't read "${name}" from your phone (${lastErr && (lastErr.name || lastErr.message)}). Please pick it again. If it keeps failing, save it to the phone's own storage first (not an SD card or cloud folder).`);
  err.cause = lastErr; throw err;
}
export async function stashAll(files, onProgress) { const out = []; for (let i = 0; i < files.length; i++) out.push(await stash(files[i], (f) => onProgress && onProgress((i + f) / files.length))); return out; }

async function readChunks(file, onChunk, onProgress) {
  for (let off = 0; off < file.size; off += CHUNK) {
    const buf = new Uint8Array(await file.slice(off, Math.min(file.size, off + CHUNK)).arrayBuffer());
    await onChunk(buf); if (onProgress) onProgress(Math.min(1, (off + buf.length) / file.size));
  }
  if (!file.size && onProgress) onProgress(1);
}
async function toOpfs(file, name, type, onProgress) {
  const d = await dir(); const id = `f${Date.now().toString(36)}_${++seq}_${name.replace(/[^\w.-]+/g, '_').slice(-60)}`;
  const h = await d.getFileHandle(id, { create: true });
  const w = await h.createWritable();
  try { await readChunks(file, (b) => w.write(b), onProgress); await w.close(); } catch (e) { try { await w.abort(); } catch (_) { /* ignore */ } try { await d.removeEntry(id); } catch (_) { /* ignore */ } throw e; }
  const f = await h.getFile(); if (f.size !== file.size) throw new Error('copy incomplete');
  const out = new File([f], name, { type, lastModified: file.lastModified }); // name/type of the original
  out.__where = 'opfs'; out.__id = id; keep.add(id); return out;
}
async function toMemory(file, name, type, onProgress) {
  const parts = []; await readChunks(file, (b) => parts.push(b), onProgress);
  const out = new File(parts, name, { type, lastModified: file.lastModified }); out.__where = 'memory'; return out;
}
function guessType(n) { const e = n.split('.').pop().toLowerCase(); return ({ mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', '3gp': 'video/3gpp', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', aac: 'audio/aac', ogg: 'audio/ogg' })[e] || 'application/octet-stream'; }

// Frees copies that are no longer used (called when the editor switches media).
export async function release(file) { if (!file || !file.__id) return; keep.delete(file.__id); try { (await dir()).removeEntry(file.__id); } catch (e) { /* ignore */ } }
// On start-up, clear copies left over from a previous session.
let cleanupP = null;
export function cleanup() { return (cleanupP = cleanupP || doCleanup()); }
async function doCleanup() { try { const d = await dir(); for await (const [n] of d.entries()) if (!keep.has(n)) await d.removeEntry(n).catch(() => {}); } catch (e) { /* no OPFS */ } }
