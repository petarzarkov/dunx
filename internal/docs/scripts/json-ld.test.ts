import { describe, expect, test } from 'bun:test';
import type { SiteIndex } from './extract/model';
import { crumbsOf, jsonLdFor, type Entity } from './json-ld';
import { clamp, pagesOf, SITE_ORIGIN } from './pages';

const entity: Entity = {
  origin: SITE_ORIGIN,
  repoUrl: 'https://github.com/petarzarkov/dunx',
  version: '3.4.1',
};

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
  ],
  packages: [
    {
      name: '@dunx/http',
      dir: 'http',
      description: 'The Bun.serve adapter.',
      subpaths: ['.'],
      exports: [],
    },
  ],
} as unknown as SiteIndex;

const releases = [{ version: '3.4.1', date: '2026-09-07' }];

interface ListItem {
  readonly '@type': string;
  readonly position: number;
  readonly name: string;
  readonly item?: string;
}

const blocksFor = (path: string, title: string, kind: 'article' | 'website') =>
  jsonLdFor({
    entity,
    path,
    title,
    description: clamp('Whatever this page is about.'),
    kind,
  }).map(
    (json) =>
      JSON.parse(json.replace(/\\u003c/g, '<')) as Record<string, unknown>,
  );

const trailFor = (
  path: string,
  title: string,
  kind: 'article' | 'website',
): ListItem[] => {
  const list = blocksFor(path, title, kind).find(
    (block) => block['@type'] === 'BreadcrumbList',
  );
  return (list?.['itemListElement'] ?? []) as ListItem[];
};

describe('the breadcrumb trail', () => {
  /**
   * Search Console reported `Missing field "item" (in "itemListElement")` as a
   * critical Breadcrumbs issue on dunx.win. Google requires `item` on every
   * `ListItem` but the last, and `/guide` and `/api` have no page of their own,
   * so the section crumb used to be published with a name and no URL.
   */
  test('gives every crumb an item, on every page the site publishes', () => {
    for (const page of pagesOf(index, releases)) {
      const trail = trailFor(page.path, page.title, page.kind);
      for (const item of trail) {
        expect({ path: page.path, ...item }).toHaveProperty('item');
      }
    }
  });

  test('numbers the positions from one, with no gaps', () => {
    for (const page of pagesOf(index, releases)) {
      const trail = trailFor(page.path, page.title, page.kind);
      expect(trail.map((item) => item.position)).toEqual(
        trail.map((_, i) => i + 1),
      );
    }
  });

  test('publishes no URL that is not a page of the site', () => {
    const served = new Set(
      pagesOf(index, releases).map((page) => `${SITE_ORIGIN}${page.path}`),
    );
    served.add(`${SITE_ORIGIN}/`);
    for (const page of pagesOf(index, releases)) {
      for (const item of trailFor(page.path, page.title, page.kind)) {
        expect([...served]).toContain(item.item ?? '(no item)');
      }
    }
  });

  test('starts at the site root and ends at the page itself', () => {
    const trail = trailFor(
      '/guide/controllers',
      'Controllers | dunx',
      'article',
    );
    expect(trail[0]).toMatchObject({ name: 'dunx', item: `${SITE_ORIGIN}/` });
    expect(trail.at(-1)).toMatchObject({
      item: `${SITE_ORIGIN}/guide/controllers`,
    });
  });

  test('keeps a routable section in the trail', () => {
    expect(crumbsOf('/releases/3.4.1', 'dunx 3.4.1 | Releases')).toEqual([
      { name: 'Releases', path: '/releases' },
      { name: 'dunx 3.4.1', path: '/releases/3.4.1' },
    ]);
  });

  /** `dunx > Controllers | dunx` said the site name twice. */
  test('labels the leaf with the title, not the whole document title', () => {
    expect(crumbsOf('/guide/controllers', 'Controllers | dunx')).toEqual([
      { name: 'Controllers', path: '/guide/controllers' },
    ]);
    expect(crumbsOf('/api/http', '@dunx/http | dunx')).toEqual([
      { name: '@dunx/http', path: '/api/http' },
    ]);
    // Nothing to strip, and a title that is only a suffix keeps itself.
    expect(crumbsOf('/api/http', '@dunx/http')[0]?.name).toBe('@dunx/http');
    expect(crumbsOf('/api/http', '| dunx')[0]?.name).toBe('| dunx');
  });

  test('is absent from the landing page, which describes the software', () => {
    const blocks = blocksFor('/', 'dunx', 'website');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.['@type']).toBe('SoftwareApplication');
  });

  test('is absent from a path no section claims', () => {
    expect(crumbsOf('/nope/deep', 'Nope')).toEqual([]);
    expect(trailFor('/404', 'Not found', 'website')).toEqual([]);
  });
});
