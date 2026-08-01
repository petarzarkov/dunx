import { describe, expect, it } from 'bun:test';
import { renderPage } from './html.js';
import type { OpenApiDocument } from './types.js';

const document: OpenApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'Rendered API',
    version: '1.2.3',
    description: 'Two routes and **one** schema.',
  },
  tags: [{ name: 'Users' }],
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

const page = renderPage(document, {
  jsonHref: '/api/openapi.json',
  warnings: ['one schema degraded'],
});

describe('the docs page', () => {
  it('is a self-contained HTML document', () => {
    expect(page.startsWith('<!doctype html>')).toBe(true);
    expect(page).toContain('</html>');
    expect(page).toContain('<style>');
  });

  it('fetches nothing: no CDN, no external URL at all', () => {
    // One inline <script> now, so operations can be sent. It is the enhancement,
    // not the content — what still must hold is that nothing is *fetched*.
    expect(page).not.toContain('src=');
    expect(page).not.toContain('<link');
    expect(page).not.toContain('url(');
    expect(page).not.toContain('//cdn');
    expect(page).not.toContain('https://unpkg');
    // The only script is the one written into the page.
    expect([...page.matchAll(/<script/g)]).toHaveLength(1);
    // Every href is either the document this page describes or a fragment of the
    // page itself. Nothing leaves the origin.
    const hrefs = [...page.matchAll(/href="([^"]*)"/g)].map(
      (match) => match[1] ?? '',
    );
    expect(hrefs).toContain('/api/openapi.json');
    expect(hrefs.filter((href) => href !== '/api/openapi.json')).toEqual([
      '#schema-CreateUser',
      '#schema-ValidationError',
    ]);
  });

  it('links a $ref to the definition on the same page', () => {
    expect(page).toContain(
      '<a href="#schema-CreateUser"><code>CreateUser</code></a>',
    );
    expect(page).toContain('<details class="op" id="schema-CreateUser">');
  });

  it('groups operations by tag and shows the method, path and summary', () => {
    expect(page).toContain('<h2>Users</h2>');
    expect(page).toContain('<span class="verb get">GET</span>');
    expect(page).toContain('<span class="route">/users</span>');
    expect(page).toContain('Every user');
    expect(page).toContain('UsersController_create');
  });

  it('renders descriptions as markdown without trusting their HTML', () => {
    expect(page).toContain('<p>Creates one.</p>');
    expect(page).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('escapes what is not prose', () => {
    expect(page).toContain('&lt;Users &amp; More&gt;');
    expect(page).not.toContain('<Users & More>');
  });

  it('shows the security requirement, the roles, and their absence', () => {
    expect(page).toContain('<code>bearer</code>');
    expect(page).toContain('Roles: <code>admin</code>.');
    expect(page).toContain('public');
  });

  it('shows the schemas and the warnings', () => {
    expect(page).toContain('<h2>Schemas</h2>');
    expect(page).toContain('CreateUser');
    expect(page).toContain('one schema degraded');
  });
});

describe('sending a route from the page', () => {
  it('emits a form per operation, carrying the method and path template', () => {
    expect(page).toContain(
      '<form class="try" data-method="get" data-path="/users/{id}">',
    );
    expect(page).toContain(
      '<form class="try" data-method="post" data-path="/users">',
    );
  });

  it('gives every parameter an input tagged with where it goes', () => {
    expect(page).toContain('data-in="query" data-name="limit"');
    // `/users/{id}` declares no `parameters` at all. Without an input derived
    // from the template the request would go out with a literal "{id}" in it.
    expect(page).toContain('data-in="path" data-name="id"');
  });

  it('pre-fills the body from the schema, so sending is one click', () => {
    // Derived from CreateUser, refs resolved against components/schemas.
    expect(page).toContain('<textarea data-body');
    expect(page).toContain('&quot;name&quot;: &quot;string&quot;');
  });

  it('seeds an Authorization line only where a scheme is required', () => {
    const forms = page.split('<form class="try"');
    // POST /users declares `security: [{ bearer: [] }]`; GET /users/{id} is
    // explicitly public, so it gets an empty box.
    // The placeholder is on every box; what differs is the pre-filled *value*.
    const value = (form: string | undefined): string =>
      /<textarea data-headers[^>]*>([^<]*)<\/textarea>/.exec(form ?? '')?.[1] ??
      '';

    const guarded = forms.find((form) =>
      form.includes('data-method="post" data-path="/users"'),
    );
    expect(value(guarded)).toBe('Authorization: Bearer ');

    const open = forms.find((form) => form.includes('data-path="/users/{id}"'));
    expect(value(open)).toBe('');
  });

  it('carries the client inline, and it is the whole of the JavaScript', () => {
    expect(page).toContain("form.matches('form.try')");
    expect(page).toContain('performance.now()');
    // The literal closing tag inside the script would end it early.
    const script = page.slice(page.indexOf('<script>') + 8);
    expect(script.slice(0, script.indexOf('</script>'))).not.toContain(
      '</script',
    );
  });
});
