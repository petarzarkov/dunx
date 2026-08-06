import { dirname, resolve } from 'node:path';
import {
  isExportAll,
  isExportNamed,
  isVariableDeclaration,
  nameOf,
  type Node,
  type Program,
} from './ast';

export interface ReExport {
  readonly specifier: string;
  /** Exported name -> the name it has in the source module. */
  readonly names: ReadonlyMap<string, string>;
  /** `export * from` re-exports everything the source module exports. */
  readonly all: boolean;
}

export interface ModuleExports {
  /** Declared here: exported name -> local name. */
  readonly local: ReadonlyMap<string, string>;
  readonly reExports: readonly ReExport[];
}

export interface ResolvedExport {
  readonly file: string;
  readonly name: string;
}

export const collectModuleExports = (program: Program): ModuleExports => {
  const local = new Map<string, string>();
  const reExports: ReExport[] = [];

  for (const statement of program.body) {
    if (isExportAll(statement)) {
      const specifier = statement.source.value;
      if (typeof specifier !== 'string') continue;
      const exported = nameOf(statement.exported);
      reExports.push(
        exported
          ? { specifier, names: new Map([[exported, '*']]), all: false }
          : { specifier, names: new Map(), all: true },
      );
      continue;
    }

    if (!isExportNamed(statement)) continue;

    if (statement.declaration) {
      const declaration = statement.declaration;
      if (isVariableDeclaration(declaration)) {
        for (const declarator of declaration.declarations) {
          const name = nameOf(declarator.id);
          if (name) local.set(name, name);
        }
      } else {
        const name = nameOf((declaration as { id?: Node | null }).id);
        if (name) local.set(name, name);
      }
      continue;
    }

    const names = new Map<string, string>();
    for (const specifier of statement.specifiers) {
      const source = nameOf(specifier.local);
      const alias = nameOf(specifier.exported);
      if (source && alias) names.set(alias, source);
    }

    const from = statement.source?.value;
    if (typeof from === 'string') {
      reExports.push({ specifier: from, names, all: false });
    } else {
      for (const [alias, source] of names) local.set(alias, source);
    }
  }

  return { local, reExports };
};

/**
 * `./foo.js` as written in source maps to `src/foo.ts` on disk - relative
 * imports carry a `.js` extension throughout this repo because `tsc` copies
 * the specifier verbatim into the emitted declarations.
 */
export const resolveSpecifier = (
  from: string,
  specifier: string,
  exists: (file: string) => boolean,
): string | null => {
  if (!specifier.startsWith('.')) return null;

  const base = resolve(dirname(from), specifier);
  const candidates = [
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.js$/, '.tsx'),
    `${base}.ts`,
    resolve(base, 'index.ts'),
  ];

  return candidates.find(exists) ?? null;
};

/**
 * The public surface of one entrypoint: every name it exports, mapped back to
 * the module that declares it. Following the graph is what lets a symbol know
 * which subpath a consumer reaches it through.
 */
export const resolveSurface = (
  entry: string,
  modules: ReadonlyMap<string, ModuleExports>,
): Map<string, ResolvedExport> => {
  const memo = new Map<string, Map<string, ResolvedExport>>();
  const active = new Set<string>();
  const exists = (file: string): boolean => modules.has(file);

  const walk = (file: string): Map<string, ResolvedExport> => {
    const cached = memo.get(file);
    if (cached) return cached;
    // A circular re-export contributes nothing new on the second entry; the
    // outer frame already has, or will have, the names.
    if (active.has(file)) return new Map();
    active.add(file);

    const result = new Map<string, ResolvedExport>();
    const module = modules.get(file);
    if (!module) {
      active.delete(file);
      return result;
    }

    for (const [alias, local] of module.local) {
      result.set(alias, { file, name: local });
    }

    for (const reExport of module.reExports) {
      const target = resolveSpecifier(file, reExport.specifier, exists);
      if (!target) continue;
      const inner = walk(target);

      if (reExport.all) {
        for (const [alias, resolved] of inner) {
          if (!result.has(alias)) result.set(alias, resolved);
        }
        continue;
      }

      for (const [alias, source] of reExport.names) {
        const resolved = inner.get(source);
        if (resolved) result.set(alias, resolved);
      }
    }

    active.delete(file);
    memo.set(file, result);
    return result;
  };

  return walk(entry);
};
