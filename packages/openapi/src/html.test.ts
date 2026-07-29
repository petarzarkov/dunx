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
      CreateUser: { type: 'object' },
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

  it('fetches nothing: no CDN, no script, no external URL at all', () => {
    expect(page).not.toContain('<script');
    expect(page).not.toContain('src=');
    expect(page).not.toContain('<link');
    expect(page).not.toContain('url(');
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
