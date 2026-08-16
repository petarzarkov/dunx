import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  assertNoWorkspaceRanges,
  readWorkspaceVersions,
  resolveWorkspaceDeps,
} from './workspace-ranges.js';

/**
 * Everything that talks to npm. Split out of `version.ts` when that file crossed
 * the 500-line cap: the release flow and the registry interaction are two
 * concerns, and only this half needs the workspace-range rewriting.
 *
 * The workspace roots arrive as arguments rather than being read from a constant
 * here, so `version.ts` stays the one place that decides which parents publish.
 */

// Trusted publishing needs npm >= 11.5.1, and GitHub's ubuntu-latest image still
// ships npm 10.x. `bunx` fetches this exact version and runs it on bun's own
// runtime, so no Node install is needed anywhere in CI.
export const NPM = 'bunx npm@11.10.1';

export const isVersionPublished = (name: string, version: string): boolean => {
  try {
    const out = execSync(`${NPM} view ${name} versions --json`, {
      stdio: 'pipe',
    })
      .toString()
      .trim();
    // npm returns a single quoted string when only one version exists,
    // or a JSON array when multiple versions exist
    const parsed: string | string[] = JSON.parse(out);
    const versions = Array.isArray(parsed) ? parsed : [parsed];
    return versions.includes(version);
  } catch {
    return false;
  }
};

/**
 * `npm publish` leaves `workspace:` ranges untouched in the packed tarball (unlike
 * `bun publish`), so swap them for concrete ranges, publish, then put the source
 * package.json back exactly as it was - version bump included. The range policy
 * itself is in `workspace-ranges.ts`, shared with `first-publish.ts`.
 */
const withResolvedWorkspaceDeps = (
  pkgDir: string,
  workspaceRoots: readonly string[],
  publish: () => void,
): void => {
  const pkgJsonPath = join(pkgDir, 'package.json');
  const original = readFileSync(pkgJsonPath, 'utf-8');
  const pkg = JSON.parse(original);
  const versions = readWorkspaceVersions(...workspaceRoots);

  const rewritten = resolveWorkspaceDeps(pkg, (name) => versions.get(name));
  for (const line of rewritten) console.log(`  ${line}`);

  if (rewritten.length === 0) {
    assertNoWorkspaceRanges(pkg);
    publish();
    return;
  }

  writeFileSync(pkgJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
  try {
    assertNoWorkspaceRanges(pkg);
    publish();
  } finally {
    writeFileSync(pkgJsonPath, original);
  }
};

/**
 * Publishes with npm rather than bun: authentication happens through npm's OIDC
 * trusted publishing, which `bun publish` does not implement (oven-sh/bun#15601).
 *
 * `--provenance` only works on a supported CI, so it is left off local runs.
 */
export const publishPackage = (
  pkgDir: string,
  workspaceRoots: readonly string[],
  repo: string,
): void => {
  const provenance = process.env['GITHUB_ACTIONS'] ? ' --provenance' : '';

  withResolvedWorkspaceDeps(pkgDir, workspaceRoots, () => {
    try {
      execSync(`${NPM} publish --access public${provenance}`, {
        cwd: pkgDir,
        stdio: 'inherit',
      });
    } catch (error) {
      // Trusted publishing needs the package to have a trusted publisher pointing
      // at this repo + workflow, and the job needs `id-token: write`. npm answers
      // a PUT it won't authorize with 404 rather than 401/403, so an unhelpful
      // "404 Not Found" here is almost always missing/mismatched config.
      console.error(
        `\nPublish failed for ${basename(pkgDir)}. If this is a 404/E404, check the ` +
          `npm trusted publisher for this package: it must point at ` +
          `${repo} and the workflow ` +
          `file that runs this script. A package that has never been published ` +
          `needs one manual publish before a trusted publisher can be attached.\n`,
      );
      throw error;
    }
  });
};
