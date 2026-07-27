import { chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';

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
    `${pkg.name ?? CWD}: package.json must set "type": "module" — dunx is ESM only.`,
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

for (const entry of Object.values(pkg.exports ?? {})) {
  const target = typeof entry === 'string' ? entry : entry.import;
  if (target) entrypoints.add(await toSource(target));
}

const binPaths =
  typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin ?? {});
for (const target of binPaths) {
  entrypoints.add(await toSource(target));
  binOutputs.add(join(CWD, target.replace(/^\.\//, '')));
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
  outdir: join(CWD, 'dist'),
  root: join(CWD, 'src'),
  target: 'bun',
  format: 'esm',
  packages: 'external',
  splitting: false,
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

for (const bin of binOutputs) await chmod(bin, 0o755);

const js = result.outputs.filter((o) => o.kind === 'entry-point');
const bytes = result.outputs.reduce((sum, o) => sum + o.size, 0);
const ms = Math.round(performance.now() - started);

console.log(
  `${pkg.name ?? 'package'}: ${js.length} entry${js.length === 1 ? '' : 'ies'} + ` +
    `declarations, ${(bytes / 1024).toFixed(1)} KiB, ${ms}ms -> dist/`,
);
