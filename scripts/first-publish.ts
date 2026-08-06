/**
 * The **first** publish of a package, and nothing else. `scripts/version.ts` owns
 * every later release through CI and OIDC; this exists only because a package
 * with no versions on npm has no trusted-publisher settings page yet, so the
 * first one has to go up against a personal `npm login`.
 *
 *   bunx npm@11.10.1 login
 *   DRY=true bun scripts/first-publish.ts    # read it first
 *   bun scripts/first-publish.ts             # 2FA prompts in a browser
 *
 * `DUNX_VERSION` overrides the version, which otherwise matches the rest of the
 * tree so a new package joins lockstep. Publishing is
 * idempotent per package only in the sense that npm refuses a version that
 * already exists - rerunning after a partial failure will fail on the packages
 * that already went up, which is safe but noisy. Set `DUNX_VERSION` or trim
 * `ORDER` to resume.
 *
 * It does the one thing a bare `npm publish` would get wrong: `workspace:*` is
 * not expanded by npm, so every internal range is rewritten around the publish and
 * the manifest restored afterwards. Both the rewrite and the assertion come from
 * `workspace-ranges.ts` rather than being repeated here - they used to be a second
 * copy, and this is the path with no CI check behind it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertNoWorkspaceRanges,
  readWorkspaceVersions,
  resolveWorkspaceDeps,
} from './workspace-ranges.js';
import { semver } from 'bun';

/**
 * The version every package in this run takes.
 *
 * Derived from the tree rather than hardcoded. It used to default to `0.1.0`,
 * which was right when it published the original eight and wrong for every
 * package added after: publishing a new `@dunx/*` at 0.1.0 into a tree at 0.2.14
 * breaks lockstep, and its `workspace:*` peers rewrite to `^0.1.0`, a range that
 * matches nothing on npm. `DUNX_VERSION` still overrides.
 */
const sharedVersion = (...packagesDirs: readonly string[]): string =>
  [...readWorkspaceVersions(...packagesDirs).values()].reduce(
    (highest, version) =>
      semver.order(version, highest) === 1 ? version : highest,
    '0.1.0',
  );
const DRY = process.env['DRY'] === 'true';
const NPM = 'bunx npm@11.10.1';

/**
 * Dependency order: a package is published after everything it references.
 *
 * Each entry is `<parent>/<dir>`, because published workspaces live under two
 * parents: `packages/` for the framework and `tools/` for the CLIs.
 */
const ORDER = [
  'packages/core',
  'packages/transform',
  'tools/create-app',
  'packages/http',
  'packages/infra',
  'packages/openapi',
  'packages/auth',
  'packages/testing',
  'tools/mcp',
];

const root = new URL('..', import.meta.url).pathname;

const VERSION =
  process.env['DUNX_VERSION'] ??
  sharedVersion(join(root, 'packages'), join(root, 'tools'));

type Manifest = { name: string; version: string } & Record<string, unknown>;

/**
 * The packument at `registry.npmjs.org/<name>` 404s for minutes after a brand-new
 * package is first published - CDN lag, not failure. The per-version document is
 * immediate and is what makes this script resumable: a rerun after a partial
 * failure skips what already went up instead of failing on it.
 */
const alreadyPublished = async (
  name: string,
  version: string,
): Promise<boolean> => {
  const url = `https://registry.npmjs.org/${name.replace('/', '%2f')}/${version}`;
  const response = await fetch(url, { method: 'HEAD' });
  return response.ok;
};

let publishedThisRun = 0;

for (const dir of ORDER) {
  const path = join(root, dir, 'package.json');
  const original = readFileSync(path, 'utf-8');
  const pkg = JSON.parse(original) as Manifest;

  if (!DRY && (await alreadyPublished(pkg.name, VERSION))) {
    console.log(`skipped ${pkg.name}@${VERSION} - already on npm`);
    continue;
  }

  // npm rate-limits bursts of new-package publishes with a 403 that reads like a
  // permissions error. Measured: four in a row went through, the fifth did not.
  if (publishedThisRun > 0 && !DRY) await Bun.sleep(5000);

  pkg.version = VERSION;
  // Every package in a first publish takes the same version, so the lookup is a
  // constant rather than a read of the workspace.
  resolveWorkspaceDeps(pkg, () => VERSION);
  assertNoWorkspaceRanges(pkg);

  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
  try {
    const flags = DRY ? '--dry-run' : '';
    // stdio is inherited, not piped. npm's 2FA is a browser flow that prints a
    // URL and then waits on the terminal - piping it makes the publish fail with
    // EOTP no matter what the user does.
    // No --provenance: it requires GITHUB_ACTIONS and errors anywhere else.
    const proc = Bun.spawnSync(
      [
        'sh',
        '-c',
        `cd ${join(root, dir)} && ${NPM} publish --access public ${flags}`,
      ],
      { stdout: 'inherit', stderr: 'inherit', stdin: 'inherit' },
    );
    if (proc.exitCode !== 0) {
      // `throw`, never `process.exit`: exit skips the `finally` below, which is
      // how an aborted run once left a manifest holding a resolved version where
      // `workspace:*` belongs - and that got committed.
      throw new Error(`${pkg.name} failed to publish`);
    }
    publishedThisRun += 1;
    console.log(
      `${DRY ? 'would publish' : 'published'} ${pkg.name}@${VERSION}`,
    );
  } catch (error) {
    console.error(`\nFAIL ${pkg.name} - stopping before the rest.`);
    throw error;
  } finally {
    // Restore the source manifest, keeping the new version.
    const restored = JSON.parse(original) as Manifest;
    restored.version = VERSION;
    writeFileSync(path, `${JSON.stringify(restored, null, 2)}\n`);
  }
}
