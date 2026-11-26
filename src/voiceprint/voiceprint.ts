// A voiceprint is a workspace's mark: seven bars shaped like a short phrase of
// speech, the same idea as releaseWave (src/lib/releaseWave.mjs), but small and
// keyed by any string. The same id always gives the same shape.

export const VOICEPRINT_BARS = 7;

function seedFrom(id: string): () => number {
  // FNV-1a, then mulberry32: the generator releaseWave uses.
  let seed = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    seed ^= id.charCodeAt(i);
    seed = Math.imul(seed, 0x01000193);
  }
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Heights 0.12 to 1, on a 0.04 grid, so two shapes are either the same or visibly different. */
export function voiceprint(id: string): number[] {
  const random = seedFrom(id || "?");
  // One phrase: it swells around a random peak, with grain, like a spoken word.
  const peak = 1.5 + random() * (VOICEPRINT_BARS - 4);
  const width = 2.2 + random() * 2.2;
  const bars: number[] = [];
  for (let i = 0; i < VOICEPRINT_BARS; i++) {
    const swell = Math.exp(-((i - peak) ** 2) / (2 * width * width * 0.45));
    const grain = 0.35 + random() * 0.65;
    bars.push(0.12 + 0.88 * Math.min(1, swell * 0.55 + grain * 0.6));
  }
  // Fill the range so no mark is a flat row or too tiny.
  const lo = Math.min(...bars);
  const hi = Math.max(...bars);
  const span = Math.max(hi - lo, 0.001);
  return bars.map((h) => Math.round((0.12 + 0.88 * ((h - lo) / span)) / 0.04) * 0.04).map((h) => Math.round(h * 100) / 100);
}
