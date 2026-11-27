// README "installer downloads" badge, read by shields.io's endpoint badge (see stars.json.ts).
// What is counted, and why Windows updates are in it: data/github.ts.
import { INSTALLER_DOWNLOADS_LABEL } from '../../data/github';

export function GET() {
  return new Response(
    JSON.stringify({
      schemaVersion: 1,
      label: 'installer downloads',
      message: INSTALLER_DOWNLOADS_LABEL ?? 'on GitHub',
      color: 'orange',
      cacheSeconds: 3600,
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
}
