import { describe, expect, it } from 'bun:test';

/**
 * The published pages are written for someone evaluating or using dunx. This
 * asserts they do not reach back into the repository the way a maintainer's note
 * does.
 *
 * It reads the **generated** bodies rather than the markdown sources, so it needs
 * no second copy of the publish list in `scripts/generate.ts`: whatever the site
 * actually ships is what gets checked. A page that stops being published stops
 * being checked, which is the correct direction.
 */
const GENERATED = new URL('./generated/guides/', import.meta.url).pathname;

const FORBIDDEN: readonly (readonly [string, RegExp])[] = [
  // Private workspaces. A reader cannot open these, and a page that cites one is
  // explaining the repository rather than the framework.
  ['private workspace', /internal\/(?:bench|docs|ui|openapi-ui|dashboard-ui)/g],
  // Planning records, and this repository's own agent instructions. A published
  // page may name the `AGENTS.md` and `CLAUDE.md` that `bunx @dunx/create-app`
  // writes into a reader's app: those are the reader's files, and the name is the
  // useful part. What stays banned is a link to dunx's own, which `rewriteHref`
  // turns into a `blob/main/` URL.
  [
    'planning record',
    /docs\/roadmap|docs\/ROADMAP\.md|blob\/main\/CLAUDE\.md/g,
  ],
  // Source layout. `@dunx/http`'s lifecycle suite is the reader-facing spelling
  // of `packages/http/src/server/lifecycle.test.ts`.
  ['source path', /packages\/[a-z-]+\/src\//g],
  // Repo scripts and the commands that drive them.
  ['repo script', /scripts\/[a-z-]+\.(?:ts|js)/g],
  // Addressed at whoever maintains this, not at whoever reads it.
  [
    'maintainer aside',
    /the repo owner|this repo(?:sitory)? (?:publishes|has)/g,
  ],
];

describe('published pages', () => {
  it('do not reference repository internals', async () => {
    const files = [
      ...new Bun.Glob('*.json').scanSync({ cwd: GENERATED }),
    ].sort();
    expect(files.length).toBeGreaterThan(0);

    const offences: string[] = [];
    for (const file of files) {
      const body = await Bun.file(`${GENERATED}${file}`).text();
      for (const [label, pattern] of FORBIDDEN) {
        for (const hit of new Set(body.match(pattern) ?? [])) {
          offences.push(`${file} -> ${label}: "${hit}"`);
        }
      }
    }

    expect(offences).toEqual([]);
  });
});
