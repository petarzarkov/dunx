import { execSync } from 'node:child_process';

/**
 * What the last commit says a release should be: the bump type, which packages are
 * in scope, and the version arithmetic itself. Nothing here publishes or writes a
 * file, which is what lets `version.test.ts` drive it directly.
 *
 * Every git call is wrapped: this runs in CI on a shallow checkout and on a
 * developer machine mid-rebase, and a failed `git log` must degrade to "patch, no
 * force publish" rather than abort a release.
 */
const parseScopes = (raw: string): string[] =>
  raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const lastCommitMessage = (): string =>
  execSync('git log -1 --pretty=format:"%s%n%b"', { stdio: 'pipe' })
    .toString()
    .trim();

export const getForcePublishTarget = (): {
  force: boolean;
  packages: string[] | null;
} => {
  const envForce = process.env['FORCE_PUBLISH'];
  if (envForce === 'true') return { force: true, packages: null };
  if (envForce && envForce !== 'false')
    return { force: true, packages: parseScopes(envForce) };

  try {
    const commitMessage = lastCommitMessage();

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

export const bumpVersion = (
  version: string,
  type: 'major' | 'minor' | 'patch',
): string => {
  const parts = version.split('.').map(Number);
  const [major, minor, patch] = parts;

  // Validated once, on integer-ness. The previous per-case `!major` / `!minor` /
  // `!patch` guards were meant to catch NaN, but 0 is falsy too, so every bump of
  // a version with a zero component threw - including 1.2.0 -> 1.2.1.
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

export const determineBumpType = (): 'major' | 'minor' | 'patch' => {
  try {
    const commitMessage = lastCommitMessage();

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

/** `null` means "could not tell", which callers must read as "all of them". */
export const getChangedSrcPackages = (): Set<string> | null => {
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
