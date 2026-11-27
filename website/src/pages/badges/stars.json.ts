// README star badge: shields.io's "endpoint" badge reads this file (https://shields.io/badges/endpoint-badge).
// Shields' own GitHub badges are slow or time out on its shared API quota; this file is plain JSON on our site, so the
// badge loads fast. The count comes from the build (data/github.ts) and the site rebuilds daily (deploy-website.yml).
import { STARS, compactCount } from '../../data/github';

export function GET() {
  return new Response(
    JSON.stringify({
      schemaVersion: 1,
      label: 'stars',
      message: STARS === null ? 'on GitHub' : compactCount(STARS),
      color: 'yellow',
      namedLogo: 'github',
      cacheSeconds: 3600,
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
}
