import { describe, expect, it } from 'bun:test';
import { DOCUMENT_ELEMENT_ID, renderShell } from './html.js';
import { contentTypeOf, isSwaggerAsset, SwaggerAssets } from './swagger.js';
import type { OpenApiDocument } from './index.js';

const document: OpenApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'Rendered API',
    version: '1.2.3',
    description: 'Two routes and **one** schema.',
  },
  tags: [{ name: 'Users', description: 'People, mostly.' }],
  paths: {
    '/users': {
      get: {
        operationId: 'UsersController_list',
        tags: ['Users'],
        summary: 'Every user',
        parameters: [
          {
            name: 'limit',
            in: 'query',
            required: false,
            schema: { type: 'integer' },
          },
        ],
        responses: { '200': { description: 'OK' } },
      },
      post: {
        operationId: 'UsersController_create',
        tags: ['Users'],
        description: 'Creates one.\n\n<script>alert(1)</script>',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CreateUser' },
            },
          },
        },
        responses: {
          '201': { description: 'Created' },
          '400': {
            description: 'A declared schema rejected the request',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ValidationError' },
              },
            },
          },
        },
        security: [{ bearer: [] }],
        'x-required-roles': ['admin'],
      },
    },
    '/users/{id}': {
      get: {
        operationId: 'UsersController_one',
        tags: ['<Users & More>'],
        responses: { '200': { description: 'OK' } },
        security: [],
      },
    },
  },
  components: {
    schemas: {
      CreateUser: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'integer', minimum: 18 },
          tags: { type: 'array', items: { type: 'string' } },
        },
      },
      ValidationError: { type: 'object' },
    },
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
  },
};

const options = {
  jsonHref: '/api/openapi.json',
  warnings: ['one schema degraded'],
  mountedAt: '/api/docs',
};

const assets = await SwaggerAssets.resolve();
const page = renderShell(document, options, assets);

/** The `<script type="application/json">` Swagger UI is handed. */
const embedded = (): OpenApiDocument => {
  const open = `<script type="application/json" id="${DOCUMENT_ELEMENT_ID}">`;
  const from = page.indexOf(open) + open.length;
  return JSON.parse(page.slice(from, page.indexOf('</script>', from)));
};

/**
 * The page without any script body - the markup a browser actually parses as
 * markup. Everything inside a `<script>` is text to the HTML parser, so an
 * `href="` inside a boot script is not a resource.
 */
const shell = page.replace(/(<script[^>]*>)[\s\S]*?(<\/script>)/g, '$1$2');

/** Every URL a browser would actually fetch from this page. */
const fetched = (): string[] => [
  ...[...shell.matchAll(/<script\b[^>]*\ssrc="([^"]*)"/g)].map(
    (m) => m[1] ?? '',
  ),
  ...[...shell.matchAll(/<link\b[^>]*\shref="([^"]*)"/g)].map(
    (m) => m[1] ?? '',
  ),
];

describe('the docs page', () => {
  it('is an HTML document with Swagger UI mount point', () => {
    expect(page.startsWith('<!doctype html>')).toBe(true);
    expect(page).toContain('</html>');
    expect(page).toContain('<style>');
    expect(page).toContain('<div id="swagger-ui"></div>');
  });

  /**
   * **The guarantee changed with the page and this is the assertion that says how.**
   * dunx used to inline its own explorer, so the page fetched nothing at all. Swagger
   * UI is 3.7x the size gzipped, so it is served as two assets instead - which means
   * the page does fetch, and what has to be pinned is that it only ever fetches from
   * this origin.
   */
  it('fetches only its own assets, and only from this origin', () => {
    expect(fetched().toSorted()).toEqual([
      // The favicon is served rather than a `data:` URI because it comes out of
      // the same install. Without it a browser asks for `/favicon.ico` and the
      // consumer's own app logs the 404.
      `/api/docs/favicon-32x32.png?v=${assets.version}`,
      `/api/docs/swagger-ui-bundle.js?v=${assets.version}`,
      `/api/docs/swagger-ui.css?v=${assets.version}`,
    ]);
    // Every one is relative, so nothing can resolve to another host.
    for (const url of fetched()) expect(url.startsWith('/')).toBe(true);
    expect(shell).not.toMatch(
      /<(img|iframe|object|embed|source|track|video|audio)\b/,
    );
    expect(page).not.toMatch(/url\(\s*["']?(https?:)?\/\//);
    expect(page).not.toContain('@import');
    expect(page).not.toContain('//cdn');
    expect(page).not.toContain('unpkg.com');
    expect(page).not.toContain('jsdelivr');
    expect(page).not.toContain('fonts.googleapis');
    // The petstore URL ships in swagger-initializer.js, which is the file this
    // page deliberately does not use. Its presence would mean the wrong layout.
    expect(page).not.toContain('petstore.swagger.io');
  });

  /**
   * `StandaloneLayout` is the default in Swagger UI's own initializer and it is
   * wrong here twice: it needs a second ~1 MiB preset file, and it renders a URL
   * bar for loading *other* documents over a page that serves exactly one.
   */
  it('uses BaseLayout and only the bundle preset', () => {
    expect(page).toContain("layout:'BaseLayout'");
    expect(page).not.toContain('StandaloneLayout');
    expect(page).not.toContain('SwaggerUIStandalonePreset');
  });

  it('caches the assets immutably, keyed by the installed version', () => {
    expect(assets.href('/api/docs', 'swagger-ui.css')).toBe(
      `/api/docs/swagger-ui.css?v=${assets.version}`,
    );
    // The version in the query is what makes `immutable` honest and what busts
    // the cache on an upgrade.
    expect(assets.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('closes no script tag early', () => {
    for (const part of page.split('<script').slice(1)) {
      const body = part.slice(part.indexOf('>') + 1);
      expect(body.slice(0, body.indexOf('</script>'))).not.toContain(
        '</script',
      );
    }
  });

  it('embeds the whole document, so Swagger UI fetches none of it', () => {
    expect(embedded()).toEqual(document);
    // `spec`, never `url`: a fetched document costs a round trip and breaks if
    // the JSON route is guarded differently from the page.
    expect(page).toContain('spec:JSON.parse(');
    expect(page).not.toMatch(/\burl:\s*['"]/);
  });

  it('escapes the one character that could end the data block', () => {
    // `<script>alert(1)</script>` lives in a description. Written raw it would
    // close the block; `\u003c` is the same text to any JSON parser.
    expect(page).not.toContain('<script>alert(1)');
    expect(embedded().paths['/users']?.post?.description).toContain(
      '<script>alert(1)</script>',
    );
  });

  it('links to the document itself and says so when JavaScript is off', () => {
    expect(page).toContain('<noscript>');
    expect(page).toContain('href="/api/openapi.json"');
  });
});

describe('SwaggerAssets', () => {
  it('resolves the installed swagger-ui-dist and every allow-listed file', async () => {
    for (const name of [
      'swagger-ui-bundle.js',
      'swagger-ui.css',
      'swagger-ui.css.map',
      'favicon-32x32.png',
    ] as const) {
      expect(isSwaggerAsset(name)).toBe(true);
      expect(await Bun.file(assets.pathOf(name)).exists()).toBe(true);
      expect(contentTypeOf(name).length).toBeGreaterThan(0);
    }
  });

  /**
   * The allow-list is what makes one wildcard route safe. `swagger-ui-dist` also
   * holds four other builds and 4 MB of sourcemaps in the same directory.
   */
  it('refuses anything not on the allow-list', () => {
    for (const name of [
      'swagger-ui-es-bundle.js',
      'swagger-ui-bundle.js.map',
      'package.json',
      '../../../etc/passwd',
      '',
    ]) {
      expect(isSwaggerAsset(name)).toBe(false);
    }
  });

  /**
   * `swagger-ui.css` ends with a `sourceMappingURL` pointing at its map, so the map
   * has to be served or every consumer with devtools open logs a 404 against their
   * own app. The JS bundle carries no such comment, so its 1.9 MB map is not served.
   */
  it('serves the css map, because the css asks for it', async () => {
    const css = await Bun.file(assets.pathOf('swagger-ui.css')).text();
    expect(css).toContain('sourceMappingURL=swagger-ui.css.map');
    expect(isSwaggerAsset('swagger-ui.css.map')).toBe(true);

    const js = await Bun.file(assets.pathOf('swagger-ui-bundle.js')).text();
    expect(js).not.toContain('sourceMappingURL');
    expect(isSwaggerAsset('swagger-ui-bundle.js.map')).toBe(false);
  });

  it('is resolved once and cached', async () => {
    expect(await SwaggerAssets.resolve()).toBe(assets);
  });
});
