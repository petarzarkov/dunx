import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { semver } from 'bun';
import {
  bumpTypeFrom,
  bumpVersion,
  commitLogSinceLastRelease,
  determineBumpType,
  getChangedSrcPackages,
  getForcePublishTarget,
  getReleaseTrigger,
  lastReleaseSha,
  RELEASE_COMMIT_PREFIX,
  type CommitRecord,
  type ReleaseTrigger,
} from './bump.js';
import {
  CHANGELOG_PATH,
  parseChangelog,
  prependRelease,
  renderRelease,
} from './changelog.js';
import { createGitHubRelease, pushTag } from './github-release.js';
import { isVersionPublished, publishPackage } from './publish.js';

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

/** What `publish.ts` resolves a `workspace:` range against. */
const WORKSPACE_ROOTS = PUBLISHABLE_DIRS.map((dir) => join(ROOT_DIR, dir));

const REPO = process.env['GITHUB_REPOSITORY'] ?? 'petarzarkov/dunx';
const REPO_URL = `https://github.com/${REPO}`;

const publish = (pkgDir: string): void =>
  publishPackage(pkgDir, WORKSPACE_ROOTS, REPO);

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
): {
  /** The one version every package was moved to, whether or not anything was
   * written - a dry run needs it to name the changelog section it previews. */
  version: string;
  bumped: { packageJsonPath: string; dir: string }[];
} => {
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

  return { version: shared, bumped };
};

/**
 * The release's section, prepended to the root `CHANGELOG.md`.
 *
 * Written from the same commit range the bump was derived from, so the file can
 * never describe a different set of commits than the version it names. Returns
 * the path so the release commit can stage it.
 *
 * A section for this version already present means a previous run wrote it and
 * failed before committing; re-running must not append a second copy.
 */
const writeChangelog = (
  version: string,
  commits: readonly CommitRecord[],
): string => {
  const path = join(ROOT_DIR, CHANGELOG_PATH);
  const existing = existsSync(path) ? readFileSync(path, 'utf-8') : '';

  if (parseChangelog(existing).some((release) => release.version === version)) {
    console.log(
      `${CHANGELOG_PATH} already has a ${version} section, leaving it.`,
    );
    return path;
  }

  const section = renderRelease({
    version,
    date: new Date().toISOString().slice(0, 10),
    commits,
    repoUrl: REPO_URL,
  });

  if (isDryRun) {
    console.log(
      `\n[DRY RUN] Would prepend to ${CHANGELOG_PATH}:\n\n${section}`,
    );
    return path;
  }

  writeFileSync(path, prependRelease(existing, section));
  console.log(`Wrote the ${version} section of ${CHANGELOG_PATH}`);
  return path;
};

const pushVersionCommit = (
  bumpedFiles: string[],
  /** Anything else the release wrote. The version is still read from the first
   * manifest, so these never lead the list. */
  extraFiles: string[] = [],
): void => {
  // bun.lock records every workspace's version, so a bump leaves it a release
  // behind and the next `bun install` anywhere rewrites it as an unrelated diff.
  execSync('bun install --lockfile-only', { stdio: 'inherit' });
  execSync(`git add ${[...bumpedFiles, ...extraFiles].join(' ')} bun.lock`);

  const path = bumpedFiles[0];
  if (!path) {
    throw new Error(`No path in bumpedFiles: ${bumpedFiles.join(', ')}`);
  }
  const pkg = JSON.parse(readFileSync(path, 'utf-8'));
  const commitMessage = `${RELEASE_COMMIT_PREFIX} ${pkg.version} [skip ci]`;
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
    execSync(
      `git push https://x-access-token:${token}@github.com/${REPO}.git HEAD:refs/heads/${branch}`,
    );
  } else {
    execSync(`git push origin HEAD:refs/heads/${branch}`);
  }

  console.log(`Successfully pushed version ${pkg.version}`);
};

interface PublishablePackage {
  name: string;
  dir: string;
  packageJsonPath: string;
}

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
    publish(dir);
  }

  if (bumpedFiles.length > 0) {
    console.log('Committing version changes...');
    pushVersionCommit(bumpedFiles);
  }
};

const runVersionBump = async (
  allPackages: PublishablePackage[],
  trigger: ReleaseTrigger,
): Promise<void> => {
  // One marker read, shared by both range queries below, so the bump and the change
  // detection can never disagree about which commits this release covers.
  const since = lastReleaseSha();
  const changedSrcPackages = getChangedSrcPackages(since);

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

  // An explicit `release(minor):` wins outright. Otherwise every commit back to the
  // last release votes, and the highest wins - so a `feat!:` batched behind three
  // `fix:`es still produces a major.
  const commits = commitLogSinceLastRelease(since);
  const bumpType =
    trigger.bump ?? bumpTypeFrom(commits.map((commit) => commit.message));
  console.log(
    trigger.bump
      ? `Version bump type: ${bumpType} (stated by the release commit)`
      : `Version bump type: ${bumpType} (from ${commits.length} commit(s) since ${since ? since.slice(0, 7) : 'the start of history'})`,
  );

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

  const { version, bumped: bumpedPackages } = applyVersionBumps(
    allPackages,
    bumpType,
  );

  const changelogPath = writeChangelog(version, commits);

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
    publish(dir);
  }

  console.log('Committing version changes...');
  pushVersionCommit(
    bumpedPackages.map((p) => p.packageJsonPath),
    [changelogPath],
  );

  // After the commit, so the tag names it. Both steps are idempotent and neither
  // throws: the packages are on npm by now, and a job that failed here would make
  // a finished publish look broken.
  pushTag(version, REPO);
  await createGitHubRelease(version, REPO);
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
      return;
    }

    // The gate. Publishing used to be a side effect of merging to main, which shipped
    // 33 versions and six breaking changes in six days - churn that reads as
    // instability to anyone deciding whether to depend on this. A release is now an
    // explicit commit, and everything else on main just runs CI and deploys the docs.
    const trigger = getReleaseTrigger();
    if (!trigger.release) {
      console.log(
        'Not a release commit, skipping publish.\n' +
          '  Release with a `release:` commit on main:\n' +
          '    release: <summary>          bump derived from the commits since the last release\n' +
          '    release(major|minor|patch): <summary>   bump stated outright\n' +
          '    release!: <summary>         major',
      );
      process.exit(0);
    }

    await runVersionBump(allPublishablePackages, trigger);
  } catch (error) {
    console.error('Failed to process packages:', error);
    process.exit(1);
  }
})();
