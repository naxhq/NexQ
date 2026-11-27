// README release badge, read by shields.io's endpoint badge (see stars.json.ts). The version is the root
// package.json's (data/releases.ts), and a release changes CHANGELOG.md, which redeploys the site.
import { CURRENT_VERSION } from '../../data/releases';

export function GET() {
  return new Response(
    JSON.stringify({ schemaVersion: 1, label: 'release', message: `v${CURRENT_VERSION}`, color: '2f81f7', cacheSeconds: 3600 }),
    { headers: { 'Content-Type': 'application/json' } },
  );
}
