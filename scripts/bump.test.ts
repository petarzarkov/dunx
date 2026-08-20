import { describe, expect, it } from 'bun:test';
import {
  bumpTypeFrom,
  bumpVersion,
  changedSrcPackages,
  mergeSubject,
  parseReleaseTrigger,
  releaseSummary,
} from './bump.js';

describe('releaseSummary', () => {
  it('takes the prose after the colon, whatever the scope', () => {
    expect(releaseSummary('release: gate publishing')).toBe('gate publishing');
    expect(releaseSummary('release(minor): gate publishing')).toBe(
      'gate publishing',
    );
    expect(releaseSummary('release!: gate publishing')).toBe('gate publishing');
  });

  it('is null for anything that is not a release commit', () => {
    expect(releaseSummary('feat: a thing')).toBeNull();
    expect(releaseSummary('chore(release): bump version to 1.0.0')).toBeNull();
  });

  // The subject only, for the same reason `parseReleaseTrigger` reads it: a body
  // quoting a release commit must not become the summary of an unrelated one.
  it('reads the subject, not the body', () => {
    expect(releaseSummary('feat: a thing\n\nrelease: not this')).toBeNull();
  });
});

describe('bumpVersion()', () => {
  it('bumps a version whose components are all non-zero', () => {
    expect(bumpVersion('1.2.3', 'major')).toBe('2.0.0');
    expect(bumpVersion('1.2.3', 'minor')).toBe('1.3.0');
    expect(bumpVersion('1.2.3', 'patch')).toBe('1.2.4');
  });

  // Regression: the guards were `!major` / `!minor` / `!patch`, and 0 is falsy, so
  // every one of these threw `Invalid version`.
  it('bumps across a zero component', () => {
    expect(bumpVersion('0.0.0', 'major')).toBe('1.0.0');
    expect(bumpVersion('0.0.0', 'minor')).toBe('0.1.0');
    expect(bumpVersion('0.0.0', 'patch')).toBe('0.0.1');
    expect(bumpVersion('1.0.0', 'minor')).toBe('1.1.0');
    expect(bumpVersion('1.0.0', 'patch')).toBe('1.0.1');
    expect(bumpVersion('1.2.0', 'patch')).toBe('1.2.1');
    expect(bumpVersion('0.1.0', 'patch')).toBe('0.1.1');
  });

  it('rejects a version that is not three non-negative integers', () => {
    for (const invalid of [
      '1.2',
      '1.2.3.4',
      '1.2.x',
      'v1.2.3',
      '',
      '1.2.-1',
      '1.2.3-beta',
    ]) {
      expect(() => bumpVersion(invalid, 'patch')).toThrow(
        `Invalid version: ${invalid}`,
      );
    }
  });
});

describe('changedSrcPackages', () => {
  /*
   * The restructure that moved `@dunx/create-app` and `@dunx/mcp` out of
   * `packages/` and into `tools/` left this pattern pinned to `packages/`, so a
   * change to either reported "no src changes detected" and the release was
   * skipped without failing. Nothing caught it, because the matcher was inline in
   * a function that shells out to git.
   */
  it('matches both published parents', () => {
    expect(
      changedSrcPackages([
        'packages/core/src/di/app.ts',
        'tools/create-app/src/scaffold.ts',
        'tools/mcp/package.json',
      ]),
    ).toEqual(new Set(['core', 'create-app', 'mcp']));
  });

  it('ignores the private parents entirely', () => {
    expect(
      changedSrcPackages([
        'internal/docs/src/App.tsx',
        'internal/ui/src/theme.ts',
        'examples/full/src/main.ts',
      ]),
    ).toEqual(new Set());
  });

  /* A release is what a consumer installs, so a test or a doc is not one. */
  it('only counts src, the manifest and the README', () => {
    expect(
      changedSrcPackages([
        'packages/core/src/index.ts',
        'packages/core/README.md',
        'packages/http/package.json',
        'packages/auth/tsconfig.json',
        'docs/ROADMAP.md',
      ]),
    ).toEqual(new Set(['core', 'http']));
  });
});

describe('mergeSubject', () => {
  /**
   * The shape GitHub actually writes. Before this existed, merging a release pull
   * request produced a green CI run that published nothing: the merge subject carries
   * no trigger and the title is one line further down.
   */
  const githubMerge = [
    'Merge pull request #3 from petarzarkov/feat/some-branch',
    '',
    'release(minor): a throttle and a teardown that finishes',
  ].join('\n');

  it('reads the pull request title a merge folded into the body', () => {
    expect(mergeSubject(githubMerge, 2)).toBe(
      'release(minor): a throttle and a teardown that finishes',
    );
  });

  it('ignores the body of an ordinary commit', () => {
    expect(mergeSubject(githubMerge, 1)).toBeNull();
  });

  it('reads no deeper than the first non-empty line', () => {
    const pasted = [
      'Merge pull request #4 from petarzarkov/feat/other',
      '',
      'chore: tidy the scaffold',
      '',
      'release(major): a changelog paste that must not publish',
    ].join('\n');
    expect(mergeSubject(pasted, 2)).toBe('chore: tidy the scaffold');
  });

  it('is null when a merge carries no body', () => {
    expect(mergeSubject('Merge branch main into feat/x', 2)).toBeNull();
  });

  it('feeds parseReleaseTrigger the bump the title stated', () => {
    const title = mergeSubject(githubMerge, 2) ?? '';
    expect(parseReleaseTrigger(title)).toEqual({
      release: true,
      bump: 'minor',
    });
  });
});

describe('parseReleaseTrigger', () => {
  it('releases on a bare `release:` and lets the range decide the bump', () => {
    expect(parseReleaseTrigger('release: ship the scoped container')).toEqual({
      release: true,
      bump: null,
    });
  });

  it('takes the bump from the scope when it names one', () => {
    expect(
      parseReleaseTrigger('release(major): drop the flat container'),
    ).toEqual({ release: true, bump: 'major' });
    expect(parseReleaseTrigger('release(minor): add gateways')).toEqual({
      release: true,
      bump: 'minor',
    });
    expect(parseReleaseTrigger('release(patch): fix the input reader')).toEqual(
      {
        release: true,
        bump: 'patch',
      },
    );
  });

  it('treats `release!:` as major', () => {
    expect(parseReleaseTrigger('release!: module-scoped DI')).toEqual({
      release: true,
      bump: 'major',
    });
  });

  /*
   * Lockstep versioning means a package-named scope cannot mean "only this one".
   * It is accepted as a label so a habit of writing one is not a silent no-release,
   * and the range decides the bump.
   */
  it('accepts an unrecognised scope as a label and derives the bump', () => {
    expect(parseReleaseTrigger('release(core): first cut')).toEqual({
      release: true,
      bump: null,
    });
  });

  it('does not release on an ordinary commit', () => {
    for (const subject of [
      'feat(http): add websocket gateways',
      'fix: resolve getWorkers()',
      'chore(release): bump version to 1.2.1 [skip ci]',
      'docs: rewrite the README',
      'released: something',
      'pre-release: something',
      'release',
      'release:',
    ]) {
      expect(parseReleaseTrigger(subject).release).toBe(false);
    }
  });

  /*
   * The body is where a revert, a changelog paste or a quoted commit puts the word.
   * Matching it would publish on a commit that never asked to.
   */
  it('reads the subject only, never the body', () => {
    const message =
      'fix(core): correct the scope closure\n\nReverts "release: 1.2.0".';
    expect(parseReleaseTrigger(message).release).toBe(false);
  });
});

describe('bumpTypeFrom', () => {
  it('defaults to patch', () => {
    expect(bumpTypeFrom(['fix: a thing', 'docs: another'])).toBe('patch');
    expect(bumpTypeFrom([])).toBe('patch');
  });

  it('takes minor from any feat in the range', () => {
    expect(bumpTypeFrom(['fix: a thing', 'feat(http): gateways'])).toBe(
      'minor',
    );
  });

  /*
   * The reason this is a range and not `HEAD`: a batched release's own commit is
   * never a feat, so reading one commit made every batch a patch regardless of what
   * it shipped. A breaking change anywhere outranks everything after it.
   */
  it('takes major from a breaking change anywhere in the range, whatever follows', () => {
    expect(
      bumpTypeFrom([
        'fix: tidy up',
        'feat(core)!: a DI scope per module',
        'docs: note it',
      ]),
    ).toBe('major');
  });

  it('takes major from a BREAKING CHANGE body', () => {
    expect(
      bumpTypeFrom([
        'feat(core): scopes\n\nBREAKING CHANGE: exports are required',
      ]),
    ).toBe('major');
  });

  /*
   * Regression: the old check was `message.includes('!:')`, so an ordinary patch
   * whose body quoted a breaking subject published a major.
   */
  it('does not take major from a body that merely quotes a breaking subject', () => {
    expect(
      bumpTypeFrom([
        'fix(core): follow-up to the scope change\n\nSee "feat(core)!: a DI scope per module".',
      ]),
    ).toBe('patch');
  });
});
