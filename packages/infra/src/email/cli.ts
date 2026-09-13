#!/usr/bin/env bun
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { Server } from 'bun';
import { EmailPreview } from './preview.js';
import { TemplateRenderer } from './renderer.js';

const USAGE = `dunx-email - preview and export email templates

  dunx-email preview [dir]   serve the templates in <dir>, default ./emails
  dunx-email export  [dir]   render every template to HTML

Options
  --port <n>        preview port, default 3035
  --out <dir>       export target, default ./out
  --renderer <mod>  module exporting a TemplateRenderer as its default export,
                    default @dunx/infra/email/react
`;

export interface Plan {
  readonly command: 'preview' | 'export';
  readonly dir: string;
  readonly out: string;
  readonly port: number;
  readonly renderer: string;
}

const DEFAULT_RENDERER = '@dunx/infra/email/react';

/**
 * Argv to a plan, or a message to print. Separate from running it so the parsing
 * is testable without a port and without the React peers installed.
 *
 * `parseArgs` rather than a hand-rolled split, which is what `@dunx/create-app`
 * already does. Filtering argv for tokens that do not start with `--` reads as
 * the same thing and is not: it collects every flag's **value** as a positional,
 * so `dunx-email preview --port 4000` served `./4000`.
 */
export const plan = (argv: readonly string[]): Plan | string => {
  const [command = 'preview'] = argv;
  if (command === '--help' || command === '-h') return USAGE;
  if (command !== 'preview' && command !== 'export') {
    return `Unknown command "${command}".\n\n${USAGE}`;
  }
  let values: Partial<Record<'port' | 'out' | 'renderer', string>>;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv.slice(1),
      allowPositionals: true,
      options: {
        port: { type: 'string' },
        out: { type: 'string' },
        renderer: { type: 'string' },
      },
    }));
  } catch (error) {
    return `${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`;
  }
  const port = Number(values.port ?? 3035);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    return `--port must be a port number, got "${String(values.port)}".`;
  }
  return {
    command,
    dir: resolve(positionals[0] ?? 'emails'),
    out: resolve(values.out ?? 'out'),
    port,
    renderer: values.renderer ?? DEFAULT_RENDERER,
  };
};

/**
 * The renderer named by `--renderer`, as its default export.
 *
 * Loaded rather than imported, so the base subpath stays free of React: an app
 * previewing MJML points this at its own module and never installs
 * `@react-email/components`.
 */
export const loadRenderer = async (
  specifier: string,
): Promise<TemplateRenderer> => {
  // A path is relative to where the shell is, not to this file. Left to
  // `import()` it resolves inside `node_modules/@dunx/infra/dist/`, where a
  // consumer's own renderer has never been. As a file URL rather than a path,
  // so a Windows drive letter is not read as a protocol. A bare specifier is
  // left alone, since that is a package and not a path.
  const from =
    specifier.startsWith('.') || isAbsolute(specifier)
      ? pathToFileURL(resolve(specifier)).href
      : specifier;
  const module = (await import(from)) as { default?: unknown };
  const loaded = module.default;
  if (!(loaded instanceof TemplateRenderer)) {
    throw new Error(`${from} must default-export a TemplateRenderer instance.`);
  }
  return loaded;
};

export interface Started {
  readonly code: number;
  /** Present for `preview`, so a caller that is not the shell can stop it. */
  readonly server?: Server<never>;
}

export const main = async (argv: readonly string[]): Promise<Started> => {
  const parsed = plan(argv);
  if (typeof parsed === 'string') {
    if (parsed === USAGE) {
      console.log(parsed);
      return { code: 0 };
    }
    console.error(parsed);
    return { code: 1 };
  }
  // A shell gets the message, not a stack: the two things that go wrong here are
  // a directory that does not exist and a renderer that does not resolve, and
  // both are one line to fix once they are stated.
  try {
    const preview = new EmailPreview({
      dir: parsed.dir,
      renderer: await loadRenderer(parsed.renderer),
      port: parsed.port,
    });
    if (parsed.command === 'export') {
      for (const file of await preview.export(parsed.out)) console.log(file);
      return { code: 0 };
    }
    const server = preview.serve();
    console.log(`Email preview on ${server.url.href}`);
    return { code: 0, server };
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return { code: 1 };
  }
};

// Only a failure exits. `preview` must not: `Bun.serve` is what holds the loop
// open, and `export` ends on its own once the writes drain.
if (import.meta.main) {
  const { code } = await main(Bun.argv.slice(2));
  if (code !== 0) process.exit(code);
}
