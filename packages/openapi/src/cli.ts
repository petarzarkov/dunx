#!/usr/bin/env bun
import { findRootModule, type ModuleRef } from '@dunx/core';
import type { VersioningOptions } from '@dunx/http';
import { RouteVersioning } from '@dunx/http/internal';
import { describeRoutes } from './discover.js';
import type { DocumentInfo } from './generate.js';
import { generateDocuments } from './versions.js';

/**
 * Writes the OpenAPI document to a file, with no container, no server and no
 * database: `describeRoutes` reads metadata off prototypes, so nothing is
 * constructed and no port is bound.
 *
 * ```
 * bunx dunx-openapi ./src/app.module.ts
 * bunx dunx-openapi ./src/openapi.config.ts --out public/openapi.json
 * ```
 *
 * The entry may export, in order of preference: `openapi`, the only form
 * supporting `contribute`; `default` or `root`, a `ModuleRef`; or any single
 * `@Module` export. `--export=<name>` settles a file declaring several.
 */
interface OpenApiEntry extends Omit<DocumentInfo, 'title' | 'version'> {
  readonly root: ModuleRef;
  readonly title?: string;
  readonly version?: string;
  /** The app's `HttpOptions.versioning`, when it sets a prefix or a default. */
  readonly versioning?: VersioningOptions;
  /**
   * Under header or media-type versioning, which version's document to write.
   * Absent writes the one `/openapi.json` serves without `?version=`.
   */
  readonly apiVersion?: string;
}

interface Exported extends Record<string, unknown> {
  readonly openapi?:
    | OpenApiEntry
    | (() => OpenApiEntry | Promise<OpenApiEntry>);
}

const usage = `Usage: bunx dunx-openapi <entry> [--out openapi.json]

  <entry>          A module exporting \`openapi\`, or one declaring your root
                   module - it is found by its @Module marker, so a plain
                   \`export class AppModule {}\` is enough.
  --export=<name>  Which export to use, when the entry declares several modules.
  --out            Where to write. Default openapi.json.
  --stdout         Write the document to stdout instead of a file.`;

const flag = (argv: readonly string[], name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? undefined : argv[at + 1];
};

/**
 * `Bun.resolveSync` is the runtime's own resolver, so every specifier `import`
 * accepts works. It follows Node resolution, so a bare relative path throws -
 * `src/app.module.ts` reads as a package named `src` - and is retried as
 * explicitly relative. As-is first, so a real package wins over a directory.
 *
 * Duplicated in `@dunx/mcp`'s CLI rather than shared: what belongs in core is the
 * contract for finding a root module, and a path resolver is not one.
 */
const locate = (entry: string): string | undefined => {
  for (const specifier of [entry, `./${entry}`]) {
    try {
      return Bun.resolveSync(specifier, process.cwd());
    } catch {
      continue;
    }
  }
  return undefined;
};

const packageInfo = async (): Promise<{ title: string; version: string }> => {
  const file = Bun.file(`${process.cwd()}/package.json`);
  if (!(await file.exists())) return { title: 'API', version: '0.0.0' };
  const json = (await file.json()) as { name?: string; version?: string };
  return { title: json.name ?? 'API', version: json.version ?? '0.0.0' };
};

type Resolved =
  | { readonly entry: OpenApiEntry }
  | { readonly ambiguous: readonly string[] }
  | undefined;

const resolveEntry = async (
  loaded: Exported,
  named: string | undefined,
): Promise<Resolved> => {
  // `openapi` first and unconditionally: it is the only form that carries
  // `contribute`, so an app that exports one has said more than a bare module can.
  if (loaded.openapi !== undefined) {
    const value = loaded.openapi;
    return { entry: typeof value === 'function' ? await value() : value };
  }

  const found = findRootModule(loaded, named);
  if (found.kind === 'found') return { entry: { root: found.root } };
  return found.kind === 'ambiguous' ? { ambiguous: found.names } : undefined;
};

export const run = async (argv: readonly string[]): Promise<number> => {
  const entryPath = argv.find((arg) => !arg.startsWith('--'));
  if (entryPath === undefined) {
    console.error(usage);
    return 1;
  }

  const path = locate(entryPath);
  if (path === undefined) {
    console.error(
      `Cannot resolve ${entryPath} from ${process.cwd()}.\n\n${usage}`,
    );
    return 1;
  }

  const loaded = (await import(path)) as Exported;

  const named = argv
    .find((arg) => arg.startsWith('--export='))
    ?.slice('--export='.length);

  const resolved = await resolveEntry(loaded, named);
  if (resolved === undefined) {
    console.error(
      `${entryPath} declares no module. Export \`openapi\`, or a class decorated ` +
        `with @Module.\n\n${usage}`,
    );
    return 1;
  }
  if ('ambiguous' in resolved) {
    console.error(
      `${entryPath} exports ${resolved.ambiguous.length} modules ` +
        `(${resolved.ambiguous.join(', ')}), so the root one is ambiguous. Pass ` +
        `--export=<name>, or export it as \`default\`.\n\n${usage}`,
    );
    return 1;
  }

  const fallback = await packageInfo();
  const { root, versioning, apiVersion, ...rest } = resolved.entry;
  const versions = RouteVersioning.of(versioning);
  const generated = await generateDocuments(
    describeRoutes(root, versions),
    { ...fallback, ...rest },
    versions,
  );
  const chosen =
    apiVersion === undefined
      ? generated.document
      : generated.versions?.documents.get(apiVersion);
  if (chosen === undefined) {
    const known = [...(generated.versions?.documents.keys() ?? [])];
    console.error(
      `apiVersion ${apiVersion} has no document. ` +
        (known.length === 0
          ? 'Only header and media-type versioning write one per version.'
          : `The versions are ${known.join(', ')}.`),
    );
    return 1;
  }
  const { document, warnings } = chosen;

  for (const warning of warnings) console.error(`warning: ${warning}`);

  const serialised = `${JSON.stringify(document, null, 2)}\n`;
  const paths = Object.keys(document.paths).length;

  if (argv.includes('--stdout')) {
    console.log(serialised.trimEnd());
    return 0;
  }

  const out = flag(argv, 'out') ?? 'openapi.json';
  const bytes = await Bun.write(out, serialised);
  console.log(
    `wrote ${out} (${(bytes / 1024).toFixed(1)} KiB, ${paths} paths)`,
  );
  return 0;
};

if (import.meta.main) process.exit(await run(Bun.argv.slice(2)));
