import { describe, expect, test } from 'bun:test';
import {
  clamp,
  fileFor,
  pagesOf,
  renderPage,
  robots,
  sitemapOf,
  type Payloads,
} from './seo';
import { crumbsOf, type Entity } from './json-ld';

const INDEX = {
  generatedAt: '2026-09-05T06:11:22.551Z',
  guides: [
    {
      slug: 'controllers',
      title: 'Controllers',
      source: 'docs/guide/05-controllers.md',
    },
  ],
  packages: [
    {
      name: '@dunx/core',
      dir: 'core',
      description: 'DI container and modules',
      exports: [{ name: 'AppFactory' }],
    },
  ],
  positioning: {
    headline: [
      'Dependency injection for Bun.',
      'Everything a service needs, one version.',
    ],
    blurb: 'Controllers, dependency injection, and the rest of it.',
    chips: ['Bun-native'],
  },
  repoUrl: 'https://github.com/petarzarkov/dunx',
};

const ENTITY: Entity = {
  origin: 'https://dunx.win',
  repoUrl: 'https://github.com/petarzarkov/dunx',
  version: '3.3.1',
};

/** The rendered payloads `writeSeoPages` reads out of `src/generated/`. */
const PAYLOADS: Payloads = {
  guideHtml: (slug) =>
    slug === 'controllers'
      ? '<p>A controller is a class whose methods are routes.</p>'
      : '',
  packageReadme: (dir) => (dir === 'core' ? '<p>The container.</p>' : ''),
};

const RELEASES = [{ version: '3.3.1', date: '2026-09-05' }];

const read = (file: string): string =>
  file === 'guide/05-controllers.md'
    ? '# Controllers\n\nA controller is a class whose methods are routes. Second sentence.\n'
    : '';

const pages = (): ReturnType<typeof pagesOf> =>
  pagesOf(INDEX, RELEASES, read, 'The landing description.', PAYLOADS);

/** The shape `vite build` emits, trimmed to the parts this rewrites. */
const TEMPLATE = `<!doctype html>
<html lang="en">
  <head>
    <title>dunx | fastest web DI framework</title>
    <meta
      name="description"
      content="Documentation and API reference for dunx."
    />
    <script type="module" crossorigin src="/assets/index-abc.js"></script>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`;

describe('pagesOf', () => {
  test('walks the model rather than a second list of routes', () => {
    const paths = pages().map((page) => page.path);

    expect(paths).toEqual([
      '/',
      '/benchmarks',
      '/coverage',
      '/releases',
      '/guide/controllers',
      '/api/core',
      '/releases/3.3.1',
    ]);
  });

  /*
   * The whole point of the exercise: every route used to answer with the same
   * title, so a search result for a guide read "dunx | fastest web DI framework".
   */
  test('every page has a title and a description of its own', () => {
    const all = pages();
    const titles = new Set(all.map((page) => page.title));
    const descriptions = new Set(all.map((page) => page.description));

    expect(titles.size).toBe(all.length);
    expect(descriptions.size).toBe(all.length);
    expect(all.every((page) => page.description.length > 0)).toBe(true);
  });

  test("a guide's description is the summary llms.txt already uses", () => {
    const guide = pages().find((page) => page.path === '/guide/controllers');

    expect(guide?.description).toBe(
      'A controller is a class whose methods are routes.',
    );
  });

  /*
   * It cannot happen today: the model is generated from these same files moments
   * before this runs. The fallback is here because `content=""` is a worse
   * signal than no description tag at all, and a search result should not rest
   * on a file still being readable.
   */
  test('a guide whose source is unreadable falls back rather than shipping an empty description', () => {
    const all = pagesOf(INDEX, RELEASES, () => '', 'home');
    const guide = all.find((page) => page.path === '/guide/controllers');

    expect(guide?.description).toBe('Controllers, from the dunx guide.');
    expect(all.every((page) => page.description.trim() !== '')).toBe(true);
  });

  test('a package with no description falls back to its name', () => {
    const bare = {
      ...INDEX,
      packages: [{ name: '@dunx/core', dir: 'core', description: '' }],
    };
    const pkg = pagesOf(bare, RELEASES, read, 'home').find(
      (page) => page.path === '/api/core',
    );

    expect(pkg?.description).toBe('API reference for @dunx/core.');
  });
});

describe('clamp', () => {
  test('leaves a description inside the budget alone', () => {
    expect(clamp('Short enough.')).toBe('Short enough.');
  });

  test('cuts at a word boundary, not mid-word', () => {
    const cut = clamp(`${'word '.repeat(40)}end`);

    expect(cut.length).toBeLessThanOrEqual(160);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut).not.toContain('wor…');
  });

  test('drops the punctuation the cut left dangling', () => {
    expect(clamp(`${'a'.repeat(150)}, and more words here`, 160)).not.toContain(
      ',…',
    );
  });
});

describe('renderPage', () => {
  const rendered = (): string => {
    const guide = pages().find((page) => page.path === '/guide/controllers');
    if (!guide) throw new Error('no guide page');
    return renderPage(TEMPLATE, guide);
  };

  test('replaces the title rather than adding a second one', () => {
    const html = rendered();

    expect(html.match(/<title>/g)).toHaveLength(1);
    expect(html).toContain('<title>Controllers | dunx</title>');
  });

  test('replaces the description rather than adding a second one', () => {
    const html = rendered();

    expect(html.match(/name="description"/g)).toHaveLength(1);
    expect(html).toContain(
      'content="A controller is a class whose methods are routes."',
    );
  });

  test('carries an absolute canonical for that route', () => {
    expect(rendered()).toContain(
      '<link rel="canonical" href="https://dunx.win/guide/controllers" />',
    );
  });

  test('keeps the built asset tags, which is why it rewrites the real page', () => {
    expect(rendered()).toContain('src="/assets/index-abc.js"');
  });

  /* There was no og:image at all: every image the site ships is an SVG, which
   * the unfurlers decline, so a share produced a bare link. */
  test('points at the raster card at the size it declares', () => {
    const html = rendered();

    expect(html).toContain(
      '<meta property="og:image" content="https://dunx.win/og.png" />',
    );
    expect(html).toContain('<meta property="og:image:width" content="1200" />');
    expect(html).toContain(
      '<meta name="twitter:card" content="summary_large_image" />',
    );
  });

  test('escapes a title that would otherwise close the attribute', () => {
    const html = renderPage(TEMPLATE, {
      path: '/guide/x',
      title: 'A "quoted" & <angled> title',
      description: 'Fine.',
      kind: 'article',
      body: '',
    });

    expect(html).toContain(
      'content="A &quot;quoted&quot; &amp; &lt;angled&gt; title"',
    );
    expect(html).not.toContain('<angled>');
  });
});

describe('the prerendered body', () => {
  const rendered = (): string => {
    const guide = pages().find((page) => page.path === '/guide/controllers');
    if (!guide) throw new Error('no guide page');
    return renderPage(TEMPLATE, guide, ENTITY);
  };

  /*
   * The whole reason for it: `https://dunx.win/` fetched without JavaScript
   * answered with a title and an empty `<div id="root">`, so the first
   * unrendered pass a crawler takes had no text to read and no link to follow.
   */
  test('goes inside #root, which createRoot empties on its first render', () => {
    const html = rendered();

    expect(html.match(/<div id="root">/g)).toHaveLength(1);
    expect(html).toContain('<div id="root"><div data-prerender><article>');
    expect(html).not.toContain('<div id="root"></div>');
  });

  test("carries the guide's own rendered prose", () => {
    expect(rendered()).toContain(
      '<p>A controller is a class whose methods are routes.</p>',
    );
  });

  test('links every guide and package, so no page is a dead end without the bundle', () => {
    const html = rendered();

    expect(html).toContain('href="/guide/controllers"');
    expect(html).toContain('href="/api/core"');
  });

  test('the landing page renders the shared headline as its one h1', () => {
    const home = pages().find((page) => page.path === '/');

    expect(home?.body).toContain(
      '<h1>Dependency injection for Bun. Everything a service needs, one version.</h1>',
    );
    expect(home?.body.match(/<h1>/g)).toHaveLength(1);
  });

  test('a reference page names what it exports, for the long tail', () => {
    const pkg = pages().find((page) => page.path === '/api/core');

    expect(pkg?.body).toContain('<code>AppFactory</code>');
    expect(pkg?.body).toContain('<p>The container.</p>');
  });

  /* `preview.ts` waits for this attribute to go away to know the bundle has
   * mounted, so a page with no body must not emit an empty one. */
  test('a page with no body keeps the shell exactly as Vite wrote it', () => {
    const html = renderPage(
      TEMPLATE,
      {
        path: '/404',
        title: 'Not found | dunx',
        description: 'Gone.',
        kind: 'website',
        body: '',
      },
      ENTITY,
    );

    expect(html).toContain('<div id="root"></div>');
    expect(html).not.toContain('data-prerender');
  });

  test('a missing payload leaves the heading rather than throwing', () => {
    const bare = pagesOf(INDEX, RELEASES, read, 'home');
    const guide = bare.find((page) => page.path === '/guide/controllers');

    expect(guide?.body).toContain('<h1>Controllers</h1>');
  });
});

describe('structured data', () => {
  const forPage = (path: string): string => {
    const page = pages().find((entry) => entry.path === path);
    if (!page) throw new Error(`no page ${path}`);
    return renderPage(TEMPLATE, page, ENTITY);
  };

  /*
   * Searching the framework by name returned other people's Bun frameworks and
   * a suggestion that it might be spelled differently, which is what an
   * unrecognised entity looks like from the outside.
   */
  test('the landing page describes the software, once', () => {
    const html = forPage('/');

    expect(html.match(/application\/ld\+json/g)).toHaveLength(1);
    expect(html).toContain('"@type":"SoftwareApplication"');
    expect(html).toContain(
      '"codeRepository":"https://github.com/petarzarkov/dunx"',
    );
    expect(html).toContain('"softwareVersion":"3.3.1"');
  });

  test('a guide is a TechArticle under a breadcrumb trail', () => {
    const html = forPage('/guide/controllers');

    expect(html).toContain('"@type":"TechArticle"');
    expect(html).toContain('"@type":"BreadcrumbList"');
    expect(html).toContain('"name":"Guide"');
  });

  /* The `Guide` step is not a page, so linking it would put a 404 in the
   * structured data. */
  test('no breadcrumb links a section that has no page', () => {
    expect(forPage('/guide/controllers')).not.toContain(
      '"item":"https://dunx.win/guide"',
    );
    expect(forPage('/api/core')).not.toContain('"item":"https://dunx.win/api"');
    expect(forPage('/releases/3.3.1')).toContain(
      '"item":"https://dunx.win/releases"',
    );
  });

  test('no page but the landing one claims to be the software', () => {
    for (const page of pages().filter((entry) => entry.path !== '/')) {
      expect(renderPage(TEMPLATE, page, ENTITY)).not.toContain(
        'SoftwareApplication',
      );
    }
  });

  /* JSON has no other way out of a script element, and `Bun.serve<T>` in a
   * package description is not hypothetical. */
  test('escapes a < so the payload cannot close the script that carries it', () => {
    const html = renderPage(
      TEMPLATE,
      {
        path: '/api/http',
        title: 'x | dunx',
        description: 'Generic over Bun.serve<T> handlers.',
        kind: 'article',
        body: '',
      },
      ENTITY,
    );

    expect(html).toContain('\\u003c');
    expect(html).not.toContain('serve<T>');
  });
});

describe('crumbsOf', () => {
  test('a section index is one crumb', () => {
    expect(crumbsOf('/releases', 'Releases')).toEqual([
      { name: 'Releases', path: '/releases' },
    ]);
  });

  /*
   * `pagesOf` writes `/releases` but no `/guide` or `/api`, and `_redirects`
   * carries no catch-all, so a crumb linking one would publish a URL that
   * answers 404.
   */
  test('a section with no page of its own gets a name and no path', () => {
    expect(crumbsOf('/guide/controllers', 'Controllers | dunx')).toEqual([
      { name: 'Guide' },
      { name: 'Controllers | dunx', path: '/guide/controllers' },
    ]);
    expect(crumbsOf('/api/core', '@dunx/core | dunx')).toEqual([
      { name: 'Reference' },
      { name: '@dunx/core | dunx', path: '/api/core' },
    ]);
  });

  test('a section that is a page keeps its link', () => {
    expect(crumbsOf('/releases/3.3.1', 'dunx 3.3.1 | Releases')).toEqual([
      { name: 'Releases', path: '/releases' },
      { name: 'dunx 3.3.1 | Releases', path: '/releases/3.3.1' },
    ]);
  });

  /* `/benchmarks` and `/coverage` are panels, not a hierarchy, so a trail
   * naming them twice would be noise in the result. */
  test('a page with no section gets no trail', () => {
    expect(crumbsOf('/benchmarks', 'Benchmarks')).toEqual([]);
    expect(crumbsOf('/', 'dunx')).toEqual([]);
  });
});

describe('fileFor', () => {
  /*
   * A directory-index file is answered with a 308 to the trailing-slash form,
   * which put a redirect hop in front of every deep link and left the rendered
   * URL disagreeing with the canonical. Measured on a preview deployment.
   */
  test('is a sibling .html, not a directory index', () => {
    expect(fileFor('/guide/controllers')).toBe('guide/controllers.html');
    expect(fileFor('/api/core')).toBe('api/core.html');
  });

  test('the landing page keeps the name the bundler wrote', () => {
    expect(fileFor('/')).toBe('index.html');
  });
});

describe('sitemapOf', () => {
  test('lists every page as an absolute url', () => {
    const all = pages();
    const xml = sitemapOf(all, '2026-09-05');

    expect(xml.match(/<loc>/g)).toHaveLength(all.length);
    expect(xml).toContain('<loc>https://dunx.win/</loc>');
    expect(xml).toContain('<loc>https://dunx.win/guide/controllers</loc>');
    expect(xml).toContain('<lastmod>2026-09-05</lastmod>');
  });
});

describe('robots', () => {
  test('points at the sitemap it is served beside', () => {
    expect(robots()).toContain('Sitemap: https://dunx.win/sitemap.xml');
  });
});
