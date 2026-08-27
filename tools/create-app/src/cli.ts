#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import { relative } from 'node:path';
import { FEATURES, featureNames, impliedBy } from './features.js';
import { scaffold, ScaffoldError, TEMPLATES } from './scaffold.js';
import { readLine } from './stdin.js';
import type { TemplateName } from './scaffold.js';

const USAGE = `Scaffold a new dunx application.

  bunx @dunx/create-app <directory> [options]

Options:
  --name <name>       package name for the app (default: the directory name)
  --with <a,b,c>      features to compose the app from (see --list)
  --all               every feature
  --template <name>   ${TEMPLATES.join(' | ')} (default: minimal, when no --with)
  --list              print the features and exit
  --force             write into a directory that already has files in it
  --yes, -y           take the default selection without prompting
  --help              print this

With no --with and no prompt, you get the minimal template: five files, one route.
With features, the wiring is generated around them and each feature's directory is
copied from dunx's own examples/full, which CI runs and tours on every push.
`;

const featureList = (): string =>
  FEATURES.map((feature) => {
    const needs =
      feature.requires.length === 0
        ? ''
        : ` (pulls in ${feature.requires.join(', ')})`;
    const service =
      feature.service === undefined ? '' : `  [needs ${feature.service}]`;
    return `  ${feature.name.padEnd(12)}${feature.summary}${needs}${service}`;
  }).join('\n');

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
    with: { type: 'string' },
    all: { type: 'boolean', default: false },
    list: { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false, short: 'y' },
    help: { type: 'boolean', default: false, short: 'h' },
  },
});

if (values.help === true) {
  console.log(USAGE);
  process.exit(0);
}

if (values.list === true) {
  console.log(`Features:\n${featureList()}`);
  process.exit(0);
}

const target = positionals[0];
if (target === undefined) {
  fail(`Missing the target directory.\n\n${USAGE}`);
}

const split = (value: string): string[] =>
  value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');

/**
 * One line of stdin, not a raw-mode menu.
 *
 * A full-screen selector means owning cursor movement, terminal restore on signal
 * and a fallback for every terminal that does not do what it claims - which is a
 * library's job, and taking one would put a dependency in the package whose whole
 * appeal is that `bunx @dunx/create-app` resolves almost nothing. A numbered list
 * plus one readline needs neither, and pasting `--with` skips it entirely.
 *
 * Only when stdin is a TTY: in CI there is nothing to answer with, and a scaffolder
 * that blocks on a prompt there hangs the job.
 */
const ask = async (): Promise<readonly string[]> => {
  if (values.all === true) return featureNames;
  if (values.with !== undefined) return split(values.with);
  if (values.yes === true || !process.stdin.isTTY) return [];

  console.log(`Features (empty for the minimal template):\n${featureList()}\n`);
  console.log('Names or numbers, comma separated. `all` for everything.');
  process.stdout.write('> ');

  const answer = await readLine();
  if (answer === '') return [];
  if (answer === 'all') return featureNames;

  return split(answer).map((part) => {
    const index = Number(part);
    // Numbers are 1-based because the printed list reads that way to a human.
    return Number.isInteger(index) && index >= 1 && index <= FEATURES.length
      ? (FEATURES[index - 1]?.name ?? part)
      : part;
  });
};

try {
  const requested = await ask();
  const result = await scaffold({
    target,
    ...(values.name === undefined ? {} : { name: values.name }),
    ...(values.template === undefined
      ? {}
      : { template: values.template as TemplateName }),
    features: requested,
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

  if (result.features.length === 0) {
    console.log(
      `  ${result.files.length} files from the ${result.template} template\n`,
    );
  } else {
    const implied = impliedBy(
      requested,
      FEATURES.filter((feature) => result.features.includes(feature.name)),
    );
    console.log(
      `  ${result.files.length} files, ${result.features.length} features: ` +
        `${result.features.join(', ')}`,
    );
    if (implied.length > 0) {
      console.log(`  ${implied.join(', ')} came along as requirements`);
    }
    const services = FEATURES.filter(
      (feature) =>
        result.features.includes(feature.name) && feature.service !== undefined,
    );
    for (const feature of services) {
      console.log(`  ${feature.name} needs ${feature.service} to do anything`);
    }
    console.log('');
  }

  console.log('Next:');
  if (where !== '') console.log(`  cd ${where}`);
  console.log('  bun install');
  console.log('  bun run start');
} catch (error) {
  if (error instanceof ScaffoldError) fail(error.message);
  throw error;
}
