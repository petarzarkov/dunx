import { join } from 'node:path';
import { EmailError } from './errors.js';

export interface TemplateEntry {
  /** Path relative to the directory, without its extension. Stable in a URL. */
  readonly name: string;
  readonly path: string;
}

const RENDERABLE = '**/*.{ts,tsx,js,jsx,mjs}';

/** Neither a template nor renderable: helpers, suites and shared styles. */
const skipped = (relative: string): boolean =>
  /(^|\/)[_.]/.test(relative) ||
  /\.(test|spec|fixture|d)\.[cm]?[jt]sx?$/.test(relative) ||
  /(^|\/)index\.[cm]?[jt]sx?$/.test(relative);

/**
 * Every renderable module under `dir`, sorted by name.
 *
 * `Bun.Glob` rather than a recursive `readdir`, and an ordinary `import()` to
 * load one: a template is a module Bun already knows how to execute, including
 * `.tsx`, so there is no bundler and no transform step here.
 */
export const discoverTemplates = async (
  dir: string,
): Promise<readonly TemplateEntry[]> => {
  const entries: TemplateEntry[] = [];
  try {
    for await (const relative of new Bun.Glob(RENDERABLE).scan({ cwd: dir })) {
      const posix = relative.replaceAll('\\', '/');
      if (skipped(posix)) continue;
      entries.push({
        name: posix.replace(/\.[cm]?[jt]sx?$/, ''),
        path: join(dir, relative),
      });
    }
  } catch (error) {
    // `scan` reports a missing cwd as a bare ENOENT on the first iteration, and
    // the directory is the one thing a caller of `dunx-email` gets wrong.
    if ((error as { code?: string }).code !== 'ENOENT') throw error;
    throw new EmailError(`No templates directory at ${dir}.`, { cause: error });
  }
  const sorted = entries.sort((a, b) => a.name.localeCompare(b.name));
  assertDistinct(sorted);
  return sorted;
};

/**
 * The extension is what a name drops, so `welcome.ts` beside `welcome.tsx` is
 * two files claiming one name. Refused rather than resolved by order: the
 * preview would render whichever came first and the export would write both to
 * `welcome.html`, last one winning, with nothing said either time.
 */
const assertDistinct = (entries: readonly TemplateEntry[]): void => {
  for (const [at, entry] of entries.entries()) {
    const next = entries[at + 1];
    if (next?.name !== entry.name) continue;
    throw new EmailError(
      `Two templates are both named "${entry.name}": ${entry.path} and ` +
        `${next.path}. Rename one, or move it out of the templates directory.`,
    );
  }
};

/**
 * A counter rather than `Date.now()`: two requests inside one millisecond
 * produce the same timestamp, so the second is served from the module cache and
 * the edit between them never appears.
 */
let reload = 0;

/**
 * The module's default export, which is the value handed to the renderer.
 *
 * `bust` appends a unique query so Bun re-executes the module rather than
 * serving it from the module cache, which is what makes an edit show up in the
 * preview without restarting the server.
 */
export const loadTemplate = async (
  path: string,
  bust = false,
): Promise<unknown> => {
  if (bust) reload += 1;
  const specifier = bust ? `${path}?reload=${String(reload)}` : path;
  const module = (await import(specifier)) as { default?: unknown };
  if (module.default === undefined) {
    throw new Error(`${path} has no default export to render.`);
  }
  return module.default;
};
