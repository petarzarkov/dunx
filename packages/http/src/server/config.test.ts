import type { BunRequest } from 'bun';
import { describe, expect, it } from 'bun:test';
import { inject, Module } from '@dunx/core';
import { Controller, Get, Post } from '../route/decorators.js';
import { joinPath, type DiscoveredRoute } from '../route/discover.js';
import type { Input, RouteSchemas } from '../route/schema.js';
import { ClientAddress } from './client-address.js';
import { HttpFactory, type HttpApp } from './factory.js';
import type { Middleware, Next } from './middleware.js';
import { buildRoutes } from './routes.js';

class Trail {
  readonly seen: string[] = [];
}

class Tagging implements Middleware {
  readonly #trail = inject(Trail);
  protected readonly tag: string = 'tagging';

  async handle(_req: BunRequest, next: Next): Promise<Response> {
    this.#trail.seen.push(this.tag);
    const response = await next();
    response.headers.append('x-trail', this.tag);
    return response;
  }
}

class First extends Tagging {
  protected override readonly tag = 'first';
}
class Second extends Tagging {
  protected override readonly tag = 'second';
}

@Controller('users')
class UsersController {
  readonly #address = inject(ClientAddress);

  @Get('/')
  list(): string[] {
    return ['ada'];
  }

  @Get('/whoami')
  whoami(input: Input<RouteSchemas>): { ip: string | undefined } {
    return { ip: this.#address.of(input.req) };
  }

  @Post('/')
  create(): { created: true } {
    return { created: true };
  }
}

@Module({ controllers: [UsersController], providers: [Trail] })
class AppModule {}

const withApp = async (
  configure: (app: HttpApp) => void,
  run: (app: HttpApp, url: string) => Promise<void>,
): Promise<void> => {
  const app = await HttpFactory.create(AppModule);
  configure(app);
  const url = await app.listen(0);
  try {
    await run(app, url);
  } finally {
    await app.shutdown();
  }
};

const messageOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error.message;
  }
  throw new Error('expected the call to throw an Error');
};

describe('setGlobalPrefix()', () => {
  it('prefixes every route and leaves the unprefixed path unrouted', async () => {
    await withApp(
      (app) => {
        app.setGlobalPrefix('api');
      },
      async (_app, url) => {
        const prefixed = await fetch(new URL('api/users', url));
        expect(prefixed.status).toBe(200);
        expect(await prefixed.json()).toEqual(['ada']);
        expect((await fetch(new URL('users', url))).status).toBe(404);
      },
    );
  });

  it('normalises stray slashes and lets the last call win', async () => {
    await withApp(
      (app) => {
        app.setGlobalPrefix('ignored').setGlobalPrefix('/v1/');
      },
      async (_app, url) => {
        expect((await fetch(new URL('v1/users', url))).status).toBe(200);
        expect((await fetch(new URL('ignored/users', url))).status).toBe(404);
      },
    );
  });

  // A uniform prefix cannot introduce a collision that the unprefixed paths did
  // not already have, which is why create() can reject one eagerly. What listen()
  // adds is that the table it validates is the prefixed one.
  it('runs collision detection on the final prefixed paths', () => {
    const prefixed = (path: string, handlerName: string): DiscoveredRoute => ({
      method: 'GET',
      path: joinPath('api', path),
      controller: 'UsersController',
      handlerName,
      handler: () => undefined,
    });

    expect(() =>
      buildRoutes([prefixed('/users', 'list'), prefixed('users/', 'index')]),
    ).toThrow(
      'Route collision: GET /api/users is declared by UsersController.list and ' +
        'by UsersController.index',
    );
  });
});

describe('use()', () => {
  it('runs after HttpOptions.middleware, in call order', async () => {
    const app = await HttpFactory.create(AppModule, { middleware: [First] });
    app.use(Second);
    const url = await app.listen(0);

    const response = await fetch(new URL('users', url));
    const trail = app.get(Trail);
    await app.shutdown();

    expect(trail.seen).toEqual(['first', 'second']);
    // Outermost middleware appends last, so the header reads inside-out.
    expect(response.headers.get('x-trail')).toBe('second, first');
  });

  it('accepts several at once and resolves them from the container', async () => {
    const app = await HttpFactory.create(AppModule);
    app.use(First, Second);
    const url = await app.listen(0);

    await fetch(new URL('users', url));
    const trail = app.get(Trail);
    await app.shutdown();

    expect(trail.seen).toEqual(['first', 'second']);
  });
});

describe("set('trust proxy')", () => {
  it('reads X-Forwarded-For only when the setting is on', async () => {
    await withApp(
      (app) => {
        app.set('trust proxy', true);
      },
      async (app, url) => {
        expect(app.setting('trust proxy')).toBe(true);
        const body = await (
          await fetch(new URL('users/whoami', url), {
            headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' },
          })
        ).json();
        expect(body).toEqual({ ip: '203.0.113.7' });
      },
    );

    await withApp(
      () => undefined,
      async (app, url) => {
        expect(app.setting('trust proxy')).toBe(false);
        const body = (await (
          await fetch(new URL('users/whoami', url), {
            headers: { 'x-forwarded-for': '203.0.113.7' },
          })
        ).json()) as { ip: string };
        // The socket address, not the header.
        expect(body.ip).not.toBe('203.0.113.7');
        expect(body.ip).toContain('127.0.0.1');
      },
    );
  });

  it('falls back to the socket when a trusted header is absent', async () => {
    await withApp(
      (app) => {
        app.set('trust proxy', true);
      },
      async (app, url) => {
        const request = new Request(
          new URL('users/whoami', url).href,
        ) as BunRequest;
        expect(app.clientIp(request)).toBeUndefined();
        const body = (await (
          await fetch(new URL('users/whoami', url))
        ).json()) as { ip: string };
        expect(body.ip).toContain('127.0.0.1');
      },
    );
  });

  it('throws when nothing has attached a server yet', async () => {
    const app = await HttpFactory.create(AppModule);
    expect(() =>
      app.clientIp(new Request('http://test/x') as BunRequest),
    ).toThrow(/only available once listen\(\) has run/);
    await app.shutdown();
  });
});

describe('configuration after listen()', () => {
  it('throws from every hook instead of silently doing nothing', async () => {
    const app = await HttpFactory.create(AppModule);
    await app.listen(0);

    for (const [hook, call] of [
      ['setGlobalPrefix()', () => app.setGlobalPrefix('late')],
      ['use()', () => app.use(First)],
      ['set()', () => app.set('trust proxy', true)],
      ['enableCors()', () => app.enableCors()],
    ] as const) {
      expect(messageOf(call)).toBe(
        `${hook} must be called before listen(). The route table and the middleware ` +
          'chain are folded into one closure per route when the server binds, so ' +
          'this call could not take effect.',
      );
    }

    expect(
      await app.listen(0).then(
        () => 'listening',
        (error: unknown) => (error as Error).message,
      ),
    ).toMatch(/^listen\(\) must be called before listen\(\)/);

    await app.shutdown();
    // Still throws once the server has stopped: nothing would rebuild the table.
    expect(messageOf(() => app.setGlobalPrefix('late'))).toMatch(
      /must be called before listen\(\)/,
    );
  });
});
