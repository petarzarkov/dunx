import { describe, expect, it } from 'bun:test';
import { releaseBody, tagFor } from './github-release.js';
import { releasePageUrl } from './site.js';

const CHANGELOG = `# Changelog

Every release, newest first.

## 2.0.1 - 2026-08-14

infra fix NotThenable constraint

### Bug fixes

- **infra**: move the constraint to the return type

## 2.0.0 - 2026-08-10

enableShutdownHooks ends the process
`;

describe('tagFor', () => {
  it('prefixes the version the way a git tag does', () => {
    expect(tagFor('2.0.1')).toBe('v2.0.1');
  });
});

describe('releasePageUrl', () => {
  /*
   * A path rather than the `#/releases/2.0.1` GitHub Pages needed: the site is on
   * a history router behind a `_redirects` fallback, so the path resolves.
   */
  it('points at the docs route for that version', () => {
    expect(releasePageUrl('2.0.1')).toBe('https://dunx.win/releases/2.0.1');
  });
});

describe('releaseBody', () => {
  const url = 'https://dunx.win/releases/2.0.1';

  it('carries that release section and nothing from the next one', () => {
    const body = releaseBody(CHANGELOG, '2.0.1', url);

    expect(body).toContain('infra fix NotThenable constraint');
    expect(body).toContain('move the constraint to the return type');
    // The section below it belongs to a different release.
    expect(body).not.toContain('enableShutdownHooks');
  });

  it('links the page that renders the same section', () => {
    expect(releaseBody(CHANGELOG, '2.0.1', url)).toContain(
      `[Full release notes](${url})`,
    );
  });

  /*
   * `[force-publish]` writes no changelog entry, having no commit range to
   * describe. That must not fail the release: the packages are already on npm.
   */
  it('still produces a link for a version with no section', () => {
    const body = releaseBody(CHANGELOG, '9.9.9', url);

    expect(body).toBe(`[Full release notes](${url})`);
  });
});
