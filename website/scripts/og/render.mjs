// Renders og.html to ../../public/og.jpg (1200 x 630, JPEG quality 85, flat colours, no glow).
// Usage (from website/): node scripts/og/render.mjs
// Needs playwright-core and a Chrome or Edge. Set PLAYWRIGHT_CORE to its index.mjs when it is not
// installed here, and CHROME_PATH when Chrome is not in a standard place.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const core = process.env.PLAYWRIGHT_CORE ? pathToFileURL(process.env.PLAYWRIGHT_CORE).href : 'playwright-core';
const { chromium } = await import(core);
const exe = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => p && fs.existsSync(p));

const browser = await chromium.launch({ executablePath: exe, headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(path.join(here, 'og.html')).href);
await page.evaluate(() => document.fonts.ready);
const out = path.resolve(here, '../../public/og.jpg');
await page.screenshot({ path: out, type: 'jpeg', quality: 85 });
await browser.close();
console.log(`wrote ${out} (${fs.statSync(out).size} bytes)`);
