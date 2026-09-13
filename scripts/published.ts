import { Glob } from 'bun';
import { PUBLISHED_DIRS, ROOT } from './workspace-ranges.js';

export interface PublishedWorkspace {
  readonly name: string;
  /** Absolute path to the workspace root, no trailing slash. */
  readonly dir: string;
  readonly json: Record<string, unknown>;
}

/**
 * Every manifest under `packages/` and `tools/` that is not `private: true`.
 *
 * `manifests.test.ts`, `rule-native.test.ts` and `rule-example.test.ts` all need
 * the same list, and scanning only `packages/` was already a real bug once: the
 * two workspaces most likely to carry a `bin` had moved to `tools/` and stopped
 * being checked for one.
 */
export const publishedWorkspaces = async (): Promise<PublishedWorkspace[]> => {
  const found: PublishedWorkspace[] = [];
  for (const parent of PUBLISHED_DIRS) {
    const base = `${ROOT}${parent}`;
    for await (const rel of new Glob('*/package.json').scan({ cwd: base })) {
      const json = (await Bun.file(`${base}/${rel}`).json()) as Record<
        string,
        unknown
      >;
      if (json['private'] === true) continue;
      found.push({
        name: String(json['name']),
        dir: `${base}/${rel.slice(0, -'/package.json'.length)}`,
        json,
      });
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
};

/** The `exports` subpaths of a manifest, as the specifiers a consumer writes. */
export const subpathsOf = (ws: PublishedWorkspace): string[] => {
  const exports = ws.json['exports'];
  if (typeof exports !== 'object' || exports === null) return [];
  return Object.keys(exports as Record<string, unknown>)
    .filter((key) => key.startsWith('.'))
    .map((key) => (key === '.' ? ws.name : `${ws.name}${key.slice(1)}`));
};

/** Every `.ts` file under a workspace's `src/`, excluding tests and fixtures. */
export const sourcesOf = async (ws: PublishedWorkspace): Promise<string[]> => {
  const files: string[] = [];
  for await (const rel of new Glob('**/*.ts').scan({ cwd: `${ws.dir}/src` })) {
    if (rel.includes('.test.') || rel.includes('.fixture.')) continue;
    files.push(`${ws.dir}/src/${rel}`);
  }
  return files.sort();
};

/** Every bare module specifier a source file imports, in any of the three forms. */
export const specifiersIn = (source: string): string[] => {
  const found = new Set<string>();
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const spec = match[1];
      if (spec && !spec.startsWith('.') && !spec.startsWith('bun:')) {
        found.add(spec);
      }
    }
  }
  return [...found];
};
