#!/usr/bin/env bun
import { findRootModule } from '@dunx/core';
import { adoptionResources, adoptionTools } from './adopt.js';
import { serve, type ToolDefinition } from './protocol.js';
import { toolsFor } from './tools.js';

/**
 * `bunx @dunx/mcp ./src/app.module.ts`
 *
 * An MCP server over stdio, answering questions about a dunx app by reading it.
 * The entry exports its root module as `default` or `root`, the same convention
 * `bunx dunx-openapi` uses.
 *
 * **The entry is optional.** Without one the server still starts, serving the
 * tools that need no app: how to start, the written guide, and what
 * `bunx @dunx/create-app` can generate. That is the state someone adopting dunx is
 * in, and requiring a root module made the server unreachable exactly then.
 *
 * **stdout is the protocol channel**, so nothing here prints to it: diagnostics go
 * to stderr, which is what an MCP client shows in its logs.
 */
const usage = `Usage: bunx @dunx/mcp [entry] [--export=<name>]

  [entry]          The file that declares your root module. A path, relative or
                   absolute, or a package specifier. Omit it and the server serves
                   only the tools that need no app.
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
 * `Bun.resolveSync` rather than string-munging a path, so every specifier `import`
 * accepts resolves the same way. It follows Node resolution, so a bare relative
 * path throws - `src/app.module.ts` reads as a package named `src` - and is
 * retried as explicitly relative. As-is first, so a real package wins over a
 * same-named directory.
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

/**
 * The tools this invocation serves, or the exit code to fail with. Separated from
 * {@link main} because everything after it blocks on stdin, so this is the half a
 * test can call in process.
 */
export const assemble = async (
  argv: readonly string[],
): Promise<readonly ToolDefinition[] | number> => {
  const adoption = adoptionTools();

  const entry = argv.find((arg) => !arg.startsWith('-'));
  if (entry === undefined) {
    console.error(
      'No entry given, so this server answers about dunx itself: dunx_start, ' +
        'dunx_guide, dunx_scaffold, and the guide as resources. Pass the file ' +
        'that declares your root module, e.g. ./src/app.module.ts, to also read ' +
        'your app.',
    );
    return adoption;
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
  return [...adoption, ...toolsFor(found.root)];
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

  const tools = await assemble(argv);
  if (typeof tools === 'number') return tools;

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
    tools,
    { name: '@dunx/mcp', version: await version() },
    adoptionResources(),
  );
  return 0;
};

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
