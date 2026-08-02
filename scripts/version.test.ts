import { describe, expect, it } from 'bun:test';
import { assertNoWorkspaceRanges, bumpVersion } from './version.js';

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

/**
 * The rewrite that turns `workspace:*` into a real version only runs on the
 * `publishPackage` path, and the first publish of a package has to be done by
 * hand — OIDC trusted publishing cannot attach to a package that does not exist
 * yet. That manual path is where an unresolved range would slip through and break
 * every consumer install, so the assertion is what actually holds the line.
 */
describe('assertNoWorkspaceRanges', () => {
  it('passes a manifest whose ranges are all resolved', () => {
    expect(() =>
      assertNoWorkspaceRanges({
        name: '@dunx/http',
        dependencies: { zod: '^3.0.0' },
        peerDependencies: { '@dunx/core': '0.1.0' },
      }),
    ).not.toThrow();
  });

  it('refuses a peer range that never got rewritten', () => {
    expect(() =>
      assertNoWorkspaceRanges({
        name: '@dunx/http',
        peerDependencies: { '@dunx/core': 'workspace:*' },
      }),
    ).toThrow(/peerDependencies\.@dunx\/core = "workspace:\*"/);
  });

  it('names every offender across every dependency field', () => {
    let message = '';
    try {
      assertNoWorkspaceRanges({
        name: '@dunx/testing',
        dependencies: { '@dunx/a': 'workspace:^' },
        peerDependencies: { '@dunx/b': 'workspace:*' },
        optionalDependencies: { '@dunx/c': 'workspace:~' },
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('dependencies.@dunx/a');
    expect(message).toContain('peerDependencies.@dunx/b');
    expect(message).toContain('optionalDependencies.@dunx/c');
  });

  it('ignores devDependencies — consumers never install them', () => {
    expect(() =>
      assertNoWorkspaceRanges({
        name: '@dunx/http',
        devDependencies: { '@dunx/core': 'workspace:*' },
      }),
    ).not.toThrow();
  });
});
