// The star count shown next to "Star on GitHub" (Navbar.astro, Hero.astro).
// BUILD time only: the site makes no request to GitHub from the visitor's browser. The deploy workflow runs on every
// push that touches the site, so the number refreshes with each deploy. If the request fails (offline, rate limit,
// slow), there is simply no count and the build carries on. GITHUB_TOKEN, when set, lifts the anonymous rate limit.
import { REPO } from './site';

const API = `https://api.github.com/repos/${new URL(REPO).pathname.slice(1)}`;

async function fetchStars(): Promise<number | null> {
  try {
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'nexq-website-build' };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const res = await fetch(API, { headers, signal: AbortSignal.timeout(5000) });
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

export const STARS = await fetchStars();
/** "950", "1.2k", or null when the count could not be read at build time. */
export const STARS_LABEL = STARS === null ? null : compactCount(STARS);
