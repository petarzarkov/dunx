import { join } from 'node:path';

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
  for await (const relative of new Bun.Glob(RENDERABLE).scan({ cwd: dir })) {
    const posix = relative.replaceAll('\\', '/');
    if (skipped(posix)) continue;
    entries.push({
      name: posix.replace(/\.[cm]?[jt]sx?$/, ''),
      path: join(dir, relative),
    });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
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
