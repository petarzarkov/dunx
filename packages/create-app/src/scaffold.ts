import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Glob } from 'bun';

/** The templates that ship with the package, as `templates/<name>/`. */
export const TEMPLATES = Object.freeze(['minimal'] as const);
export type TemplateName = (typeof TEMPLATES)[number];

/**
 * Every `@dunx/*` version in a template manifest is this placeholder. Versioning
 * is lockstep, so the right version to install is whatever version of
 * `@dunx/create-app` is doing the scaffolding - resolved at run time rather than
 * written into the template, which would go stale on the next release.
 */
export const VERSION_PLACEHOLDER = '__DUNX_VERSION__';

/** npm renames a published `.gitignore` to `.npmignore`, so it ships prefixed. */
const RENAMED = Object.freeze({ _gitignore: '.gitignore' });

export interface ScaffoldOptions {
  /** Directory to create. Relative paths resolve against `cwd`. */
  readonly target: string;
  /** Package name for the generated app. Defaults to the target's basename. */
  readonly name?: string;
  readonly template?: TemplateName;
  /** Write into a directory that already has files in it. */
  readonly force?: boolean;
  readonly cwd?: string;
  /** Overrides the version written into the generated manifest. */
  readonly version?: string;
}

export interface ScaffoldResult {
  readonly directory: string;
  readonly name: string;
  readonly template: TemplateName;
  readonly files: readonly string[];
}

export class ScaffoldError extends Error {
  override readonly name = 'ScaffoldError';
}

/**
 * `dist/index.js` and `dist/cli.js` both sit one level under the package root, so
 * `../templates` resolves the same from either. In the source tree it resolves
 * from `src/`, which is the same depth - so tests exercise the real path rather
 * than a special case.
 *
 * `fileURLToPath`, not `new URL(...).pathname`: the latter stays percent-encoded,
 * so an install under a directory with a space in it looks for `space%20test/`
 * and reports the template missing. On Windows it is worse - it yields a
 * leading-slash, drive-lettered path that resolves nowhere.
 */
const templatesRoot = (): string =>
  resolve(dirname(fileURLToPath(import.meta.url)), '..', 'templates');

/**
 * npm forbids uppercase and a leading dot or underscore, and a scope is legal.
 * Checked here because the failure would otherwise surface as a confusing
 * `bun install` error inside a directory the user just created.
 */
const isValidPackageName = (name: string): boolean =>
  /^(?:@[a-z0-9-*~][a-z0-9-*._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(name);

const readPackageVersion = async (): Promise<string> => {
  const file = Bun.file(join(templatesRoot(), '..', 'package.json'));
  const json = (await file.json()) as { version?: string };
  return json.version ?? '0.0.0';
};

export const scaffold = async (
  options: ScaffoldOptions,
): Promise<ScaffoldResult> => {
  const template = options.template ?? 'minimal';
  if (!TEMPLATES.includes(template)) {
    throw new ScaffoldError(
      `Unknown template "${template}". Available: ${TEMPLATES.join(', ')}.`,
    );
  }

  const directory = resolve(options.cwd ?? process.cwd(), options.target);
  const name = options.name ?? basename(directory);

  if (!isValidPackageName(name)) {
    throw new ScaffoldError(
      `"${name}" is not a usable package name. Pass --name to choose one.`,
    );
  }

  if (
    existsSync(directory) &&
    readdirSync(directory).length > 0 &&
    options.force !== true
  ) {
    throw new ScaffoldError(
      `${directory} is not empty. Pass --force to write into it anyway.`,
    );
  }

  const source = join(templatesRoot(), template);
  if (!existsSync(source)) {
    throw new ScaffoldError(
      `Template "${template}" is missing from ${source}.`,
    );
  }

  const version = options.version ?? `^${await readPackageVersion()}`;
  const written: string[] = [];

  // `**/*` with `dot: true` so a template can carry a dotfile that npm did not
  // rename; the explicit `_gitignore` mapping covers the one that it does.
  for await (const relative of new Glob('**/*').scan({
    cwd: source,
    dot: true,
    onlyFiles: true,
  })) {
    const base = relative.split('/').at(-1) ?? relative;
    const renamed = (RENAMED as Record<string, string | undefined>)[base];
    const target =
      renamed === undefined ? relative : join(dirname(relative), renamed);

    const contents = await Bun.file(join(source, relative)).text();
    // `Bun.write` creates parent directories, so there is no mkdir pass.
    await Bun.write(
      join(directory, target),
      contents
        .replaceAll(VERSION_PLACEHOLDER, version)
        .replaceAll('__DUNX_APP_NAME__', name),
    );
    written.push(target);
  }

  return { directory, name, template, files: written.sort() };
};
