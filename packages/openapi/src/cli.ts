#!/usr/bin/env bun
import { describeRoutes } from './discover.js';
import { generateDocument, type DocumentInfo } from './generate.js';
import type { ModuleRef } from '@dunx/core';

/**
 * Writes the OpenAPI document to a file, with no container, no server and no
 * database.
 *
 * `describeRoutes` walks the module graph reading metadata off prototypes, so
 * nothing is constructed and no port is bound. That makes an offline document a
 * matter of importing one module and serialising the result - which every app was
 * otherwise writing for itself, because the two primitives were public and the
 * plumbing around them was not.
 *
 * ```
 * bunx dunx-openapi ./src/app.module.ts
 * bunx dunx-openapi ./src/openapi.config.ts --out public/openapi.json
 * ```
 *
 * The entry may export, in this order of preference:
 *
 * - **`openapi`** - a function returning `{ root, ...DocumentInfo }`, or that
 *   object. This is the form that supports `contribute`, so it is the one an app
 *   mounting Better Auth needs: the contribution is the app's to describe, not
 *   something a CLI can guess.
 * - **`default`** or **`root`** - a `ModuleRef`. Title and version then come from
 *   the nearest `package.json`.
 */
interface OpenApiEntry extends Omit<DocumentInfo, 'title' | 'version'> {
  readonly root: ModuleRef;
  readonly title?: string;
  readonly version?: string;
}

type Exported =
  | {
      readonly openapi?:
        | OpenApiEntry
        | (() => OpenApiEntry | Promise<OpenApiEntry>);
    }
  | { readonly default?: ModuleRef; readonly root?: ModuleRef };

const usage = `Usage: bunx dunx-openapi <entry> [--out openapi.json]

  <entry>   A module exporting \`openapi\`, or a root module as \`default\`/\`root\`.
  --out     Where to write. Default openapi.json.
  --stdout  Write the document to stdout instead of a file.`;

const flag = (argv: readonly string[], name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? undefined : argv[at + 1];
};

const packageInfo = async (): Promise<{ title: string; version: string }> => {
  const file = Bun.file(`${process.cwd()}/package.json`);
  if (!(await file.exists())) return { title: 'API', version: '0.0.0' };
  const json = (await file.json()) as { name?: string; version?: string };
  return { title: json.name ?? 'API', version: json.version ?? '0.0.0' };
};

const resolveEntry = async (
  loaded: Exported,
): Promise<OpenApiEntry | undefined> => {
  if ('openapi' in loaded && loaded.openapi !== undefined) {
    const value = loaded.openapi;
    return typeof value === 'function' ? await value() : value;
  }
  if ('root' in loaded && loaded.root !== undefined)
    return { root: loaded.root };
  if ('default' in loaded && loaded.default !== undefined) {
    return { root: loaded.default };
  }
  return undefined;
};

export const run = async (argv: readonly string[]): Promise<number> => {
  const entryPath = argv.find((arg) => !arg.startsWith('--'));
  if (entryPath === undefined) {
    console.error(usage);
    return 1;
  }

  const loaded = (await import(
    entryPath.startsWith('.') ? `${process.cwd()}/${entryPath}` : entryPath
  )) as Exported;

  const entry = await resolveEntry(loaded);
  if (entry === undefined) {
    console.error(
      `${entryPath} exports no root module. Export \`openapi\`, or the module as ` +
        '`default` or `root`.\n\n' +
        usage,
    );
    return 1;
  }

  const fallback = await packageInfo();
  const { root, ...rest } = entry;
  const { document, warnings } = await generateDocument(describeRoutes(root), {
    ...fallback,
    ...rest,
  });

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
