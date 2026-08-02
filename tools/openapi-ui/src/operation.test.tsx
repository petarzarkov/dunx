import { Accordion, MantineProvider } from '@mantine/core';
import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'bun:test';
import { Operation } from './components/Operation';
import { entriesOf, type OpenApiDocument, type PageModel } from './model';

/**
 * `RouteSchemas.response` puts response bodies into `openapi.json`. These lock in
 * that the explorer reads them: a fully documented route must not render like an
 * undocumented one, the `$ref` has to resolve against `components.schemas` the way
 * the request side does, and the documented response must stay separate from
 * whatever the try-it-out panel gets back.
 */
const spec: OpenApiDocument = {
  openapi: '3.1.0',
  info: { title: 'T', version: '1' },
  paths: {
    '/people/{id}': {
      get: {
        operationId: 'People_get',
        tags: ['People'],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': {
            description: 'OK',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Person' },
              },
            },
          },
          '404': {
            description: 'Not Found',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Problem' },
              },
            },
          },
        },
      },
    },
    '/people': {
      // A route that documented no body: still one row per status, no table.
      delete: {
        operationId: 'People_delete',
        responses: { '204': { description: 'No Content' } },
      },
    },
  },
  components: {
    schemas: {
      Person: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          nickname: { type: 'string', description: 'What they go by' },
        },
        required: ['id'],
      },
      Problem: {
        type: 'object',
        properties: { error: { type: 'string' } },
      },
    },
  },
};

const model: PageModel = {
  document: spec,
  jsonHref: '/openapi.json',
  warnings: [],
  prose: {},
  samples: {},
  fields: {},
};

const open = (operationId: string) => {
  const entry = entriesOf(spec).find(
    (one) => one.operation.operationId === operationId,
  );
  if (!entry) throw new Error(`no operation ${operationId}`);
  return render(
    <MantineProvider defaultColorScheme="light">
      <Accordion defaultValue={`${entry.method}:${entry.path}`}>
        <Operation entry={entry} model={model} auth={{}} />
      </Accordion>
    </MantineProvider>,
  );
};

afterEach(() => {
  document.body.innerHTML = '';
});

describe('a documented response', () => {
  test('renders one panel per status, resolving the named schema', () => {
    open('People_get');
    const text = document.body.textContent ?? '';

    expect(text).toContain('200');
    expect(text).toContain('OK');
    expect(text).toContain('404');
    expect(text).toContain('Not Found');
    expect(text).toContain('#/components/schemas/Person');
    expect(text).toContain('#/components/schemas/Problem');
  });

  test('reuses the request-side property table rather than dumping JSON', () => {
    open('People_get');
    // Three tables: the parameters, then one per documented status. The response
    // rows come from the same `SchemaView` a request body renders through, so a
    // `$ref`, a required marker and a format all read the same on both sides.
    const tables = screen.getAllByRole('table');
    expect(tables).toHaveLength(3);

    const person = tables[1];
    if (!person) throw new Error('no response table');
    expect(within(person).getByText('id')).toBeDefined();
    expect(within(person).getByText('string · uuid')).toBeDefined();
    expect(within(person).getByText('What they go by')).toBeDefined();
    expect(within(person).getAllByLabelText('required')).toHaveLength(1);
  });

  test('stays separate from the try-it-out result', () => {
    open('People_get');
    // The documented response is a contract; the panel below sends a real
    // request. Merging them would let a 500 from a local run read as the spec.
    const text = document.body.textContent ?? '';
    expect(text.indexOf('Responses')).toBeLessThan(text.indexOf('Send it'));
    expect(screen.getByRole('button', { name: 'Send' })).toBeDefined();
  });

  test('a status with no body is still listed', () => {
    open('People_delete');
    const text = document.body.textContent ?? '';
    expect(text).toContain('204');
    expect(text).toContain('No Content');
    expect(screen.queryAllByRole('table')).toHaveLength(0);
  });
});
