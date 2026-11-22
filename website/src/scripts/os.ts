// The visitor's desktop platform, read once from the browser. Used by the hero download label
// (callDemo.ts) and the Download section highlight (dl-detect.ts), so both always agree.
// Phones and tablets cannot run either build, so they get '' (no platform).

export type Platform = 'windows' | 'mac' | '';

let cached: Platform | undefined;

export function detectOS(): Platform {
  if (cached !== undefined) return cached;
  const ua = navigator.userAgent;
  // userAgentData.platform where the browser has it (Chromium), otherwise the user agent alone says enough.
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  const hint = `${ua} ${uaData?.platform ?? ''}`;
  const touchMac = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1; // iPadOS reports a Mac
  const mobile = /iPhone|iPad|iPod|Android/i.test(ua) || touchMac;
  cached = mobile ? '' : /Windows|Win32|Win64/i.test(hint) ? 'windows' : /Macintosh|MacIntel|Mac OS X|macOS/i.test(hint) ? 'mac' : '';
  return cached;
}
