// Global motion estimation used by the video stabiliser (pure, unit-tested).
// Returns [dx, dy] such that b(x,y) ~= a(x - dx, y - dy) (content moved by dx,dy).
export function estimateShift(a, b, W, H, R = 8) {
  let best = [0, 0], bestE = Infinity;
  const m = R + 2;
  const sad = (dx, dy, step) => {
    let e = 0, n = 0;
    for (let y = m; y < H - m; y += step) for (let x = m; x < W - m; x += step) { e += Math.abs(b[y * W + x] - a[(y - dy) * W + (x - dx)]); n++; }
    return e / n;
  };
  // exhaustive integer search on a sparse pixel grid (cheap at 160 px wide)
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) { const e = sad(dx, dy, 3) + 0.02 * (Math.abs(dx) + Math.abs(dy)); if (e < bestE) { bestE = e; best = [dx, dy]; } }
  return best;
}
