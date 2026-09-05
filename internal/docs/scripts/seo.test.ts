import { describe, expect, test } from 'bun:test';
import { clamp, fileFor, pagesOf, renderPage, robots, sitemapOf } from './seo';

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
    },
  ],
};

const RELEASES = [{ version: '3.3.1', date: '2026-09-05' }];

const read = (file: string): string =>
  file === 'guide/05-controllers.md'
    ? '# Controllers\n\nA controller is a class whose methods are routes. Second sentence.\n'
    : '';

const pages = (): ReturnType<typeof pagesOf> =>
  pagesOf(INDEX, RELEASES, read, 'The landing description.');

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

  test('a guide whose source is missing still gets a page', () => {
    const [, , , , guide] = pagesOf(INDEX, RELEASES, () => '', 'home');

    expect(guide?.path).toBe('/guide/controllers');
    expect(guide?.description).toBe('');
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

  test('escapes a title that would otherwise close the attribute', () => {
    const html = renderPage(TEMPLATE, {
      path: '/guide/x',
      title: 'A "quoted" & <angled> title',
      description: 'Fine.',
      kind: 'article',
    });

    expect(html).toContain(
      'content="A &quot;quoted&quot; &amp; &lt;angled&gt; title"',
    );
    expect(html).not.toContain('<angled>');
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
