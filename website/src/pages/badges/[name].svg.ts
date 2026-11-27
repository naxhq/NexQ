// The README's badges, as images on getnexq.com (lib/badge.ts says why). Numbers come from the build, and the site
// rebuilds daily (deploy-website.yml), so stars and downloads are at most a day old.
import type { APIRoute } from 'astro';
import { badgeSvg, type Badge } from '../../lib/badge';
import { STARS, INSTALLER_DOWNLOADS_LABEL, compactCount } from '../../data/github';
import { CURRENT_VERSION } from '../../data/releases';

const BADGES: Record<string, Badge> = {
  release: { label: 'release', message: `v${CURRENT_VERSION}`, color: '#2f81f7' },
  downloads: { label: 'installer downloads', message: INSTALLER_DOWNLOADS_LABEL ?? 'on GitHub', color: '#ea7233' },
  license: { label: 'license', message: 'MIT', color: '#67ac09' },
  platform: { label: 'platform', message: 'Windows | macOS (beta)', color: '#9f9f9f' },
  tauri: { label: 'built with', message: 'Tauri 2', color: '#24c8db', logo: 'tauri' },
  stars: { label: 'stars', message: STARS === null ? 'on GitHub' : compactCount(STARS), color: '#d8b800', logo: 'github' },
  discussions: { label: 'discussions', message: 'ask or share', color: '#8250df', logo: 'github' },
};

export function getStaticPaths() {
  return Object.keys(BADGES).map((name) => ({ params: { name } }));
}

export const GET: APIRoute = ({ params }) =>
  new Response(badgeSvg(BADGES[params.name as string]), { headers: { 'Content-Type': 'image/svg+xml' } });
