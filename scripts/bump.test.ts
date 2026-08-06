import { describe, expect, it } from 'bun:test';
import { bumpVersion, changedSrcPackages } from './bump.js';

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
