import { describe, expect, test } from 'bun:test';
import { Module } from '@dunx/core';
import { Controller, Get } from '../route/decorators.js';
import { HttpFactory } from './factory.js';
import { RequestMetrics } from './metrics.js';
import { withTrailingSlashAliases } from './routes.js';
import type { BunRoutes } from './routes.js';
import type { RouteHandler } from './middleware.js';
import type { BunRequest } from 'bun';

/*
 * A trailing slash is a 404 by default, which is what `Bun.serve` matches and
 * what hono defaults to. `strict: false` serves both spellings.
 */

@Controller('users')
class UsersController {
  @Get()
  list(): readonly string[] {
    return ['ada'];
  }

  /* No params schema, so the reader hands over `req` alone. */
  @Get(':id')
  one({ req }: { readonly req: BunRequest }): { readonly id: string } {
    return { id: req.params['id'] ?? '' };
  }
}

@Module({ controllers: [UsersController] })
class AppModule {}

const handler: RouteHandler = async () => new Response('ok');

describe('withTrailingSlashAliases', () => {
  test('adds a slashed key for a static and a parameterised path', () => {
    const aliased = withTrailingSlashAliases({
      '/users': { GET: handler },
      '/users/:id': { GET: handler },
    });

    expect(Object.keys(aliased).sort()).toEqual([
      '/users',
      '/users/',
      '/users/:id',
      '/users/:id/',
    ]);
  });

  /* One object under two keys: one set of handlers, one preflight, one series. */
  test('the alias is the same object, not a copy', () => {
    const byMethod = { GET: handler };
    const aliased = withTrailingSlashAliases({ '/users': byMethod });

    expect(aliased['/users/']).toBe(byMethod);
  });

  /* Its alias would be `//`, which Bun matches as neither. */
  test('the root gets no alias', () => {
    expect(
      Object.keys(withTrailingSlashAliases({ '/': { GET: handler } })),
    ).toEqual(['/']);
  });

  /* `@dunx/auth` mounts `<basePath>/*`, which Bun matches at `<basePath>/`. */
  test('a wildcard mount gets no alias', () => {
    expect(
      Object.keys(
        withTrailingSlashAliases({ '/api/auth/*': { GET: handler } }),
      ),
    ).toEqual(['/api/auth/*']);
  });

  test('a declared route is never replaced by an alias', () => {
    const declared: RouteHandler = async () => new Response('declared');
    const routes: BunRoutes = {
      '/x': { GET: handler },
      '/x/': { GET: declared },
    };

    expect(withTrailingSlashAliases(routes)['/x/']?.GET).toBe(declared);
  });
});

interface Served {
  readonly status: number;
  readonly body: string;
}

const serve = async (
  paths: readonly string[],
  strict?: boolean,
): Promise<Served[]> => {
  const app = await HttpFactory.create(AppModule, {
    port: 0,
    requestLogging: false,
    bootLogging: false,
    metrics: true,
    ...(strict !== undefined && { strict }),
  });
  const url = await app.listen(0);
  const served: Served[] = [];
  for (const path of paths) {
    const response = await fetch(new URL(path, url));
    served.push({ status: response.status, body: await response.text() });
  }
  const { routes } = app.get(RequestMetrics).snapshot();
  await app.shutdown();
  // Last entry carries the metrics labels, so one boot answers both questions.
  return [
    ...served,
    {
      status: routes.length,
      body: routes
        .map((r) => r.route)
        .sort()
        .join(','),
    },
  ];
};

describe('a trailing slash', () => {
  /* The declined decision in architecture/http.md stands as the default. */
  test('is a 404 by default', async () => {
    const [list, listSlash, one, oneSlash] = await serve([
      '/users',
      '/users/',
      '/users/1',
      '/users/1/',
    ]);

    expect([list?.status, one?.status]).toEqual([200, 200]);
    expect([listSlash?.status, oneSlash?.status]).toEqual([404, 404]);
  });

  test('serves the same route under strict: false', async () => {
    const [list, listSlash, one, oneSlash] = await serve(
      ['/users', '/users/', '/users/1', '/users/1/'],
      false,
    );

    expect([list?.status, listSlash?.status]).toEqual([200, 200]);
    expect(listSlash?.body).toBe(list?.body);
    expect([one?.status, oneSlash?.status]).toEqual([200, 200]);
    expect(oneSlash?.body).toBe('{"id":"1"}');
  });

  /* Two spellings are one series, not `/users/:id` and `/users/:id/`. */
  test('is counted under the path as declared', async () => {
    const served = await serve(['/users/1', '/users/1/', '/users/'], false);
    const labels = served[served.length - 1];

    expect(labels?.body).toBe('/users,/users/:id');
    expect(labels?.status).toBe(2);
  });
});
