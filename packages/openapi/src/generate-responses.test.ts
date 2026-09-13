import { describe, expect, it } from 'bun:test';
import { Module } from '@dunx/core';
import {
  Controller,
  Delete,
  Get,
  HttpStatusCode,
  Post,
  type Input,
  type RouteSchemas,
} from '@dunx/http';
import { z } from 'zod';
import { describeRoutes } from './discover.js';
import { info, operationOf } from './document.fixture.js';
import { generateDocument } from './generate.js';
import { danglingRefs } from './refs.js';

const Tag = z
  .object({ label: z.string().min(1) })
  .meta({ id: 'Tag', title: 'A label attached to a user' });

const CreateUser = z
  .object({ name: z.string().min(1).max(40), tags: z.array(Tag).default([]) })
  .meta({ id: 'CreateUser', title: 'Create a user' });

const UserIndex = z
  .object({ id: z.coerce.number().int().min(1) })
  .meta({ id: 'UserIndex' });

/**
 * Response bodies, non-zod vendors, deep schema rewrites and contributed paths.
 * Split from `generate.test.ts` to keep both halves inside the repo's 500-line
 * limit; the fixtures above are the same ones, deliberately duplicated rather
 * than shared, because a plain `.ts` helper would count as package source and
 * move every coverage number.
 */

describe('documented response bodies', () => {
  const SanitizedUser = z
    .object({ id: z.number().int(), name: z.string() })
    .meta({ id: 'SanitizedUser' });

  const Problem = z.object({ error: z.string() });

  const showUser = {
    params: UserIndex,
    response: { 200: SanitizedUser, 404: Problem },
  } as const satisfies RouteSchemas;

  const listPeople = {
    response: { 200: z.array(SanitizedUser) },
  } as const satisfies RouteSchemas;

  const createPerson = {
    body: CreateUser,
    response: { 201: SanitizedUser },
  } as const satisfies RouteSchemas;

  const removePerson = {
    status: HttpStatusCode.NO_CONTENT,
  } as const satisfies RouteSchemas;

  type Person = z.infer<typeof SanitizedUser>;
  const ada: Person = { id: 1, name: 'Ada' };

  @Controller('people')
  class PeopleController {
    // The bodies conform because the decorators hold them to the `response`
    // entry for each route's success status - a `null` here is a TS1241.
    @Get('/', listPeople)
    list(_input: Input<typeof listPeople>): readonly Person[] {
      return [ada];
    }

    @Get('/:id', showUser)
    one(_input: Input<typeof showUser>): Person {
      return ada;
    }

    @Post('/', createPerson)
    create(_input: Input<typeof createPerson>): Person {
      return ada;
    }

    @Delete('/:id', removePerson)
    remove(_input: Input<typeof removePerson>): undefined {
      return undefined;
    }
  }

  @Module({ controllers: [PeopleController] })
  class PeopleModule {}

  const built = generateDocument(describeRoutes(PeopleModule), info);

  it('refs a named response schema, hoisted like a request body', async () => {
    const { document, warnings } = await built;

    expect(
      operationOf(document, '/people/{id}', 'get').responses['200'],
    ).toEqual({
      description: 'OK',
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/SanitizedUser' },
        },
      },
    });
    expect(Object.keys(document.components.schemas)).toContain('SanitizedUser');
    expect(warnings).toEqual([]);
    expect(danglingRefs(document)).toEqual([]);
  });

  it('inlines an anonymous one, and documents a status the route never defaults to', async () => {
    const { document } = await built;
    const responses = operationOf(document, '/people/{id}', 'get').responses;

    expect(Object.keys(responses)).toEqual(['200', '400', '404']);
    expect(responses['404']).toEqual({
      description: 'Not found',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: { error: { type: 'string' } },
            required: ['error'],
            additionalProperties: false,
          },
        },
      },
    });
  });

  it('hoists a $def a response root only referenced', async () => {
    const { document } = await built;

    expect(operationOf(document, '/people', 'get').responses['200']).toEqual({
      description: 'OK',
      content: {
        'application/json': {
          schema: {
            type: 'array',
            items: { $ref: '#/components/schemas/SanitizedUser' },
          },
        },
      },
    });
  });

  it('documents the verb’s own success status, not only 200', async () => {
    const { document } = await built;
    const created = operationOf(document, '/people', 'post').responses['201'];

    expect(created?.content?.['application/json']?.schema).toEqual({
      $ref: '#/components/schemas/SanitizedUser',
    });
  });

  it('leaves a route that declared no response body exactly as it was', async () => {
    const { document } = await built;

    expect(operationOf(document, '/people/{id}', 'delete').responses).toEqual({
      '204': { description: 'No content' },
    });
  });

  it('reads the response side as output: a default is present coming back', async () => {
    const Paged = z.object({ take: z.number().default(10) });
    const paged = { response: { 200: Paged } } as const satisfies RouteSchemas;

    @Controller('paged')
    class PagedController {
      @Get('/', paged)
      list(_input: Input<typeof paged>): { take: number } {
        return { take: 10 };
      }
    }

    @Module({ controllers: [PagedController] })
    class PagedModule {}

    const { document } = await generateDocument(
      describeRoutes(PagedModule),
      info,
    );
    // `io: 'output'`, unlike the request side: a field with a default is optional
    // going in and always present coming out.
    expect(
      operationOf(document, '/paged', 'get').responses['200']?.content?.[
        'application/json'
      ]?.schema,
    ).toEqual({
      type: 'object',
      properties: { take: { type: 'number', default: 10 } },
      required: ['take'],
      additionalProperties: false,
    });
  });
});

/**
 * Endpoints served by something other than a dunx controller are invisible to
 * route discovery. Better Auth is the motivating case: it owns a dozen paths
 * behind its own handler, and without this the document describes an API with no
 * authentication surface at all.
 */
describe('contributed paths', () => {
  const fragment = {
    paths: { '/api/auth/session': { get: { summary: 'Session' } } },
    schemas: { Session: { type: 'object' } },
    tags: [{ name: 'auth' }],
  };

  it('merges paths, schemas and tags a contributor supplies', async () => {
    const { document, warnings } = await generateDocument([], {
      title: 'API',
      version: '1',
      contribute: [fragment],
    });

    expect(document.paths['/api/auth/session'] as unknown).toEqual({
      get: { summary: 'Session' },
    });
    // Titled from its key, the same as a generated schema, so a contributed model
    // labels correctly where it appears nested.
    expect(document.components.schemas?.['Session']).toEqual({
      title: 'Session',
      type: 'object',
    });
    expect(document.tags?.some((tag) => tag.name === 'auth')).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('accepts an async contributor', async () => {
    const { document } = await generateDocument([], {
      title: 'API',
      version: '1',
      contribute: [async () => fragment],
    });

    expect(document.paths['/api/auth/session']).toBeDefined();
  });

  it('keeps a declared route and warns when a contributor collides', async () => {
    // The contributor is describing endpoints the generator could not see, so a
    // collision means it was wrong. Replacing real documentation with a guess is
    // the worse outcome.
    const routes = await generateDocument([], {
      title: 'API',
      version: '1',
      contribute: [
        { paths: { '/x': { get: { summary: 'from contributor' } } } },
        { paths: { '/x': { get: { summary: 'second contributor' } } } },
      ],
    });

    expect(routes.document.paths['/x'] as unknown).toEqual({
      get: { summary: 'from contributor' },
    });
    expect(routes.warnings.join(' ')).toContain('"/x"');
  });

  it('survives a contributor that throws', async () => {
    const { document, warnings } = await generateDocument([], {
      title: 'API',
      version: '1',
      contribute: [
        () => {
          throw new Error('library exploded');
        },
        fragment,
      ],
    });

    // A library that cannot produce its schema costs documentation, not boot.
    expect(warnings.join(' ')).toContain('library exploded');
    expect(document.paths['/api/auth/session']).toBeDefined();
  });
});
