import { describe, expect, it } from 'bun:test';
import { Module } from '@dunx/core';
import {
  Controller,
  Get,
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

/**
 * Schemas the generator cannot translate literally: a vendor that is not zod, a
 * cycle whose root `$ref: "#"` has to be repointed, and two schemas claiming one
 * id. Whatever comes out still has to be a document with no dangling `$ref`.
 */

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
      title: 'Clash',
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
    });
    expect(danglingRefs(result.document)).toEqual([]);
  });
});
