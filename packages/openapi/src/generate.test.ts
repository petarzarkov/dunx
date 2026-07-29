import { describe, expect, it } from 'bun:test';
import { Module } from '@dunx/core';
import {
  Controller,
  Delete,
  Get,
  HttpStatusCode,
  Patch,
  Post,
  Public,
  Roles,
  type Input,
  type RouteSchemas,
  type StandardSchemaV1,
} from '@dunx/http';
import { z } from 'zod';
import { describeRoutes } from './discover.js';
import { generateDocument } from './generate.js';
import { ApiDoc } from './metadata.js';
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

const ListUsers = z.object({
  q: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

const listUsers = { query: ListUsers } as const satisfies RouteSchemas;
const oneUser = { params: UserIndex } as const satisfies RouteSchemas;
const createUser = { body: CreateUser } as const satisfies RouteSchemas;
const removeUser = {
  params: UserIndex,
  status: HttpStatusCode.NO_CONTENT,
} as const satisfies RouteSchemas;

@Controller('users')
class UsersController {
  @Get('/', listUsers)
  list(_input: Input<typeof listUsers>): readonly string[] {
    return [];
  }

  @ApiDoc({
    summary: 'One user',
    description: 'Reads **one** user.',
    tags: ['People'],
  })
  @Get('/:id', oneUser)
  one(_input: Input<typeof oneUser>): string {
    return 'ada';
  }

  @Post('/', createUser)
  create(_input: Input<typeof createUser>): string {
    return 'ada';
  }

  @ApiDoc({ deprecated: true })
  @Delete('/:id', removeUser)
  remove(input: Input<typeof removeUser>): number {
    return input.params.id;
  }

  @Get('/health')
  health(): { readonly ok: true } {
    return { ok: true };
  }
}

@Roles('admin')
@Controller('reports')
class ReportsController {
  @Public()
  @Get('/health')
  health(): { readonly ok: true } {
    return { ok: true };
  }

  @Roles('editor')
  @Patch('/:id')
  rename(): readonly string[] {
    return [];
  }
}

@Module({ controllers: [UsersController] })
class UsersModule {}

@Module({ controllers: [ReportsController] })
class ReportsModule {}

@Module({ imports: [UsersModule, ReportsModule] })
class RootModule {}

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

const generated = await generateDocument(describeRoutes(RootModule), info);
const { document } = generated;

describe('the generated document', () => {
  it('is an OpenAPI 3.1 document that survives a JSON round trip', () => {
    expect(document.openapi).toBe('3.1.0');
    expect(document.info).toEqual({ title: 'Test API', version: '2.1.0' });
    expect(JSON.parse(JSON.stringify(document))).toEqual(document);
  });

  it('generates nothing it has to warn about', () => {
    expect(generated.warnings).toEqual([]);
  });

  it('templates the paths Bun matches with `:params`', () => {
    expect(Object.keys(document.paths)).toEqual([
      '/reports/health',
      '/reports/{id}',
      '/users',
      '/users/health',
      '/users/{id}',
    ]);
  });

  it('names every operation after its controller and handler', () => {
    expect(operationOf(document, '/users', 'get').operationId).toBe(
      'UsersController_list',
    );
    expect(operationOf(document, '/users', 'post').operationId).toBe(
      'UsersController_create',
    );
  });

  it('tags by controller, and by @ApiDoc when it says otherwise', () => {
    expect(operationOf(document, '/users', 'get').tags).toEqual(['Users']);
    expect(operationOf(document, '/users/{id}', 'get').tags).toEqual([
      'People',
    ]);
    expect(document.tags).toEqual([{ name: 'Reports' }, { name: 'Users' }]);
  });

  it('carries the summary, description and deprecation @ApiDoc declared', () => {
    const one = operationOf(document, '/users/{id}', 'get');
    expect(one.summary).toBe('One user');
    expect(one.description).toBe('Reads **one** user.');
    expect(one.deprecated).toBeUndefined();
    expect(operationOf(document, '/users/{id}', 'delete').deprecated).toBe(
      true,
    );
  });

  it('reads path parameters out of the params schema', () => {
    expect(operationOf(document, '/users/{id}', 'get').parameters).toEqual([
      {
        name: 'id',
        in: 'path',
        required: true,
        schema: { type: 'integer', minimum: 1, maximum: 9007199254740991 },
      },
    ]);
  });

  it('falls back to a string path parameter with no params schema', () => {
    expect(operationOf(document, '/reports/{id}', 'patch').parameters).toEqual([
      { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
    ]);
  });

  it('expands a query schema into parameters, with input-side requiredness', () => {
    // `limit` has a default, so it is optional going in even though the handler
    // always sees it.
    expect(operationOf(document, '/users', 'get').parameters).toEqual([
      {
        name: 'q',
        in: 'query',
        required: false,
        schema: { type: 'string', minLength: 1 },
      },
      {
        name: 'limit',
        in: 'query',
        required: false,
        schema: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
      },
    ]);
  });

  it('refs the body schema into components/schemas by its .meta({ id })', () => {
    expect(operationOf(document, '/users', 'post').requestBody).toEqual({
      required: true,
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/CreateUser' },
        },
      },
    });
  });

  it('hoists the $defs zod emitted, rewriting the prefix and nothing else', () => {
    expect(Object.keys(document.components.schemas)).toEqual([
      'CreateUser',
      'Tag',
      'ValidationError',
    ]);
    expect(document.components.schemas['Tag']).toEqual({
      type: 'object',
      properties: { label: { type: 'string', minLength: 1 } },
      required: ['label'],
      title: 'A label attached to a user',
    });
    expect(document.components.schemas['CreateUser']).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 40 },
        tags: {
          type: 'array',
          default: [],
          items: { $ref: '#/components/schemas/Tag' },
        },
      },
      required: ['name'],
      title: 'Create a user',
    });
  });

  it('resolves every $ref it wrote', () => {
    expect(danglingRefs(document)).toEqual([]);
  });

  it('uses the route’s real status, and 400 only where a schema can reject', () => {
    expect(
      Object.keys(operationOf(document, '/users', 'post').responses),
    ).toEqual(['201', '400']);
    expect(
      Object.keys(operationOf(document, '/users', 'get').responses),
    ).toEqual(['200', '400']);
    // No schemas declared, so nothing can 400.
    expect(
      Object.keys(operationOf(document, '/users/health', 'get').responses),
    ).toEqual(['200']);
    // An explicit status wins over the verb's default.
    expect(
      Object.keys(operationOf(document, '/users/{id}', 'delete').responses),
    ).toEqual(['204', '400']);
    expect(
      operationOf(document, '/users/{id}', 'delete').responses['204'],
    ).toEqual({ description: 'No content' });
  });

  it('documents the framework’s own 400 shape', () => {
    expect(operationOf(document, '/users', 'post').responses['400']).toEqual({
      description: 'A declared schema rejected the request',
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/ValidationError' },
        },
      },
    });
    const shape = document.components.schemas['ValidationError'];
    expect(shape?.['required']).toEqual(['error', 'status', 'issues']);
  });
});

describe('security, from the metadata the guards read', () => {
  it('gives a @Public route an explicitly empty requirement', () => {
    expect(operationOf(document, '/reports/health', 'get').security).toEqual(
      [],
    );
  });

  it('gives a @Roles route the scheme, the roles and a note in the prose', () => {
    const rename = operationOf(document, '/reports/{id}', 'patch');
    expect(rename.security).toEqual([{ bearer: [] }]);
    expect(rename['x-required-roles']).toEqual(['editor']);
    expect(rename.description).toContain('`editor`');
  });

  it('inherits the class-level @Roles where the method declares none', () => {
    // ReportsController is @Roles('admin'); only /health opted out.
    expect(
      operationOf(document, '/reports/health', 'get')['x-required-roles'],
    ).toBeUndefined();
  });

  it('leaves a route that declared neither to the document default', () => {
    expect(operationOf(document, '/users', 'get').security).toBeUndefined();
  });

  it('documents the scheme only where some route asked for it', async () => {
    expect(document.components.securitySchemes).toEqual({
      bearer: {
        type: 'http',
        scheme: 'bearer',
        description: expect.stringContaining('guards'),
      },
    });

    const unguarded = await generateDocument(describeRoutes(UsersModule), info);
    expect(unguarded.document.components.securitySchemes).toBeUndefined();
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
