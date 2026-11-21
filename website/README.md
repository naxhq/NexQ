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
  pages/index.astro        page order: Navbar, Hero, CallStory, YourAI, AfterCall, MadeFor,
                           Privacy, Releases, Download, Compare, FAQ, FinalCTA, Footer
  layouts/Layout.astro     head, OG/Twitter, JSON-LD, font preload, reveal-on-scroll helper
  components/              one file per section, plus Navbar, Footer, Icon, Wave
  data/site.ts             facts and copy lists (see below)
  data/releases.ts         build-time release data
  styles/global.css        tokens, fonts, shared classes (read the comments at the top)
```

Each section is a `<section id=... aria-labelledby=...>`. The ids are in `SECTION` in `site.ts`.

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

## Commits

Use `docs(website): ...` so a site change never bumps the app version.
