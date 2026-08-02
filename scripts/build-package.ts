import { chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
// Imported from source, not dist: this script is what builds @dunx/transform, so
// depending on its output would not bootstrap.
import { depsPlugin } from '../packages/transform/src/plugin.js';

/**
 * Bun-native package build. Run from a package root: `bun ../../scripts/build-package.ts`.
 *
 * Bun has no `--dts`, so declarations still come from `tsc --emitDeclarationOnly`.
 * Everything else (transpile, bundle, source maps) is Bun.
 *
 * Entrypoints are derived from `exports` and `bin` rather than configured
 * separately, so a new public subpath cannot be added to the manifest without
 * also being built.
 */

const CWD = process.cwd();

interface ExportEntry {
  import?: string;
}

interface Manifest {
  name?: string;
  type?: string;
  exports?: Record<string, string | ExportEntry>;
  bin?: string | Record<string, string>;
}

const pkg = (await Bun.file(join(CWD, 'package.json')).json()) as Manifest;

if (pkg.type !== 'module') {
  throw new Error(
    `${pkg.name ?? CWD}: package.json must set "type": "module" - dunx is ESM only.`,
  );
}

/** `./dist/foo/index.js` -> `src/foo/index.ts`, verifying the source exists. */
async function toSource(distPath: string): Promise<string> {
  const rel = distPath.replace(/^\.\//, '');
  if (!rel.startsWith('dist/')) {
    throw new Error(`Expected a dist/ path, got "${distPath}"`);
  }
  const src = `src/${rel.slice('dist/'.length).replace(/\.js$/, '.ts')}`;
  if (!(await Bun.file(join(CWD, src)).exists())) {
    throw new Error(`"${distPath}" has no matching source at ${src}`);
  }
  return src;
}

const entrypoints = new Set<string>();
const binOutputs = new Set<string>();
const exported = new Set<string>();

const unprefixed = (distPath: string): string => distPath.replace(/^\.\//, '');

for (const entry of Object.values(pkg.exports ?? {})) {
  const target = typeof entry === 'string' ? entry : entry.import;
  if (target) {
    entrypoints.add(await toSource(target));
    exported.add(unprefixed(target));
  }
}

const binPaths =
  typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin ?? {});
for (const target of binPaths) {
  entrypoints.add(await toSource(target));
  binOutputs.add(join(CWD, unprefixed(target)));
}

if (entrypoints.size === 0) {
  throw new Error(`${pkg.name ?? CWD}: no "exports" or "bin" to build`);
}

await rm(join(CWD, 'dist'), { recursive: true, force: true });

const started = performance.now();

// `packages: 'external'` bundles relative imports but leaves dependencies
// alone. That keeps the emitted JS free of extension-resolution hazards while
// staying tree-shakeable for consumers.
const result = await Bun.build({
  entrypoints: [...entrypoints],
  // A package that exports a DI-managed class has to ship its constructor
  // dependency records. A consuming app's plugin skips node_modules, so if the
  // metadata is not baked in here the container cannot construct the class.
  plugins: [depsPlugin],
  outdir: join(CWD, 'dist'),
  root: join(CWD, 'src'),
  target: 'bun',
  format: 'esm',
  packages: 'external',
  // Splitting is what makes a lazy subpath real. With it off, Bun **inlines** a
  // relative `await import()` into the importing entry - measured: a 200 KB module
  // behind a dynamic import produced a 200,980 B entry with `splitting: false` and
  // a 350 B entry plus a chunk with it on. `@dunx/openapi` needs that, or its
  // `./ui` split would be a no-op that still shipped 456 KB to every consumer.
  //
  // It is safe for the other packages and better for the multi-entry ones. A
  // module two subpaths share was previously **duplicated** into both, so
  // `@dunx/infra/db` and `@dunx/infra/queue` each carried their own copy - and
  // their own module instance. Sharing a chunk fixes both: infra's dist went from
  // 127.7 KB to 71.7 KB, transform's from 10.3 KB to 5.6 KB. Single-entry packages
  // with no dynamic imports (`@dunx/core`, `@dunx/http`) emit byte-identical
  // output.
  splitting: true,
  sourcemap: 'linked',
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new AggregateError(result.logs, 'Bun.build failed');
}

// tsc refuses to infer rootDir when emitting, so both paths are explicit here
// rather than duplicated into a second tsconfig.
const tsc = Bun.spawnSync({
  cmd: [
    'bunx',
    'tsc',
    '-p',
    'tsconfig.json',
    '--noEmit',
    'false',
    '--declaration',
    '--emitDeclarationOnly',
    '--rootDir',
    'src',
    '--outDir',
    'dist',
  ],
  cwd: CWD,
  stdout: 'inherit',
  stderr: 'inherit',
});

if (tsc.exitCode !== 0) {
  throw new Error('tsc failed to emit declarations');
}

// One tsconfig covers both typecheck and build, so tests are in scope for tsc
// and it emits declarations for them. They have no runtime counterpart in dist
// (Bun only builds the declared entrypoints), so drop them.
const testDecls = new Bun.Glob('**/*.{test,spec}.d.ts{,.map}');
for await (const rel of testDecls.scan({ cwd: join(CWD, 'dist') })) {
  await rm(join(CWD, 'dist', rel));
}

// A `bin` script is spawned, never imported, so tsc's declaration for it has no
// consumer at all - `@dunx/create-app`'s is literally `export {};`. Declarations
// for internal modules are a different matter and must stay: `dist/index.d.ts`
// re-exports from `./scaffold.js`, which resolves to `dist/scaffold.d.ts`, so
// dropping that one breaks the published types. A path that is both a `bin` and an
// `exports` target is public surface and is left alone.
for (const target of binPaths) {
  const rel = unprefixed(target);
  if (exported.has(rel)) continue;
  const base = join(CWD, rel.replace(/\.js$/, ''));
  await rm(`${base}.d.ts`, { force: true });
  await rm(`${base}.d.ts.map`, { force: true });
}

for (const bin of binOutputs) await chmod(bin, 0o755);

const js = result.outputs.filter((o) => o.kind === 'entry-point');
const bytes = result.outputs.reduce((sum, o) => sum + o.size, 0);
const ms = Math.round(performance.now() - started);

console.log(
  `${pkg.name ?? 'package'}: ${js.length} entry${js.length === 1 ? '' : 'ies'} + ` +
    `declarations, ${(bytes / 1024).toFixed(1)} KiB, ${ms}ms -> dist/`,
);
