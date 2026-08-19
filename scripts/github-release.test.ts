import { describe, expect, it } from 'bun:test';
import { releaseBody, releasePageUrl, tagFor } from './github-release.js';

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
   * Derived from `owner/repo` rather than hardcoded, so a fork's tag points at the
   * fork's own Pages site. The hash form is what `internal/docs` serves; a path URL
   * would 404 on GitHub Pages, which is why that router is hash based.
   */
  it('points at the docs route for that version', () => {
    expect(releasePageUrl('petarzarkov/dunx', '2.0.1')).toBe(
      'https://petarzarkov.github.io/dunx/#/releases/2.0.1',
    );
  });

  it('follows the owner of a fork', () => {
    expect(releasePageUrl('someone/dunx', '1.0.0')).toBe(
      'https://someone.github.io/dunx/#/releases/1.0.0',
    );
  });
});

describe('releaseBody', () => {
  const url = 'https://petarzarkov.github.io/dunx/#/releases/2.0.1';

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
