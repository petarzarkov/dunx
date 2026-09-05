/**
 * A real HTML file per route, written after `vite build`.
 *
 * The site is one bundle behind a client router, so every route used to be the
 * same `index.html`: one title, one description, and no way to say which URL a
 * page is. Search results and link unfurls all read "dunx | fastest web DI
 * framework", whatever the reader had actually opened.
 *
 * The route set is not invented here. `src/generated/index.json` already holds
 * every guide and package because the nav is built from it, and `releases.json`
 * holds every version, so this walks the same model the site renders.
 *
 * The second reason to emit files is the 404. `public/_redirects` used to carry
 * `/* /index.html 200`, which answered **every** miss with the shell: a typo, a
 * renamed guide and `/sitemap.xml` all returned 200 and a page, so a crawler
 * could index unlimited soft 404s and a moved document failed silently. With a
 * file per known route that rule is gone, and `404.html` gives Cloudflare
 * something to serve with a real status.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SITE_URL, summaryOf } from './agent-docs.js';

/** No trailing slash, so `${ORIGIN}${page.path}` is never `//guide`. */
const ORIGIN = SITE_URL.replace(/\/$/, '');

export interface Page {
  /** Absolute path, `/` for the landing page. */
  readonly path: string;
  readonly title: string;
  readonly description: string;
  /** `article` for a document, `website` for a landing or index page. */
  readonly kind: 'article' | 'website';
}

interface GuideEntry {
  readonly slug: string;
  readonly title: string;
  readonly source: string;
}

interface PackageEntry {
  readonly name: string;
  readonly dir: string;
  readonly description: string;
}

interface SiteIndex {
  readonly generatedAt: string;
  readonly guides: readonly GuideEntry[];
  readonly packages: readonly PackageEntry[];
}

interface ReleaseEntry {
  readonly version: string;
  readonly date: string;
}

/**
 * `docs/guide/05-controllers.md` as the model records it, against the
 * `docs/` root the caller reads from.
 */
const sourcePath = (source: string): string => source.replace(/^docs\//, '');

const FIXED: readonly Page[] = [
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
 * all, and a guide's summary depends on its source being readable at build time.
 * That holds today - the model is generated from those same files moments
 * earlier - but a search result should not rest on it.
 */
const descriptionOr = (summary: string, fallback: string): string =>
  summary.trim() === '' ? fallback : summary.trim();

/**
 * Every page the site serves, in sitemap order.
 *
 * `read` takes a path under `docs/` and returns its markdown, or `''` when it is
 * absent - the same contract `writeAgentDocs` takes, so a caller already holding
 * one can pass it straight through.
 */
export const pagesOf = (
  index: SiteIndex,
  releases: readonly ReleaseEntry[],
  read: (file: string) => string,
  /** The landing page's own line, read out of `index.html` rather than restated. */
  homeDescription: string,
): Page[] => [
  {
    path: '/',
    title: 'dunx | fastest web DI framework',
    description: homeDescription,
    kind: 'website',
  },
  ...FIXED,
  ...index.guides.map((guide) => ({
    path: `/guide/${guide.slug}`,
    title: `${guide.title} | dunx`,
    description: descriptionOr(
      summaryOf(read(sourcePath(guide.source))),
      `${guide.title}, from the dunx guide.`,
    ),
    kind: 'article' as const,
  })),
  ...index.packages.map((pkg) => ({
    path: `/api/${pkg.dir}`,
    title: `${pkg.name} | dunx`,
    description: descriptionOr(
      pkg.description,
      `API reference for ${pkg.name}.`,
    ),
    kind: 'article' as const,
  })),
  ...releases.map((release) => ({
    path: `/releases/${release.version}`,
    title: `dunx ${release.version} | Releases`,
    description: `What shipped in dunx ${release.version}, released ${release.date}.`,
    kind: 'article' as const,
  })),
];

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
  return `${(space > limit / 2 ? cut.slice(0, space) : cut).replace(/[,;:.\s]+$/, '')}\u2026`;
};

/** Attribute-safe. A guide title carrying an ampersand would end the value. */
const attr = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * The head for one page, built from the page Vite emitted.
 *
 * A rewrite of the built document rather than a template of its own: the asset
 * URLs, the colour-scheme script and the icon are all in there already, and a
 * second copy of that head would go stale the first time one of them changed.
 *
 * No `og:image`. Every image the site has is an SVG, which the major unfurlers
 * decline to render, so a tag pointing at one buys a broken preview rather than
 * no preview.
 */
export const renderPage = (template: string, page: Page): string => {
  const url = `${ORIGIN}${page.path}`;
  const description = clamp(page.description);

  const meta = [
    `    <link rel="canonical" href="${attr(url)}" />`,
    `    <meta property="og:type" content="${page.kind}" />`,
    `    <meta property="og:site_name" content="dunx" />`,
    `    <meta property="og:title" content="${attr(page.title)}" />`,
    `    <meta property="og:description" content="${attr(description)}" />`,
    `    <meta property="og:url" content="${attr(url)}" />`,
    `    <meta name="twitter:card" content="summary" />`,
    `    <meta name="twitter:title" content="${attr(page.title)}" />`,
    `    <meta name="twitter:description" content="${attr(description)}" />`,
  ].join('\n');

  const titled = template.replace(
    /<title>[\s\S]*?<\/title>/,
    `<title>${attr(page.title)}</title>`,
  );
  const described = titled.replace(
    /<meta\s+name="description"[\s\S]*?\/>/,
    `<meta name="description" content="${attr(description)}" />`,
  );

  return described.replace('  </head>', `${meta}\n  </head>`);
};

export const sitemapOf = (pages: readonly Page[], lastmod: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages
    .map(
      (page) =>
        `  <url>\n    <loc>${attr(`${ORIGIN}${page.path}`)}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>`,
    )
    .join('\n')}\n</urlset>\n`;

export const robots = (): string =>
  `User-agent: *\nAllow: /\n\nSitemap: ${ORIGIN}/sitemap.xml\n`;

/**
 * `/guide/controllers` becomes `guide/controllers.html`, not
 * `guide/controllers/index.html`.
 *
 * Measured on a preview deployment: Cloudflare answers a directory-index file
 * with a **308 to the trailing-slash form**, so every deep link cost a redirect
 * hop and the URL that finally rendered disagreed with the canonical this file
 * writes. The `.html` sibling is served at the extensionless path directly.
 */
export const fileFor = (path: string): string =>
  path === '/' ? 'index.html' : `${path.replace(/^\//, '')}.html`;

export interface WriteOptions {
  readonly distDir: string;
  readonly docsDir: string;
  readonly generatedDir: string;
}

export const writeSeoPages = (options: WriteOptions): Page[] => {
  const { distDir, docsDir, generatedDir } = options;

  const template = readFileSync(join(distDir, 'index.html'), 'utf8');
  const index = JSON.parse(
    readFileSync(join(generatedDir, 'index.json'), 'utf8'),
  ) as SiteIndex;
  const releasesPath = join(generatedDir, 'releases.json');
  const releases = existsSync(releasesPath)
    ? (JSON.parse(readFileSync(releasesPath, 'utf8')) as ReleaseEntry[])
    : [];

  const read = (file: string): string => {
    const full = join(docsDir, file);
    return existsSync(full) ? readFileSync(full, 'utf8') : '';
  };

  // The description Vite emitted, which is the one hand-written in `index.html`.
  // Taking it from there rather than repeating it here is what stops the landing
  // page having two descriptions that disagree.
  const home =
    /<meta\s+name="description"\s+content="([^"]*)"/.exec(template)?.[1] ?? '';

  const pages = pagesOf(index, releases, read, home);

  for (const page of pages) {
    const target = join(distDir, fileFor(page.path));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, renderPage(template, page));
  }

  // The shell with no route-specific head, served by Cloudflare with a 404
  // status for anything the loop above did not write. The router renders its
  // own Not found panel once it boots.
  writeFileSync(
    join(distDir, '404.html'),
    renderPage(template, {
      path: '/404',
      title: 'Not found | dunx',
      description: 'That page does not exist on the dunx documentation site.',
      kind: 'website',
    }),
  );

  writeFileSync(
    join(distDir, 'sitemap.xml'),
    sitemapOf(pages, index.generatedAt.slice(0, 10)),
  );
  writeFileSync(join(distDir, 'robots.txt'), robots());

  return pages;
};

if (import.meta.main) {
  const root = new URL('../../..', import.meta.url).pathname;
  const pages = writeSeoPages({
    distDir: join(root, 'internal/docs/dist'),
    docsDir: join(root, 'docs'),
    generatedDir: join(root, 'internal/docs/src/generated'),
  });
  console.log(
    `SEO: ${pages.length} pages, sitemap.xml, robots.txt and 404.html`,
  );
}
