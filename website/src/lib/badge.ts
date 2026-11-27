// README badges drawn at build time, in shields.io's flat-square style, so the README never waits on shields.io
// (its GitHub-backed badges and its endpoint badge often time out). GitHub's image proxy fetches them from our site.
// Layout copied from shields' own SVGs; text widths are Verdana 11px measured in Chrome (data/badge-assets.json),
// within a pixel of shields' table. Logos are shields' Simple Icons (CC0) data URIs.
import assets from '../data/badge-assets.json';

const WIDTHS = assets.widths as Record<string, number>;
const LOGOS = assets.logos as Record<string, string>;
/** Average width, for any character outside printable ASCII. */
const FALLBACK = 7;

export const textWidth = (s: string): number => Math.round([...s].reduce((n, ch) => n + (WIDTHS[ch] ?? FALLBACK), 0));

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface Badge {
  label: string;
  message: string;
  /** Hex colour of the message side, with the #. */
  color: string;
  logo?: keyof typeof assets.logos;
}

export function badgeSvg({ label, message, color, logo }: Badge): string {
  const lw = textWidth(label);
  const mw = textWidth(message);
  const logoW = logo ? 17 : 0; // 14px icon plus 3px gap
  const left = lw + 10 + logoW;
  const right = mw + 10;
  const title = esc(`${label}: ${message}`);
  const icon = logo ? `<image x="5" y="3" width="14" height="14" href="${LOGOS[logo]}"/>` : '';
  const lx = (logoW + (lw + 10) / 2 + 1) * 10;
  const mx = (left + right / 2 - 1) * 10;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${left + right}" height="20" role="img" aria-label="${title}"><title>${title}</title>` +
    `<g shape-rendering="crispEdges"><rect width="${left}" height="20" fill="#555"/><rect x="${left}" width="${right}" height="20" fill="${color}"/></g>` +
    `<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="110">${icon}` +
    `<text x="${lx}" y="140" textLength="${lw * 10}" transform="scale(.1)">${esc(label)}</text>` +
    `<text x="${mx}" y="140" textLength="${mw * 10}" transform="scale(.1)">${esc(message)}</text></g></svg>`
  );
}
