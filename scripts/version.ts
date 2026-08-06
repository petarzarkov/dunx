import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { semver } from 'bun';
import {
  bumpVersion,
  determineBumpType,
  getChangedSrcPackages,
  getForcePublishTarget,
} from './bump.js';
import {
  assertNoWorkspaceRanges,
  readWorkspaceVersions,
  resolveWorkspaceDeps,
} from './workspace-ranges.js';

const isDryRun = process.env['DRY_RUN'] === 'true';

const ROOT_DIR = resolve(import.meta.dir, '..');
/**
 * Every directory that can hold a **published** workspace.
 *
 * `tools/` used to be private-only and is not any more: `@dunx/create-app` and
 * `@dunx/mcp` are CLIs rather than framework packages, so they live there and still
 * publish. `internal/` is the private half - the docs site, the benchmark harness,
 * the OpenAPI explorer bundle and the shared frontend - and is deliberately absent
 * from this list. A `private: true` manifest is still what actually decides, so a
 * mistake in either direction is caught by the filter below rather than by this
 * array.
 */
const PUBLISHABLE_DIRS = ['packages', 'tools'] as const;

// Trusted publishing needs npm >= 11.5.1, and GitHub's ubuntu-latest image still
// ships npm 10.x. `bunx` fetches this exact version and runs it on bun's own
// runtime, so no Node install is needed anywhere in CI.
const NPM = 'bunx npm@11.10.1';

const forcePublish = getForcePublishTarget();

const findPublishablePackages = (): {
  name: string;
  dir: string;
  packageJsonPath: string;
}[] => {
  const packages: {
    name: string;
    dir: string;
    packageJsonPath: string;
  }[] = [];

  for (const parent of PUBLISHABLE_DIRS) {
    const parentDir = join(ROOT_DIR, parent);
    if (!existsSync(parentDir)) continue;
    for (const entry of readdirSync(parentDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkgJsonPath = join(parentDir, entry.name, 'package.json');
      if (!existsSync(pkgJsonPath)) continue;
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
      if (pkg.private) continue;
      packages.push({
        name: pkg.name,
        dir: join(parentDir, entry.name),
        packageJsonPath: pkgJsonPath,
      });
    }
  }

  return packages;
};

const applyVersionBumps = (
  packages: {
    name: string;
    dir: string;
    packageJsonPath: string;
  }[],
  bumpType: 'major' | 'minor' | 'patch',
): { packageJsonPath: string; dir: string }[] => {
  const bumped: {
    packageJsonPath: string;
    dir: string;
  }[] = [];

  // One target for all of them: the highest version present, bumped once. Taking
  // the highest rather than each package's own is what keeps them in lockstep when
  // a previous run published some and failed on others.
  const highest = packages
    .map(({ packageJsonPath }) => {
      const { version } = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
      return typeof version === 'string' ? version : '0.0.0';
    })
    .reduce(
      (max, version) => (semver.order(version, max) === 1 ? version : max),
      '0.0.0',
    );
  const shared = bumpVersion(highest, bumpType);

  for (const { name, dir, packageJsonPath } of packages) {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    const oldVersion = pkg.version;

    if (!oldVersion) {
      console.warn(`No version found in ${name}. Skipping.`);
      continue;
    }

    const newVersion = shared;

    if (semver.order(newVersion, oldVersion) !== 1) {
      console.warn(
        `Skipping ${name}: new version ${newVersion} is not greater than ${oldVersion}`,
      );
      continue;
    }

    pkg.version = newVersion;

    if (!isDryRun) {
      writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
      bumped.push({ packageJsonPath, dir });
      console.log(`Bumped ${name} from ${oldVersion} to ${newVersion}`);
    } else {
      console.log(
        `[DRY RUN] Would bump ${name} from ${oldVersion} to ${newVersion}`,
      );
    }
  }

  return bumped;
};

/**
 * `npm publish` leaves `workspace:` ranges untouched in the packed tarball (unlike
 * `bun publish`), so swap them for concrete ranges, publish, then put the source
 * package.json back exactly as it was - version bump included. The range policy
 * itself is in `workspace-ranges.ts`, shared with `first-publish.ts`.
 */
const withResolvedWorkspaceDeps = (pkgDir: string, publish: () => void) => {
  const pkgJsonPath = join(pkgDir, 'package.json');
  const original = readFileSync(pkgJsonPath, 'utf-8');
  const pkg = JSON.parse(original);
  const versions = readWorkspaceVersions(
    ...PUBLISHABLE_DIRS.map((dir) => join(ROOT_DIR, dir)),
  );

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

const pushVersionCommit = (bumpedFiles: string[]): void => {
  // bun.lock records every workspace's version, so a bump leaves it a release
  // behind and the next `bun install` anywhere rewrites it as an unrelated diff.
  execSync('bun install --lockfile-only', { stdio: 'inherit' });
  execSync(`git add ${bumpedFiles.join(' ')} bun.lock`);

  const path = bumpedFiles[0];
  if (!path) {
    throw new Error(`No path in bumpedFiles: ${bumpedFiles.join(', ')}`);
  }
  const pkg = JSON.parse(readFileSync(path, 'utf-8'));
  const commitMessage = `chore(release): bump version to ${pkg.version} [skip ci]`;
  execSync(`git commit -m "${commitMessage}" --no-verify`);

  const branch =
    process.env['GITHUB_REF_NAME'] ??
    execSync('git branch --show-current').toString().trim();

  if (!branch) {
    throw new Error('Unable to determine branch for pushing release commit.');
  }

  console.log(`Pushing to branch: ${branch}`);
  const token = process.env['GITHUB_TOKEN'];
  if (token) {
    const repo = process.env['GITHUB_REPOSITORY'] ?? 'petarzarkov/dunx';
    execSync(
      `git push https://x-access-token:${token}@github.com/${repo}.git HEAD:refs/heads/${branch}`,
    );
  } else {
    execSync(`git push origin HEAD:refs/heads/${branch}`);
  }

  console.log(`Successfully pushed version ${pkg.version}`);
};

/**
 * Publishes with npm rather than bun: authentication happens through npm's OIDC
 * trusted publishing, which `bun publish` does not implement (oven-sh/bun#15601).
 *
 * `--provenance` only works on a supported CI, so it is left off local runs.
 */
const publishPackage = (pkgDir: string): void => {
  const provenance = process.env['GITHUB_ACTIONS'] ? ' --provenance' : '';

  withResolvedWorkspaceDeps(pkgDir, () => {
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
          `${process.env['GITHUB_REPOSITORY'] ?? 'petarzarkov/dunx'} and the workflow ` +
          `file that runs this script. A package that has never been published ` +
          `needs one manual publish before a trusted publisher can be attached.\n`,
      );
      throw error;
    }
  });
};

interface PublishablePackage {
  name: string;
  dir: string;
  packageJsonPath: string;
}

const isVersionPublished = (name: string, version: string): boolean => {
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

const runForcePublish = (
  packages: PublishablePackage[],
  targetPackages: string[] | null,
): void => {
  const filtered = targetPackages
    ? packages.filter(
        (pkg) =>
          targetPackages.includes(basename(pkg.dir)) ||
          targetPackages.includes(pkg.name),
      )
    : packages;

  if (targetPackages) {
    console.log(
      `\n--- FORCE PUBLISH MODE: publishing ${targetPackages.join(', ')} at current version ---\n`,
    );
  } else {
    console.log(
      '\n--- FORCE PUBLISH MODE: publishing all packages at current versions ---\n',
    );
  }

  if (filtered.length === 0) {
    console.log(
      targetPackages
        ? `Package(s) "${targetPackages.join(', ')}" not found.`
        : 'No publishable packages found.',
    );
    process.exit(0);
  }

  const bumpType = determineBumpType();
  const bumpedFiles: string[] = [];
  const toPublish: { name: string; dir: string; version: string }[] = [];

  // Bump pass: write every version bump before publishing anything, so a package
  // that depends on another bumped here resolves the new version, not the old one.
  for (const { name, dir, packageJsonPath } of filtered) {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    let { version } = pkg;

    if (isVersionPublished(name, version)) {
      const newVersion = bumpVersion(version, bumpType);
      console.log(
        `${name}@${version} already published, bumping to ${newVersion}`,
      );
      pkg.version = newVersion;
      version = newVersion;

      if (!isDryRun) {
        writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
        bumpedFiles.push(packageJsonPath);
      }
    }

    toPublish.push({ name, dir, version });
  }

  if (isDryRun) {
    for (const { name, version } of toPublish) {
      console.log(`[DRY RUN] Would publish ${name}@${version}`);
    }
    return;
  }

  for (const { name, dir, version } of toPublish) {
    console.log(`Publishing ${name}@${version}...`);
    publishPackage(dir);
  }

  if (bumpedFiles.length > 0) {
    console.log('Committing version changes...');
    pushVersionCommit(bumpedFiles);
  }
};

const runVersionBump = (allPackages: PublishablePackage[]): void => {
  const changedSrcPackages = getChangedSrcPackages();

  if (changedSrcPackages !== null && changedSrcPackages.size === 0) {
    console.log('No src changes detected, skipping version bump.');
    process.exit(0);
  }

  if (changedSrcPackages !== null) {
    console.log(
      `Detected src changes in: ${[...changedSrcPackages].join(', ')}`,
    );
  } else {
    console.log('Could not determine changed packages, processing all.');
  }

  const bumpType = determineBumpType();
  console.log(`Determined version bump type: ${bumpType}`);

  // **Lockstep: every @dunx package shares one version and ships together**, even
  // the ones this commit did not touch. Change detection above decides *whether*
  // to release, never *what* to release.
  //
  // This is a correctness requirement, not tidiness. `version.ts` rewrites a
  // `workspace:*` range to the dependency's exact version at publish time, so with
  // independent versions `@dunx/http@0.2.0` would pin `@dunx/core@0.1.0` while a
  // later `@dunx/infra@0.3.0` pinned `@dunx/core@0.2.0` - and an app using both
  // would install **two copies of @dunx/core**. In this container a token *is* a
  // class object, so two copies means two distinct `Logger` classes and
  // `app.get(Logger)` silently missing the binding another package registered.
  // `Symbol.for('dunx.deps')` already survives duplicate copies on purpose; class
  // identity cannot.
  //
  // Caret ranges do not save it: pre-1.0, `^0.1.0` excludes `0.2.0`, so a minor
  // bump of core would still fragment the graph.
  //
  // `@dunx/core` and `@dunx/http` **are** peers now, which is a second guarantee
  // rather than a replacement for this one: a peer cannot be duplicated by the
  // installer, and lockstep keeps the exact version this script writes into it
  // coherent. Independent versions on top of peers is the remaining prize and
  // needs a range policy first - see docs/ROADMAP.md item 1. The build ordering
  // that used to block peers is fixed: `bun run build` is `scripts/build-all.ts`,
  // which orders by peerDependencies and devDependencies too. Re-measured on a
  // clean tree - the old `--filter '*' build` still fails with TS7016, the new one
  // does not.
  //
  // Cost: an untouched package still gets a version. For a pre-1.0 framework whose
  // packages move together that is a feature - one number answers "which versions
  // work together".
  if (changedSrcPackages !== null) {
    console.log(
      `Releasing all ${allPackages.length} packages in lockstep (changed: ${[...changedSrcPackages].join(', ')})`,
    );
  }

  const bumpedPackages = applyVersionBumps(allPackages, bumpType);

  if (isDryRun || bumpedPackages.length === 0) return;

  // Publish BEFORE committing/pushing the bump. If publish fails, main is left
  // untouched so the next run retries the same bump cleanly - a committed-but-
  // unpublished version would otherwise be orphaned ([skip ci] + diff-based
  // change detection means it never gets republished). The isVersionPublished
  // guard makes reruns idempotent and lets a failed-push-after-publish recover.
  console.log('Publishing bumped packages...');
  for (const { dir, packageJsonPath } of bumpedPackages) {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    if (isVersionPublished(pkg.name, pkg.version)) {
      console.log(`${pkg.name}@${pkg.version} already published, skipping`);
      continue;
    }
    console.log(`Publishing ${basename(dir)}...`);
    publishPackage(dir);
  }

  console.log('Committing version changes...');
  pushVersionCommit(bumpedPackages.map((p) => p.packageJsonPath));
};

// Guarded so importing this file cannot start a publish. The pure helpers moved to
// `bump.ts` and `workspace-ranges.ts`, which is where the tests import from - this
// file is now only the flow that stitches them together.
void (async () => {
  if (!import.meta.main) return;
  if (isDryRun) {
    console.log('\n--- DRY RUN MODE ENABLED ---\n');
  }

  const allPublishablePackages = findPublishablePackages();

  try {
    if (forcePublish.force) {
      runForcePublish(allPublishablePackages, forcePublish.packages);
    } else {
      runVersionBump(allPublishablePackages);
    }
  } catch (error) {
    console.error('Failed to process packages:', error);
    process.exit(1);
  }
})();
