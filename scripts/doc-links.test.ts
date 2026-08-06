import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Every relative link between tracked Markdown files points at a file that exists.
 *
 * Written after splitting `docs/ARCHITECTURE.md` into `docs/architecture/*.md`
 * silently broke six of them: the content moved one directory deeper, so every
 * `./` and `../` in it shifted by one, and nothing complained. A reader found the
 * first one.
 *
 * Only relative targets are checked. An `http(s)` link is somebody else's uptime,
 * and a bare `#anchor` inside one document is checked on the site side, by
 * `internal/docs/src/links.test.tsx`, which knows what headings actually rendered.
 */
const tracked = (): readonly string[] =>
  [...new Bun.Glob('**/*.md').scanSync({ cwd: process.cwd() })]
    .filter(
      (file) =>
        !file.includes('node_modules/') &&
        !file.includes('/dist/') &&
        !file.startsWith('.claude/worktrees/'),
    )
    .sort();

/** `[text](./path.md)` and `[text](../path.md#anchor)`, target only. */
const LINK = /\]\(([^)#\s]+\.md)(?:#[^)\s]*)?\)/g;

/**
 * Fenced blocks and inline code spans removed, so an example of a link is not
 * read as one. This file's own roadmap entry quotes
 * `[x](./04-modules.md#section)` as an illustration, which the first version of
 * this check reported as broken.
 */
const prose = (markdown: string): string =>
  markdown.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');

describe('markdown links', () => {
  it('resolve to files that exist', async () => {
    const broken: string[] = [];

    for (const file of tracked()) {
      const text = await Bun.file(file).text();
      for (const match of prose(text).matchAll(LINK)) {
        const target = match[1];
        if (target === undefined) continue;
        if (/^(?:[a-z]+:|\/\/)/i.test(target)) continue;

        if (!existsSync(resolve(dirname(file), target))) {
          broken.push(`${file} -> ${target}`);
        }
      }
    }

    expect(broken).toEqual([]);
  });

  /*
   * A link into the architecture record has to name the page that holds the
   * section, not the index. The index is a table of contents, so a reader sent
   * there for "Versioning is lockstep" arrives nowhere near it.
   *
   * Matched per line, and on the link target rather than anywhere the string
   * appears: a whole-file regex with `[^)]*` in it spans newlines and reported
   * two files that were fine.
   */
  it('do not send a reader to the index while naming a section', async () => {
    const vague: string[] = [];

    for (const file of tracked()) {
      const text = await Bun.file(file).text();
      prose(text)
        .split('\n')
        .forEach((line, index) => {
          if (/\]\([^)]*ARCHITECTURE\.md\)[,.]?\s*["'“]/.test(line)) {
            vague.push(`${file}:${index + 1}`);
          }
        });
    }

    expect(vague).toEqual([]);
  });
});
