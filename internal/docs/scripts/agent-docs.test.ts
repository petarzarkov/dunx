import { describe, expect, test } from 'bun:test';
import { join, resolve } from 'node:path';
import type { SiteIndex } from './extract/model';

/**
 * The two files an agent fetches. Both are build output, written by
 * `scripts/generate.ts` into `public/` for Vite to copy to the site root, so this
 * asserts the artifacts rather than the generator.
 */
const TOOL_ROOT = resolve(import.meta.dir, '..');
const REPO_ROOT = resolve(TOOL_ROOT, '../..');
const PUBLIC_DIR = join(TOOL_ROOT, 'public');

// Read rather than imported: the docs tsconfig has no `resolveJsonModule`, and the
// `?raw` form `src/data.ts` uses is Vite's.
const index = (await Bun.file(
  join(TOOL_ROOT, 'src', 'generated', 'index.json'),
).json()) as SiteIndex;

describe('the agent-facing assets', () => {
  test('setup.md is served verbatim from docs/', async () => {
    const served = Bun.file(join(PUBLIC_DIR, 'setup.md'));

    expect(await served.exists()).toBe(true);
    expect(await served.text()).toBe(
      await Bun.file(join(REPO_ROOT, 'docs', 'setup.md')).text(),
    );
  });

  test('llms.txt lists every guide the site publishes', async () => {
    const llms = await Bun.file(join(PUBLIC_DIR, 'llms.txt')).text();

    expect(llms.startsWith('# dunx\n')).toBe(true);
    expect(llms).toContain('https://petarzarkov.github.io/dunx/setup.md');

    for (const guide of index.guides) {
      expect(llms, `${guide.slug} is missing from llms.txt`).toContain(
        `/main/${guide.source}`,
      );
    }
  });

  test('every link in it is absolute, a .txt having no base', async () => {
    const llms = await Bun.file(join(PUBLIC_DIR, 'llms.txt')).text();

    for (const [, href] of llms.matchAll(/\]\(([^)]+)\)/g)) {
      expect(href, `${href} is not fetchable on its own`).toMatch(
        /^https:\/\//,
      );
    }
  });
});
