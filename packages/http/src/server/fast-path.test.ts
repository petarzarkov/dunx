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
import { HttpError } from './errors.js';
import { HttpFactory, type HttpApp } from './factory.js';
import type { Middleware, Next } from './middleware.js';
import { buildRoutes } from './routes.js';
import { HttpStatusCode } from './status.js';

/**
 * `buildRoutes` emits a **synchronous** handler for a route with no middleware,
 * no CORS and no declared schemas — it returns a `Response` rather than a
 * `Promise<Response>`, because Bun accepts either and the general path's two
 * `await`s are on values that were never thenable.
 *
 * That is a real fork in the dispatch logic, so both branches are exercised here
 * and the observable behaviour is asserted to be identical. The optimisation is
 * only worth having if nothing about it is visible to a handler.
 */
/** A Standard Schema by hand — @dunx/http depends on no validator. */
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

const bodySchema = { body: named } as const;
const noSchemas = {} as const satisfies RouteSchemas;

class Marker implements Middleware {
  handle(_req: BunRequest, _ctx: RouteContext, next: Next): Promise<Response> {
    return next();
  }
}

@Controller('fast')
class FastController {
  /** Sync, no schemas, no middleware — the fast path. */
  @Get('/sync')
  sync(): { via: string } {
    return { via: 'sync' };
  }

  /** Async on the fast path: the promise must be adopted, not double-wrapped. */
  @Get('/async')
  async async(): Promise<{ via: string }> {
    await Bun.sleep(1);
    return { via: 'async' };
  }

  /** The escape hatch still passes through untouched. */
  @Get('/raw')
  raw(): Response {
    return new Response('raw', { headers: { 'x-hatch': 'yes' } });
  }

  /** Nothing at all is a 204, on either path. */
  @Get('/empty')
  empty(): undefined {
    return undefined;
  }

  /** A sync throw must reach the error mapper, not escape as a rejection. */
  @Get('/throws')
  throws(): never {
    throw new HttpError(418, 'teapot');
  }

  /** An async rejection must reach it too. */
  @Get('/rejects')
  async rejects(): Promise<never> {
    await Bun.sleep(1);
    throw new HttpError(418, 'async teapot');
  }

  /** An unmapped throw is a 500, not a crash. */
  @Get('/explodes')
  explodes(): never {
    throw new Error('boom');
  }

  /** `status` without schemas still takes the fast path and must be honoured. */
  @Get('/status', { status: HttpStatusCode.ACCEPTED })
  accepted(): { ok: true } {
    return { ok: true };
  }

  /** Declaring a schema opts the route back onto the async path. */
  @Post('/validated', bodySchema)
  validated(input: Input<typeof bodySchema>): { name: string } {
    return { name: input.body.name };
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

describe('buildRoutes emits a synchronous handler where it can', () => {
  it('returns a Response, not a Promise, for the qualifying shape', () => {
    const routes = buildRoutes([
      {
        controller: 'C',
        handlerName: 'h',
        method: 'GET',
        path: '/x',
        handler: () => ({ ok: true }),
      },
    ]);

    const handler = routes['/x']?.GET;
    expect(handler).toBeDefined();
    // The point of the whole exercise: no promise allocated at all.
    const value = handler?.({} as BunRequest);
    expect(value).toBeInstanceOf(Response);
    expect(value).not.toBeInstanceOf(Promise);
  });

  it('still returns a Promise once middleware is present', () => {
    const routes = buildRoutes(
      [
        {
          controller: 'C',
          handlerName: 'h',
          method: 'GET',
          path: '/x',
          handler: () => ({ ok: true }),
        },
      ],
      [new Marker()],
    );

    expect(routes['/x']?.GET?.({} as BunRequest)).toBeInstanceOf(Promise);
  });

  it('still returns a Promise once a schema is declared', () => {
    const routes = buildRoutes([
      {
        controller: 'C',
        handlerName: 'h',
        method: 'POST',
        path: '/y',
        handler: () => ({ ok: true }),
        options: bodySchema,
      },
    ]);

    expect(routes['/y']?.POST?.({} as BunRequest)).toBeInstanceOf(Promise);
  });
});

for (const [name, options] of branches) {
  describe(`observable behaviour is identical — ${name}`, () => {
    it('serves a sync handler', async () => {
      await withApp(async (url) => {
        const response = await fetch(new URL('fast/sync', url));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ via: 'sync' });
      }, options);
    });

    it('adopts a promise a handler returns', async () => {
      await withApp(async (url) => {
        const response = await fetch(new URL('fast/async', url));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ via: 'async' });
      }, options);
    });

    it('passes a Response through untouched', async () => {
      await withApp(async (url) => {
        const response = await fetch(new URL('fast/raw', url));
        expect(response.headers.get('x-hatch')).toBe('yes');
        expect(await response.text()).toBe('raw');
      }, options);
    });

    it('answers nothing with 204', async () => {
      await withApp(async (url) => {
        expect((await fetch(new URL('fast/empty', url))).status).toBe(204);
      }, options);
    });

    it('routes a sync throw to the error mapper', async () => {
      await withApp(async (url) => {
        const response = await fetch(new URL('fast/throws', url));
        expect(response.status).toBe(418);
        expect(await response.json()).toEqual({ error: 'teapot', status: 418 });
      }, options);
    });

    it('routes an async rejection to the error mapper', async () => {
      await withApp(async (url) => {
        const response = await fetch(new URL('fast/rejects', url));
        expect(response.status).toBe(418);
        expect(await response.json()).toEqual({
          error: 'async teapot',
          status: 418,
        });
      }, options);
    });

    it('maps an unmapped throw to 500 rather than crashing', async () => {
      await withApp(async (url) => {
        const response = await fetch(new URL('fast/explodes', url));
        expect(response.status).toBe(500);
        // The server is still up afterwards, which is the real assertion.
        expect((await fetch(new URL('fast/sync', url))).status).toBe(200);
      }, options);
    });

    it('honours an explicit status with no schemas declared', async () => {
      await withApp(async (url) => {
        expect((await fetch(new URL('fast/status', url))).status).toBe(202);
      }, options);
    });

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

describe('CORS keeps a route on the async path', () => {
  it('still applies CORS headers to a would-be fast route', async () => {
    // `enableCors` is a hook between create() and listen(), not an option — and
    // it is the reason the fast path checks for CORS at all: the header has to be
    // applied to the response, which needs the async wrapper.
    const app = await HttpFactory.create(FastModule, { requestLogging: false });
    app.enableCors({ origin: 'https://example.com' });
    const url = await app.listen(0);

    try {
      const response = await fetch(new URL('fast/sync', url), {
        headers: { origin: 'https://example.com' },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('access-control-allow-origin')).toBe(
        'https://example.com',
      );
      expect(await response.json()).toEqual({ via: 'sync' });
    } finally {
      await app.shutdown();
    }
  });
});
