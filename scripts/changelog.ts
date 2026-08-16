import {
  RELEASE_COMMIT_PREFIX,
  releaseSummary,
  type CommitRecord,
} from './bump.js';

/**
 * The changelog `version.ts` writes and the documentation site reads.
 *
 * Both directions live here so the format is declared once: `renderRelease` turns
 * a release range into a section, `parseChangelog` splits the file back into
 * sections. The site parses only the heading line and hands the body to its own
 * markdown renderer, so a change to how an entry is written needs nothing on the
 * reading side.
 *
 * Nothing here touches git or the filesystem, which is what lets the tests drive
 * it with a list of commits.
 */

export interface ReleaseSection {
  readonly version: string;
  /** `YYYY-MM-DD`. */
  readonly date: string;
  /** Markdown between this release's heading and the next one. */
  readonly body: string;
}

export const CHANGELOG_PATH = 'CHANGELOG.md';

export const CHANGELOG_HEADER = `# Changelog

Every release, newest first. Written by \`bun run version\` from the commits in the
release range. Every @dunx package shares one version and ships together, so a
release covers all of them.
`;

/** `## 2.0.1 - 2026-08-09` */
const RELEASE_HEADING = /^## (\d+\.\d+\.\d+) - (\d{4}-\d{2}-\d{2})\s*$/;

/** `feat(http)!: summary` */
const SUBJECT = /^([a-z]+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/;

/** A trailing `(#123)` a squash merge appends to the subject. */
const PR_SUFFIX = /\s*\(#(\d+)\)\s*$/;

/**
 * Which heading each conventional type lands under, in the order they are
 * written. `other` is the catch-all: a commit with no recognised type still
 * appears, because a changelog that silently drops what it did not understand is
 * worse than one with an untidy last section.
 */
const GROUPS: readonly (readonly [string, string])[] = [
  ['breaking', 'Breaking changes'],
  ['feat', 'Features'],
  ['fix', 'Fixes'],
  ['perf', 'Performance'],
  ['refactor', 'Refactors'],
  ['docs', 'Documentation'],
  ['other', 'Other changes'],
];

const GROUP_KEYS = new Set(GROUPS.map(([key]) => key));

interface Entry {
  readonly group: string;
  readonly scope: string | null;
  readonly summary: string;
  readonly pr: string | null;
  readonly sha: string;
}

/**
 * A commit subject, made safe to paste into markdown.
 *
 * `<` opens raw HTML, so a subject naming a type parameter - `NoPromise<T>` -
 * loses everything up to the closing bracket when rendered. The entity is what
 * both GitHub and the site show as the character.
 *
 * The dashes are the repo's own rule reaching its generated output:
 * `no-em-dash.test.ts` scans every tracked file, and subjects written before the
 * rule existed still carry them.
 */
const sanitize = (text: string): string =>
  text.replace(/</g, '&lt;').replace(/[\u2014\u2013]/g, '-');

const subjectOf = (message: string): string =>
  message.split('\n', 1)[0]?.trim() ?? '';

const isBreaking = (message: string, bang: string | undefined): boolean =>
  bang === '!' || /^BREAKING CHANGE/m.test(message);

/**
 * A commit that describes the release rather than being part of it: the version
 * bump this script's own commit writes, and the merge commits a branch update
 * leaves behind.
 */
const isMachinery = (subject: string): boolean =>
  subject.startsWith(RELEASE_COMMIT_PREFIX) || subject.startsWith('Merge ');

const entryOf = (commit: CommitRecord): Entry | null => {
  const subject = subjectOf(commit.message);
  if (isMachinery(subject)) return null;
  // The `release:` commit is the release's own summary, rendered above the
  // groups rather than inside one.
  if (releaseSummary(commit.message) !== null) return null;

  const match = SUBJECT.exec(subject);
  const type = match?.[1];
  const raw = match?.[4] ?? subject;
  const pr = PR_SUFFIX.exec(raw);

  return {
    group: isBreaking(commit.message, match?.[3])
      ? 'breaking'
      : type !== undefined && GROUP_KEYS.has(type)
        ? type
        : 'other',
    scope: match?.[2] ?? null,
    summary: sanitize(raw.replace(PR_SUFFIX, '').trim()),
    pr: pr?.[1] ?? null,
    sha: commit.sha,
  };
};

const renderEntry = (entry: Entry, repoUrl: string): string => {
  const scope = entry.scope ? `**${entry.scope}**: ` : '';
  const pr = entry.pr ? ` ([#${entry.pr}](${repoUrl}/pull/${entry.pr}))` : '';
  const short = entry.sha.slice(0, 7);
  const commit = ` ([\`${short}\`](${repoUrl}/commit/${entry.sha}))`;
  return `- ${scope}${entry.summary}${pr}${commit}`;
};

export interface ReleaseInput {
  readonly version: string;
  /** `YYYY-MM-DD`. */
  readonly date: string;
  /** Every commit in the release range, newest first. */
  readonly commits: readonly CommitRecord[];
  readonly repoUrl: string;
}

/**
 * One release's markdown, heading included.
 *
 * The `release:` commit's own prose becomes the summary line, because that is
 * what it is: a sentence someone wrote to describe the release. A release whose
 * only commit is that one still produces a section, which is why the summary is
 * not just another entry.
 */
export const renderRelease = ({
  version,
  date,
  commits,
  repoUrl,
}: ReleaseInput): string => {
  const summary = commits
    .map((commit) => releaseSummary(commit.message))
    .find((text): text is string => text !== null);

  const entries = commits
    .map(entryOf)
    .filter((entry): entry is Entry => entry !== null);

  const lines = [`## ${version} - ${date}`, ''];
  if (summary) lines.push(sanitize(summary), '');

  for (const [key, heading] of GROUPS) {
    const group = entries.filter((entry) => entry.group === key);
    if (group.length === 0) continue;
    lines.push(`### ${heading}`, '');
    for (const entry of group) lines.push(renderEntry(entry, repoUrl));
    lines.push('');
  }

  if (!summary && entries.length === 0) lines.push('No recorded changes.', '');

  return lines.join('\n');
};

/**
 * The new section above the existing ones, under the file's header.
 *
 * Prepending rather than appending keeps the newest release at the top of both
 * the file and the page, and means the site never has to sort.
 */
export const prependRelease = (existing: string, section: string): string => {
  const body = existing.trim() === '' ? '' : existing;
  const at = body.search(new RegExp(RELEASE_HEADING.source, 'm'));

  if (at === -1) {
    const header =
      body.trim() === '' ? CHANGELOG_HEADER : `${body.trimEnd()}\n`;
    return `${header}\n${section}`;
  }

  return `${body.slice(0, at)}${section}\n${body.slice(at)}`;
};

/** Every release in the file, in the order it holds them (newest first). */
export const parseChangelog = (markdown: string): ReleaseSection[] => {
  const releases: ReleaseSection[] = [];
  let current: { version: string; date: string; body: string[] } | null = null;

  const flush = (): void => {
    if (!current) return;
    releases.push({
      version: current.version,
      date: current.date,
      body: current.body.join('\n').trim(),
    });
  };

  for (const line of markdown.split('\n')) {
    const heading = RELEASE_HEADING.exec(line);
    if (heading?.[1] !== undefined && heading[2] !== undefined) {
      flush();
      current = { version: heading[1], date: heading[2], body: [] };
      continue;
    }
    current?.body.push(line);
  }

  flush();
  return releases;
};
