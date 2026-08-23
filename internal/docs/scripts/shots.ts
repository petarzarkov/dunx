/**
 * Screenshots of the built site, for looking at it.
 *
 * `bun run shots` builds, serves `dist/` on a free port and writes one PNG per
 * route per viewport into `.shots/`. It is a local eye-check, not a test: the
 * assertions about layout live in `src/*.test.tsx`.
 */
import { chromium } from 'playwright';

const ROUTES = [
  ['landing', '#/'],
  ['guide', '#/guide/introduction'],
  ['guide-long', '#/guide/controllers'],
  ['api', '#/api/http'],
  ['benchmarks', '#/benchmarks'],
  ['releases', '#/releases'],
  ['coverage', '#/coverage'],
] as const;

const VIEWPORTS = [
  ['desktop', 1440, 900],
  ['mobile', 393, 852],
] as const;

/** Vite writes absolute `/dunx/...` asset urls, so the server has to mount there. */
const BASE = '/dunx';
const root = new URL('../dist/', import.meta.url).pathname;
const out = new URL('../.shots/', import.meta.url).pathname;

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname.replace(BASE, '');
    const file = Bun.file(
      `${root}${path === '' || path === '/' ? 'index.html' : path.slice(1)}`,
    );
    if (await file.exists()) return new Response(file);
    return new Response(Bun.file(`${root}index.html`));
  },
});

const browser = await chromium.launch();
const only = process.argv.slice(2);

for (const [scheme, dark] of [
  ['light', false],
  ['dark', true],
] as const) {
  for (const [vp, width, height] of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width, height },
      colorScheme: dark ? 'dark' : 'light',
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();

    for (const [name, hash] of ROUTES) {
      if (only.length > 0 && !only.includes(name)) continue;
      await page.goto(`${server.url.origin}${BASE}/${hash}`, {
        waitUntil: 'networkidle',
      });
      await page.waitForTimeout(400);
      await page.screenshot({
        path: `${out}${name}-${vp}-${scheme}.png`,
        fullPage: false,
      });
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
      console.log(
        `${name}-${vp}-${scheme}`.padEnd(28),
        overflow ? 'HORIZONTAL OVERFLOW' : 'ok',
      );
    }
    await context.close();
  }
}

await browser.close();
server.stop(true);
