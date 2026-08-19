import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mount } from './harness';
import { loadReleases } from './data';

beforeEach(() => {
  window.location.hash = '';
});

afterEach(() => {
  document.body.innerHTML = '';
});

const newest = async () => {
  const releases = (await loadReleases()) ?? [];
  const first = releases[0];
  if (!first) throw new Error('no releases');
  return { releases, first };
};

describe('the releases index', () => {
  test('renders the changelog the release script wrote', async () => {
    mount('#/releases');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Releases',
    );

    // The history is a chunk, so the frame is on screen a tick before it.
    const { first } = await newest();
    await waitFor(() => {
      expect(screen.getAllByText(first.version).length).toBeGreaterThan(0);
    });
  });
});

/*
 * The sub-page exists so a GitHub release note has a stable URL to link at, which
 * makes the version in the hash the contract: a route that stopped resolving would
 * turn every published link into a Not found panel.
 */
describe('one release', () => {
  test('renders the version it was asked for', async () => {
    const { first } = await newest();
    mount(`#/releases/${first.version}`);

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
        first.version,
      );
    });
  });

  test('accepts the v-prefixed form a git tag would use', async () => {
    const { first } = await newest();
    mount(`#/releases/v${first.version}`);

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
        first.version,
      );
    });
  });

  test('says which version was missing rather than redirecting', async () => {
    mount('#/releases/9.9.9');

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(
        /not found/i,
      );
    });
    expect(document.body.textContent).toContain('9.9.9');
  });

  test('links to the neighbouring releases, and both resolve', async () => {
    const { releases, first } = await newest();
    // Needs a release with one on each side, so the middle of the history.
    const at = Math.floor(releases.length / 2);
    const middle = releases[at];
    if (!middle || releases.length < 3) return;

    mount(`#/releases/${middle.version}`);

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
        middle.version,
      );
    });

    const links = [...document.querySelectorAll('a[href^="#/releases/"]')].map(
      (link) => link.getAttribute('href'),
    );
    const versions = new Set(releases.map((release) => release.version));
    for (const link of links) {
      expect(versions.has((link ?? '').replace('#/releases/', ''))).toBe(true);
    }
    // The newest release has no next, so the middle one having both is the case
    // worth asserting.
    expect(links).toContain(`#/releases/${releases[at + 1]?.version}`);
    expect(links).toContain(`#/releases/${releases[at - 1]?.version}`);
    expect(first.version).not.toBe(middle.version);
  });

  test('links every package at that version on npm', async () => {
    const { first } = await newest();
    mount(`#/releases/${first.version}`);

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
        first.version,
      );
    });

    const pinned = [
      ...document.querySelectorAll('a[href^="https://www.npmjs.com/package/"]'),
    ].map((link) => link.getAttribute('href') ?? '');
    expect(pinned.length).toBeGreaterThan(0);
    for (const href of pinned) {
      expect(href).toContain(`/v/${first.version}`);
    }
  });
});

/*
 * The release history comes from a file a script writes, so the parse is the part
 * that can rot: a heading it stops matching turns the page blank rather than
 * failing the build.
 */
describe('the release history', () => {
  test('every release has a version, a date and a rendered body', async () => {
    const releases = (await loadReleases()) ?? [];
    expect(releases.length).toBeGreaterThan(0);

    for (const release of releases) {
      expect(release.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(release.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(release.anchor).toBe(release.version.replace(/\./g, '-'));
      expect(release.html.trim()).not.toBe('');
    }
  });

  test('newest first, and no version listed twice', async () => {
    const releases = (await loadReleases()) ?? [];
    const versions = releases.map((release) => release.version);
    expect(new Set(versions).size).toBe(versions.length);

    const dates = releases.map((release) => release.date);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  /*
   * Every release has its own "Features" heading, and `renderDoc` de-duplicates
   * within one document rather than across the page. Without the version prefix
   * the generator adds, thirty-five cards share a handful of ids.
   */
  test('heading ids are unique across the whole page', async () => {
    const releases = (await loadReleases()) ?? [];
    const ids = releases.flatMap((release) =>
      [...release.html.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]),
    );
    expect(new Set(ids).size).toBe(ids.length);
  });
});
