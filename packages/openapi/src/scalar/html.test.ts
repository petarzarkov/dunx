import { describe, expect, it } from 'bun:test';
import { PackageAssets } from '../assets.js';
import { DOCUMENT_ELEMENT_ID } from '../shell.js';
import type { OpenApiDocument } from '../types.js';
import { MOUNT_ELEMENT_ID, renderScalarPage } from './html.js';
import { renderScalarOptions, type ScalarOptions } from './options.js';
import { SCALAR_ASSETS } from './renderer.js';

const document: OpenApiDocument = {
  openapi: '3.1.0',
  info: { title: 'Rendered API', version: '1.2.3' },
  tags: [{ name: 'Users', description: 'People, mostly.' }],
  paths: {
    '/users': {
      get: {
        operationId: 'UsersController_list',
        tags: ['Users'],
        description: 'Every user.\n\n<script>alert(1)</script>',
        responses: { '200': { description: 'OK' } },
      },
    },
  },
  components: { schemas: {} },
};

const options = {
  jsonHref: '/api/openapi.json',
  warnings: [],
  mountedAt: '/api/reference',
};

const assets = await PackageAssets.resolve(SCALAR_ASSETS);
const page = (scalar?: ScalarOptions): string =>
  renderScalarPage(document, options, assets, scalar);

/** Everything inside a `<script>` is text to the HTML parser, not a resource. */
const shell = (html: string): string =>
  html.replace(/(<script[^>]*>)[\s\S]*?(<\/script>)/g, '$1$2');

const embedded = (html: string): OpenApiDocument => {
  const open = `<script type="application/json" id="${DOCUMENT_ELEMENT_ID}">`;
  const from = html.indexOf(open) + open.length;
  return JSON.parse(html.slice(from, html.indexOf('</script>', from)));
};

describe('the scalar page', () => {
  it('is an HTML document with a Scalar mount point', () => {
    expect(page().startsWith('<!doctype html>')).toBe(true);
    expect(page()).toContain(`<div id="${MOUNT_ELEMENT_ID}"></div>`);
    expect(page()).toContain(
      `Scalar.createApiReference("#${MOUNT_ELEMENT_ID}",options)`,
    );
  });

  /**
   * Every official Scalar adapter is a `<script src="https://cdn.jsdelivr.net">`
   * tag. This one serves the same bundle out of the consumer's own install.
   */
  it('fetches one asset, and only from this origin', () => {
    const html = page();
    const requested = [
      ...shell(html).matchAll(
        /<(?:script|link)\b[^>]*\s(?:src|href)="([^"]*)"/g,
      ),
    ]
      .map(([, href]) => href ?? '')
      .filter((href) => !href.startsWith('data:'));

    expect(requested).toEqual([
      `/api/reference/standalone.js?v=${assets.version}`,
    ]);
    expect(html).not.toContain('jsdelivr');
    expect(html).not.toContain('//cdn');
    expect(html).not.toContain('unpkg.com');
    expect(html).not.toContain('registry.scalar.com');
    expect(html).not.toContain('proxy.scalar.com');
    // Scalar's own fonts come from fonts.scalar.com, which this default declines.
    expect(html).toContain('"withDefaultFonts":false');
    expect(shell(html)).not.toMatch(
      /<(img|iframe|object|embed|source|track|video|audio)\b/,
    );
  });

  /**
   * The auto-mount the standalone bundle runs on load reads `#api-reference`, so
   * the embedded document must not answer to that id or Scalar would mount twice.
   */
  it('embeds the document under an id the bundle does not claim', () => {
    expect(embedded(page())).toEqual(document);
    expect(page()).toContain('options.content=content;');
    expect(page()).not.toContain('id="api-reference"');
    expect(page()).not.toContain('data-url');
  });

  it('escapes the one character that could end the data block', () => {
    expect(page()).not.toContain('<script>alert(1)');
    expect(embedded(page()).paths['/users']?.get?.description).toContain(
      '<script>alert(1)</script>',
    );
  });

  it('suppresses the favicon request by default, and takes one of your own', () => {
    expect(page()).toContain('<link rel="icon" href="data:,">');
    expect(page({ favicon: '/brand.svg' })).toContain(
      '<link rel="icon" href="/brand.svg">',
    );
    expect(page({ favicon: false })).not.toContain('rel="icon"');
  });

  it('takes a title of your own, defaulting to the document info', () => {
    expect(page()).toContain('<title>Rendered API 1.2.3</title>');
    expect(page({ title: 'My API' })).toContain('<title>My API</title>');
    expect(page({ title: '<script>x</script>' })).not.toContain(
      '<title><script>',
    );
  });

  it('links the document for a reader with JavaScript off', () => {
    expect(page()).toContain('<noscript>');
    expect(page()).toContain('href="/api/openapi.json"');
  });

  it('closes no script tag early', () => {
    const html = page({ customCss: 'body{}</script><script>alert(1)' });
    for (const part of html.split('<script').slice(1)) {
      const body = part.slice(part.indexOf('>') + 1);
      expect(body.slice(0, body.indexOf('</script>'))).not.toContain(
        '</script',
      );
    }
  });
});

describe('renderScalarOptions', () => {
  it('applies the dunx default under whatever the caller passed', () => {
    expect(renderScalarOptions({})).toBe('{"withDefaultFonts":false}');
    expect(renderScalarOptions({ withDefaultFonts: true })).toContain(
      '"withDefaultFonts":true',
    );
  });

  it('forwards the configuration Scalar reads', () => {
    const out = renderScalarOptions({
      theme: 'purple',
      layout: 'classic',
      hideModels: true,
      defaultHttpClient: { targetKey: 'js', clientKey: 'fetch' },
    });
    expect(out).toContain('"theme":"purple"');
    expect(out).toContain('"layout":"classic"');
    expect(out).toContain('"hideModels":true');
    expect(out).toContain('"defaultHttpClient":{"targetKey":"js"');
  });

  it('keeps the keys dunx owns out of the Scalar argument', () => {
    const out = renderScalarOptions({ favicon: '/i.png', title: 'Mine' });
    expect(out).not.toContain('favicon');
    expect(out).not.toContain('title');
  });
});

describe('the @scalar/api-reference assets', () => {
  it('serves the standalone bundle and the map it asks for', async () => {
    const bundle = Bun.file(assets.pathOf('standalone.js'));
    expect(await bundle.exists()).toBe(true);
    // The last line is a sourceMappingURL, so the map is served for the same
    // reason swagger-ui's stylesheet map is: devtools would log a 404 otherwise.
    const tail = await bundle.slice(bundle.size - 64).text();
    expect(tail).toContain('sourceMappingURL=standalone.js.map');
    expect(Object.hasOwn(SCALAR_ASSETS.files, 'standalone.js.map')).toBe(true);
  });

  it('serves the standalone build rather than the chunked ESM one', async () => {
    expect(Object.hasOwn(SCALAR_ASSETS.files, 'standalone.esm.js')).toBe(false);
    expect(
      (await PackageAssets.serve(SCALAR_ASSETS, 'standalone.esm.js')).status,
    ).toBe(404);
  });
});
