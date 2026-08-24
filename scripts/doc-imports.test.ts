import { Glob } from 'bun';
import { describe, expect, it } from 'bun:test';

/**
 * Every `@dunx/*` name a documentation code block imports is a name that package
 * really exports.
 *
 * `doc-links.test.ts` catches a link to a file that moved. This catches the other
 * half: a guide that still imports a symbol after it was renamed. Prose cannot fail
 * a test for being wrong, but its import lines can, and those are what a reader
 * copies first.
 *
 * Names only, not types or arity. A guide that calls a real export with the wrong
 * arguments is what `examples/full` is for, under Rule 4.
 */
const exportedNames = async (): Promise<Map<string, Set<string>>> => {
  const byPackage = new Map<string, Set<string>>();

  for await (const entry of new Glob('{packages,tools}/*/package.json').scan(
    '.',
  )) {
    const dir = entry.slice(0, -'/package.json'.length);
    const manifest = (await Bun.file(entry).json()) as { name?: string };
    if (manifest.name === undefined) continue;

    const names = new Set<string>();
    for await (const src of new Glob(`${dir}/src/**/*.ts`).scan('.')) {
      if (src.includes('.test.') || src.includes('.fixture.')) continue;
      const text = await Bun.file(src).text();
      for (const match of text.matchAll(
        /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:const|let|class|function|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm,
      )) {
        names.add(match[1] ?? '');
      }
      // Re-exports, which is how the barrels are written.
      for (const match of text.matchAll(
        /^\s*(?:type\s+)?([A-Za-z_$][\w$]*),?$/gm,
      )) {
        names.add(match[1] ?? '');
      }
    }
    byPackage.set(manifest.name, names);
  }

  return byPackage;
};

const imported = async (): Promise<
  { file: string; name: string; from: string }[]
> => {
  const found: { file: string; name: string; from: string }[] = [];

  for await (const doc of new Glob('docs/**/*.md').scan('.')) {
    const text = await Bun.file(doc).text();
    for (const block of text.matchAll(
      /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+'(@dunx\/[\w/-]+)'/g,
    )) {
      for (const raw of (block[1] ?? '').split(',')) {
        const name = raw
          .trim()
          .replace(/^type\s+/, '')
          .split(/\s+as\s+/)[0]
          ?.trim();
        if (name) found.push({ file: doc, name, from: block[2] ?? '' });
      }
    }
  }

  return found;
};

describe('every @dunx import in docs/', () => {
  it('names something the package exports', async () => {
    const byPackage = await exportedNames();
    const uses = await imported();

    // Guards the guard: a regex that stopped matching would pass vacuously.
    expect(uses.length).toBeGreaterThan(100);

    const unknown = uses
      .filter((use) => {
        const pkg = use.from.split('/').slice(0, 2).join('/');
        const names = byPackage.get(pkg);
        return names !== undefined && !names.has(use.name);
      })
      .map((use) => `${use.file}: ${use.name} from ${use.from}`);

    expect(unknown).toEqual([]);
  });
});
