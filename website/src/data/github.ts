// The star count shown next to "Star on GitHub" (Navbar.astro, Hero.astro).
// BUILD time only: the site makes no request to GitHub from the visitor's browser. The deploy workflow runs on every
// push that touches the site and once a day, so the number is at most a day old. pages/badges/[name].svg.ts draws
// the README badges from it. If the request fails (offline, rate limit,
// slow), there is simply no count and the build carries on. GITHUB_TOKEN, when set, lifts the anonymous rate limit.
import { REPO } from './site';

const API = `https://api.github.com/repos/${new URL(REPO).pathname.slice(1)}`;

function headers(): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'nexq-website-build' };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

async function fetchStars(): Promise<number | null> {
  try {
    const res = await fetch(API, { headers: headers(), signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const n = (await res.json()).stargazers_count;
    return Number.isInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

/** Compact, rounded down so it never overstates: 950, 1.2k, 12k. */
export function compactCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return `${Math.floor(n / 100) / 10}k`;
  return `${Math.floor(n / 1000)}k`;
}

/**
 * Downloads of the installers across every release: the Windows setup.exe and the Mac .dmg. Leaves out the update
 * checks (latest.json), signatures and the Mac update archive. The Windows updater downloads the same setup.exe, so
 * Windows updates are in this number; that is why it is called "installer downloads", never installs or users.
 */
export const isInstaller = (name: string): boolean => /-setup\.exe$|\.dmg$/i.test(name);

async function fetchInstallerDownloads(): Promise<number | null> {
  try {
    let total = 0;
    for (let page = 1; page <= 10; page++) {
      const res = await fetch(`${API}/releases?per_page=100&page=${page}`, { headers: headers(), signal: AbortSignal.timeout(8000) });
      if (!res.ok) return null;
      const releases = (await res.json()) as { assets?: { name: string; download_count: number }[] }[];
      for (const r of releases) for (const a of r.assets ?? []) if (isInstaller(a.name)) total += a.download_count;
      if (releases.length < 100) return total;
    }
    return total;
  } catch {
    return null;
  }
}

export const STARS = await fetchStars();
export const INSTALLER_DOWNLOADS = await fetchInstallerDownloads();
/** "6.5k", or null when the count could not be read at build time. */
export const INSTALLER_DOWNLOADS_LABEL = INSTALLER_DOWNLOADS === null ? null : compactCount(INSTALLER_DOWNLOADS);
/** "950", "1.2k", or null when the count could not be read at build time. */
export const STARS_LABEL = STARS === null ? null : compactCount(STARS);
