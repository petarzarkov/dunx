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
import { BLURB, CHIPS, HEADLINE } from '../../../scripts/positioning.js';
import { SITE_URL, summaryOf } from './agent-docs.js';
import { jsonLdFor, type Entity } from './json-ld.js';
import {
  escapeHtml,
  guideBody,
  homeBody,
  packageBody,
  panelBody,
  PRERENDER_STYLE,
  type Content,
} from './prerender.js';

/** No trailing slash, so `${ORIGIN}${page.path}` is never `//guide`. */
const ORIGIN = SITE_URL.replace(/\/$/, '');

/** A page's head, before {@link pagesOf} gives it a body to go with it. */
export interface PageMeta {
  /** Absolute path, `/` for the landing page. */
  readonly path: string;
  readonly title: string;
  readonly description: string;
  /** `article` for a document, `website` for a landing or index page. */
  readonly kind: 'article' | 'website';
}

export interface Page extends PageMeta {
  /**
   * The markup written inside `#root`, so the file carries the page's text and
   * its links before the bundle runs. See `prerender.ts`.
   */
  readonly body: string;
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
  /** Absent in a fixture; the generator writes it for every package. */
  readonly exports?: readonly { readonly name: string }[];
}

interface SiteIndex {
  readonly generatedAt: string;
  readonly guides: readonly GuideEntry[];
  readonly packages: readonly PackageEntry[];
  /** The hero's own copy, which the prerendered landing page reuses. */
  readonly positioning?: {
    readonly headline: readonly string[];
    readonly blurb: string;
    readonly chips: readonly string[];
  };
  readonly repoUrl?: string;
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
 * all, and a guide's summary depends on its source being readable at build time.
 * That holds today - the model is generated from those same files moments
 * earlier - but a search result should not rest on it.
 */
const descriptionOr = (summary: string, fallback: string): string =>
  summary.trim() === '' ? fallback : summary.trim();

/**
 * The two payload lookups `prerender.ts` needs, which a fixture can stub.
 *
 * Separate from `read` because these return HTML the generator has already
 * rendered, out of `src/generated/`, rather than markdown out of `docs/`.
 */
export interface Payloads {
  readonly guideHtml: (slug: string) => string;
  readonly packageReadme: (dir: string) => string;
}

const NO_PAYLOADS: Payloads = {
  guideHtml: () => '',
  packageReadme: () => '',
};

/**
 * The landing page's copy, out of the model the site renders from.
 *
 * The fallback is the source those model fields are generated from, rather than
 * a copy of the words: a literal here would be a second declaration of the
 * headline, and it would drift the first time the real one moved.
 */
const positioningOf = (index: SiteIndex): Content['positioning'] =>
  index.positioning ?? { headline: HEADLINE, blurb: BLURB, chips: CHIPS };

const contentOf = (index: SiteIndex, payloads: Payloads): Content => ({
  positioning: positioningOf(index),
  guides: index.guides.map((guide) => ({
    slug: guide.slug,
    title: guide.title,
  })),
  packages: index.packages.map((pkg) => ({
    name: pkg.name,
    dir: pkg.dir,
    description: pkg.description,
    exports: (pkg.exports ?? []).map((symbol) => symbol.name),
  })),
  guideHtml: payloads.guideHtml,
  packageReadme: payloads.packageReadme,
});

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
  payloads: Payloads = NO_PAYLOADS,
): Page[] => {
  const content = contentOf(index, payloads);

  return [
    {
      path: '/',
      title: 'dunx | fastest web DI framework',
      description: homeDescription,
      kind: 'website',
      body: homeBody(content),
    },
    ...FIXED.map((page) => ({
      ...page,
      body: panelBody(page.title, page.description, content),
    })),
    ...index.guides.map((guide) => ({
      path: `/guide/${guide.slug}`,
      title: `${guide.title} | dunx`,
      description: descriptionOr(
        summaryOf(read(sourcePath(guide.source))),
        `${guide.title}, from the dunx guide.`,
      ),
      kind: 'article' as const,
      body: guideBody(guide.title, payloads.guideHtml(guide.slug), content),
    })),
    // `content.packages` rather than `index.packages`: it is the same list with
    // the export names already flattened, so there is no second reshape here and
    // no index to reach back through.
    ...content.packages.map((pkg) => ({
      path: `/api/${pkg.dir}`,
      title: `${pkg.name} | dunx`,
      description: descriptionOr(
        pkg.description,
        `API reference for ${pkg.name}.`,
      ),
      kind: 'article' as const,
      body: packageBody(pkg, content),
    })),
    ...releases.map((release) => ({
      path: `/releases/${release.version}`,
      title: `dunx ${release.version} | Releases`,
      description: `What shipped in dunx ${release.version}, released ${release.date}.`,
      kind: 'article' as const,
      body: panelBody(
        `dunx ${release.version}`,
        `What shipped in dunx ${release.version}, released ${release.date}.`,
        content,
      ),
    })),
  ];
};

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

/**
 * The social card, at the 1.91:1 the unfurlers crop to.
 *
 * There used to be no `og:image` at all, because every image the site had was an
 * SVG and the major unfurlers decline to render one. `scripts/og-card.ts` draws
 * a PNG through the `Bun.WebView` the screenshot suite already uses, so the tag
 * points at a raster file and `summary_large_image` is honest.
 */
const OG_IMAGE = `${ORIGIN}/og.png`;

/**
 * The default entity, for a model with no `repoUrl` and a caller with no
 * release list. `writeSeoPages` passes the real one.
 */
const DEFAULT_ENTITY: Entity = {
  origin: ORIGIN,
  repoUrl: 'https://github.com/petarzarkov/dunx',
  version: null,
};

/**
 * The head and body for one page, built from the page Vite emitted.
 *
 * A rewrite of the built document rather than a template of its own: the asset
 * URLs, the colour-scheme script and the icon are all in there already, and a
 * second copy of that head would go stale the first time one of them changed.
 */
export const renderPage = (
  template: string,
  page: Page,
  entity: Entity = DEFAULT_ENTITY,
): string => {
  const url = `${ORIGIN}${page.path}`;
  const description = clamp(page.description);
  const attr = escapeHtml;

  const meta = [
    `    <link rel="canonical" href="${attr(url)}" />`,
    `    <meta property="og:type" content="${page.kind}" />`,
    `    <meta property="og:site_name" content="dunx" />`,
    `    <meta property="og:title" content="${attr(page.title)}" />`,
    `    <meta property="og:description" content="${attr(description)}" />`,
    `    <meta property="og:url" content="${attr(url)}" />`,
    `    <meta property="og:image" content="${attr(OG_IMAGE)}" />`,
    `    <meta property="og:image:width" content="1200" />`,
    `    <meta property="og:image:height" content="630" />`,
    `    <meta name="twitter:card" content="summary_large_image" />`,
    `    <meta name="twitter:title" content="${attr(page.title)}" />`,
    `    <meta name="twitter:description" content="${attr(description)}" />`,
    `    <meta name="twitter:image" content="${attr(OG_IMAGE)}" />`,
    jsonLdFor({
      entity,
      path: page.path,
      title: page.title,
      description,
      kind: page.kind,
    }),
    page.body === '' ? '' : PRERENDER_STYLE,
  ]
    .filter((line) => line !== '')
    .join('\n');

  const titled = template.replace(
    /<title>[\s\S]*?<\/title>/,
    `<title>${attr(page.title)}</title>`,
  );
  const described = titled.replace(
    /<meta\s+name="description"[\s\S]*?\/>/,
    `<meta name="description" content="${attr(description)}" />`,
  );

  const headed = described.replace('  </head>', `${meta}\n  </head>`);

  if (page.body === '') return headed;

  // Inside `#root`, which `createRoot().render()` empties on its first render.
  // Matching Vite's exact spelling rather than a regex: if the emitted shell
  // ever stops carrying that div, the replace is a no-op and the prerender test
  // fails, which is better than a loose pattern quietly matching something else.
  //
  // `data-prerender` is what tells the two of them apart once the page is live.
  // `preview.ts` used to treat any non-empty `<h1>` as "the app has mounted",
  // and the prerendered heading is there before the bundle is even requested, so
  // every screenshot would have caught this markup instead of the site.
  return headed.replace(
    '<div id="root"></div>',
    `<div id="root"><div data-prerender>${page.body}</div></div>`,
  );
};

export const sitemapOf = (pages: readonly Page[], lastmod: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages
    .map(
      (page) =>
        `  <url>\n    <loc>${escapeHtml(`${ORIGIN}${page.path}`)}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>`,
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

  /**
   * The rendered payloads, read one at a time. Together the guides come to about
   * 1 MB, and each page needs one of them.
   */
  const payload = (dir: string, name: string, field: string): string => {
    const full = join(generatedDir, dir, `${name}.json`);
    if (!existsSync(full)) return '';
    const parsed = JSON.parse(readFileSync(full, 'utf8')) as Record<
      string,
      unknown
    >;
    const value = parsed[field];
    return typeof value === 'string' ? value : '';
  };

  const payloads: Payloads = {
    guideHtml: (slug) => payload('guides', slug, 'html'),
    packageReadme: (dir) => payload('packages', dir, 'readme'),
  };

  // The description Vite emitted, which is the one hand-written in `index.html`.
  // Taking it from there rather than repeating it here is what stops the landing
  // page having two descriptions that disagree.
  const home =
    /<meta\s+name="description"\s+content="([^"]*)"/.exec(template)?.[1] ?? '';

  const pages = pagesOf(index, releases, read, home, payloads);
  const entity: Entity = {
    origin: ORIGIN,
    repoUrl: index.repoUrl ?? DEFAULT_ENTITY.repoUrl,
    version: releases[0]?.version ?? null,
  };

  for (const page of pages) {
    const target = join(distDir, fileFor(page.path));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, renderPage(template, page, entity));
  }

  // The shell with no route-specific head, served by Cloudflare with a 404
  // status for anything the loop above did not write. The router renders its
  // own Not found panel once it boots.
  //
  // Its body stays empty on purpose: a 404 carrying the site's whole nav is a
  // soft-404 signal, and `_redirects` was rewritten to stop producing those.
  writeFileSync(
    join(distDir, '404.html'),
    renderPage(
      template,
      {
        path: '/404',
        title: 'Not found | dunx',
        description: 'That page does not exist on the dunx documentation site.',
        kind: 'website',
        body: '',
      },
      entity,
    ),
  );

  writeFileSync(
    join(distDir, 'sitemap.xml'),
    sitemapOf(pages, index.generatedAt.slice(0, 10)),
  );
  writeFileSync(join(distDir, 'robots.txt'), robots());

  return pages;
};

if (import.meta.main) {
  const root = Bun.fileURLToPath(new URL('../../..', import.meta.url));
  const pages = writeSeoPages({
    distDir: join(root, 'internal/docs/dist'),
    docsDir: join(root, 'docs'),
    generatedDir: join(root, 'internal/docs/src/generated'),
  });
  console.log(
    `SEO: ${pages.length} pages, sitemap.xml, robots.txt and 404.html`,
  );
}
