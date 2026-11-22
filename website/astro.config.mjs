import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

// Deployed to GitHub Pages as a project site: https://naxhq.github.io/NexQ/
export default defineConfig({
  site: 'https://naxhq.github.io',
  base: '/NexQ/',
  output: 'static',
  // Astro 7 defaults to 'jsx', which strips whitespace between inline elements.
  // Keep the previous HTML compression so text spacing renders exactly as before.
  compressHTML: true,
  integrations: [sitemap()],
  vite: {
    plugins: [tailwindcss()],
    // Tailwind runs as a Vite plugin. An inline (empty) PostCSS config stops Vite from
    // picking up the desktop app's postcss.config.js (Tailwind 3) in the repo root.
    css: { postcss: {} },
    // The site imports the app's own release helpers (../src/lib/*.mjs) and reads the
    // root CHANGELOG.md and package.json, so the dev server may serve files above website/.
    server: { fs: { allow: ['..'] } },
  },
});
