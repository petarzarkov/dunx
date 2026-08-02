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
  type StandardSchemaV1,
} from '@dunx/http';
import { z } from 'zod';
import { describeRoutes } from './discover.js';
import { generateDocument } from './generate.js';
import { danglingRefs } from './refs.js';
import type {
  OpenApiDocument,
  OperationKey,
  OperationObject,
} from './types.js';

const Tag = z
  .object({ label: z.string().min(1) })
  .meta({ id: 'Tag', title: 'A label attached to a user' });

const CreateUser = z
  .object({ name: z.string().min(1).max(40), tags: z.array(Tag).default([]) })
  .meta({ id: 'CreateUser', title: 'Create a user' });

const UserIndex = z
  .object({ id: z.coerce.number().int().min(1) })
  .meta({ id: 'UserIndex' });

const info = { title: 'Test API', version: '2.1.0' } as const;

const operationOf = (
  document: OpenApiDocument,
  path: string,
  method: OperationKey,
): OperationObject => {
  const item = document.paths[path];
  if (item === undefined) {
    throw new Error(
      `no path ${path}; document has ${Object.keys(document.paths).join(', ')}`,
    );
  }
  const operation = item[method];
  if (operation === undefined) throw new Error(`no ${method} on ${path}`);
  return operation;
};

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

  @Controller('people')
  class PeopleController {
    @Get('/', listPeople)
    list(_input: Input<typeof listPeople>): null {
      return null;
    }

    @Get('/:id', showUser)
    one(_input: Input<typeof showUser>): null {
      return null;
    }

    @Post('/', createPerson)
    create(_input: Input<typeof createPerson>): null {
      return null;
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
      list(_input: Input<typeof paged>): null {
        return null;
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

describe('a vendor that is not zod', () => {
  const foreign: StandardSchemaV1 = {
    '~standard': {
      version: 1,
      vendor: 'valibot',
      validate: (value: unknown) => ({ value }),
    },
  };

  const foreignBody = { body: foreign } as const satisfies RouteSchemas;
  const foreignQuery = { query: foreign } as const satisfies RouteSchemas;

  @Controller('foreign')
  class ForeignController {
    @Post('/', foreignBody)
    create(input: Input<typeof foreignBody>): unknown {
      return input.body;
    }

    @Get('/', foreignQuery)
    list(input: Input<typeof foreignQuery>): unknown {
      return input.query;
    }
  }

  @Module({ controllers: [ForeignController] })
  class ForeignModule {}

  it('degrades to a permissive schema and says so, instead of throwing', async () => {
    const result = await generateDocument(describeRoutes(ForeignModule), info);
    const create = operationOf(result.document, '/foreign', 'post');

    expect(create['x-schema-vendor']).toBe('valibot');
    const schema =
      create.requestBody?.content['application/json']?.schema ?? {};
    // Permissive: no type, no properties, nothing that could reject a request.
    expect(Object.keys(schema)).toEqual(['description']);
    expect(result.warnings.join('\n')).toContain('"valibot"');
    expect(danglingRefs(result.document)).toEqual([]);
  });

  it('emits no query parameters it cannot name', async () => {
    const result = await generateDocument(describeRoutes(ForeignModule), info);
    expect(
      operationOf(result.document, '/foreign', 'get').parameters,
    ).toBeUndefined();
  });
});

describe('schemas that need more than a prefix rewrite', () => {
  it('repoints a cyclic schema’s root `$ref: "#"` at its component', async () => {
    interface Node {
      readonly name: string;
      readonly children: readonly Node[];
    }
    const TreeNode: z.ZodType<Node> = z
      .lazy(() => z.object({ name: z.string(), children: z.array(TreeNode) }))
      .meta({ id: 'TreeNode' });

    const createNode = { body: TreeNode } as const satisfies RouteSchemas;

    @Controller('tree')
    class TreeController {
      @Post('/', createNode)
      create(input: Input<typeof createNode>): unknown {
        return input.body;
      }
    }

    @Module({ controllers: [TreeController] })
    class TreeModule {}

    const result = await generateDocument(describeRoutes(TreeModule), info);
    const node = result.document.components.schemas['TreeNode'];

    expect(node).toBeDefined();
    expect(JSON.stringify(node)).toContain('"#/components/schemas/TreeNode"');
    expect(JSON.stringify(result.document)).not.toContain('"$ref":"#"');
    expect(danglingRefs(result.document)).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('registers a cyclic query root, which is expanded rather than referenced', async () => {
    interface Chain {
      readonly id: string;
      readonly next?: Chain | undefined;
    }
    const Link: z.ZodType<Chain> = z
      .lazy(() => z.object({ id: z.string(), next: Link.optional() }))
      .meta({ id: 'Link' });

    const chained = { query: Link } as const satisfies RouteSchemas;

    @Controller('chain')
    class ChainController {
      @Get('/', chained)
      list(input: Input<typeof chained>): unknown {
        return input.query;
      }
    }

    @Module({ controllers: [ChainController] })
    class ChainModule {}

    const result = await generateDocument(describeRoutes(ChainModule), info);
    const next = operationOf(result.document, '/chain', 'get').parameters?.find(
      (parameter) => parameter.name === 'next',
    );

    // The parameter carries the self-ref, so the component it names has to exist
    // even though nothing referenced the root itself.
    expect(next?.schema).toEqual({ $ref: '#/components/schemas/Link' });
    expect(result.document.components.schemas['Link']).toBeDefined();
    expect(danglingRefs(result.document)).toEqual([]);
  });

  it('keeps the first of two schemas claiming one id, and warns', async () => {
    const first = z.object({ a: z.string() }).meta({ id: 'Clash' });
    const second = z.object({ b: z.number() }).meta({ id: 'Clash' });
    const one = { body: first } as const satisfies RouteSchemas;
    const two = { body: second } as const satisfies RouteSchemas;

    @Controller('clash')
    class ClashController {
      @Post('/one', one)
      one(input: Input<typeof one>): unknown {
        return input.body;
      }

      @Post('/two', two)
      two(input: Input<typeof two>): unknown {
        return input.body;
      }
    }

    @Module({ controllers: [ClashController] })
    class ClashModule {}

    const result = await generateDocument(describeRoutes(ClashModule), info);
    expect(result.warnings.join('\n')).toContain(
      'Two different schemas are both named "Clash"',
    );
    expect(result.document.components.schemas['Clash']).toEqual({
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
    });
    expect(danglingRefs(result.document)).toEqual([]);
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
    expect(document.components.schemas?.['Session']).toEqual({
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
