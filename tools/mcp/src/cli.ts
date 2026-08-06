#!/usr/bin/env bun
import { findRootModule } from '@dunx/core';
import { serve } from './protocol.js';
import { toolsFor } from './tools.js';

/**
 * `bunx @dunx/mcp ./src/app.module.ts`
 *
 * An MCP server over stdio, answering questions about a dunx app by reading it.
 * The entry exports its root module as `default` or `root`, the same convention
 * `bunx dunx-openapi` uses.
 *
 * **stdout is the protocol channel**, so nothing here prints to it: diagnostics go
 * to stderr, which is what an MCP client shows in its logs.
 */
const usage = `Usage: bunx @dunx/mcp <entry> [--export=<name>]

  <entry>          The file that declares your root module. A path, relative or
                   absolute, or a package specifier.
  --export=<name>  Which export to use, when the entry declares several modules.
                   Otherwise the single @Module export is found on its own, and
                   \`default\` or \`root\` wins if present.
  --help, -h       Print this and exit.
  --version        Print the server version and exit.

Speaks the Model Context Protocol over stdio. Reads the app; never boots it.`;

type Exported = Record<string, unknown>;

/**
 * The root module is *recognised*, not conventionally named - `findRootModule` reads
 * the marker `@Module` leaves. It lives in `@dunx/core` because the marker does, and
 * because `bunx dunx-openapi` needs the identical answer.
 */
const named = (argv: readonly string[]): string | undefined =>
  argv.find((arg) => arg.startsWith('--export='))?.slice('--export='.length);

const version = async (): Promise<string> => {
  const manifest = Bun.file(`${import.meta.dir}/../package.json`);
  return (await manifest.exists())
    ? (((await manifest.json()) as { version?: string }).version ?? '0.0.0')
    : '0.0.0';
};

/**
 * `Bun.resolveSync` rather than string-munging a path: it is the runtime's own
 * resolver, so `./src/app.module.ts`, an absolute path, an extensionless
 * `./src/app.module` and a bare package specifier all resolve exactly as `import`
 * would resolve them.
 *
 * It follows Node resolution, which means a bare *relative* path throws -
 * `src/app.module.ts` is read as a package named `src`. Measured, not assumed. So
 * an unresolved specifier is retried as explicitly relative, which is what someone
 * typing a path from their shell meant. As-is is tried first, so a real package
 * still wins over a same-named directory.
 *
 * The old `startsWith('.') ? cwd + entry : entry` got this wrong in the same place
 * and failed to find a file that was plainly there.
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

const load = async (path: string): Promise<Exported | undefined> => {
  try {
    return (await import(path)) as Exported;
  } catch (error) {
    // The app's own import-time failure, not ours - a missing dependency, a
    // throwing top-level statement. Worth reporting as the app's error rather
    // than dying on an unhandled rejection with no context.
    console.error(`Failed to load ${path}:\n${String(error)}`);
    return undefined;
  }
};

export const main = async (argv: readonly string[]): Promise<number> => {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.error(usage);
    return 0;
  }
  if (argv.includes('--version')) {
    console.error(await version());
    return 0;
  }

  const entry = argv.find((arg) => !arg.startsWith('-'));
  if (entry === undefined) {
    console.error(usage);
    return 1;
  }

  const path = locate(entry);
  if (path === undefined) {
    console.error(
      `Cannot resolve ${entry} from ${process.cwd()}. Pass a path to the module ` +
        'that exports your root module, e.g. ./src/app.module.ts.',
    );
    return 1;
  }

  const loaded = await load(path);
  if (loaded === undefined) return 1;

  const wanted = named(argv);
  const found = findRootModule(loaded, wanted);
  if (found.kind === 'none') {
    console.error(
      wanted === undefined
        ? `${entry} exports no @Module class. Point at the file that declares ` +
            'your root module, e.g. ./src/app.module.ts.'
        : `${entry} has no exported @Module named \`${wanted}\`.`,
    );
    return 1;
  }
  if (found.kind === 'ambiguous') {
    console.error(
      `${entry} exports ${found.names.length} modules ` +
        `(${found.names.join(', ')}), so the root one is ambiguous. Pass ` +
        '--export=<name>, or export it as `default`.',
    );
    return 1;
  }
  const { root } = found;

  /**
   * `Bun.stdout.writer()` rather than `process.stdout.write`. It is a `FileSink`
   * over the fd, and the explicit `flush()` per message is what the framing needs:
   * a buffered write with no flush leaves the client waiting on an answer that is
   * sitting in this process.
   */
  const sink = Bun.stdout.writer();
  await serve(
    Bun.stdin.stream(),
    async (line) => {
      // `write` answers with a byte count, which nothing here needs. `flush` is
      // typed as possibly async - it is a number for a pipe, measured - and
      // awaiting it costs nothing while covering the sink that is not.
      void sink.write(line);
      await sink.flush();
    },
    toolsFor(root),
    { name: '@dunx/mcp', version: await version() },
  );
  return 0;
};

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
