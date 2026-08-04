/**
 * Scaffolds representative feature selections and typechecks each one.
 *
 * The feature *sources* are already covered: they are copied byte-for-byte from
 * `examples/full`, which CI builds, typechecks, tests and tours. What nothing else
 * covers is the **wiring generated around them** - `app.module.ts`, `config.ts`,
 * `bootstrap.ts` and `main.ts` - and that is a different file for every selection.
 * A generator that emits an import for a module the selection does not carry, or a
 * `config.get('redis')` with no `redis` group, breaks only for the combination that
 * hits it.
 *
 * Scaffolded **into `examples/full/`** on purpose, because that workspace's
 * `node_modules` already holds every `@dunx/*` package plus zod, drizzle,
 * better-auth and bullmq - exactly a composed app's dependency set. So this
 * typechecks against the code in the tree with no install and no network, rather
 * than against whatever is published.
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { featureNames } from '../packages/create-app/src/features.js';
import { scaffold } from '../packages/create-app/src/scaffold.js';

const ROOT = new URL('..', import.meta.url).pathname;
const HOST = join(ROOT, 'examples/full');

/**
 * Every feature alone, plus the combinations with something to get wrong: the whole
 * set, and the pairs where one feature's config or bootstrap contribution has to
 * coexist with another's.
 */
const SELECTIONS: readonly (readonly string[])[] = [
  ...featureNames.map((name) => [name]),
  featureNames,
  ['notes', 'openapi', 'http'],
  ['users', 'auth'],
  ['websockets', 'cache'],
  ['jobs', 'health'],
];

const label = (features: readonly string[]): string =>
  features.length > 3 ? `${features.length} features` : features.join('+');

let failed = 0;

for (const [at, features] of SELECTIONS.entries()) {
  const dir = join(HOST, `scaffold-check-${at}`);
  await rm(dir, { recursive: true, force: true });

  try {
    const result = await scaffold({
      target: dir,
      name: 'scaffold-check',
      features,
      version: 'workspace:*',
    });

    const tsc = Bun.spawnSync(['bunx', 'tsc', '--noEmit', '--skipLibCheck'], {
      cwd: result.directory,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    if (tsc.exitCode === 0) {
      console.log(`  ok  ${label(features)} (${result.files.length} files)`);
    } else {
      failed += 1;
      console.error(`fail  ${label(features)}`);
      console.error(tsc.stdout.toString().trimEnd());
      console.error(tsc.stderr.toString().trimEnd());
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

if (failed > 0) {
  console.error(
    `\n${failed} of ${SELECTIONS.length} selections do not typecheck.`,
  );
  process.exit(1);
}

console.log(`\n${SELECTIONS.length} scaffolded selections typecheck.`);
