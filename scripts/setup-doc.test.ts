import { describe, expect, it } from 'bun:test';
import { Glob } from 'bun';
import { join } from 'node:path';

/**
 * `docs/setup.md` is fetched by an agent and followed literally, so every file it
 * quotes has to be the file `bunx @dunx/create-app` writes.
 *
 * The parity is checked rather than avoided, the way `features.test.ts` checks the
 * vendored feature folders against `examples/full`: a condensed page for a machine
 * is worth having, and a copy nothing compares is what goes stale.
 */
const SETUP = 'docs/setup.md';
const TEMPLATE = 'tools/create-app/templates/minimal';

/** Quoted path in the page -> the template file it must equal. */
const QUOTED: Readonly<Record<string, string>> = Object.freeze({
  'bunfig.toml': '_bunfig.toml',
  'tsconfig.json': 'tsconfig.json',
  'src/greetings.service.ts': 'src/greetings.service.ts',
  'src/greetings.controller.ts': 'src/greetings.controller.ts',
  'src/app.module.ts': 'src/app.module.ts',
  'src/main.ts': 'src/main.ts',
});

const page = await Bun.file(SETUP).text();

/** Every fenced block, with the last non-empty line before it as its label. */
const blocks = (): { label: string; body: string }[] => {
  const found: { label: string; body: string }[] = [];
  const lines = page.split('\n');
  let label = '';
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at] ?? '';
    if (!line.startsWith('```')) {
      if (line.trim() !== '') label = line;
      continue;
    }
    const body: string[] = [];
    for (
      at++;
      at < lines.length && !(lines[at] ?? '').startsWith('```');
      at++
    ) {
      body.push(lines[at] ?? '');
    }
    found.push({ label, body: `${body.join('\n')}\n` });
  }
  return found;
};

describe('docs/setup.md', () => {
  it('quotes the minimal template byte for byte', async () => {
    const found = blocks();

    for (const [quoted, template] of Object.entries(QUOTED)) {
      const block = found.find(({ label }) => label.includes(`\`${quoted}\``));
      expect(block, `no fenced block labelled \`${quoted}\``).toBeDefined();
      expect(block?.body, `${quoted} has drifted from ${template}`).toBe(
        await Bun.file(join(TEMPLATE, template)).text(),
      );
    }
  });

  it('names only packages and subpaths that exist', async () => {
    const exports = new Map<string, readonly string[]>();
    for await (const entry of new Glob('{packages,tools}/*/package.json').scan(
      '.',
    )) {
      const manifest = (await Bun.file(entry).json()) as {
        name?: string;
        exports?: Record<string, unknown>;
      };
      if (manifest.name === undefined) continue;
      exports.set(manifest.name, Object.keys(manifest.exports ?? { '.': {} }));
    }

    const named = new Set(
      [...page.matchAll(/@dunx\/[a-z][a-z-]*(?:\/[a-z][a-z-]*)?/g)].map(
        (match) => match[0],
      ),
    );
    expect(named.size).toBeGreaterThan(8);

    for (const name of named) {
      const parts = name.split('/');
      const pkg = `${parts[0]}/${parts[1]}`;
      const subpath = parts[2] === undefined ? '.' : `./${parts[2]}`;
      expect(exports.get(pkg), `${pkg} is not a workspace`).toBeDefined();
      expect(exports.get(pkg), `${pkg} has no ${subpath} export`).toContain(
        subpath,
      );
    }
  });

  it('tells the reader to run bun, and nothing else', () => {
    const commands = blocks()
      .filter(({ label }) => !label.includes('`'))
      .map(({ body }) => body)
      .join('\n');

    expect(commands).not.toMatch(/\b(?:npm|npx|yarn|pnpm)\b/);
    expect(page).toContain('bunx @dunx/create-app');
  });
});
