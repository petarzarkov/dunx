import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { semver } from 'bun';

const isDryRun = process.env['DRY_RUN'] === 'true';

const ROOT_DIR = resolve(import.meta.dir, '..');
const PACKAGES_DIR = join(ROOT_DIR, 'packages');

// Trusted publishing needs npm >= 11.5.1, and GitHub's ubuntu-latest image still
// ships npm 10.x. `bunx` fetches this exact version and runs it on bun's own
// runtime, so no Node install is needed anywhere in CI.
const NPM = 'bunx npm@11.10.1';
const WORKSPACE_PROTOCOL = 'workspace:';
const DEPENDENCY_FIELDS = [
  'dependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

const parseScopes = (raw: string): string[] =>
  raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const getForcePublishTarget = (): {
  force: boolean;
  packages: string[] | null;
} => {
  const envForce = process.env['FORCE_PUBLISH'];
  if (envForce === 'true') return { force: true, packages: null };
  if (envForce && envForce !== 'false')
    return { force: true, packages: parseScopes(envForce) };

  try {
    const commitMessage = execSync('git log -1 --pretty=format:"%s%n%b"', {
      stdio: 'pipe',
    })
      .toString()
      .trim();

    const scopedMatch = commitMessage.match(/\[force-publish:([^\]]+)\]/);
    if (scopedMatch && scopedMatch[1])
      return { force: true, packages: parseScopes(scopedMatch[1]) };
    if (commitMessage.includes('[force-publish]'))
      return { force: true, packages: null };

    return { force: false, packages: null };
  } catch {
    return { force: false, packages: null };
  }
};

const forcePublish = getForcePublishTarget();

export const bumpVersion = (
  version: string,
  type: 'major' | 'minor' | 'patch',
): string => {
  const parts = version.split('.').map(Number);
  const [major, minor, patch] = parts;

  // Validated once, on integer-ness. The previous per-case `!major` / `!minor` /
  // `!patch` guards were meant to catch NaN, but 0 is falsy too, so every bump of
  // a version with a zero component threw — including 1.2.0 -> 1.2.1.
  if (
    parts.length !== 3 ||
    major === undefined ||
    minor === undefined ||
    patch === undefined ||
    !parts.every((part) => Number.isInteger(part) && part >= 0)
  ) {
    throw new Error(`Invalid version: ${version}`);
  }

  switch (type) {
    case 'major':
      return `${major + 1}.0.0`;
    case 'minor':
      return `${major}.${minor + 1}.0`;
    case 'patch':
      return `${major}.${minor}.${patch + 1}`;
    default:
      throw new Error(`Invalid bump type: ${String(type)}`);
  }
};

const extractCommitType = (message: string): string | null => {
  // Handle squashed merge commits: "Merge pull request #123 from branch\n\nfeat: message"
  // or "feat(scope): message (#123)"
  const mergeMatch = message.match(
    /(?:Merge.*?\n\n?)?(?:^|\n)(feat|fix|chore|docs|test|style|refactor|perf|build|ci|revert|security|sync)(?:\([^)]+\))?(!)?: /m,
  );

  if (mergeMatch && mergeMatch[1]) {
    return mergeMatch[1];
  }

  return null;
};

const determineBumpType = (): 'major' | 'minor' | 'patch' => {
  try {
    const commitMessage = execSync('git log -1 --pretty=format:"%s%n%b"', {
      stdio: 'pipe',
    })
      .toString()
      .trim();

    if (
      commitMessage.includes('!:') ||
      commitMessage.includes('BREAKING CHANGE')
    ) {
      return 'major';
    }

    const commitType = extractCommitType(commitMessage);

    if (commitType === 'feat') {
      return 'minor';
    }

    return 'patch';
  } catch (error) {
    console.warn(
      'Could not determine bump type from commit message, defaulting to patch',
      error,
    );
    return 'patch';
  }
};

const getChangedSrcPackages = (): Set<string> | null => {
  try {
    const out = execSync('git diff-tree --no-commit-id --name-only -r HEAD', {
      stdio: 'pipe',
    })
      .toString()
      .trim();

    if (!out) return null;

    const dirs = new Set<string>();
    for (const file of out.split('\n')) {
      const match = file.match(
        /^packages\/([^/]+)\/(src\/|frontend\/src\/|package\.json|README\.md)/,
      );
      if (match && match[1]) dirs.add(match[1]);
    }
    return dirs;
  } catch {
    return null;
  }
};

const findPublishablePackages = (): {
  name: string;
  dir: string;
  packageJsonPath: string;
}[] => {
  const entries = readdirSync(PACKAGES_DIR, {
    withFileTypes: true,
  });
  const packages: {
    name: string;
    dir: string;
    packageJsonPath: string;
  }[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pkgJsonPath = join(PACKAGES_DIR, entry.name, 'package.json');
    if (!existsSync(pkgJsonPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
    if (pkg.private) continue;
    packages.push({
      name: pkg.name,
      dir: join(PACKAGES_DIR, entry.name),
      packageJsonPath: pkgJsonPath,
    });
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

const readWorkspaceVersions = (): Map<string, string> => {
  const versions = new Map<string, string>();

  for (const entry of readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgJsonPath = join(PACKAGES_DIR, entry.name, 'package.json');
    if (!existsSync(pkgJsonPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
    if (pkg.name && pkg.version) versions.set(pkg.name, pkg.version);
  }

  return versions;
};

/**
 * The last thing between a `workspace:` range and a published tarball.
 *
 * `npm publish` copies these ranges verbatim, so a package shipped with
 * `"@dunx/core": "workspace:*"` fails to install for every consumer. The rewrite
 * above is the mechanism that prevents it — this asserts the mechanism actually
 * ran, because it only runs on the `publishPackage` path, and the first publish
 * of a package has to be done by hand (OIDC trusted publishing cannot attach to a
 * package that does not exist yet). That manual path is exactly where this would
 * otherwise slip through, and it now spans five packages rather than one since
 * `@dunx/core` and `@dunx/http` became peers.
 */
export const assertNoWorkspaceRanges = (pkg: {
  name?: string;
  [field: string]: unknown;
}): void => {
  const offenders: string[] = [];
  for (const field of DEPENDENCY_FIELDS) {
    const deps = pkg[field] as Record<string, string> | undefined;
    if (!deps) continue;
    for (const [name, range] of Object.entries(deps)) {
      if (range.startsWith(WORKSPACE_PROTOCOL)) {
        offenders.push(`${field}.${name} = "${range}"`);
      }
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      `Refusing to publish ${pkg.name ?? 'package'}: unresolved workspace ` +
        `ranges would ship and break every consumer install — ` +
        offenders.join(', '),
    );
  }
};

/**
 * `npm publish` leaves `workspace:` ranges untouched in the packed tarball (unlike
 * `bun publish`), so swap them for concrete ranges, publish, then put the source
 * package.json back exactly as it was — version bump included.
 */
const withResolvedWorkspaceDeps = (pkgDir: string, publish: () => void) => {
  const pkgJsonPath = join(pkgDir, 'package.json');
  const original = readFileSync(pkgJsonPath, 'utf-8');
  const pkg = JSON.parse(original);
  const versions = readWorkspaceVersions();
  let resolvedAny = false;

  for (const field of DEPENDENCY_FIELDS) {
    const deps: Record<string, string> | undefined = pkg[field];
    if (!deps) continue;

    for (const [name, range] of Object.entries(deps)) {
      if (!range.startsWith(WORKSPACE_PROTOCOL)) continue;

      const version = versions.get(name);
      if (!version) {
        throw new Error(
          `${pkg.name} depends on ${name} via "${range}" but no workspace package named ${name} was found`,
        );
      }

      const specifier = range.slice(WORKSPACE_PROTOCOL.length);
      deps[name] =
        specifier === '*' || specifier === ''
          ? version
          : `${specifier}${version}`;
      resolvedAny = true;
      console.log(`  ${name}: ${range} -> ${deps[name]}`);
    }
  }

  if (!resolvedAny) {
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
  execSync(`git add ${bumpedFiles.join(' ')}`);

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
  // later `@dunx/infra@0.3.0` pinned `@dunx/core@0.2.0` — and an app using both
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
  // needs a range policy first — see docs/ROADMAP.md item 1. The build ordering
  // that used to block peers is fixed: `bun run build` is `scripts/build-all.ts`,
  // which orders by peerDependencies and devDependencies too. Re-measured on a
  // clean tree — the old `--filter '*' build` still fails with TS7016, the new one
  // does not.
  //
  // Cost: an untouched package still gets a version. For a pre-1.0 framework whose
  // packages move together that is a feature — one number answers "which versions
  // work together".
  if (changedSrcPackages !== null) {
    console.log(
      `Releasing all ${allPackages.length} packages in lockstep (changed: ${[...changedSrcPackages].join(', ')})`,
    );
  }

  const bumpedPackages = applyVersionBumps(allPackages, bumpType);

  if (isDryRun || bumpedPackages.length === 0) return;

  // Publish BEFORE committing/pushing the bump. If publish fails, main is left
  // untouched so the next run retries the same bump cleanly — a committed-but-
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

// Guarded so the pure helpers above can be imported by a test without the script
// running its whole publish flow.
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
