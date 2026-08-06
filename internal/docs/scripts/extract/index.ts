import { readFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { parseSync } from 'oxc-parser';
import type { Comment, Program } from './ast';
import type { DocSymbol, PackageDoc } from './model';
import { collectSymbols } from './symbols';
import {
  collectModuleExports,
  resolveSurface,
  type ModuleExports,
} from './surface';

export interface Manifest {
  readonly name: string;
  readonly description?: string;
  readonly exports?: Record<string, string | { import?: string }>;
}

interface ParsedModule {
  readonly source: string;
  readonly program: Program;
  readonly comments: readonly Comment[];
}

const parseFile = (file: string): ParsedModule => {
  const source = readFileSync(file, 'utf8');
  const parsed = parseSync(file, source, { sourceType: 'module' });
  if (parsed.errors.length > 0) {
    const detail = parsed.errors
      .slice(0, 2)
      .map((error) => error.message)
      .join('; ');
    throw new Error(`${file}: could not parse - ${detail}`);
  }
  return {
    source,
    program: parsed.program as unknown as Program,
    comments: parsed.comments as unknown as readonly Comment[],
  };
};

/** `./dist/db/index.js` -> `<pkg>/src/db/index.ts`, matching build-package.ts. */
const entryFile = (packageDir: string, distPath: string): string | null => {
  const rel = distPath.replace(/^\.\//, '');
  if (!rel.startsWith('dist/')) return null;
  return join(
    packageDir,
    'src',
    rel.slice('dist/'.length).replace(/\.js$/, '.ts'),
  );
};

export const sourceFiles = (srcDir: string): string[] =>
  [...new Bun.Glob('**/*.ts').scanSync({ cwd: srcDir, absolute: true })]
    .filter((file) => !/\.(test|spec)\.ts$/.test(file))
    .sort();

export interface ExtractOptions {
  readonly repoRoot: string;
  readonly packageDir: string;
  readonly manifest: Manifest;
  readonly readme: string;
  readonly render: (md: string) => string;
}

export const extractPackage = (options: ExtractOptions): PackageDoc => {
  const { repoRoot, packageDir, manifest } = options;
  const srcDir = join(packageDir, 'src');
  const files = sourceFiles(srcDir);

  const parsed = new Map<string, ParsedModule>();
  const moduleExports = new Map<string, ModuleExports>();
  const declared = new Map<string, readonly DocSymbol[]>();

  for (const file of files) {
    const module = parseFile(file);
    parsed.set(file, module);
    moduleExports.set(file, collectModuleExports(module.program));
    declared.set(
      file,
      collectSymbols(
        relative(repoRoot, file),
        module.source,
        module.program,
        module.comments,
        options.render,
      ).symbols,
    );
  }

  const subpaths: string[] = [];
  const exposure = new Map<string, Set<string>>();

  for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
    const distPath = typeof target === 'string' ? target : target.import;
    if (!distPath) continue;
    const entry = entryFile(packageDir, distPath);
    if (!entry || !parsed.has(entry)) continue;

    subpaths.push(subpath);
    for (const [alias, resolved] of resolveSurface(entry, moduleExports)) {
      const key = `${resolved.file}#${resolved.name}`;
      const found = exposure.get(key) ?? new Set<string>();
      // The alias matters: `export { Foo as Bar }` publishes Bar, not Foo.
      found.add(alias === resolved.name ? subpath : `${subpath} as ${alias}`);
      exposure.set(key, found);
    }
  }

  const symbols: DocSymbol[] = [];
  for (const [file, list] of declared) {
    for (const symbol of list) {
      const key = `${file}#${symbol.name}`;
      symbols.push({
        ...symbol,
        subpaths: [...(exposure.get(key) ?? [])].sort(),
      });
    }
  }

  symbols.sort(
    (a, b) =>
      Number(b.subpaths.length > 0) - Number(a.subpaths.length > 0) ||
      a.name.localeCompare(b.name),
  );

  return {
    name: manifest.name,
    // The leaf, not a path relative to one parent: published workspaces live
    // under `packages/` and `tools/`, and the site keys pages and `#/api/<dir>`
    // links on the bare name, so this stays stable across the move.
    dir: basename(packageDir),
    description: manifest.description ?? '',
    readme: options.readme,
    subpaths: subpaths.sort(),
    symbols,
  };
};
