import type { BunRequest } from 'bun';
import { describe, expect, it } from 'bun:test';
import { inject, Module, type OnShutdown } from '@dunx/core';
import { Controller, Get, Post } from '../route/decorators.js';
import type { DiscoveredRoute } from '../route/discover.js';
import type { Input, RouteSchemas } from '../route/schema.js';
import type { RouteContext } from './context.js';
import { defaultErrorMapper, HttpError } from './errors.js';
import { HttpFactory, type HttpApp } from './factory.js';
import type { Middleware, Next } from './middleware.js';
import { buildRoutes } from './routes.js';

const request = (path = '/x') =>
  new Request(`http://test${path}`) as BunRequest;

const route = (over: Partial<DiscoveredRoute> = {}): DiscoveredRoute => ({
  method: 'GET',
  path: '/x',
  controller: 'XController',
  handlerName: 'handle',
  handler: () => ({ ok: true }),
  ...over,
});

const silenceErrors = (): (() => void) => {
  const original = console.error;
  console.error = () => undefined;
  return () => {
    console.error = original;
  };
};

const rejectionMessage = async (promise: Promise<unknown>): Promise<string> => {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof Error))
    throw new Error('expected the promise to reject with an Error');
  return error.message;
};

describe('buildRoutes()', () => {
  it('wraps a plain value in Response.json', async () => {
    const routes = buildRoutes([route()]);
    const response = await routes['/x']!.GET!(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('passes a Response through untouched', async () => {
    const routes = buildRoutes([
      route({ handler: () => new Response('raw', { status: 201 }) }),
    ]);
    const response = await routes['/x']!.GET!(request());

    expect(response.status).toBe(201);
    expect(await response.text()).toBe('raw');
  });

  it('returns 204 for undefined', async () => {
    const routes = buildRoutes([route({ handler: () => undefined })]);

    expect((await routes['/x']!.GET!(request())).status).toBe(204);
  });

  it('throws on a duplicate method and path, naming both handlers', () => {
    expect(() =>
      buildRoutes([
        route({ handlerName: 'first' }),
        route({ controller: 'YController', handlerName: 'second' }),
      ]),
    ).toThrow(
      'Route collision: GET /x is declared by XController.first and by YController.second',
    );
  });

  it('keeps two methods on one path apart', () => {
    const routes = buildRoutes([route(), route({ method: 'POST' })]);

    expect(Object.keys(routes)).toEqual(['/x']);
    expect(Object.keys(routes['/x']!).sort()).toEqual(['GET', 'POST']);
  });
});

describe('middleware', () => {
  it('runs outside-in and can wrap the response', async () => {
    const order: string[] = [];

    class Outer implements Middleware {
      async handle(
        _req: BunRequest,
        _ctx: RouteContext,
        next: Next,
      ): Promise<Response> {
        order.push('outer:before');
        const response = await next();
        order.push('outer:after');
        return new Response(await response.text(), {
          headers: { 'x-wrapped': '1' },
        });
      }
    }
    class Inner implements Middleware {
      async handle(
        _req: BunRequest,
        _ctx: RouteContext,
        next: Next,
      ): Promise<Response> {
        order.push('inner');
        return next();
      }
    }

    const routes = buildRoutes([route()], [new Outer(), new Inner()]);
    const response = await routes['/x']!.GET!(request());

    expect(order).toEqual(['outer:before', 'inner', 'outer:after']);
    expect(response.headers.get('x-wrapped')).toBe('1');
  });

  it('turns a throwing middleware into a mapped error - a guard', async () => {
    class Guard implements Middleware {
      handle(): Promise<Response> {
        throw new HttpError(403, 'Forbidden');
      }
    }

    const routes = buildRoutes([route()], [new Guard()]);
    const response = await routes['/x']!.GET!(request());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Forbidden', status: 403 });
  });
});

describe('defaultErrorMapper()', () => {
  it('uses the status of an HttpError', async () => {
    const response = defaultErrorMapper(new HttpError(404, 'Nope'), request());

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Nope', status: 404 });
  });

  it('hides an unexpected error behind a 500', async () => {
    const restore = silenceErrors();
    const response = defaultErrorMapper(new Error('boom'), request());
    restore();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: 'Internal Server Error',
      status: 500,
    });
  });
});

class Store implements OnShutdown {
  readonly closed: string[] = [];
  readonly rows = ['ada', 'grace'];

  onShutdown(): void {
    this.closed.push('store');
  }
}

@Controller('users')
class UsersController {
  readonly #store = inject(Store);

  @Get('/')
  list(): string[] {
    return this.#store.rows;
  }

  @Get('/:id')
  one(input: Input<RouteSchemas>): { id: string | undefined } {
    return { id: input.req.params['id'] };
  }

  // No body schema, so the raw request is still there - and the 201 now comes
  // from the verb rather than from a hand-built Response.
  @Post('/')
  create(input: Input<RouteSchemas>): Promise<unknown> {
    return input.req.json();
  }

  @Get('/boom')
  boom(): never {
    throw new HttpError(418, 'teapot');
  }
}

@Module({ controllers: [UsersController], providers: [Store] })
class UsersModule {}

@Module({ imports: [UsersModule] })
class AppModule {}

const withApp = async (
  run: (app: HttpApp, url: string) => Promise<void>,
): Promise<void> => {
  const app = await HttpFactory.create(AppModule, { requestLogging: false });
  const url = await app.listen(0);
  try {
    await run(app, url);
  } finally {
    await app.shutdown();
  }
};

describe('HttpFactory', () => {
  it('serves discovered routes off a real Bun server', async () => {
    await withApp(async (_app, url) => {
      expect(await (await fetch(new URL('users', url))).json()).toEqual([
        'ada',
        'grace',
      ]);
      expect(await (await fetch(new URL('users/42', url))).json()).toEqual({
        id: '42',
      });

      const created = await fetch(new URL('users', url), {
        method: 'POST',
        body: JSON.stringify({ name: 'hopper' }),
      });
      expect(created.status).toBe(201);
      expect(await created.json()).toEqual({ name: 'hopper' });
    });
  });

  it('maps a thrown HttpError and lets Bun answer a method miss', async () => {
    await withApp(async (_app, url) => {
      expect((await fetch(new URL('users/boom', url))).status).toBe(418);
      // Bun's native routes handle the method miss - no JS router involved.
      expect(
        (await fetch(new URL('users/42', url), { method: 'DELETE' })).status,
      ).toBe(404);
      expect((await fetch(new URL('nothing', url))).status).toBe(404);
    });
  });

  /**
   * Pinned rather than fixed. Nest, Express and Fastify all normalise a trailing
   * slash, so a ported client hits a 404 that looks like a missing route - but
   * `Bun.serve({ routes })` owns matching, and the only place dunx could
   * normalise is the `fetch` fallback, which by then has no pattern to match
   * `/users/1/` against without becoming the JavaScript router this repo refuses
   * to write. So the behaviour is documented in guide 05 and asserted here.
   */
  it('matches paths exactly - a trailing slash is a different path', async () => {
    await withApp(async (_app, url) => {
      expect((await fetch(new URL('users', url))).status).toBe(200);
      expect((await fetch(new URL('users/', url))).status).toBe(404);
      expect((await fetch(new URL('users/42', url))).status).toBe(200);
      expect((await fetch(new URL('users/42/', url))).status).toBe(404);
      // The declared side is normalised, though: `@Get('/')` under a prefix is
      // `/users`, never `/users/`, so both spellings are never both live.
      expect((await fetch(new URL('users//', url))).status).toBe(404);
    });
  });

  it('stops the server and tears providers down on shutdown', async () => {
    const app = await HttpFactory.create(AppModule);
    const url = await app.listen(0);
    const store = app.get(Store);

    await app.shutdown();
    await app.closed;

    expect(store.closed).toEqual(['store']);
    expect(
      await fetch(new URL('users', url)).then(
        () => 'reachable',
        () => 'refused',
      ),
    ).toBe('refused');
  });

  it('stops the server on a hooked signal, and hooks only once', async () => {
    const app = await HttpFactory.create(AppModule);
    await app.listen(0);
    const store = app.get(Store);

    expect(app.enableShutdownHooks(['SIGHUP'])).toBe(app);
    expect(app.enableShutdownHooks(['SIGHUP'])).toBe(app);
    expect(process.listenerCount('SIGHUP')).toBe(1);

    process.emit('SIGHUP');
    await app.closed;

    expect(store.closed).toEqual(['store']);
  });

  it('throws when a registered controller declares no routes', async () => {
    @Controller('empty')
    class EmptyController {}

    @Module({ controllers: [EmptyController] })
    class EmptyModule {}

    expect(await rejectionMessage(HttpFactory.create(EmptyModule))).toMatch(
      /EmptyController is registered as a controller but declares no routes/,
    );
  });

  it('throws on a collision between two controllers', async () => {
    @Controller('dup')
    class FirstController {
      @Get('/')
      list(): string {
        return 'list';
      }
    }
    @Controller('dup')
    class SecondController {
      @Get('/')
      also(): string {
        return 'also';
      }
    }

    @Module({ controllers: [FirstController, SecondController] })
    class DupModule {}

    expect(await rejectionMessage(HttpFactory.create(DupModule))).toMatch(
      /Route collision: GET \/dup is declared by FirstController\.list and by SecondController\.also/,
    );
  });

  it('resolves middleware from the container so it can inject', async () => {
    class Counter {
      count = 0;
    }

    class CountingMiddleware implements Middleware {
      readonly #counter = inject(Counter);

      handle(
        _req: BunRequest,
        _ctx: RouteContext,
        next: Next,
      ): Promise<Response> {
        this.#counter.count += 1;
        return next();
      }
    }

    const app = await HttpFactory.create(AppModule, {
      middleware: [CountingMiddleware],
    });
    const url = await app.listen(0);

    await fetch(new URL('users', url));
    await fetch(new URL('users/1', url));
    const counter = app.get(Counter);
    await app.shutdown();

    expect(counter.count).toBe(2);
  });

  it('resolves middleware constructor parameters', async () => {
    class Counter {
      count = 0;
    }

    class CountingMiddleware implements Middleware {
      constructor(private readonly counter: Counter) {}

      handle(
        _req: BunRequest,
        _ctx: RouteContext,
        next: Next,
      ): Promise<Response> {
        this.counter.count += 1;
        return next();
      }
    }
    // Stands in for @dunx/transform, which does not run over this package's tests.
    Object.defineProperty(CountingMiddleware, Symbol.for('dunx.deps'), {
      value: () => [Counter],
    });

    const app = await HttpFactory.create(AppModule, {
      middleware: [CountingMiddleware],
    });
    const url = await app.listen(0);

    await fetch(new URL('users', url));
    const counter = app.get(Counter);
    await app.shutdown();

    expect(counter.count).toBe(1);
  });

  it('resolves controller constructor parameters', async () => {
    class Greeter {
      greet(): string {
        return 'hello';
      }
    }

    @Controller('greet')
    class GreetController {
      constructor(private readonly greeter: Greeter) {}

      @Get('/')
      hello(): string {
        return this.greeter.greet();
      }
    }
    Object.defineProperty(GreetController, Symbol.for('dunx.deps'), {
      value: () => [Greeter],
    });

    @Module({ controllers: [GreetController], providers: [Greeter] })
    class GreetModule {}

    const app = await HttpFactory.create(GreetModule);
    const url = await app.listen(0);
    const body = await (await fetch(new URL('greet', url))).json();
    await app.shutdown();

    expect(body).toBe('hello');
  });
});

describe('unmatched requests', () => {
  class Seen implements Middleware {
    readonly paths: string[] = [];
    handle(_req: BunRequest, ctx: RouteContext, next: Next): Promise<Response> {
      this.paths.push(`${ctx.method} ${ctx.path} (${ctx.controller})`);
      return next();
    }
  }

  const withSeen = async (
    run: (seen: Seen, url: string) => Promise<void>,
  ): Promise<void> => {
    @Module({ imports: [UsersModule], providers: [Seen] })
    class WatchedModule {}

    const app = await HttpFactory.create(WatchedModule, {
      requestLogging: false,
    });
    app.use(Seen);
    const url = await app.listen(0);
    try {
      await run(app.get(Seen), url);
    } finally {
      await app.shutdown();
    }
  };

  it('runs the global middleware and answers in the framework error shape', async () => {
    await withSeen(async (seen, url) => {
      const response = await fetch(new URL('nope', url));

      // Bun's own 404 never reaches the chain, which would make every miss
      // invisible to request logging.
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: 'NOT_FOUND',
        status: 404,
      });
      expect(seen.paths).toContain('GET /nope ((unmatched))');
    });
  });

  it('still lets a matched route through untouched', async () => {
    await withSeen(async (seen, url) => {
      expect((await fetch(new URL('users', url))).status).toBe(200);
      expect(seen.paths).toEqual(['GET /users (UsersController)']);
    });
  });
});
