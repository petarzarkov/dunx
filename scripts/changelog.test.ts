import { describe, expect, it } from 'bun:test';
import {
  CHANGELOG_HEADER,
  parseChangelog,
  prependRelease,
  renderRelease,
} from './changelog.js';
import type { CommitRecord } from './bump.js';

const REPO = 'https://github.com/petarzarkov/dunx';

const commit = (sha: string, message: string): CommitRecord => ({
  sha,
  message,
});

const render = (commits: CommitRecord[], version = '1.2.0'): string =>
  renderRelease({ version, date: '2026-08-16', commits, repoUrl: REPO });

describe('renderRelease', () => {
  it('heads the section with the version and the date', () => {
    expect(render([commit('a'.repeat(40), 'fix: a thing')])).toStartWith(
      '## 1.2.0 - 2026-08-16\n',
    );
  });

  it('groups by conventional type, in a fixed order', () => {
    const section = render([
      commit('1'.repeat(40), 'docs: explain it'),
      commit('2'.repeat(40), 'fix: repair it'),
      commit('3'.repeat(40), 'feat: add it'),
    ]);

    const headings = [...section.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
    expect(headings).toEqual(['Features', 'Fixes', 'Documentation']);
  });

  it('renders the scope in bold and links the commit', () => {
    const sha = 'abc1234def5678901234567890123456789012ab';
    expect(render([commit(sha, 'feat(http): websocket gateways')])).toContain(
      `- **http**: websocket gateways ([\`abc1234\`](${REPO}/commit/${sha}))`,
    );
  });

  it('links a squash-merge PR number and takes it out of the summary', () => {
    const section = render([commit('f'.repeat(40), 'fix(core): a leak (#42)')]);
    expect(section).toContain(`([#42](${REPO}/pull/42))`);
    expect(section).toContain('- **core**: a leak (');
    expect(section).not.toContain('a leak (#42)');
  });

  it('sends a breaking change to its own group, however it is marked', () => {
    const section = render([
      commit('1'.repeat(40), 'feat(core)!: a scope per module'),
      commit(
        '2'.repeat(40),
        'refactor: rename it\n\nBREAKING CHANGE: it moved',
      ),
      commit('3'.repeat(40), 'feat: an ordinary one'),
    ]);

    const breaking = section.slice(
      section.indexOf('### Breaking changes'),
      section.indexOf('### Features'),
    );
    expect(breaking).toContain('a scope per module');
    expect(breaking).toContain('rename it');
    expect(breaking).not.toContain('an ordinary one');
  });

  it('keeps a commit whose type it does not recognise', () => {
    const section = render([commit('a'.repeat(40), 'wip on the thing')]);
    expect(section).toContain('### Other changes');
    expect(section).toContain('- wip on the thing (');
  });

  /*
   * The `release:` commit is the only human-written description of a release, and
   * a release whose whole range is that one commit is the common case for a
   * single-fix release. Treating it as an ordinary entry produced empty sections.
   */
  it('lifts the release commit into the summary rather than a group', () => {
    const section = render([
      commit(
        'a'.repeat(40),
        'release: gate publishing behind a release commit',
      ),
      commit('b'.repeat(40), 'feat: something else'),
    ]);

    expect(section).toContain('\ngate publishing behind a release commit\n');
    expect(section).not.toContain('- gate publishing');
    expect(section.indexOf('gate publishing')).toBeLessThan(
      section.indexOf('### Features'),
    );
  });

  it('renders a release whose only commit is the release commit', () => {
    const section = render([commit('a'.repeat(40), 'release(patch): one fix')]);
    expect(section).toContain('one fix');
    expect(section).not.toContain('###');
    expect(section).not.toContain('No recorded changes.');
  });

  it('says so when the range holds nothing to report', () => {
    const section = render([
      commit('a'.repeat(40), 'chore(release): bump version to 1.1.0 [skip ci]'),
      commit('b'.repeat(40), 'Merge remote-tracking branch origin/main'),
    ]);
    expect(section).toContain('No recorded changes.');
  });

  /*
   * `<` opens raw HTML, so `NoPromise<T>` lost everything to the closing bracket
   * when the page rendered it. The dashes are the repo's own rule reaching its
   * generated output: `no-em-dash.test.ts` scans every tracked file.
   */
  it('escapes a type parameter and replaces a dash', () => {
    const section = render([
      commit('a'.repeat(40), `fix: return NoPromise<T> \u2014 not a thenable`),
    ]);
    expect(section).toContain('NoPromise&lt;T>');
    expect(section).not.toContain('\u2014');
    expect(section).not.toContain('\u2013');
  });
});

describe('prependRelease', () => {
  it('writes the header when there is no file yet', () => {
    const out = prependRelease('', render([commit('a'.repeat(40), 'fix: it')]));
    expect(out).toStartWith(CHANGELOG_HEADER);
    expect(out).toContain('## 1.2.0 - 2026-08-16');
  });

  it('puts the new release above the existing ones', () => {
    const first = prependRelease(
      '',
      render([commit('a'.repeat(40), 'fix: it')], '1.0.0'),
    );
    const second = prependRelease(
      first,
      render([commit('b'.repeat(40), 'feat: more')], '1.1.0'),
    );

    expect(second.indexOf('## 1.1.0')).toBeLessThan(second.indexOf('## 1.0.0'));
    // The header survives, once.
    expect(second).toStartWith(CHANGELOG_HEADER);
    expect(second.split('# Changelog').length - 1).toBe(1);
  });
});

describe('parseChangelog', () => {
  it('reads back what renderRelease wrote', () => {
    const file = prependRelease(
      prependRelease(
        '',
        render([commit('a'.repeat(40), 'fix: older')], '1.0.0'),
      ),
      render([commit('b'.repeat(40), 'feat(http): newer')], '1.1.0'),
    );

    const releases = parseChangelog(file);
    expect(releases.map((r) => r.version)).toEqual(['1.1.0', '1.0.0']);
    expect(releases[0]?.date).toBe('2026-08-16');
    expect(releases[0]?.body).toContain('### Features');
    expect(releases[0]?.body).toContain('**http**: newer');
    // The heading itself is not part of the body the site renders.
    expect(releases[0]?.body).not.toContain('## 1.1.0');
    // Nothing of the older release leaks into the newer one's body.
    expect(releases[0]?.body).not.toContain('older');
  });

  it('finds nothing in an empty or header-only file', () => {
    expect(parseChangelog('')).toEqual([]);
    expect(parseChangelog(CHANGELOG_HEADER)).toEqual([]);
  });

  it('ignores a heading that is not a release', () => {
    const releases = parseChangelog(
      '# Changelog\n\n## Unreleased\n\nnope\n\n## 1.0.0 - 2026-01-02\n\nyes\n',
    );
    expect(releases.map((r) => r.version)).toEqual(['1.0.0']);
    expect(releases[0]?.body).toBe('yes');
  });
});
