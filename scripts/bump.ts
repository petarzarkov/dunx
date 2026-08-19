import { execSync } from 'node:child_process';

/**
 * What the history says a release should be: whether to release at all, the bump
 * type, which packages are in scope, and the version arithmetic itself. Nothing
 * here publishes or writes a file, which is what lets the tests drive it directly.
 *
 * Every git call is wrapped: this runs in CI on a shallow checkout and on a
 * developer machine mid-rebase, and a failed `git log` must degrade to "patch, no
 * force publish" rather than abort a release.
 */

export type BumpType = 'major' | 'minor' | 'patch';

/**
 * The subject of the commit `pushVersionCommit` writes. It is the marker that ends
 * one release range and starts the next, which is why it is declared here and
 * imported by `version.ts` rather than written out twice.
 */
export const RELEASE_COMMIT_PREFIX = 'chore(release): bump version to';

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

/**
 * Whether this commit asks for a release, and what kind.
 *
 * `release: ...` releases and lets the range decide the bump. `release(major|minor|
 * patch): ...` states it outright, and `release!: ...` is major. Every other commit
 * on main runs CI and publishes nothing, which is the point: a release is a
 * deliberate act, not a side effect of merging.
 *
 * Only the **subject** is matched. A body that quotes the word would otherwise
 * publish, and the body is where a revert or a changelog paste puts it.
 */
export interface ReleaseTrigger {
  readonly release: boolean;
  /** An explicit bump, or `null` to derive one from the commits in the range. */
  readonly bump: BumpType | null;
}

const RELEASE_SUBJECT = /^release(?:\(([^)]*)\))?(!)?:\s*\S/;

/**
 * The prose a `release:` commit's subject carries, or `null` if it is not one.
 *
 * That sentence is the only human-written description of a release, so the
 * changelog uses it as the section's summary rather than deriving one.
 */
export const releaseSummary = (message: string): string | null => {
  const subject = message.split('\n', 1)[0]?.trim() ?? '';
  if (!RELEASE_SUBJECT.test(subject)) return null;
  return subject.slice(subject.indexOf(':') + 1).trim();
};

/**
 * The prose under a `release:` subject, which is the release note someone sat down
 * and wrote. `null` when the commit is not a release trigger or carries no body.
 *
 * The subject alone was the whole summary until 2.1.1, whose range held nothing but
 * the release commit: the section came out as one line, because the grouped entries
 * below it are built from the *other* commits in the range and there were none. A
 * release squashed into a single commit is a normal way to work, so the body it
 * carries is the only place its notes can come from.
 *
 * Avoid `#` and `##` headings in that body. They will render, but `##` is the level
 * the release headings themselves use, so a reader scanning the file sees them at
 * the same weight. `###` and below are fine.
 */
export const releaseNotes = (message: string): string | null => {
  const subject = message.split('\n', 1)[0]?.trim() ?? '';
  if (!RELEASE_SUBJECT.test(subject)) return null;

  const at = message.indexOf('\n');
  if (at === -1) return null;

  const body = message.slice(at + 1).trim();
  return body === '' ? null : body;
};

export const parseReleaseTrigger = (message: string): ReleaseTrigger => {
  const subject = message.split('\n', 1)[0]?.trim() ?? '';
  const match = RELEASE_SUBJECT.exec(subject);
  if (!match) return { release: false, bump: null };

  if (match[2]) return { release: true, bump: 'major' };

  const scope = match[1]?.trim().toLowerCase();
  if (scope === 'major' || scope === 'minor' || scope === 'patch') {
    return { release: true, bump: scope };
  }
  // Any other scope is a label, not an instruction. Every @dunx package shares one
  // version and ships together, so a package-named scope cannot mean "release only
  // this one" - the range decides the bump and the whole set goes out.
  return { release: true, bump: null };
};

/** A conventional-commit subject declaring a breaking change: `feat!:`, `fix(x)!:`. */
const BREAKING_SUBJECT = /^[a-z]+(?:\([^)]*\))?!:/;

/**
 * The highest bump any commit in the range asks for: one breaking change makes the
 * whole release major, one `feat` makes it minor, anything else is a patch.
 *
 * This is what batching requires. Reading only `HEAD` was correct when every push
 * published, and is silently wrong once a release covers a range - the release
 * commit itself is not a `feat`, so every batched release would have been a patch
 * no matter what it contained.
 */
export const bumpTypeFrom = (messages: readonly string[]): BumpType => {
  let highest: BumpType = 'patch';

  for (const message of messages) {
    const subject = message.split('\n', 1)[0]?.trim() ?? '';
    // Anchored to the subject, unlike the `includes('!:')` this replaced: a body
    // pasting a breaking commit's subject made an unrelated patch a major.
    if (BREAKING_SUBJECT.test(subject) || /^BREAKING CHANGE/m.test(message)) {
      return 'major';
    }
    if (extractCommitType(message) === 'feat') highest = 'minor';
  }

  return highest;
};

export const bumpVersion = (version: string, type: BumpType): string => {
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

export const determineBumpType = (): BumpType => {
  try {
    return bumpTypeFrom([lastCommitMessage()]);
  } catch (error) {
    console.warn(
      'Could not determine bump type from commit message, defaulting to patch',
      error,
    );
    return 'patch';
  }
};

/** Does this commit ask for a release? Reads the checked-out `HEAD`. */
export const getReleaseTrigger = (): ReleaseTrigger => {
  try {
    return parseReleaseTrigger(lastCommitMessage());
  } catch {
    return { release: false, bump: null };
  }
};

/**
 * The commit that ended the previous release range, or `null` when there is not one
 * in reach - a first release, or a shallow CI checkout that did not fetch far enough.
 * Callers fall back to `HEAD` alone, which under-reports rather than over-reports.
 */
export const lastReleaseSha = (): string | null => {
  try {
    const sha = execSync(
      `git log -1 --format=%H --fixed-strings --grep="${RELEASE_COMMIT_PREFIX}"`,
      { stdio: 'pipe' },
    )
      .toString()
      .trim();
    return sha || null;
  } catch {
    return null;
  }
};

/** One commit in a release range: what it says, and what to link it to. */
export interface CommitRecord {
  readonly sha: string;
  readonly message: string;
}

/**
 * Every commit since the last release, newest first, with its sha.
 *
 * The sha is here for the changelog, which links each entry back to the commit.
 * `bumpTypeFrom` reads only the messages, so `commitsSinceLastRelease` below
 * projects this rather than running a second `git log` with a second format
 * string that could disagree about the range.
 */
export const commitLogSinceLastRelease = (
  sha: string | null,
): CommitRecord[] => {
  const range = sha ? `${sha}..HEAD` : 'HEAD';
  try {
    // NUL-separated records, because a commit body contains newlines and blank
    // lines; the sha is split off by a unit separator, which a message cannot
    // contain.
    return execSync(`git log ${range} --pretty=format:%H%x1f%B%x00`, {
      stdio: 'pipe',
    })
      .toString()
      .split('\0')
      .map((record) => {
        const [sha = '', message = ''] = record.split('\x1f');
        return { sha: sha.trim(), message: message.trim() };
      })
      .filter((commit) => commit.sha !== '' && commit.message !== '');
  } catch {
    return [];
  }
};

/** Every commit message since the last release, newest first. */
export const commitsSinceLastRelease = (sha: string | null): string[] =>
  commitLogSinceLastRelease(sha).map((commit) => commit.message);

/**
 * Which published workspaces a list of changed files touches.
 *
 * Split out from the git call so the pattern is testable without a repository -
 * it is the only thing here that can silently skip a release, and it did: pinned
 * to `packages/` alone, a change under `tools/create-app/src` matched nothing and
 * the run reported "no src changes detected".
 *
 * Both published parents count, and only the paths that can change what a consumer
 * installs: `src/`, the manifest and the README. A test or a doc elsewhere in the
 * workspace is deliberately not a release.
 */
export const changedSrcPackages = (files: readonly string[]): Set<string> => {
  const dirs = new Set<string>();
  for (const file of files) {
    const match =
      /^(?:packages|tools)\/([^/]+)\/(src\/|frontend\/src\/|package\.json|README\.md)/.exec(
        file,
      );
    if (match?.[1]) dirs.add(match[1]);
  }
  return dirs;
};

/**
 * Which published workspaces changed since the last release.
 *
 * Ranged, for the same reason `bumpTypeFrom` is: a batched release's `HEAD` is the
 * `release:` commit itself, which touches no package at all. Diffing only `HEAD`
 * would report "no src changes detected" and skip every release that a batch was
 * meant to ship.
 *
 * `null` means "could not tell", which callers must read as "all of them".
 */
export const getChangedSrcPackages = (
  sha: string | null,
): Set<string> | null => {
  try {
    const command = sha
      ? `git diff --name-only ${sha}..HEAD`
      : 'git diff-tree --no-commit-id --name-only -r HEAD';
    const out = execSync(command, { stdio: 'pipe' }).toString().trim();

    // With no range there is nothing to conclude from an empty diff. With one, an
    // empty diff is the answer: nothing publishable moved.
    if (!out) return sha ? new Set<string>() : null;

    return changedSrcPackages(out.split('\n'));
  } catch {
    return null;
  }
};
