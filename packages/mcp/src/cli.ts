#!/usr/bin/env bun
import { serve } from './protocol.js';
import { toolsFor } from './tools.js';
import type { ModuleRef } from '@dunx/core';

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
const usage = `Usage: bunx @dunx/mcp <entry>

  <entry>  A module exporting its root module as \`default\` or \`root\`.

Speaks the Model Context Protocol over stdio. Reads the app; never boots it.`;

interface Exported {
  readonly default?: ModuleRef;
  readonly root?: ModuleRef;
}

export const main = async (argv: readonly string[]): Promise<number> => {
  const entry = argv.find((arg) => !arg.startsWith('--'));
  if (entry === undefined) {
    console.error(usage);
    return 1;
  }

  const loaded = (await import(
    entry.startsWith('.') ? `${process.cwd()}/${entry}` : entry
  )) as Exported;

  const root = loaded.root ?? loaded.default;
  if (root === undefined) {
    console.error(
      `${entry} exports no root module as \`default\` or \`root\`.`,
    );
    return 1;
  }

  const manifest = Bun.file(`${import.meta.dir}/../package.json`);
  const version = (await manifest.exists())
    ? (((await manifest.json()) as { version?: string }).version ?? '0.0.0')
    : '0.0.0';

  await serve(
    Bun.stdin.stream(),
    (line) => process.stdout.write(line),
    toolsFor(root),
    { name: '@dunx/mcp', version },
  );
  return 0;
};

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
