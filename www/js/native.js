// Bridges to the small native plugin (MediaStore saving + keep screen awake).
const plugin = () => (globalThis.Capacitor && Capacitor.Plugins && Capacitor.Plugins.GallerySaver) || null;
export const isNative = () => !!(globalThis.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform());

function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// Saves a Blob into the phone gallery (Pictures/PortraitStudio or Movies/PortraitStudio).
export async function saveToGallery(blob, name, onProgress) {
  const p = plugin();
  if (!p) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    return { where: 'Downloads' };
  }
  const { id } = await p.open({ name, mime: blob.type || 'application/octet-stream' });
  const CH = 3 * 1024 * 1024;
  try {
    for (let off = 0; off < blob.size; off += CH) {
      const part = new Uint8Array(await blob.slice(off, off + CH).arrayBuffer());
      await p.write({ id, data: b64(part) });
      if (onProgress) onProgress(Math.min(1, (off + CH) / blob.size));
    }
    const r = await p.close({ id });
    return { where: r.where || 'Gallery', uri: r.uri };
  } catch (e) {
    try { await p.abort({ id }); } catch (_) { /* ignore */ }
    throw e;
  }
}

export async function keepAwake(on) {
  const p = plugin();
  try { if (p) await p.keepAwake({ on }); } catch (e) { /* not fatal */ }
}
