import { afterEach, describe, expect, test } from 'bun:test';
import { Module, provide } from '@dunx/core';
import { Controller, Get, Post } from '../route/decorators.js';
import { Deprecated, withDeprecation } from '../route/deprecation.js';
import { discoverRoutes } from '../route/discover.js';
import {
  RouteVersioning,
  Version,
  VERSION_NEUTRAL,
  type VersioningOptions,
} from '../route/version.js';
import { HealthModule } from '../health/module.js';
import { HttpFactory, type HttpApp, type HttpOptions } from './factory.js';
import { HttpError } from './errors.js';
import { HttpOptionsProvider } from './options-provider.js';

@Controller('users', { version: '1' })
class UsersV1Controller {
  @Get(':id')
  one(): string {
    return 'v1';
  }

  @Version('2')
  @Get('')
  list(): string {
    return 'v2 list';
  }

  @Version(VERSION_NEUTRAL)
  @Get('count')
  count(): string {
    return 'neutral';
  }

  @Post('')
  create(): string {
    return 'created v1';
  }
}

@Controller('users', { version: '2' })
class UsersV2Controller {
  @Get(':id')
  one(): string {
    return 'v2';
  }
}

@Controller('tags')
class TagsController {
  @Version(['1', '2'])
  @Get('')
  list(): string {
    return 'tags';
  }
}

@Controller('plain')
class PlainController {
  @Get('')
  get(): string {
    return 'plain';
  }
}

@Deprecated({
  since: '2026-06-30T23:59:59Z',
  sunset: '2027-01-01',
  link: 'https://example.test/deprecations/v1',
})
@Controller('orders', { version: '1' })
class OrdersV1Controller {
  @Get('')
  list(): Response {
    return new Response('orders v1', {
      headers: { link: '</orders?page=2>; rel="next"' },
    });
  }

  @Deprecated({ since: '2026-01-01' })
  @Get('old')
  old(): string {
    return 'old';
  }

  @Post('')
  create(): string {
    throw new HttpError(409, 'TAKEN');
  }
}

@Module({
  controllers: [
    UsersV1Controller,
    UsersV2Controller,
    TagsController,
    PlainController,
    OrdersV1Controller,
  ],
})
class AppModule {}

let app: HttpApp | undefined;
afterEach(async () => {
  await app?.shutdown();
  app = undefined;
});

const serve = async (
  options: HttpOptions,
  root: typeof AppModule = AppModule,
): Promise<string> => {
  app = await HttpFactory.create(root, {
    requestLogging: false,
    bootLogging: false,
    ...options,
  });
  return (await app.listen(0)).replace(/\/$/, '');
};

const text = async (
  url: string,
  init?: RequestInit,
): Promise<[number, string]> => {
  const response = await fetch(url, init);
  return [response.status, await response.text()];
};

const uri: VersioningOptions = { type: 'uri' };

describe('URI versioning', () => {
  test('each version is its own path', async () => {
    const base = await serve({ versioning: uri });

    expect(await text(`${base}/v1/users/7`)).toEqual([200, '"v1"']);
    expect(await text(`${base}/v2/users/7`)).toEqual([200, '"v2"']);
    expect(await text(`${base}/v3/users/7`)).toEqual([404, expect.any(String)]);
    expect(await text(`${base}/users/7`)).toEqual([404, expect.any(String)]);
  });

  test("a handler's version replaces its controller's", async () => {
    const base = await serve({ versioning: uri });

    expect(await text(`${base}/v2/users`)).toEqual([200, '"v2 list"']);
    expect((await fetch(`${base}/v1/users`)).status).toBe(404);
    expect(await text(`${base}/v1/users`, { method: 'POST' })).toEqual([
      201,
      '"created v1"',
    ]);
  });

  test('a handler may serve several versions', async () => {
    const base = await serve({ versioning: uri });

    expect(await text(`${base}/v1/tags`)).toEqual([200, '"tags"']);
    expect(await text(`${base}/v2/tags`)).toEqual([200, '"tags"']);
  });

  test('a neutral handler and an unversioned controller stay unversioned', async () => {
    const base = await serve({ versioning: uri });

    expect(await text(`${base}/users/count`)).toEqual([200, '"neutral"']);
    expect(await text(`${base}/plain`)).toEqual([200, '"plain"']);
    expect((await fetch(`${base}/v1/plain`)).status).toBe(404);
  });

  test('defaultVersion versions a route that declares none, not a neutral one', async () => {
    const base = await serve({
      versioning: { type: 'uri', defaultVersion: '1' },
    });

    expect(await text(`${base}/v1/plain`)).toEqual([200, '"plain"']);
    expect((await fetch(`${base}/plain`)).status).toBe(404);
    expect(await text(`${base}/users/count`)).toEqual([200, '"neutral"']);
  });

  test('prefix replaces the v', async () => {
    const base = await serve({
      versioning: { type: 'uri', prefix: 'version-' },
    });

    expect(await text(`${base}/version-2/users/7`)).toEqual([200, '"v2"']);
  });

  test('the global prefix goes in front of the version', async () => {
    const base = await serve({ versioning: uri, prefix: 'api' });

    expect(await text(`${base}/api/v1/users/7`)).toEqual([200, '"v1"']);
    expect((await fetch(`${base}/v1/api/users/7`)).status).toBe(404);
  });

  test('strict: false aliases a versioned path', async () => {
    const base = await serve({ versioning: uri, strict: false });

    expect(await text(`${base}/v1/users/7/`)).toEqual([200, '"v1"']);
  });

  test('CORS, CSRF and security headers wrap a versioned route', async () => {
    const base = await serve({
      versioning: uri,
      cors: { origin: 'https://app.test' },
      csrf: true,
      securityHeaders: true,
    });

    const preflight = await fetch(`${base}/v1/users`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://app.test',
        'access-control-request-method': 'POST',
      },
    });
    expect(preflight.headers.get('access-control-allow-origin')).toBe(
      'https://app.test',
    );

    const refused = await fetch(`${base}/v1/users`, {
      method: 'POST',
      headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.test' },
    });
    expect(refused.status).toBe(403);
    expect(refused.headers.get('x-content-type-options')).toBe('nosniff');

    const served = await fetch(`${base}/v2/users/7`);
    expect(served.headers.get('x-frame-options')).toBe('DENY');
  });

  test('HealthModule stays unversioned under a defaultVersion', async () => {
    @Module({
      imports: [HealthModule.forRoot()],
      controllers: [PlainController],
    })
    class WithHealth {}

    const base = await serve(
      { versioning: { type: 'uri', defaultVersion: '1' } },
      WithHealth,
    );

    expect((await fetch(`${base}/health/live`)).status).toBe(200);
    expect((await fetch(`${base}/v1/plain`)).status).toBe(200);
  });

  test('an HttpOptionsProvider answers versioning', async () => {
    class VersionedOptions extends HttpOptionsProvider {
      override get versioning(): VersioningOptions {
        return { type: 'uri', defaultVersion: '3' };
      }
    }
    @Module({
      controllers: [PlainController],
      providers: [provide(HttpOptionsProvider, { useClass: VersionedOptions })],
    })
    class Provided {}

    const base = await serve({}, Provided);

    expect(await text(`${base}/v3/plain`)).toEqual([200, '"plain"']);
  });
});

describe('versioning off', () => {
  test('an app declaring no version is served as before', async () => {
    @Module({ controllers: [PlainController] })
    class Unversioned {}

    const base = await serve({}, Unversioned);

    expect(await text(`${base}/plain`)).toEqual([200, '"plain"']);
  });

  test('a declared version is a boot error naming the handler', async () => {
    expect(serve({})).rejects.toThrow(
      "UsersV1Controller.one() declares version 1, but versioning is off. Set HttpOptions.versioning: { type: 'uri' }.",
    );
  });
});

describe('RouteVersioning', () => {
  test('refuses an unknown type, and a header or key left empty', () => {
    expect(() =>
      RouteVersioning.of({ type: 'query' } as unknown as VersioningOptions),
    ).toThrow('versioning.type "query" is not supported');
    expect(() => RouteVersioning.of({ type: 'header', header: ' ' })).toThrow(
      'versioning.header is required',
    );
    expect(() =>
      RouteVersioning.of({ type: 'media-type' } as VersioningOptions),
    ).toThrow('versioning.key is required');
  });

  test('refuses a header that is not a header name, and an empty or non-string default', () => {
    expect(() =>
      RouteVersioning.of({ type: 'header', header: 'X-API Version' }),
    ).toThrow('versioning.header "X-API Version" is not a valid header name.');
    expect(() =>
      RouteVersioning.of({ type: 'uri', defaultVersion: '' }),
    ).toThrow('versioning.defaultVersion must be non-empty strings.');
    expect(() =>
      RouteVersioning.of({ type: 'uri', defaultVersion: 1 as never }),
    ).toThrow('versioning.defaultVersion must be non-empty strings.');
  });

  test('a URI version colliding with a literal path is a boot error', async () => {
    @Controller('users', { version: '1' })
    class Versioned {
      @Get('')
      list(): string {
        return 'versioned';
      }
    }
    @Controller('v1/users')
    class Literal {
      @Get('')
      list(): string {
        return 'literal';
      }
    }
    @Module({ controllers: [Versioned, Literal] })
    class Colliding {}

    expect(serve({ versioning: uri }, Colliding)).rejects.toThrow(
      'Route collision: GET /v1/users is declared by Versioned.list and by Literal.list',
    );
  });

  test('refuses a slash in the prefix or a default version', () => {
    expect(() => RouteVersioning.of({ type: 'uri', prefix: 'v/' })).toThrow(
      'versioning.prefix "v/" contains a /',
    );
    expect(() =>
      RouteVersioning.of({ type: 'uri', defaultVersion: ['1', '2/3'] }),
    ).toThrow('versioning.defaultVersion "2/3" contains a /');
  });

  test('refuses an empty or slashed declared version', () => {
    @Controller('bad', { version: [] })
    class Empty {
      @Get('')
      get(): string {
        return '';
      }
    }
    @Controller('bad', { version: '1/2' })
    class Slashed {
      @Get('')
      get(): string {
        return '';
      }
    }

    expect(() => discoverRoutes(new Empty())).toThrow(
      'Empty.get() declares an empty version',
    );
    expect(() => discoverRoutes(new Slashed())).toThrow(
      'Slashed.get() version "1/2" contains a /',
    );
  });

  test('two versions of one handler are two entries carrying their version', () => {
    const routes = discoverRoutes(new TagsController());

    expect(routes.map(({ path, version }) => [path, version])).toEqual([
      ['/v1/tags', '1'],
      ['/v2/tags', '2'],
    ]);
  });
});

describe('@Deprecated', () => {
  test('stamps Deprecation, Sunset and Link in the RFC formats', async () => {
    const base = await serve({ versioning: uri });

    const response = await fetch(`${base}/v1/orders`);
    expect(response.headers.get('deprecation')).toBe('@1782863999');
    expect(response.headers.get('sunset')).toBe(
      'Fri, 01 Jan 2027 00:00:00 GMT',
    );
    expect(response.headers.get('link')).toBe(
      '</orders?page=2>; rel="next", ' +
        '<https://example.test/deprecations/v1>; rel="deprecation"; type="text/html"',
    );
  });

  test("a handler's replaces its controller's", async () => {
    const base = await serve({ versioning: uri });

    const response = await fetch(`${base}/v1/orders/old`);
    expect(response.headers.get('deprecation')).toBe('@1767225600');
    expect(response.headers.get('sunset')).toBeNull();
    expect(response.headers.get('link')).toBeNull();
  });

  test('a mapped error carries the headers too', async () => {
    const base = await serve({ versioning: uri });

    const response = await fetch(`${base}/v1/orders`, { method: 'POST' });
    expect(response.status).toBe(409);
    expect(response.headers.get('deprecation')).toBe('@1782863999');
  });

  test('a route not deprecated carries none', async () => {
    const base = await serve({ versioning: uri });

    expect(
      (await fetch(`${base}/v2/users/7`)).headers.get('deprecation'),
    ).toBeNull();
  });

  test('a header the handler set is kept', async () => {
    const stamped = withDeprecation(
      { since: new Date(0) },
      () => new Response('', { headers: { deprecation: '@5' } }),
    );

    const response = (await stamped(
      new Request('http://x/') as never,
      undefined as never,
    )) as Response;
    expect(response.headers.get('deprecation')).toBe('@5');
  });

  test('refuses a date that does not parse, a sunset before since, and a bad link', () => {
    expect(() => Deprecated({ since: 'soon' })).toThrow(
      '@Deprecated since "soon" is not a date.',
    );
    expect(() =>
      Deprecated({ since: '2027-01-01', sunset: '2026-01-01' }),
    ).toThrow('is before since');
    expect(() => Deprecated({ since: '2026-01-01', link: 'http://[' })).toThrow(
      '@Deprecated link "http://[" is not a URL.',
    );
  });

  test('takes a Date and a relative link', () => {
    expect(() =>
      Deprecated({ since: new Date('2026-01-01'), link: '/docs/v1' }),
    ).not.toThrow();
  });
});
