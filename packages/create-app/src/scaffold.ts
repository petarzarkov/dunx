import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Glob } from 'bun';
import { resolveFeatures, type Feature } from './features.js';
import {
  appModule,
  bootstrap,
  config,
  configGroupsFor,
  envExample,
  main,
  manifest,
  readme,
  worker,
} from './generate.js';

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

/**
 * Names a package cannot ship as-is, so they ship prefixed and are renamed on write.
 *
 * `.gitignore` is the known one: npm renames a published copy to `.npmignore`.
 *
 * **`bunfig.toml` is the one that was silently missing.** It is stripped from the
 * tarball entirely - presumably so a dependency cannot hijack the installing
 * project's Bun config - and it is the single file dunx asks an app to have. Every
 * app scaffolded from a published `@dunx/create-app` therefore had no
 * `@dunx/transform/preload`, and failed at boot with the very error the guide
 * describes. Measured with `bun pm pack`, and `pack.test.ts` now measures it on
 * every run rather than trusting this comment.
 */
const RENAMED = Object.freeze({
  _gitignore: '.gitignore',
  '_bunfig.toml': 'bunfig.toml',
});

/**
 * Entries that do not make a directory non-empty for scaffolding purposes.
 *
 * `.git` is the one that matters: `git init` then scaffold into the repo is the
 * documented way to start, and refusing it blocks the flow outright. `.gitkeep`
 * exists only so git can track an otherwise empty directory, so it *means* empty.
 * `.DS_Store` appears from merely opening the folder in Finder. `LICENSE` is what
 * GitHub's create-a-repository flow leaves in a fresh clone.
 *
 * The list is deliberately short, and the test for it is whether the template
 * writes that name. It does not write any of these four, so ignoring them can
 * never destroy anything. `.gitignore` and `README.md` are excluded for exactly
 * that reason: the template writes both, and silently overwriting a user's copy
 * is what `--force` exists to gate.
 */
const IGNORED_WHEN_EMPTY: ReadonlySet<string> = new Set([
  '.DS_Store',
  '.git',
  '.gitkeep',
  'LICENSE',
]);

export interface ScaffoldOptions {
  /** Directory to create. Relative paths resolve against `cwd`. */
  readonly target: string;
  /** Package name for the generated app. Defaults to the target's basename. */
  readonly name?: string;
  readonly template?: TemplateName;
  /**
   * Features to compose the app from, by name. Anything they require is pulled in.
   *
   * Passing any switches from copying a fixed template to generating the wiring
   * around the chosen feature directories - see `generate.ts`. An empty list, or
   * none at all, scaffolds `template` unchanged, so the default behaviour is exactly
   * what it was.
   */
  readonly features?: readonly string[];
  /** Write into a directory that already has files in it. */
  readonly force?: boolean;
  readonly cwd?: string;
  /** Overrides the version written into the generated manifest. */
  readonly version?: string;
}

export interface ScaffoldResult {
  readonly directory: string;
  readonly name: string;
  readonly template: TemplateName | 'composed';
  /** Resolved feature names, in import order. Empty for a fixed template. */
  readonly features: readonly string[];
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

/** Placeholders are substituted in every written file, generated or copied. */
const fill = (contents: string, name: string, version: string): string =>
  contents
    .replaceAll(VERSION_PLACEHOLDER, version)
    .replaceAll('__DUNX_APP_NAME__', name);

/**
 * The four files a subset of features cannot copy, because the full example states
 * every feature at once in each of them.
 */
const generated = (
  name: string,
  features: readonly Feature[],
): Readonly<Record<string, string>> => {
  const groups = configGroupsFor(features);
  const files: Record<string, string> = {
    'package.json': manifest(features),
    'README.md': readme(name, features),
    '.env.example': envExample(groups),
    'src/main.ts': main(name, features),
    'src/bootstrap.ts': bootstrap(name, features),
    'src/app.module.ts': appModule(name, features),
    'src/config.ts': config(name, groups),
  };
  if (features.some((feature) => feature.name === 'jobs')) {
    files['src/worker.ts'] = worker(name);
  }
  return files;
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

  // Resolved before anything is written, so an unknown feature name fails with the
  // list of real ones rather than half a directory.
  const requested = options.features ?? [];
  let features: readonly Feature[] = [];
  try {
    features = resolveFeatures(requested);
  } catch (error) {
    throw new ScaffoldError(
      error instanceof Error ? error.message : String(error),
    );
  }
  const composing = features.length > 0;

  const directory = resolve(options.cwd ?? process.cwd(), options.target);
  const name = options.name ?? basename(directory);

  if (!isValidPackageName(name)) {
    throw new ScaffoldError(
      `"${name}" is not a usable package name. Pass --name to choose one.`,
    );
  }

  if (existsSync(directory) && options.force !== true) {
    const blocking = readdirSync(directory).filter(
      (entry) => !IGNORED_WHEN_EMPTY.has(entry),
    );
    if (blocking.length > 0) {
      // Naming what blocked it, because `.git` used to block it and the message
      // gave no way to tell that from a directory of real work.
      const shown = blocking.sort().slice(0, 3).join(', ');
      const rest = blocking.length > 3 ? `, +${blocking.length - 3} more` : '';
      throw new ScaffoldError(
        `${directory} is not empty (${shown}${rest}). ` +
          `Pass --force to write into it anyway.`,
      );
    }
  }

  const version = options.version ?? `^${await readPackageVersion()}`;
  const written: string[] = [];

  /** Copies a directory of the package's own templates into the new app. */
  const copyTree = async (from: string, into: string): Promise<void> => {
    // `**/*` with `dot: true` so a template can carry a dotfile that npm did not
    // rename; the explicit `_gitignore` mapping covers the one that it does.
    for await (const relative of new Glob('**/*').scan({
      cwd: from,
      dot: true,
      onlyFiles: true,
    })) {
      const base = relative.split('/').at(-1) ?? relative;
      const renamed = (RENAMED as Record<string, string | undefined>)[base];
      const target = join(
        into,
        renamed === undefined ? relative : join(dirname(relative), renamed),
      );

      const contents = await Bun.file(join(from, relative)).text();
      // `Bun.write` creates parent directories, so there is no mkdir pass.
      await Bun.write(join(directory, target), fill(contents, name, version));
      written.push(target);
    }
  };

  if (!composing) {
    const source = join(templatesRoot(), template);
    if (!existsSync(source)) {
      throw new ScaffoldError(
        `Template "${template}" is missing from ${source}.`,
      );
    }
    await copyTree(source, '.');
    return {
      directory,
      name,
      template,
      features: [],
      files: written.sort(),
    };
  }

  // The base carries what every composed app needs and no feature owns: the
  // tsconfig, the transform preload, and the gitignore.
  const base = join(templatesRoot(), 'base');
  if (!existsSync(base)) {
    throw new ScaffoldError(
      `The base template is missing from ${base}. Run \`bun run sync:templates\`.`,
    );
  }
  await copyTree(base, '.');

  for (const feature of features) {
    const from = join(templatesRoot(), 'features', feature.source);
    if (!existsSync(from)) {
      throw new ScaffoldError(
        `Feature "${feature.name}" is missing from ${from}. ` +
          'Run `bun run sync:templates`.',
      );
    }
    await copyTree(from, join('src', feature.source));
  }

  for (const [target, contents] of Object.entries(generated(name, features))) {
    await Bun.write(join(directory, target), fill(contents, name, version));
    written.push(target);
  }

  return {
    directory,
    name,
    template: 'composed',
    features: features.map((feature) => feature.name),
    files: written.sort(),
  };
};
