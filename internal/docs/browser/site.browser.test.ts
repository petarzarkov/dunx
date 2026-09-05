import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  ROUTES,
  SCHEMES,
  startPreview,
  VIEWPORTS,
  type Preview,
} from '../scripts/preview';

/**
 * The built site in a real browser, which is a different question from
 * `src/*.test.tsx`. Those render components through happy-dom and assert content.
 * These assert what happy-dom cannot answer: that the **bundle** loads, that a
 * route reached by direct link works on a cold load, that real layout does not
 * scroll sideways, and that nothing logs an error along the way.
 *
 * One test per route per viewport per colour scheme, and each writes its PNG into
 * `.shots/`. That is for looking at locally - `bun run shots` is this suite plus a
 * build, so the pictures and the assertions cannot drift apart. CI does not keep
 * them.
 *
 * Outside `src/`, and with its own `bunfig.toml`, so `bun run test` does not
 * collect it and the happy-dom preload does not replace the global `Response` -
 * `Bun.serve` refuses one that is not its own. See docs/bun-apis.md.
 */
const dist = new URL('../dist/', import.meta.url).pathname;
const shots = new URL('../.shots/', import.meta.url).pathname;

let preview: Preview;

beforeAll(async () => {
  if (!(await Bun.file(`${dist}index.html`).exists())) {
    throw new Error(
      `No built site at ${dist}. Run \`bun run ci build\` first, or \`bun run shots\`.`,
    );
  }
  preview = await startPreview(dist);
});

afterAll(async () => {
  await preview?.close();
});

/**
 * The heading each route lands on. A route falling back to the landing page, or to
 * a not-found, fails here rather than looking plausible in a screenshot.
 */
const HEADINGS: Record<string, RegExp> = {
  landing: /Everything a service needs/i,
  guide: /Introduction/i,
  'guide-long': /Controllers/i,
  api: /@dunx\/http/i,
  benchmarks: /Benchmarks/i,
  releases: /Releases/i,
  coverage: /Coverage/i,
};

for (const scheme of SCHEMES) {
  for (const [viewport, width, height] of VIEWPORTS) {
    describe(`${viewport} ${scheme}`, () => {
      for (const [name, hash] of ROUTES) {
        test(`${name} loads cold, fits the width and logs no error`, async () => {
          await preview.scheme(scheme);
          await preview.view(width, height, 2);
          await preview.open(hash);

          // Before the assertions, so a local failure leaves the frame behind.
          await Bun.write(
            `${shots}${name}-${viewport}-${scheme}.png`,
            await preview.screenshot(),
          );

          const expected = HEADINGS[name];
          if (!expected) throw new Error(`no expected heading for ${name}`);
          expect(await preview.heading()).toMatch(expected);
          expect(await preview.overflows()).toBe(false);
          expect(
            preview.logged().filter((line) => line.type === 'error'),
          ).toEqual([]);
        });
      }
    });
  }
}

describe('colour scheme', () => {
  /**
   * `defaultColorScheme="auto"`, so the page follows `prefers-color-scheme` with
   * nothing stored. A page painting the same under both would mean the dark palette
   * never applied, and that the 14 dark screenshots above are of a light site.
   */
  test('paints a dark background under prefers-color-scheme: dark', async () => {
    await preview.view(1440, 900, 1);

    await preview.scheme('light');
    await preview.open('/');
    const light = await preview.background();

    await preview.scheme('dark');
    await preview.open('/');
    const dark = await preview.background();

    expect(light).toBe('rgb(255, 255, 255)');
    expect(dark).not.toBe(light);
    // Dark, not merely different.
    const [red] = /\d+/.exec(dark) ?? [];
    expect(Number(red)).toBeLessThan(80);
  });
});
