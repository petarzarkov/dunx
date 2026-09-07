import { describe, expect, test } from 'bun:test';
import type { SiteIndex } from './extract/model';
import {
  clamp,
  escapeHtml,
  fileFor,
  HOME_DESCRIPTION,
  pagesOf,
  SITE_ORIGIN,
} from './pages';

/**
 * The route list and the head data, which is all that survived of the old
 * `scripts/seo.ts`. The bodies are the app's own now, so what is left to assert
 * is the set of paths, the descriptions and the file each path is written to -
 * everything a search result or the edge depends on.
 */
const index = {
  generatedAt: '2026-09-07T00:00:00.000Z',
  repoUrl: 'https://github.com/petarzarkov/dunx',
  guides: [
    {
      slug: 'controllers',
      category: 'guide',
      section: 'Fundamentals',
      order: 5,
      source: 'docs/guide/05-controllers.md',
      title: 'Controllers',
      summary: 'A controller is a provider with routes on it.',
      headings: [],
    },
    {
      slug: 'blank',
      category: 'reference',
      section: '',
      order: 0,
      source: 'docs/blank.md',
      title: 'Blank',
      summary: '',
      headings: [],
    },
  ],
  packages: [
    {
      name: '@dunx/http',
      dir: 'http',
      description: 'The Bun.serve adapter.',
      subpaths: ['.'],
      exports: [],
    },
    {
      name: '@dunx/bare',
      dir: 'bare',
      description: '',
      subpaths: ['.'],
      exports: [],
    },
  ],
} as unknown as SiteIndex;

const releases = [{ version: '3.3.2', date: '2026-09-05' }];
const pages = pagesOf(index, releases);
const at = (path: string) => pages.find((page) => page.path === path);

describe('the page list', () => {
  test('covers the landing page, the panels, every guide, package and release', () => {
    expect(pages.map((page) => page.path)).toEqual([
      '/',
      '/benchmarks',
      '/coverage',
      '/releases',
      '/guide/controllers',
      '/guide/blank',
      '/api/http',
      '/api/bare',
      '/releases/3.3.2',
    ]);
  });

  test('gives the landing page the one description that is declared', () => {
    expect(at('/')?.description).toBe(HOME_DESCRIPTION);
  });

  test('takes a guide description off the model rather than re-reading its source', () => {
    expect(at('/guide/controllers')?.description).toBe(
      'A controller is a provider with routes on it.',
    );
  });

  test('never emits an empty description', () => {
    expect(at('/guide/blank')?.description).toBe('Blank, from the dunx guide.');
    expect(at('/api/bare')?.description).toBe('API reference for @dunx/bare.');
    for (const page of pages) expect(page.description.trim()).not.toBe('');
  });

  test('marks documents as articles and index pages as websites', () => {
    expect(at('/')?.kind).toBe('website');
    expect(at('/releases')?.kind).toBe('website');
    expect(at('/guide/controllers')?.kind).toBe('article');
    expect(at('/api/http')?.kind).toBe('article');
    expect(at('/releases/3.3.2')?.kind).toBe('article');
  });
});

describe('fileFor', () => {
  /**
   * Measured on a preview deployment: Cloudflare answers a directory index with
   * a 308 to the trailing-slash form, so every deep link cost a redirect hop
   * and the URL that rendered disagreed with the canonical the file carries.
   */
  test('writes a sibling .html, not a directory index', () => {
    expect(fileFor('/guide/controllers')).toBe('guide/controllers.html');
    expect(fileFor('/releases/3.3.2')).toBe('releases/3.3.2.html');
  });

  test('writes the landing page as the shell itself', () => {
    expect(fileFor('/')).toBe('index.html');
  });
});

describe('clamp', () => {
  test('leaves a description Google renders in full alone', () => {
    expect(clamp('A controller is a provider with routes on it.')).toBe(
      'A controller is a provider with routes on it.',
    );
  });

  test('cuts a long one at a word boundary', () => {
    const clamped = clamp(`${'word '.repeat(50)}end`);
    expect(clamped.length).toBeLessThanOrEqual(160);
    expect(clamped.endsWith('…')).toBe(true);
    expect(clamped).not.toContain(' …');
  });
});

describe('escapeHtml', () => {
  test('escapes the five characters that change meaning in markup', () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&amp;&#39;',
    );
  });
});

test('the origin carries no trailing slash, so a path never doubles it', () => {
  expect(SITE_ORIGIN.endsWith('/')).toBe(false);
  expect(`${SITE_ORIGIN}/guide/controllers`).toBe(
    'https://dunx.win/guide/controllers',
  );
});
