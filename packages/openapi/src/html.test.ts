import { describe, expect, it } from 'bun:test';
import { MODEL_ELEMENT_ID } from './html.js';
import { buildModel } from './model.js';
import { renderPage } from './ui.js';
import type { OpenApiDocument, PageModel } from './index.js';

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
};
const page = renderPage(document, options);

/** The `<script type="application/json">` the bundle boots from. */
const embedded = (): PageModel => {
  const open = `<script type="application/json" id="${MODEL_ELEMENT_ID}">`;
  const from = page.indexOf(open) + open.length;
  return JSON.parse(page.slice(from, page.indexOf('</script>', from)));
};

/**
 * The page without either script body - the markup a browser actually parses as
 * markup. Everything inside a `<script>` is text to the HTML parser, so an
 * `href="` or a `src=` in minified React is not a resource, and asserting over
 * it would only be asserting about somebody else's string table.
 */
const shell = page.replace(/(<script[^>]*>)[\s\S]*?(<\/script>)/g, '$1$2');

describe('the docs page', () => {
  it('is a self-contained HTML document', () => {
    expect(page.startsWith('<!doctype html>')).toBe(true);
    expect(page).toContain('</html>');
    expect(page).toContain('<style>');
    expect(page).toContain('<div id="root"></div>');
  });

  /**
   * The guarantee is unchanged; the proof had to change with the page. The old
   * page was hand-written HTML, so `not.toContain('src=')` over the whole string
   * was both sound and cheap. The page now inlines a built bundle, and minified
   * React contains `.src=` in its own code - so the assertion moved from the
   * text to the *tags*, which is what actually decides whether a browser fetches.
   */
  it('fetches nothing: no CDN, no src=, no <link>', () => {
    expect(shell).not.toMatch(/\ssrc=/);
    expect(shell).not.toMatch(/<link\b/);
    expect(shell).not.toMatch(
      /<(img|iframe|object|embed|source|track|video|audio)\b/,
    );
    // Two scripts: the model as data, and the explorer. Neither is fetched.
    // Counted by their closers - react-dom carries the literal `"<script>"` in
    // a string of its own, which the browser never sees as a tag.
    expect([...page.matchAll(/<\/script>/g)]).toHaveLength(2);
    // The only href in the markup is the document this page describes.
    expect([...shell.matchAll(/href="([^"]*)"/g)].map((m) => m[1])).toEqual([
      '/api/openapi.json',
    ]);
    // Nothing in the bundle's own CSS or code reaches off the origin either.
    expect(page).not.toMatch(/url\(\s*["']?(https?:)?\/\//);
    expect(page).not.toContain('@import');
    expect(page).not.toContain('//cdn');
    expect(page).not.toContain('unpkg.com');
    expect(page).not.toContain('jsdelivr');
    expect(page).not.toContain('fonts.googleapis');
  });

  it('closes neither script tag early', () => {
    for (const part of page.split('<script').slice(1)) {
      const body = part.slice(part.indexOf('>') + 1);
      expect(body.slice(0, body.indexOf('</script>'))).not.toContain(
        '</script',
      );
    }
  });

  it('carries the whole document, so the explorer fetches none of it', () => {
    const model = embedded();
    expect(model.document).toEqual(document);
    expect(model.jsonHref).toBe('/api/openapi.json');
    expect(model.warnings).toEqual(['one schema degraded']);
  });

  it('escapes the one character that could end the data block', () => {
    // `<script>alert(1)</script>` lives in a description. Written raw it would
    // close the block; `<` is the same text to any JSON parser.
    expect(page).not.toContain('<script>alert(1)');
    expect(embedded().prose['op:UsersController_create']).toContain(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    );
  });

  it('links to the document itself and says so when JavaScript is off', () => {
    expect(page).toContain('<noscript>');
    expect(page).toContain('href="/api/openapi.json"');
  });
});

describe('the model the page embeds', () => {
  const model = buildModel(document, options);

  it('renders descriptions as markdown without trusting their HTML', () => {
    expect(model.prose['info']).toContain('<strong>one</strong>');
    expect(model.prose['op:UsersController_create']).toContain(
      '<p>Creates one.</p>',
    );
    expect(model.prose['tag:Users']).toContain('People, mostly.');
  });

  it('pre-fills the body from the schema, so sending is one click', () => {
    // Derived from CreateUser, refs resolved against components/schemas.
    const sample = model.samples['UsersController_create'] ?? '';
    expect(JSON.parse(sample)).toEqual({
      name: 'string',
      age: 18,
      tags: ['string'],
    });
    // A GET with no request body gets no sample rather than an empty one.
    expect(model.samples['UsersController_list']).toBeUndefined();
  });

  it('gives every parameter a field tagged with where it goes', () => {
    expect(model.fields['UsersController_list']).toEqual([
      { name: 'limit', in: 'query', required: false, placeholder: '0' },
    ]);
    // `/users/{id}` declares no `parameters` at all. Without a field derived
    // from the template the request would go out with a literal "{id}" in it.
    expect(model.fields['UsersController_one']).toEqual([
      { name: 'id', in: 'path', required: true, placeholder: 'string' },
    ]);
  });

  it('leaves security, roles and their absence for the UI to read', () => {
    const create = document.paths['/users']?.post;
    expect(create?.security).toEqual([{ bearer: [] }]);
    expect(create?.['x-required-roles']).toEqual(['admin']);
    expect(document.paths['/users/{id}']?.get?.security).toEqual([]);
    expect(model.document.components.securitySchemes).toEqual({
      bearer: { type: 'http', scheme: 'bearer' },
    });
  });
});
