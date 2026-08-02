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
