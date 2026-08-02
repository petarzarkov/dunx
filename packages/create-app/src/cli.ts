#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import { relative } from 'node:path';
import { scaffold, ScaffoldError, TEMPLATES } from './scaffold.js';
import type { TemplateName } from './scaffold.js';

const USAGE = `Scaffold a new dunx application.

  bunx @dunx/create-app <directory> [options]

Options:
  --name <name>       package name for the app (default: the directory name)
  --template <name>   ${TEMPLATES.join(' | ')} (default: minimal)
  --force             write into a directory that already has files in it
  --yes, -y           accepted and ignored; nothing here ever prompts
  --help              print this
`;

// A declaration, not a `const` arrow: control-flow analysis only narrows past a
// never-returning call when the callee is declared this way, so `target` stays
// `string | undefined` below if this is an arrow.
function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    name: { type: 'string' },
    template: { type: 'string' },
    force: { type: 'boolean', default: false },
    // Declared and never read. The scaffolder is fully non-interactive, so there
    // is nothing for `--yes` to confirm - but it is what a hand reaches for out of
    // habit, and `parseArgs` answers an undeclared flag with a `TypeError`.
    yes: { type: 'boolean', default: false, short: 'y' },
    help: { type: 'boolean', default: false, short: 'h' },
  },
});

if (values.help === true) {
  console.log(USAGE);
  process.exit(0);
}

const target = positionals[0];
if (target === undefined) {
  fail(`Missing the target directory.\n\n${USAGE}`);
}

try {
  const result = await scaffold({
    target,
    ...(values.name === undefined ? {} : { name: values.name }),
    ...(values.template === undefined
      ? {}
      : { template: values.template as TemplateName }),
    force: values.force === true,
  });

  // Empty when the target resolved to the directory the process is already in, in
  // which case `in ./` and `cd .` are both noise to a reader standing there.
  const where = relative(process.cwd(), result.directory);
  console.log(
    where === ''
      ? `Created ${result.name} here`
      : `Created ${result.name} in ${where}/`,
  );
  console.log(
    `  ${result.files.length} files from the ${result.template} template\n`,
  );
  console.log('Next:');
  if (where !== '') console.log(`  cd ${where}`);
  console.log('  bun install');
  console.log('  bun run start');
} catch (error) {
  if (error instanceof ScaffoldError) fail(error.message);
  throw error;
}
