/**
 * The git tag and GitHub release a publish leaves behind.
 *
 * Neither existed: `bun run version` bumped manifests, wrote `CHANGELOG.md`,
 * published to npm and pushed one commit, so `git tag -l` was empty across every
 * release and the repo's Releases page held nothing to link from.
 *
 * The notes are **read back** from `CHANGELOG.md` rather than re-rendered from the
 * commit range. `scripts/changelog.ts` already owns that format in both directions,
 * and a second renderer here is how the tag, the file and the site would come to
 * disagree about what shipped.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { CHANGELOG_PATH, parseChangelog } from './changelog.js';

/** `v` prefixed, which is the form `internal/docs`'s release route strips. */
export const tagFor = (version: string): string => `v${version}`;

/**
 * The page that renders one release, derived from `owner/repo` so a fork points at
 * its own Pages site rather than this one. Mirrors `internal/docs`'s hash route and
 * its `/dunx/` base.
 */
export const releasePageUrl = (repo: string, version: string): string => {
  const [owner = '', name = ''] = repo.split('/');
  return `https://${owner}.github.io/${name}/#/releases/${version}`;
};

/**
 * A release's notes: the changelog section for that version, then a link to the
 * page. A version with no section still gets the link, because a `[force-publish]`
 * run has no commit range to describe and should not fail over it.
 */
export const releaseBody = (
  changelog: string,
  version: string,
  pageUrl: string,
): string => {
  const section = parseChangelog(changelog).find(
    (release) => release.version === version,
  );
  const body = section?.body.trim();
  return `${body ? `${body}\n\n` : ''}[Full release notes](${pageUrl})`;
};

const remoteFor = (repo: string, token: string | undefined): string =>
  token ? `https://x-access-token:${token}@github.com/${repo}.git` : 'origin';

const tagExists = (tag: string): boolean => {
  try {
    execSync(`git rev-parse -q --verify refs/tags/${tag}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

/**
 * Annotated and pushed, on whatever commit is checked out - which is the release
 * commit, since this runs after it. Skipped when the tag is already there, so a
 * rerun after a partial failure is not an error.
 */
export const pushTag = (version: string, repo: string): void => {
  const tag = tagFor(version);
  if (tagExists(tag)) {
    console.log(`Tag ${tag} already exists, skipping`);
    return;
  }

  execSync(`git tag -a ${tag} -m "${tag}"`);
  execSync(
    `git push ${remoteFor(repo, process.env['GITHUB_TOKEN'])} refs/tags/${tag}`,
  );
  console.log(`Tagged ${tag}`);
};

const API_HEADERS = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'dunx-release-script',
});

/**
 * Creates the GitHub release, or reports why it did not.
 *
 * `fetch` against the REST API rather than the `gh` CLI: `gh` is one more tool to
 * have installed and nothing else in `scripts/` depends on it, while `fetch` is
 * native. Needs `contents: write`, which `ci.yml`'s publishing job already has.
 *
 * A missing token is not a failure. A local `bun run version` has no
 * `GITHUB_TOKEN`, and refusing to finish a publish over the notes would be worse
 * than leaving them to be written by hand.
 */
export const createGitHubRelease = async (
  version: string,
  repo: string,
): Promise<void> => {
  const token = process.env['GITHUB_TOKEN'];
  if (!token) {
    console.log('No GITHUB_TOKEN, skipping the GitHub release');
    return;
  }

  const tag = tagFor(version);
  const base = `https://api.github.com/repos/${repo}/releases`;
  const headers = API_HEADERS(token);

  const existing = await fetch(`${base}/tags/${tag}`, { headers });
  if (existing.ok) {
    console.log(`GitHub release ${tag} already exists, skipping`);
    return;
  }

  const response = await fetch(base, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      tag_name: tag,
      name: tag,
      body: releaseBody(
        readFileSync(CHANGELOG_PATH, 'utf-8'),
        version,
        releasePageUrl(repo, version),
      ),
      draft: false,
      prerelease: false,
    }),
  });

  if (!response.ok) {
    // Reported rather than thrown: the packages are already on npm by this point,
    // and failing the job here would make a successful publish look broken.
    console.error(
      `GitHub release ${tag} failed: ${response.status} ${await response.text()}`,
    );
    return;
  }

  console.log(`Created GitHub release ${tag}`);
};
