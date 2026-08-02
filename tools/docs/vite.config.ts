import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Vite 8 (Rolldown) rather than `Bun.build`, and the reason is tree shaking.
 * Measured on this site with Mantine, `@mantine/charts` and recharts in the
 * graph: 426.8 KB gzipped JS against `Bun.build`'s 506.5 KB, and 31.2 KB of CSS
 * against 35.0 KB - 83.5 KB less over the wire for the same pixels. The build
 * speed that bought `Bun.build` the job originally has stopped being a
 * difference worth having: 0.3 s against 0.15 s, both irrelevant in CI.
 *
 * Served from https://petarzarkov.github.io/dunx/, so every asset URL needs the
 * repository name as its prefix. `DOCS_BASE=/` builds for a local server.
 *
 * `public/` is copied to the output root by Vite itself, which is where the
 * coverage badges `gen:cov` writes come from. It may not exist on a clean
 * checkout; Vite tolerates that.
 */
export default defineConfig({
  base: process.env['DOCS_BASE'] ?? '/dunx/',
  plugins: [react()],
  build: {
    sourcemap: false,
    // One entry, one chunk. The warning is about a threshold this site has no
    // intention of meeting - it ships a full design system and a chart library.
    chunkSizeWarningLimit: 2048,
  },
});
