# Social card (og.jpg)

`og.html` is the source of `public/og.jpg` (1200 x 630): the hero headline, the logo and a crisp stand-in for the overlay's question card and answer, on the app's dark background. No glow, no gradient.

Regenerate after editing: from `website/`, run `node scripts/og/render.mjs` (needs playwright-core and Chrome or Edge; set `PLAYWRIGHT_CORE` and `CHROME_PATH` if they are not found). Keep the file under 150 KB.
