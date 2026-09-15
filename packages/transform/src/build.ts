import { chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { depsPlugin } from './plugin.js';

/**
 * A subpath's target: a path, a condition map, an array of fallbacks, or `null`
 * to block it. `exports` is itself one, for the single-entry spelling.
 */
type ExportEntry =
  | string
  | null
  | readonly ExportEntry[]
  | { readonly [condition: string]: ExportEntry };

/** The manifest fields a build reads. */
interface PackageManifest {
  readonly name?: string;
  readonly type?: string;
  readonly exports?: ExportEntry;
  readonly bin?: string | Readonly<Record<string, string>>;
}

export interface PackageBuildOptions {
  /** Package root holding `package.json` and `src/`. Defaults to `cwd`. */
  readonly cwd?: string;
  /**
   * Emit `.d.ts` through `tsc --emitDeclarationOnly`, which Bun has no
   * equivalent for. Off for a package nobody imports types from.
   */
  readonly declarations?: boolean;
}

export interface PackageBuildResult {
  readonly name: string;
  readonly entrypoints: readonly string[];
  readonly entries: number;
  readonly bytes: number;
  readonly ms: number;
}

const unprefixed = (distPath: string): string => distPath.replace(/^\.\//, '');

/**
 * Every file an `exports` tree names, at any depth. Both targets of a package
 * declaring two conditions are built: picking one leaves the other pointing at
 * a file nobody emitted. A `.d.ts` leaf is a `types` condition, which `tsc`
 * emits rather than an entrypoint.
 */
const targetsOf = (entry: ExportEntry): readonly string[] => {
  if (typeof entry === 'string') return entry.endsWith('.d.ts') ? [] : [entry];
  if (entry === null || typeof entry !== 'object') return [];
  return Object.values(entry).flatMap(targetsOf);
};

/** `./dist/foo/index.js` -> `src/foo/index.ts`, verifying the source exists. */
const toSource = async (cwd: string, distPath: string): Promise<string> => {
  const rel = unprefixed(distPath);
  if (!rel.startsWith('dist/')) {
    throw new Error(`Expected a dist/ path, got "${distPath}"`);
  }
  const src = `src/${rel.slice('dist/'.length).replace(/\.js$/, '.ts')}`;
  if (!(await Bun.file(join(cwd, src)).exists())) {
    throw new Error(`"${distPath}" has no matching source at ${src}`);
  }
  return src;
};

/**
 * Builds a package whose classes the dunx container has to construct.
 *
 * The part that is not optional is `depsPlugin`: a consuming app's plugin skips
 * `node_modules`, so a published package that does not record its constructor
 * dependencies here ships classes nobody can inject, and the error surfaces in
 * someone else's app. Everything else is a default worth having.
 *
 * Entrypoints are derived from `exports` and `bin` rather than configured, so a
 * new public subpath cannot be added to the manifest without also being built.
 * The layout is assumed: `src/` in, `dist/` out, one root `tsconfig.json`, and
 * `typescript` as an optional peer for the declarations Bun does not emit.
 */
export const buildPackage = async (
  options: PackageBuildOptions = {},
): Promise<PackageBuildResult> => {
  const cwd = options.cwd ?? process.cwd();
  const pkg = (await Bun.file(
    join(cwd, 'package.json'),
  ).json()) as PackageManifest;
  const name = pkg.name ?? cwd;

  if (pkg.type !== 'module') {
    throw new Error(
      `${name}: package.json must set "type": "module" - dunx is ESM only.`,
    );
  }

  const entrypoints = new Set<string>();
  const binOutputs = new Set<string>();
  const exported = new Set<string>();

  for (const target of targetsOf(pkg.exports ?? {})) {
    entrypoints.add(await toSource(cwd, target));
    exported.add(unprefixed(target));
  }

  const binPaths =
    typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin ?? {});
  for (const target of binPaths) {
    entrypoints.add(await toSource(cwd, target));
    binOutputs.add(join(cwd, unprefixed(target)));
  }

  if (entrypoints.size === 0) {
    throw new Error(`${name}: no "exports" or "bin" to build`);
  }

  await rm(join(cwd, 'dist'), { recursive: true, force: true });

  const started = performance.now();

  // `packages: 'external'` bundles relative imports but leaves dependencies
  // alone. That keeps the emitted JS free of extension-resolution hazards while
  // staying tree-shakeable for consumers.
  const result = await Bun.build({
    entrypoints: [...entrypoints].map((rel) => join(cwd, rel)),
    plugins: [depsPlugin],
    // Bun throws one error at a time by default; every log at once is more use.
    throw: false,
    outdir: join(cwd, 'dist'),
    root: join(cwd, 'src'),
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
    // No source maps. `sourcemap: 'linked'` embedded full `sourcesContent`, so every
    // package shipped its own TypeScript inside the `.map` and the maps were 50-64%
    // of the tarball by byte - `@dunx/http`'s was 317 KB against 114 KB of JS. `files`
    // excludes `src/`, so publishing the sources through the back door was not the
    // intent.
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new AggregateError(result.logs, 'Bun.build failed');
  }

  if (options.declarations !== false) {
    await emitDeclarations(cwd, exported, binPaths);
  }

  for (const bin of binOutputs) await chmod(bin, 0o755);

  return {
    name,
    entrypoints: [...entrypoints],
    entries: result.outputs.filter((o) => o.kind === 'entry-point').length,
    bytes: result.outputs.reduce((sum, o) => sum + o.size, 0),
    ms: Math.round(performance.now() - started),
  };
};

/**
 * Bun has no `--dts`, so declarations come from `tsc`. Both paths are explicit
 * because tsc refuses to infer `rootDir` when emitting, which is what keeps this
 * to one tsconfig per package rather than a second build variant.
 */
const emitDeclarations = async (
  cwd: string,
  exported: ReadonlySet<string>,
  binPaths: readonly string[],
): Promise<void> => {
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
    cwd,
    stdout: 'inherit',
    stderr: 'inherit',
  });

  if (tsc.exitCode !== 0) {
    throw new Error('tsc failed to emit declarations');
  }

  // One tsconfig covers both typecheck and build, so tests are in scope for tsc
  // and it emits declarations for them. They have no runtime counterpart in dist
  // (Bun only builds the declared entrypoints), so drop them.
  //
  // `.fixture.` is in the pattern for the same reason: a fixture is test-only
  // support that no entrypoint imports, so tsc emits a declaration with no `.js`
  // beside it.
  const testDecls = new Bun.Glob('**/*.{test,spec,fixture}.d.ts{,.map}');
  for await (const rel of testDecls.scan({ cwd: join(cwd, 'dist') })) {
    await rm(join(cwd, 'dist', rel));
  }

  // A `bin` script is spawned, never imported, so tsc's declaration for it has no
  // consumer at all. Declarations for internal modules are a different matter and
  // must stay: `dist/index.d.ts` re-exports from `./scaffold.js`, which resolves to
  // `dist/scaffold.d.ts`, so dropping that one breaks the published types. A path
  // that is both a `bin` and an `exports` target is public surface and is left alone.
  for (const target of binPaths) {
    const rel = unprefixed(target);
    if (exported.has(rel)) continue;
    const base = join(cwd, rel.replace(/\.js$/, ''));
    await rm(`${base}.d.ts`, { force: true });
    await rm(`${base}.d.ts.map`, { force: true });
  }
};
