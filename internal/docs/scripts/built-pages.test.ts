import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileFor, SITE_ORIGIN } from './pages';

/**
 * What `bun run build` wrote, read off disk.
 *
 * The old suite asserted a hand-built body against a fixture, because the body
 * was this repo's own markup. It is the app's now, so the question changed: is
 * each page the real page, does its head say which URL it is, and did the SSR
 * bundle stay out of `dist/`.
 *
 * Skipped rather than failed without a build: `bun run ci` builds first, and the
 * dev loop should not have to.
 */
const dist = new URL('../dist/', import.meta.url).pathname;
const built = existsSync(join(dist, 'guide/controllers.html'));
const read = (path: string): string =>
  readFileSync(join(dist, fileFor(path)), 'utf8');

describe.skipIf(!built)('the built pages', () => {
  test('render the app, not an approximation of it', () => {
    const page = read('/guide/controllers');
    // The shell, the nav and the contents rail are what the reader used to
    // watch appear a second after the prose did.
    expect(page).toContain('mantine-AppShell-navbar');
    expect(page).toContain('mantine-AppShell-header');
    expect(page).toContain('<h1');
    expect(page).toContain('Controllers');
  });

  test('carry the prose the client reads back out of the document', () => {
    expect(read('/guide/controllers')).toContain(
      'data-prose-seed="guide:controllers"',
    );
    expect(read('/api/http')).toContain('data-prose-seed="package:http"');
  });

  test('say which URL they are, exactly once', () => {
    const page = read('/guide/controllers');
    expect(page).toContain(
      `<link rel="canonical" href="${SITE_ORIGIN}/guide/controllers" />`,
    );
    expect(page.match(/name="description"/g)).toHaveLength(1);
    expect(page).toContain('<title>Controllers | dunx</title>');
  });

  test('carry a social card and structured data', () => {
    const page = read('/guide/controllers');
    expect(page).toContain(`content="${SITE_ORIGIN}/og.png"`);
    expect(page).toContain('name="twitter:card" content="summary_large_image"');
    const blocks = page.match(/application\/ld\+json/g) ?? [];
    expect(blocks.length).toBeGreaterThan(0);
    for (const json of page.matchAll(
      /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g,
    )) {
      expect(() => JSON.parse(json[1] ?? '')).not.toThrow();
    }
  });

  /**
   * `vite-prerender-plugin` was measured here first and rejected for this: it
   * adds the prerender script as a client input, so `dist/` held a 1,011 KB
   * `react-dom/server` chunk and all 99 pages carried a `modulepreload` for it.
   */
  test('ship no server renderer to the browser', () => {
    const page = read('/guide/controllers');
    expect(page).not.toContain('entry-server');
    expect(page).not.toContain('modulepreload');
  });

  test('leave the not-found page without the site nav', () => {
    const page = read('/404');
    expect(page).toContain('<div id="root"></div>');
    expect(page).toContain('<title>Not found | dunx</title>');
  });

  test('list every page in the sitemap and point robots at it', () => {
    const sitemap = readFileSync(join(dist, 'sitemap.xml'), 'utf8');
    expect(sitemap).toContain(`${SITE_ORIGIN}/guide/controllers`);
    expect(sitemap).toContain(`${SITE_ORIGIN}/`);
    expect(readFileSync(join(dist, 'robots.txt'), 'utf8')).toContain(
      `Sitemap: ${SITE_ORIGIN}/sitemap.xml`,
    );
  });
});
