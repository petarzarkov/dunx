import { describe, expect, it } from 'bun:test';
import {
  assertNoWorkspaceRanges,
  resolveWorkspaceDeps,
  resolveWorkspaceRange,
} from './workspace-ranges.js';

/**
 * The published range policy, which is the whole reason this module is separate
 * from `version.ts`: `first-publish.ts` had its own copy of the rewrite and the two
 * could disagree about what `workspace:*` means.
 */
describe('resolveWorkspaceRange', () => {
  it('publishes workspace:* as a caret range, not an exact pin', () => {
    // An exact pin makes `@dunx/http@0.2.0` demand `@dunx/core@0.2.0` and nothing
    // else, so a consumer whose core resolved to 0.2.1 either gets a peer warning
    // from bun, an ERESOLVE failure from npm, or a nested second copy of core -
    // and a second copy of core is a second `Logger` class, so every token misses.
    expect(resolveWorkspaceRange('workspace:*', '0.2.0')).toBe('^0.2.0');
  });

  it('treats a bare workspace: the same as workspace:*', () => {
    expect(resolveWorkspaceRange('workspace:', '0.2.0')).toBe('^0.2.0');
  });

  it('keeps an explicit specifier rather than overriding it', () => {
    expect(resolveWorkspaceRange('workspace:^', '0.2.0')).toBe('^0.2.0');
    expect(resolveWorkspaceRange('workspace:~', '0.2.0')).toBe('~0.2.0');
    expect(resolveWorkspaceRange('workspace:>=', '0.2.0')).toBe('>=0.2.0');
  });
});

describe('resolveWorkspaceDeps', () => {
  const versions = new Map([
    ['@dunx/core', '0.2.0'],
    ['@dunx/http', '0.2.0'],
  ]);
  const versionFor = (name: string): string | undefined => versions.get(name);

  it('rewrites every publishable field and leaves the rest alone', () => {
    const pkg = {
      name: '@dunx/auth',
      dependencies: { 'better-auth': '^1.0.0' },
      peerDependencies: { '@dunx/core': 'workspace:*', zod: '^4.0.0' },
      optionalDependencies: { '@dunx/http': 'workspace:*' },
    };

    const rewritten = resolveWorkspaceDeps(pkg, versionFor);

    expect(pkg.peerDependencies['@dunx/core']).toBe('^0.2.0');
    expect(pkg.optionalDependencies['@dunx/http']).toBe('^0.2.0');
    expect(pkg.peerDependencies.zod).toBe('^4.0.0');
    expect(pkg.dependencies['better-auth']).toBe('^1.0.0');
    expect(rewritten).toHaveLength(2);
  });

  it('leaves devDependencies as workspace ranges - they are never installed', () => {
    const pkg = {
      name: '@dunx/http',
      devDependencies: { '@dunx/core': 'workspace:*' },
    };

    expect(resolveWorkspaceDeps(pkg, versionFor)).toHaveLength(0);
    expect(pkg.devDependencies['@dunx/core']).toBe('workspace:*');
  });

  it('reports nothing rewritten when there is nothing to rewrite', () => {
    const pkg = { name: '@dunx/core', peerDependencies: { zod: '^4.0.0' } };
    expect(resolveWorkspaceDeps(pkg, versionFor)).toEqual([]);
  });

  it('throws naming the package when the workspace has no such member', () => {
    const pkg = {
      name: '@dunx/http',
      peerDependencies: { '@dunx/ghost': 'workspace:*' },
    };

    expect(() => resolveWorkspaceDeps(pkg, versionFor)).toThrow(
      /@dunx\/http depends on @dunx\/ghost/,
    );
  });
});

/**
 * The rewrite that turns `workspace:*` into a real range only runs on the
 * `publishPackage` path, and the first publish of a package has to be done by
 * hand - OIDC trusted publishing cannot attach to a package that does not exist
 * yet. That manual path is where an unresolved range would slip through and break
 * every consumer install, so the assertion is what actually holds the line.
 */
describe('assertNoWorkspaceRanges', () => {
  it('passes a manifest whose ranges are all resolved', () => {
    expect(() =>
      assertNoWorkspaceRanges({
        name: '@dunx/http',
        dependencies: { zod: '^3.0.0' },
        peerDependencies: { '@dunx/core': '^0.2.0' },
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

  it('ignores devDependencies - consumers never install them', () => {
    expect(() =>
      assertNoWorkspaceRanges({
        name: '@dunx/http',
        devDependencies: { '@dunx/core': 'workspace:*' },
      }),
    ).not.toThrow();
  });
});
