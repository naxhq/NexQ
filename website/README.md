# NexQ website

Static marketing site for NexQ. Astro 7, Tailwind 4 (Vite plugin), no client framework.
Deployed to https://naxhq.github.io/NexQ/ (base `/NexQ/`) by `.github/workflows/deploy-website.yml`.

## Run it

```bash
cd website
npm ci
npm run dev        # http://localhost:4321/NexQ/
npx astro build    # static output in dist/
npm run preview
```

## Structure

```
src/
  pages/index.astro        page order: Navbar, Hero (hero + "The call" as one stage), YourAI, AfterCall,
                           MadeFor, Privacy, Releases, Download, Compare, FAQ, FinalCTA, Footer
  layouts/Layout.astro     head, OG/Twitter, JSON-LD, font preload, reveal-on-scroll helper
  components/              one file per section, plus Navbar, Footer, Icon, Wave
  components/overlay/      the overlay recreation: Overlay, BeatFrame, content.ts, overlay.css, stage.css
  scripts/                 small vanilla TS modules, one per interactive part (callDemo.ts is the demo)
  data/site.ts             facts and copy lists (see below)
  data/releases.ts         build-time release data
  styles/global.css        tokens, fonts, shared classes (read the comments at the top)
```

Each section is a `<section id=... aria-labelledby=...>`. The ids are in `SECTION` in `site.ts`.

## The call stage

`Hero.astro` renders the hero and the "Scroll the call" beats (`#call`) as one stage (`overlay/stage.css`):
one grid with a single overlay that stays pinned beside the text (CSS `position: sticky`, no
scroll-jacking) from the first word to the last beat. Under 900px it is one column.

- `components/overlay/content.ts` holds the whole sample conversation (Dana, a design hiring call):
  hero lines, the beat lines a to e, the answers and the times each moment shows. `AfterCall.astro`
  tells the same interview from the other side, so keep the two in step.
- `scripts/callDemo.ts` is the state machine: the hero plays its opening once and holds on the question
  card, a click on Assist streams the answer, and each beat (a both sides, b question caught, c one
  key, d what it knows, e hide from screen share) changes one thing in the overlay. One rAF loop, paused
  offscreen and in a hidden tab. Without JS, or with reduced motion, every beat shows its final state.
- Phones (and no JS) get a still of each beat (`BeatFrame.astro`) next to its text. The hero CTA names
  your system from 640px up, and on phones reads "Get it for Windows or Mac" and jumps to Download.

## Where facts live

`src/data/site.ts` is the single source for links, provider lists, counts, hotkeys, scenarios,
the FAQ and optional release one-liners. Every claim must be traceable to `CHANGELOG.md`,
`README.md`, `docs/user-guide/` or the app source. The FAQ array feeds both the visible FAQ and
the FAQPage JSON-LD, so they cannot drift apart. Meta descriptions over 160 characters fail the build.

## Releases and the waveform

Nothing about versions is typed by hand.

- `CURRENT_VERSION` comes from the root `package.json`.
- `RELEASES` is parsed from the root `CHANGELOG.md` with the app's own `parseChangelog`
  (`src/lib/releaseNotes.mjs`). It keeps versions from 2.22.0 on that have new features, drops
  entries scoped `website`, `deps` or `release`, and lists newest first. `RELEASE_ONELINERS` in
  `site.ts` can override a release's summary, keyed by version ("2.41.0").
- `waveFor(version)` imports the app's own `releaseWave()` (`src/lib/releaseWave.mjs`), so the site
  shows the same shape as the update dialog and the installer. Seed it with the full version
  string. `Wave.astro` renders it as static, labelled markup; sections move a `--progress`
  custom property (0 to 1) to play it. Bar heights never animate.

The workflow redeploys when `CHANGELOG.md`, `package.json` or those two `.mjs` files change.

## Design rules

Dark only, using the app's own palette (`src/index.css`, `.dark`). Colour carries meaning:
blue is for actions, green is you, orange is them, amber is translation, red is recording.
Type is Schibsted Grotesk and Martian Mono, self-hosted (no third-party requests). Motion uses one
spring curve, never bounces, and respects `prefers-reduced-motion`; the page also works without JS.

Banned, because they read as a template: bento or three-card grids, gradient text, glowing orbs,
aurora, grain, glass (except the overlay mock), count-up numbers, logo walls, marquees, typewriter
headlines, sparkles, cursor spotlights, tilt cards, magnetic buttons, an italic serif word in a sans
headline, uppercase mono eyebrows, fake Zoom or Teams chrome, stock faces, scroll-jacking.

Copy is plain and human: short sentences, no em dashes, no "seamless" or "AI-powered" filler.

## Evidence

The local harness lives in `.agent-logs/website/tools/` (local-only, excluded from git; run `node .agent-logs/website/tools/evidence.mjs <roundN>` from the repo root). It builds the site and writes `.agent-logs/website/<roundN>/`:

- Lighthouse, mobile (three runs, median) and desktop, against the budgets in `owner-decisions.md`.
- axe-core at 1280 and 360 widths (no serious or critical findings).
- Screenshots at 360, 768, 1280 and 1440, plus reduced motion, no JavaScript, `prefers-contrast: more` and forced colours.
- Keyboard walkthrough, text contrast table, console errors, and a byte report (JavaScript and fonts, gzipped).
- A claims trace per section author (`claims-*.md`): every fact on the page, with its source file and line.

## Commits

Use `docs(website): ...` so a site change never bumps the app version.

## After a release

The site redeploys on its own when a release changes `CHANGELOG.md`, so new versions appear in the release timeline. Everything else is written by hand. After each release, decide what else to update: the timeline one-liner (`RELEASE_ONELINERS` in `src/data/site.ts`) always, other sections only for prominent features or fixes. Changes you decide to hold go in `docs/website-pending.md` and are offered again with the next release.
