/**
 * Every page the site serves, with the head each one needs.
 *
 * The route set is not invented here. `src/generated/index.json` already holds
 * every guide and package because the nav is built from it, and `releases.json`
 * holds every version, so this walks the same model the site renders.
 *
 * Nothing in this file touches the filesystem, which is what lets both readers
 * have it: `vite.config.ts` turns the list into the routes to prerender, and
 * `src/entry-server.tsx` is bundled by Vite and looks up one page's head by
 * path. A guide's summary comes off the model rather than out of its source
 * markdown - see `GuideMeta.summary`.
 */

import type { GuideMeta, PackageMeta, SiteIndex } from './extract/model';

/** No trailing slash, so `${SITE_ORIGIN}${page.path}` is never `//guide`. */
export const SITE_ORIGIN = 'https://dunx.win';

export interface PageMeta {
  /** Absolute path, `/` for the landing page. */
  readonly path: string;
  readonly title: string;
  readonly description: string;
  /** `article` for a document, `website` for a landing or index page. */
  readonly kind: 'article' | 'website';
}

export interface ReleaseEntry {
  readonly version: string;
  readonly date: string;
}

/**
 * The landing page's own line.
 *
 * It used to be read back out of the `<meta name="description">` Vite emitted,
 * because the head was assembled by rewriting that document. The prerender
 * plugin appends to the head rather than rewriting it, so `index.html` carries
 * no description to read and this is the one declaration.
 */
export const HOME_DESCRIPTION =
  'Documentation and API reference for dunx, a Bun-native dependency injection framework.';

const FIXED: readonly PageMeta[] = [
  {
    path: '/benchmarks',
    title: 'Benchmarks',
    description:
      'dunx measured against raw Bun.serve, Elysia, Hono, Fastify and NestJS, on the same machine in the same run.',
    kind: 'website',
  },
  {
    path: '/coverage',
    title: 'Coverage',
    description:
      'Line and function coverage for every published dunx package, regenerated on each release.',
    kind: 'website',
  },
  {
    path: '/releases',
    title: 'Releases',
    description: 'Every dunx release, with the commits that went into it.',
    kind: 'website',
  },
];

/**
 * A description is never empty.
 *
 * A page shipping `content=""` is a worse signal than one carrying no tag at
 * all, and a guide's summary depends on its source being readable when the
 * model was generated. That holds today, but a search result should not rest
 * on it.
 */
const descriptionOr = (summary: string, fallback: string): string =>
  summary.trim() === '' ? fallback : summary.trim();

/**
 * Google renders about 160 characters of a description and drops the rest, so a
 * longer one is a sentence nobody reads. Cut at a word boundary: `summaryOf`
 * stops at 200 for `llms.txt`, where the budget is different.
 */
export const clamp = (text: string, limit = 160): string => {
  const value = text.trim();
  if (value.length <= limit) return value;
  const cut = value.slice(0, limit - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > limit / 2 ? cut.slice(0, space) : cut).replace(/[,;:.\s]+$/, '')}…`;
};

/**
 * Escapes the five characters that change meaning in markup.
 *
 * Shared by the page heads `entry-server.tsx` writes and the SVG
 * `og-card.ts` draws: two escapers that disagree about which context they were
 * for is how a title carrying an ampersand ends the attribute it sits in.
 */
export const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const guidePage = (guide: GuideMeta): PageMeta => ({
  path: `/guide/${guide.slug}`,
  title: `${guide.title} | dunx`,
  description: descriptionOr(
    guide.summary,
    `${guide.title}, from the dunx guide.`,
  ),
  kind: 'article',
});

const packagePage = (pkg: PackageMeta): PageMeta => ({
  path: `/api/${pkg.dir}`,
  title: `${pkg.name} | dunx`,
  description: descriptionOr(pkg.description, `API reference for ${pkg.name}.`),
  kind: 'article',
});

/** Every page, in sitemap order. */
export const pagesOf = (
  index: SiteIndex,
  releases: readonly ReleaseEntry[],
): PageMeta[] => [
  {
    path: '/',
    title: 'dunx | fastest web DI framework',
    description: HOME_DESCRIPTION,
    kind: 'website',
  },
  ...FIXED,
  ...index.guides.map(guidePage),
  ...index.packages.map(packagePage),
  ...releases.map((release) => ({
    path: `/releases/${release.version}`,
    title: `dunx ${release.version} | Releases`,
    description: `What shipped in dunx ${release.version}, released ${release.date}.`,
    kind: 'article' as const,
  })),
];

/**
 * `/guide/controllers` becomes `guide/controllers.html`, not
 * `guide/controllers/index.html`.
 *
 * Measured on a preview deployment: Cloudflare answers a directory-index file
 * with a **308 to the trailing-slash form**, so every deep link cost a redirect
 * hop and the URL that finally rendered disagreed with the canonical the file
 * carries. The `.html` sibling is served at the extensionless path directly.
 */
export const fileFor = (path: string): string =>
  path === '/' ? 'index.html' : `${path.replace(/^\//, '')}.html`;
