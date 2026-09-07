import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import type { SiteIndex } from './scripts/extract/model';
import {
  fileFor,
  pagesOf,
  SITE_ORIGIN,
  type PageMeta,
  type ReleaseEntry,
} from './scripts/pages';

const here = (path: string): string =>
  fileURLToPath(new URL(path, import.meta.url));

const read = <T>(path: string, fallback: T): T => {
  try {
    return JSON.parse(readFileSync(here(path), 'utf8')) as T;
  } catch {
    return fallback;
  }
};

/**
 * The routes, out of the same generated model the nav is built from.
 *
 * `bun run generate` writes both files before Vite starts, so this is read at
 * config time rather than crawled: the plugin only follows links a `prerender()`
 * returns, and handing it the list outright is one fewer thing that can silently
 * miss a page.
 */
const pages: PageMeta[] = pagesOf(
  read<SiteIndex>('./src/generated/index.json', {
    generatedAt: '',
    guides: [],
    packages: [],
  } as unknown as SiteIndex),
  read<ReleaseEntry[]>('./src/generated/releases.json', []),
);

/**
 * A real HTML file per route, rendered by the app itself.
 *
 * `SSR_ENTRY` is the output of `vite build --ssr src/entry-server.tsx`, which
 * `bun run build` runs first. A separate build rather than an extra input to
 * this one: `vite-prerender-plugin` does it that way and the cost was measured
 * here - the prerender entry became a client chunk, so `dist/` carried a
 * 1,011 KB `react-dom/server` bundle and every one of the 99 pages preloaded it.
 *
 * The head is a string insert rather than a parsed document, and the body goes
 * into the `<div id="root">` Vite emitted. Matching the exact spelling rather
 * than a regex: if the shell ever stops carrying that div the replace is a
 * no-op and the test fails, which is better than a loose pattern quietly
 * matching something else.
 */
const SSR_ENTRY = new URL('./.ssr/entry-server.js', import.meta.url).href;

const pageFiles = (): Plugin => ({
  name: 'dunx:pages',
  apply: 'build',
  // After Vite's own HTML plugin, which is what puts `index.html` in the bundle
  // for this hook to read.
  enforce: 'post',
  // `bun run build` runs Vite twice, and only the client pass has a shell to
  // render into. Without this the SSR pass reached the hook and failed on a
  // bundle with no `index.html`.
  applyToEnvironment: (environment) => environment.name === 'client',
  async generateBundle(_options, bundle) {
    const shell = bundle['index.html'];
    // `this.error` throws, so the narrowing below is what the compiler needs
    // rather than a second guard.
    if (shell?.type !== 'asset') {
      return this.error('no index.html in the bundle to render pages into');
    }
    const template = String(shell.source);

    // An absolute `file://`, because Vite loads this config from a temp
    // directory and a relative specifier resolves against that.
    const { renderPage } = (await import(SSR_ENTRY)) as {
      renderPage: (
        path: string,
      ) => Promise<{ html: string; title: string; head: string }>;
    };

    // `/404` is not in `pages`: it is the shell with no body, which Cloudflare
    // serves with a real status for anything the list does not cover. A
    // not-found page carrying the site's whole nav is a soft-404 signal.
    for (const page of [...pages, { path: '/404' }]) {
      const { html, title, head } = await renderPage(page.path);
      const source = template
        .replace(/<title>[\s\S]*?<\/title>/, `<title>${title}</title>`)
        .replace('  </head>', `${head}\n  </head>`)
        .replace('<div id="root"></div>', `<div id="root">${html}</div>`);

      if (page.path === '/') shell.source = source;
      else
        this.emitFile({ type: 'asset', fileName: fileFor(page.path), source });
    }

    const lastmod = new Date().toISOString().slice(0, 10);
    const urls = pages
      .map(
        (page) =>
          `  <url>\n    <loc>${SITE_ORIGIN}${page.path}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>`,
      )
      .join('\n');

    this.emitFile({
      type: 'asset',
      fileName: 'sitemap.xml',
      source: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
    });
    this.emitFile({
      type: 'asset',
      fileName: 'robots.txt',
      source: `User-agent: *\nAllow: /\n\nSitemap: ${SITE_ORIGIN}/sitemap.xml\n`,
    });
  },
});

/**
 * Vite 8 (Rolldown) rather than `Bun.build`, and the reason is tree shaking.
 * Measured on this site with Mantine, `@mantine/charts` and recharts in the
 * graph: 426.8 KB gzipped JS against `Bun.build`'s 506.5 KB, and 31.2 KB of CSS
 * against 35.0 KB - 83.5 KB less over the wire for the same pixels. The build
 * speed that bought `Bun.build` the job originally has stopped being a
 * difference worth having: 0.3 s against 0.15 s, both irrelevant in CI.
 *
 * Served from https://dunx.win/, so the base is the root. It was `/dunx/` for
 * GitHub Pages, and a build carrying that prefix onto Cloudflare asks for
 * `/dunx/assets/...`, which no file answers: the SPA fallback returns
 * `index.html` and the browser refuses it as CSS on a MIME check. `DOCS_BASE`
 * is what a fork serving from a subpath sets.
 *
 * `public/` is copied to the output root by Vite itself, which is where the
 * coverage badges `gen:cov` writes come from, along with `_headers` and
 * `_redirects`. It may not exist on a clean checkout; Vite tolerates that.
 *
 * `pageFiles` renders every route through the app's own React tree and writes a
 * real HTML file for each. It replaced a `scripts/prerender.ts` that built a
 * second, flatter layout out of the same model and the half of `scripts/seo.ts`
 * that pasted it into the shell.
 */
export default defineConfig({
  base: process.env['DOCS_BASE'] ?? '/',
  plugins: [react(), pageFiles()],
  build: {
    sourcemap: false,
    // One entry, one chunk. The warning is about a threshold this site has no
    // intention of meeting - it ships a full design system and a chart library.
    chunkSizeWarningLimit: 2048,
  },
});
