import { describe, expect, it } from 'bun:test';
import { Module } from '@dunx/core';
import type { BunRequest } from 'bun';
import { Controller, Get, Post } from '../route/decorators.js';
import type {
  Input,
  RouteSchemas,
  StandardSchemaResult,
  StandardSchemaV1,
} from '../route/schema.js';
import type { RouteContext } from './context.js';
import { HttpFactory, type HttpApp } from './factory.js';
import type { Middleware, Next } from './middleware.js';

/**
 * The declared-schema half of the fast path, whose dispatch fork is exercised in
 * `fast-path.test.ts`: a route with no middleware and no CORS gets a direct
 * handler, and a declared body, params or query must behave on that branch exactly
 * as it does on the async one. Every assertion below therefore runs twice.
 *
 * That includes every failure mode: a rejected body is a 400 carrying every issue
 * with its path flattened to dots, whichever branch produced it. The optimisation
 * is only worth having if nothing about it is visible to a caller.
 */

/** A Standard Schema by hand - @dunx/http depends on no validator. */
const named: StandardSchemaV1<unknown, { name: string }> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (value): StandardSchemaResult<{ name: string }> => {
      const name =
        typeof value === 'object' && value !== null
          ? (value as Record<string, unknown>)['name']
          : undefined;
      return typeof name === 'string'
        ? { value: { name } }
        : { issues: [{ message: 'name must be a string', path: ['name'] }] };
    },
  },
};

/** The same contract answered from a promise, which Standard Schema permits. */
const namedAsync: StandardSchemaV1<unknown, { name: string }> = {
  '~standard': {
    version: 1,
    vendor: 'test-async',
    validate: async (value) => {
      await Bun.sleep(1);
      return named['~standard'].validate(value);
    },
  },
};

/** Always fails, with each of the three path shapes the spec allows. */
const everyPathShape: StandardSchemaV1<unknown, unknown> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: () => ({
      issues: [
        { message: 'bare segments', path: ['a', 0] },
        { message: 'key objects', path: [{ key: 'b' }, { key: 1 }] },
        { message: 'no path at all' },
      ],
    }),
  },
};

/** `id` must be numeric. Synchronous, so a params-only route awaits nothing. */
const numericId: StandardSchemaV1<unknown, { id: number }> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (value): StandardSchemaResult<{ id: number }> => {
      const raw =
        typeof value === 'object' && value !== null
          ? (value as Record<string, unknown>)['id']
          : undefined;
      const id = Number(raw);
      return Number.isInteger(id)
        ? { value: { id } }
        : { issues: [{ message: 'id must be an integer', path: ['id'] }] };
    },
  },
};

const bodySchema = { body: named } as const;
const asyncBodySchema = { body: namedAsync } as const;
const issuesSchema = { body: everyPathShape } as const;
const paramsSchema = { params: numericId } as const;
const querySchema = { query: numericId } as const;
const noSchemas = {} as const satisfies RouteSchemas;

class Marker implements Middleware {
  handle(_req: BunRequest, _ctx: RouteContext, next: Next): Promise<Response> {
    return next();
  }
}

@Controller('fast')
class FastController {
  /** A declared body: the one shape that genuinely has to await `req.json()`. */
  @Post('/validated', bodySchema)
  validated(input: Input<typeof bodySchema>): { name: string } {
    return { name: input.body.name };
  }

  /** An async validator must still work, and must still 400 on failure. */
  @Post('/validated-async', asyncBodySchema)
  validatedAsync(input: Input<typeof asyncBodySchema>): { name: string } {
    return { name: input.body.name };
  }

  /** Never reached: the schema rejects every body, with all three path shapes. */
  @Post('/issues', issuesSchema)
  issues(): { reached: true } {
    return { reached: true };
  }

  /** `params` with a sync validator: declared, yet nothing to await. */
  @Get('/typed-params/:id', paramsSchema)
  typedParams(input: Input<typeof paramsSchema>): { id: number } {
    return { id: input.params.id };
  }

  /** Same for `query`. */
  @Get('/typed-query', querySchema)
  typedQuery(input: Input<typeof querySchema>): { id: number } {
    return { id: input.query.id };
  }

  /** No schemas but a param read straight off the request. */
  @Get('/params/:id', noSchemas)
  params(input: Input<typeof noSchemas>): { id: string | undefined } {
    return { id: input.req.params['id'] };
  }
}

@Module({ controllers: [FastController] })
class FastModule {}

const withApp = async (
  run: (url: string) => Promise<void>,
  options: Parameters<typeof HttpFactory.create>[1] = {},
): Promise<void> => {
  const app: HttpApp = await HttpFactory.create(FastModule, {
    requestLogging: false,
    ...options,
  });
  const url = await app.listen(0);
  try {
    await run(url);
  } finally {
    await app.shutdown();
  }
};

/** Both dispatch branches, so every assertion below runs twice. */
const branches: readonly [string, Parameters<typeof HttpFactory.create>[1]][] =
  [
    ['fast path', {}],
    ['async path (middleware present)', { middleware: [Marker] }],
  ];

for (const [name, options] of branches) {
  describe(`observable behaviour is identical - ${name}`, () => {
    it('validates a declared body', async () => {
      await withApp(async (url) => {
        const ok = await fetch(new URL('fast/validated', url), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'ada' }),
        });
        expect(ok.status).toBe(201);
        expect(await ok.json()).toEqual({ name: 'ada' });

        const bad = await fetch(new URL('fast/validated', url), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 7 }),
        });
        expect(bad.status).toBe(400);
        expect(await bad.json()).toEqual({
          error: 'Invalid body',
          status: 400,
          issues: [{ message: 'name must be a string', path: 'name' }],
        });
      }, options);
    });

    it('validates a declared body with an async validator', async () => {
      await withApp(async (url) => {
        const ok = await fetch(new URL('fast/validated-async', url), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'ada' }),
        });
        expect(ok.status).toBe(201);
        expect(await ok.json()).toEqual({ name: 'ada' });

        const bad = await fetch(new URL('fast/validated-async', url), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 7 }),
        });
        expect(bad.status).toBe(400);
        expect(await bad.json()).toEqual({
          error: 'Invalid body',
          status: 400,
          issues: [{ message: 'name must be a string', path: 'name' }],
        });
      }, options);
    });

    it('reports every issue, with each path shape flattened to dots', async () => {
      await withApp(async (url) => {
        const response = await fetch(new URL('fast/issues', url), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
          error: 'Invalid body',
          status: 400,
          issues: [
            { message: 'bare segments', path: 'a.0' },
            { message: 'key objects', path: 'b.1' },
            { message: 'no path at all' },
          ],
        });
      }, options);
    });

    it('rejects an unsupported content type with 415, unread', async () => {
      await withApp(async (url) => {
        const response = await fetch(new URL('fast/validated', url), {
          method: 'POST',
          headers: { 'content-type': 'application/x-tar' },
          body: 'not json',
        });
        expect(response.status).toBe(415);
        expect(((await response.json()) as { error: string }).error).toContain(
          'application/x-tar',
        );
      }, options);
    });

    it('rejects a mangled body with 400, not 500', async () => {
      await withApp(async (url) => {
        const response = await fetch(new URL('fast/validated', url), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{ not json',
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
          error: 'Malformed application/json body',
          status: 400,
        });
      }, options);
    });

    it('validates declared params and query without a body', async () => {
      await withApp(async (url) => {
        expect(
          await (await fetch(new URL('fast/typed-params/42', url))).json(),
        ).toEqual({ id: 42 });
        expect(
          (await fetch(new URL('fast/typed-params/abc', url))).status,
        ).toBe(400);

        expect(
          await (await fetch(new URL('fast/typed-query?id=7', url))).json(),
        ).toEqual({ id: 7 });
        const badQuery = await fetch(new URL('fast/typed-query?id=x', url));
        expect(badQuery.status).toBe(400);
        expect(await badQuery.json()).toEqual({
          error: 'Invalid query',
          status: 400,
          issues: [{ message: 'id must be an integer', path: 'id' }],
        });
      }, options);
    });

    it('reads a path parameter with no params schema', async () => {
      await withApp(async (url) => {
        expect(
          await (await fetch(new URL('fast/params/42', url))).json(),
        ).toEqual({ id: '42' });
      }, options);
    });
  });
}
