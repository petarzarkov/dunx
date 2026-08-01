import { describe, expect, test } from 'bun:test';
import { join, resolve } from 'node:path';
import { parseSync } from 'oxc-parser';
import { renderDoc, rewriteHref, slugify } from './content';
import type { Comment, Program } from './extract/ast';
import { extractPackage, sourceFiles } from './extract/index';
import { createDocFinder, parseJsdoc } from './extract/jsdoc';
import { collectSymbols } from './extract/symbols';
import {
  collectModuleExports,
  resolveSpecifier,
  resolveSurface,
  type ModuleExports,
} from './extract/surface';

const REPO_ROOT = resolve(import.meta.dir, '../../..');

const parse = (source: string) => {
  const parsed = parseSync('input.ts', source, { sourceType: 'module' });
  return {
    program: parsed.program as unknown as Program,
    comments: parsed.comments as unknown as readonly Comment[],
  };
};

const plain = (md: string): string => md;

const extract = (source: string) => {
  const { program, comments } = parse(source);
  return collectSymbols('input.ts', source, program, comments, plain).symbols;
};

const byName = (source: string, name: string) => {
  const found = extract(source).find((symbol) => symbol.name === name);
  if (!found) throw new Error(`no symbol ${name} in\n${source}`);
  return found;
};

describe('parseJsdoc', () => {
  test('splits the summary from the tags', () => {
    const doc = parseJsdoc(
      '*\n * Does a thing.\n *\n * @param a - the a\n * @returns nothing\n ',
      plain,
    );
    expect(doc.summary).toBe('Does a thing.');
    expect(doc.tags).toEqual([
      { name: 'param', text: 'a - the a' },
      { name: 'returns', text: 'nothing' },
    ]);
  });

  test('a decorator inside a fenced example is not a tag', () => {
    const doc = parseJsdoc(
      '*\n * Example:\n *\n * ```ts\n * @Module({})\n * class X {}\n * ```\n ',
      plain,
    );
    expect(doc.tags).toHaveLength(0);
    expect(doc.summary).toContain('@Module({})');
  });

  test('multi-line tag bodies are kept together', () => {
    const doc = parseJsdoc('*\n * @remarks one\n * two\n ', plain);
    expect(doc.tags[0]).toEqual({ name: 'remarks', text: 'one\ntwo' });
  });
});

describe('createDocFinder', () => {
  test('attaches only an immediately preceding block comment', () => {
    const source =
      '/** near */\nconst a = 1;\n\n/** far */\nconst b = 2;\nconst c = 3;';
    const { comments } = parse(source);
    const find = createDocFinder(source, comments);

    expect(find(source.indexOf('const a'))?.value).toBe('* near ');
    expect(find(source.indexOf('const b'))?.value).toBe('* far ');
    expect(find(source.indexOf('const c'))).toBeUndefined();
  });

  test('a plain block comment is not a doc comment', () => {
    const source = '/* not a doc */\nconst a = 1;';
    const { comments } = parse(source);
    expect(
      createDocFinder(source, comments)(source.indexOf('const')),
    ).toBeUndefined();
  });
});

describe('collectSymbols', () => {
  test('only exported declarations are emitted', () => {
    const names = extract('class Hidden {}\nexport class Shown {}').map(
      (s) => s.name,
    );
    expect(names).toEqual(['Shown']);
  });

  test('a class keeps its doc, signature and public members', () => {
    const symbol = byName(
      `/** The service. */
export class Users extends Base implements Thing {
  /** count */
  readonly total: number = 0;
  private secret = 1;
  #hidden = 2;
  async find(id: string): Promise<void> {}
  static make(): Users { return new Users(); }
}`,
      'Users',
    );

    expect(symbol.kind).toBe('class');
    expect(symbol.signature).toBe('class Users extends Base implements Thing');
    expect(symbol.doc?.summary).toBe('The service.');
    expect(symbol.members.map((m) => m.name)).toEqual([
      'total',
      'find',
      'make',
    ]);
    expect(symbol.members[0]?.signature).toBe('readonly total: number');
    expect(symbol.members[1]?.signature).toBe(
      'async find(id: string): Promise<void>',
    );
    expect(symbol.members[2]?.isStatic).toBe(true);
  });

  test('an arrow-initialised const reads as a function, body excluded', () => {
    const symbol = byName(
      'export const add = (a: number, b: number): number => a + b;',
      'add',
    );
    expect(symbol.kind).toBe('function');
    expect(symbol.signature).toBe(
      'const add = (a: number, b: number): number =>',
    );
  });

  test('the frozen-object enum replacement keeps both halves', () => {
    const symbol = byName(
      `export const Level = Object.freeze({ A: 1 } as const);
export type Level = (typeof Level)[keyof typeof Level];`,
      'Level',
    );
    expect(symbol.kind).toBe('variable');
    expect(symbol.signature).toBe(
      'const Level = Object.freeze({ A: 1 } as const)\ntype Level = (typeof Level)[keyof typeof Level]',
    );
  });

  test('an interface reports its members', () => {
    const symbol = byName(
      'export interface Opts {\n  /** a doc */\n  a: string;\n  b?: number;\n}',
      'Opts',
    );
    expect(symbol.kind).toBe('interface');
    expect(symbol.signature).toBe('interface Opts');
    expect(symbol.members.map((m) => m.name)).toEqual(['a', 'b']);
    expect(symbol.members[0]?.doc?.summary).toBe('a doc');
    expect(symbol.members[1]?.optional).toBe(true);
  });

  test('an export list picks up a separately declared symbol, under its alias', () => {
    const symbol = byName(
      'class Impl {}\nexport { Impl as Public };',
      'Public',
    );
    expect(symbol.kind).toBe('class');
  });

  test('@deprecated is flagged', () => {
    expect(
      byName('/** @deprecated use b */\nexport const a = 1;', 'a').deprecated,
    ).toBe(true);
  });
});

describe('surface graph', () => {
  const modules = (
    entries: Record<string, string>,
  ): Map<string, ModuleExports> =>
    new Map(
      Object.entries(entries).map(([file, source]) => [
        file,
        collectModuleExports(parse(source).program),
      ]),
    );

  test('resolves a .js specifier to the .ts on disk', () => {
    const exists = (file: string): boolean => file === '/p/src/db/index.ts';
    expect(resolveSpecifier('/p/src/index.ts', './db/index.js', exists)).toBe(
      '/p/src/db/index.ts',
    );
    expect(resolveSpecifier('/p/src/index.ts', 'node:fs', exists)).toBeNull();
  });

  test('star and named re-exports both reach the declaring module', () => {
    const graph = modules({
      '/p/src/index.ts':
        "export * from './a.js';\nexport { b as B } from './b.js';",
      '/p/src/a.ts': 'export const a = 1;',
      '/p/src/b.ts': 'export const b = 2;',
    });

    const surface = resolveSurface('/p/src/index.ts', graph);
    expect(surface.get('a')).toEqual({ file: '/p/src/a.ts', name: 'a' });
    expect(surface.get('B')).toEqual({ file: '/p/src/b.ts', name: 'b' });
  });

  test('a circular re-export terminates', () => {
    const graph = modules({
      '/p/src/index.ts': "export * from './a.js';\nexport const root = 1;",
      '/p/src/a.ts': "export * from './index.js';\nexport const a = 1;",
    });

    const surface = resolveSurface('/p/src/index.ts', graph);
    expect([...surface.keys()].sort()).toEqual(['a', 'root']);
  });
});

describe('markdown content', () => {
  test('headings get stable, deduplicated ids', () => {
    const { html, headings } = renderDoc('## One\n\n### Two\n\n## One\n', {
      guides: new Map(),
      packages: new Map(),
    });
    expect(html).toContain('<h2 id="one">');
    expect(html).toContain('<h2 id="one-1">');
    expect(headings.map((h) => h.id)).toEqual(['one', 'two', 'one-1']);
  });

  test('links resolve to in-site routes, or back to GitHub', () => {
    const targets = {
      guides: new Map([['ARCHITECTURE.md', '#/guide/architecture']]),
      packages: new Map([['core', '#/api/core']]),
    };
    expect(rewriteHref('./ARCHITECTURE.md', targets)).toBe(
      '#/guide/architecture',
    );
    expect(rewriteHref('../docs/ARCHITECTURE.md', targets)).toBe(
      '#/guide/architecture',
    );
    expect(rewriteHref('./packages/core', targets)).toBe('#/api/core');
    expect(rewriteHref('./CLAUDE.md', targets)).toBe(
      'https://github.com/petarzarkov/dunx/blob/main/CLAUDE.md',
    );
    expect(rewriteHref('https://bun.sh', targets)).toBe('https://bun.sh');
    expect(rewriteHref('#anchor', targets)).toBe('#anchor');
  });

  test('slugify strips backticks and punctuation', () => {
    expect(slugify('`Bun.serve()` adapter')).toBe('bun-serve-adapter');
  });
});

describe('extractPackage over @dunx/core', () => {
  const packageDir = join(REPO_ROOT, 'packages', 'core');
  const doc = extractPackage({
    repoRoot: REPO_ROOT,
    packageDir,
    manifest: {
      name: '@dunx/core',
      description: 'core',
      exports: { '.': { import: './dist/index.js' } },
    },
    readme: '',
    render: plain,
  });

  test('test files are not part of the surface', () => {
    expect(
      sourceFiles(join(packageDir, 'src')).some((f) => f.includes('.test.')),
    ).toBe(false);
  });

  test('the documented public surface matches the real entrypoint', () => {
    const publicNames = doc.symbols
      .filter((symbol) => symbol.subpaths.includes('.'))
      .map((symbol) => symbol.name);

    expect(publicNames).toContain('AppFactory');
    expect(publicNames).toContain('Module');
    expect(publicNames).toContain('inject');
    expect(publicNames).toContain('Logger');
  });

  test('symbols carry a repo-relative file and a real line number', () => {
    const factory = doc.symbols.find((symbol) => symbol.name === 'AppFactory');
    expect(factory?.file.startsWith('packages/core/src/')).toBe(true);
    expect(factory?.line).toBeGreaterThan(0);
    expect(factory?.kind).toBe('class');
  });

  test('a module-private symbol is reported with no subpath', () => {
    expect(doc.symbols.some((symbol) => symbol.subpaths.length === 0)).toBe(
      true,
    );
  });
});
