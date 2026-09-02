#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import { relative } from 'node:path';
import { Banner } from './banner.js';
import { FEATURES } from './features.js';
import { CancelledError, PromptRunner } from './prompt.js';
import {
  packageVersion,
  scaffold,
  ScaffoldError,
  type ScaffoldOptions,
} from './scaffold.js';
import { Style } from './style.js';
import { ProcessTty } from './tty.js';
import { Wizard } from './wizard.js';

const USAGE = `Scaffold a new dunx application.

  bunx @dunx/create-app [directory]

It asks. Up and down move, space toggles a feature, Enter takes the selection,
and the list says which features your choices pull in and which need a service
running. Nothing about the app is chosen by a flag.

Options:
  --name <name>   package name for the app (default: the directory name)
  --force         write into a directory that already has files in it
  --yes, -y       skip the questions and take the minimal template
  --help          print this

With no terminal to ask in - piped, or CI - it takes the minimal template rather
than blocking on a question nothing can answer. To choose features from a script,
call \`scaffold({ features })\` from \`@dunx/create-app\` instead.
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
    force: { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false, short: 'y' },
    help: { type: 'boolean', default: false, short: 'h' },
  },
});

if (values.help === true) {
  console.log(USAGE);
  process.exit(0);
}

const style = new Style();
const target = positionals[0];

/**
 * Piped, redirected or in CI, there is nobody to answer, so it writes the minimal
 * template. A scaffolder that blocks on a prompt there hangs the job.
 */
const withoutAsking = (): ScaffoldOptions => {
  if (target === undefined) {
    fail(`Missing the target directory.\n\n${USAGE}`);
  }
  return {
    target,
    ...(values.name === undefined ? {} : { name: values.name }),
    features: [],
    force: values.force === true,
  };
};

const byAsking = async (): Promise<ScaffoldOptions> => {
  const tty = new ProcessTty();
  const banner = new Banner(style).lines(tty.columns, await packageVersion());
  console.log(['', ...banner, ''].join('\n'));

  const wizard = new Wizard(new PromptRunner(tty), style);
  const answers = await wizard.run({
    target,
    name: values.name,
    features: [],
    force: values.force === true,
    cwd: process.cwd(),
  });
  return answers;
};

const interactive = values.yes !== true && ProcessTty.available();

try {
  const options = interactive ? await byAsking() : withoutAsking();
  const result = await scaffold(options);

  // Empty when the target resolved to the directory the process is already in, in
  // which case `in ./` and `cd .` are both noise to a reader standing there.
  const where = relative(process.cwd(), result.directory);
  console.log(
    where === ''
      ? `\nCreated ${result.name} here`
      : `\nCreated ${result.name} in ${where}/`,
  );

  if (result.features.length === 0) {
    console.log(
      `  ${result.files.length} files from the ${result.template} template\n`,
    );
  } else {
    const requested = options.features ?? [];
    const implied = result.features.filter((name) => !requested.includes(name));
    const noun = result.features.length === 1 ? 'feature' : 'features';
    console.log(
      `  ${result.files.length} files, ${result.features.length} ${noun}: ` +
        `${result.features.join(', ')}`,
    );
    if (implied.length > 0) {
      const as = implied.length === 1 ? 'a requirement' : 'requirements';
      console.log(`  ${implied.join(', ')} came along as ${as}`);
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
  console.log(
    `  bun run dev  ${style.muted('# or `start`, which does not watch')}`,
  );
} catch (error) {
  if (error instanceof CancelledError) {
    console.log(style.muted(error.message));
    // 130 is what a shell reports for a Ctrl+C, and the cancel is one whether it
    // arrived as a signal or as the byte raw mode turns it into.
    process.exit(130);
  }
  if (error instanceof ScaffoldError) fail(error.message);
  throw error;
}
