import { describe, expect, it } from 'bun:test';
import { renderShell } from './html.js';
import { SwaggerAssets } from './swagger.js';
import { renderUiOptions, type SwaggerUiOptions } from './ui-options.js';
import type { OpenApiDocument } from './types.js';

const doc: OpenApiDocument = {
  openapi: '3.1.0',
  info: { title: 'T', version: '1' },
  tags: [],
  paths: {},
  components: { schemas: {}, securitySchemes: {} },
};

const assets = await SwaggerAssets.resolve();
const page = (ui?: SwaggerUiOptions): string =>
  renderShell(
    doc,
    {
      jsonHref: '/openapi.json',
      warnings: [],
      mountedAt: '/docs',
      ...(ui ? { ui } : {}),
    },
    assets,
  );

describe('renderUiOptions', () => {
  it('always names the mount point, and never from the caller', () => {
    expect(renderUiOptions({}, 'swagger-ui')).toContain('dom_id:"#swagger-ui"');
  });

  it('applies dunx defaults under whatever the caller passed', () => {
    const out = renderUiOptions({}, 'x');
    expect(out).toContain('"deepLinking":true');
    // Swagger UI's own default uploads the document to validator.swagger.io.
    expect(out).toContain('"validatorUrl":null');
  });

  it('lets the caller override a default', () => {
    expect(renderUiOptions({ deepLinking: false }, 'x')).toContain(
      '"deepLinking":false',
    );
    expect(
      renderUiOptions({ validatorUrl: 'https://v.example' }, 'x'),
    ).toContain('"validatorUrl":"https://v.example"');
  });

  it('emits every JSON-shaped option as JSON', () => {
    const out = renderUiOptions(
      {
        docExpansion: 'none',
        filter: true,
        maxDisplayedTags: 5,
        tryItOutEnabled: true,
        persistAuthorization: true,
        supportedSubmitMethods: ['get', 'post'],
        syntaxHighlight: { activated: true, theme: 'nord' },
        request: { curlOptions: ['--insecure'] },
      },
      'x',
    );
    expect(out).toContain('"docExpansion":"none"');
    expect(out).toContain('"filter":true');
    expect(out).toContain('"maxDisplayedTags":5');
    expect(out).toContain('"supportedSubmitMethods":["get","post"]');
    expect(out).toContain(
      '"syntaxHighlight":{"activated":true,"theme":"nord"}',
    );
    expect(out).toContain('"request":{"curlOptions":["--insecure"]}');
  });

  /**
   * The seven function-valued parameters. A server-rendered page cannot carry a
   * closure, so these are source text and land unquoted.
   */
  it('emits the function-valued options as source, not strings', () => {
    const out = renderUiOptions(
      {
        requestInterceptor: '(r) => r',
        responseInterceptor: '(r) => r',
        modelPropertyMacro: '(p) => p',
        parameterMacro: '(p) => p',
        onComplete: '() => console.log(1)',
        plugins: '[SwaggerUIBundle.plugins.DownloadUrl]',
        presets: '[SwaggerUIBundle.presets.apis]',
      },
      'x',
    );
    expect(out).toContain('"requestInterceptor":(r) => r');
    expect(out).toContain('"onComplete":() => console.log(1)');
    expect(out).toContain('"plugins":[SwaggerUIBundle.plugins.DownloadUrl]');
    // Not `"(r) => r"` - a quoted function is an inert string to Swagger UI.
    expect(out).not.toContain('"requestInterceptor":"');
  });

  /**
   * The sorters live in both worlds: Swagger UI takes `'alpha'`/`'method'` as
   * shorthands, and anything else has to be a comparator.
   */
  it('quotes a sorter shorthand and passes a comparator through as source', () => {
    expect(renderUiOptions({ operationsSorter: 'alpha' }, 'x')).toContain(
      '"operationsSorter":"alpha"',
    );
    expect(renderUiOptions({ tagsSorter: 'alpha' }, 'x')).toContain(
      '"tagsSorter":"alpha"',
    );
    expect(renderUiOptions({ operationsSorter: '(a,b) => 0' }, 'x')).toContain(
      '"operationsSorter":(a,b) => 0',
    );
  });

  it('keeps the keys dunx owns out of the Swagger UI argument', () => {
    const out = renderUiOptions({ favicon: '/i.png', title: 'Mine' }, 'x');
    expect(out).not.toContain('favicon');
    expect(out).not.toContain('"title"');
  });
});

describe('the page, configured', () => {
  it('serves the swagger favicon by default', () => {
    expect(page()).toContain(
      `<link rel="icon" href="/docs/favicon-32x32.png?v=${assets.version}">`,
    );
  });

  it('takes a favicon of your own', () => {
    expect(page({ favicon: '/brand.svg' })).toContain(
      '<link rel="icon" href="/brand.svg">',
    );
    expect(page({ favicon: 'data:,' })).toContain(
      '<link rel="icon" href="data:,">',
    );
  });

  it('omits the link entirely for `favicon: false`', () => {
    expect(page({ favicon: false })).not.toContain('rel="icon"');
  });

  it('takes a title of your own, defaulting to the document info', () => {
    expect(page()).toContain('<title>T 1</title>');
    expect(page({ title: 'My API' })).toContain('<title>My API</title>');
  });

  it('escapes what it interpolates', () => {
    expect(page({ title: '<script>x</script>' })).not.toContain(
      '<title><script>',
    );
    expect(page({ favicon: '"><script>x</script>' })).not.toContain(
      '"><script>',
    );
  });
});
