// Every release has its own waveform, drawn from its version number: the update
// dialog and the installer show the same shape for the same version.
//
// Plain JavaScript because scripts/nsis-release-info.mjs imports it at build
// time, before TypeScript is involved.

/** Bar heights from 0 to 1. The same version always gives the same wave. */
export function releaseWave(version, count = 72) {
  let seed = 0x811c9dc5;
  for (let i = 0; i < version.length; i++) {
    seed ^= version.charCodeAt(i);
    seed = Math.imul(seed, 0x01000193);
  }

  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // Shaped like speech: phrases that swell and fade, with a breath between them.
  const wave = [];
  while (wave.length < count) {
    const length = 7 + Math.floor(random() * 12);
    const peak = 0.55 + random() * 0.45;
    for (let i = 0; i < length && wave.length < count; i++) {
      const swell = Math.sin((Math.PI * (i + 0.5)) / length);
      const grain = 0.45 + random() * 0.55;
      wave.push(Math.round(Math.max(0.1, peak * swell * grain) * 100) / 100);
    }
    const breath = 1 + Math.floor(random() * 2);
    for (let i = 0; i < breath && wave.length < count; i++) wave.push(0.06);
  }
  return wave;
}
