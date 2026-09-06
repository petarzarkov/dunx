/**
 * Compile the CLI to one self-contained executable: the Bun runtime plus the app
 * in one file, so a host needs nothing installed to run it.
 *
 * `Bun.build` gets both `plugins: [depsPlugin]` and `compile`. Constructor
 * injection has no runtime annotation, so `@dunx/transform` records each class's
 * dependencies as a statement after it - at `bun run` time via the preload, and
 * here baked into the binary at build time, since a compiled binary has no
 * load-time plugin. `bun run test` compiles this and asserts a dependency
 * survived. See README.md for the Bun-version history behind the single pass.
 *
 *   bun run build      # from this directory
 */
import { depsPlugin } from '@dunx/transform';
import { join, resolve } from 'node:path';
import pkg from '../package.json' with { type: 'json' };

const DIR = resolve(import.meta.dir, '..');
const BINARY = 'pulse';
const outfile = join(DIR, 'dist', BINARY);

console.log(`Building ${BINARY} ${pkg.version} -> ${outfile}`);
const started = performance.now();

const compiled = await Bun.build({
  entrypoints: [join(DIR, 'src/main.ts')],
  target: 'bun',
  compile: { outfile },
  plugins: [depsPlugin],
  minify: true,
  // A stack trace is never read off a shipped binary, and debug symbols would add
  // tens of megabytes to it.
  sourcemap: 'none',
  tsconfig: join(DIR, 'tsconfig.json'),
});

if (!compiled.success) {
  for (const log of compiled.logs) console.error(log);
  throw new AggregateError(compiled.logs, 'compile failed');
}

const bytes = await Bun.file(outfile).bytes();
console.log(
  `Built ${BINARY} ${pkg.version}, ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB, ` +
    `in ${Math.round(performance.now() - started)}ms`,
);
