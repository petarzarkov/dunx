import { afterEach, describe, expect, test } from 'bun:test';
import { Module } from '@dunx/core';
import type { BunRequest } from 'bun';
import { Controller, Get, Post } from '../route/decorators.js';
import { Deprecated } from '../route/deprecation.js';
import { discoverRoutes } from '../route/discover.js';
import { UseGuards } from '../route/metadata.js';
import {
  compareVersions,
  RouteVersioning,
  Version,
  VERSION_NEUTRAL,
  type VersioningOptions,
} from '../route/version.js';
import { routesOf } from '../inspect.js';
import type { RouteContext } from './context.js';
import { HttpFactory, type HttpApp, type HttpOptions } from './factory.js';
import type { Middleware, Next } from './middleware.js';
import { buildRoutes } from './routes.js';

class StampV2 implements Middleware {
  async handle(_req: BunRequest, _ctx: RouteContext, next: Next) {
    const response = await next();
    response.headers.set('x-guarded', 'v2');
    return response;
  }
}

@Deprecated({ since: '2026-01-01' })
@Controller('items', { version: '1' })
class ItemsV1Controller {
  @Get(':id')
  one(): string {
    return 'v1';
  }

  @Post('')
  create(): string {
    return 'created v1';
  }
}

@UseGuards(StampV2)
@Controller('items', { version: '2' })
class ItemsV2Controller {
  @Get(':id')
  one(): string {
    return 'v2';
  }
}

@Controller('items')
class ItemsNeutralController {
  @Version(VERSION_NEUTRAL)
  @Get('')
  list(): string {
    return 'neutral list';
  }
}

@Controller('plain')
class PlainController {
  @Get('')
  get(): string {
    return 'plain';
  }
}

@Module({
  controllers: [
    ItemsV1Controller,
    ItemsV2Controller,
    ItemsNeutralController,
    PlainController,
  ],
  providers: [StampV2],
})
class AppModule {}

const header: VersioningOptions = { type: 'header', header: 'X-API-Version' };

let app: HttpApp | undefined;
afterEach(async () => {
  await app?.shutdown();
  app = undefined;
});

const serve = async (options: HttpOptions): Promise<string> => {
  app = await HttpFactory.create(AppModule, {
    requestLogging: false,
    bootLogging: false,
    ...options,
  });
  return (await app.listen(0)).replace(/\/$/, '');
};

const get = (url: string, headers: Record<string, string> = {}) =>
  fetch(url, { headers });

describe('header versioning', () => {
  test('one path, the version picked by the header', async () => {
    const base = await serve({ versioning: header });

    expect(
      await (await get(`${base}/items/1`, { 'x-api-version': '1' })).text(),
    ).toBe('"v1"');
    expect(
      await (await get(`${base}/items/1`, { 'X-Api-Version': '2' })).text(),
    ).toBe('"v2"');
    expect((await get(`${base}/v1/items/1`)).status).toBe(404);
  });

  test('a missing or unknown version is a 404 without a defaultVersion', async () => {
    const base = await serve({ versioning: header });

    expect((await get(`${base}/items/1`)).status).toBe(404);
    expect(
      (await get(`${base}/items/1`, { 'x-api-version': '9' })).status,
    ).toBe(404);
  });

  test('a missing version gets defaultVersion; an unknown one still 404s', async () => {
    const base = await serve({
      versioning: { ...header, defaultVersion: '2' },
    });

    expect(await (await get(`${base}/items/1`)).text()).toBe('"v2"');
    expect(
      (await get(`${base}/items/1`, { 'x-api-version': '9' })).status,
    ).toBe(404);
    // An undeclared route took the default, and is selected like any other.
    expect(await (await get(`${base}/plain`)).text()).toBe('"plain"');
    expect((await get(`${base}/plain`, { 'x-api-version': '1' })).status).toBe(
      404,
    );
  });

  test('a neutral route answers whatever the header says', async () => {
    const base = await serve({ versioning: header });

    expect(await (await get(`${base}/items`)).text()).toBe('"neutral list"');
    expect(
      await (await get(`${base}/items`, { 'x-api-version': '7' })).text(),
    ).toBe('"neutral list"');
    expect(await (await get(`${base}/plain`)).text()).toBe('"plain"');
  });

  test('every response of a grouped entry varies on the header, the 404 too', async () => {
    const base = await serve({
      versioning: header,
      cors: { origin: 'https://app.test' },
    });

    const served = await get(`${base}/items/1`, {
      'x-api-version': '1',
      origin: 'https://app.test',
    });
    expect(served.headers.get('vary')).toBe('Origin, X-API-Version');
    expect((await get(`${base}/items/1`)).headers.get('vary')).toContain(
      'X-API-Version',
    );
    expect((await get(`${base}/plain`)).headers.get('vary')).toBeNull();
  });

  test('guards, @Deprecated, CSRF and security headers apply per version', async () => {
    const base = await serve({
      versioning: header,
      csrf: true,
      securityHeaders: true,
    });

    const v1 = await get(`${base}/items/1`, { 'x-api-version': '1' });
    const v2 = await get(`${base}/items/1`, { 'x-api-version': '2' });
    expect(v1.headers.get('deprecation')).toBe('@1767225600');
    expect(v1.headers.get('x-guarded')).toBeNull();
    expect(v2.headers.get('deprecation')).toBeNull();
    expect(v2.headers.get('x-guarded')).toBe('v2');
    expect(v2.headers.get('x-content-type-options')).toBe('nosniff');

    const refused = await fetch(`${base}/items`, {
      method: 'POST',
      headers: { 'x-api-version': '1', 'sec-fetch-site': 'cross-site' },
    });
    expect(refused.status).toBe(403);
    const created = await fetch(`${base}/items`, {
      method: 'POST',
      headers: { 'x-api-version': '1' },
    });
    expect(await created.text()).toBe('"created v1"');
  });

  test('a fixed CORS allowedHeaders list admits the version header', async () => {
    const base = await serve({
      versioning: header,
      cors: { origin: 'https://app.test', allowedHeaders: ['content-type'] },
    });

    const preflight = await fetch(`${base}/items/1`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://app.test',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'x-api-version',
      },
    });
    expect(preflight.headers.get('access-control-allow-headers')).toBe(
      'content-type, X-API-Version',
    );
  });

  test('selection is synchronous when the handler is', () => {
    const versioning = RouteVersioning.of(header);
    const table = buildRoutes(
      discoverRoutes(new ItemsV1Controller(), versioning),
      [],
      undefined,
      undefined,
      undefined,
      { versioning, miss: () => new Response('miss', { status: 404 }) },
    );

    const answer = table['/items/:id']?.GET?.(
      new Request('http://x/items/1', {
        headers: { 'x-api-version': '1' },
      }) as BunRequest,
    );
    expect(answer).toBeInstanceOf(Response);
  });

  test('the route table lists each version of one path', () => {
    const versioning = RouteVersioning.of(header);
    const listed = routesOf(AppModule, versioning)
      .filter((route) => route.path === '/items/:id')
      .map((route) => route.version);

    expect(listed).toEqual(['1', '2']);
    expect(
      routesOf(AppModule, versioning).find(
        (route) => route.path === '/items' && route.method === 'GET',
      )?.version,
    ).toBeNull();
  });
});

describe('media-type versioning', () => {
  const media: VersioningOptions = { type: 'media-type', key: 'v=' };

  test('the version is an Accept parameter', async () => {
    const base = await serve({ versioning: media });

    const v2 = await get(`${base}/items/1`, { accept: 'application/json;v=2' });
    expect(await v2.text()).toBe('"v2"');
    expect(v2.headers.get('vary')).toBe('Accept');
    const listed = await get(`${base}/items/1`, {
      accept: 'text/html, application/json; q=0.9; v=1',
    });
    expect(await listed.text()).toBe('"v1"');
    expect(
      (await get(`${base}/items/1`, { accept: 'application/json' })).status,
    ).toBe(404);
    expect((await get(`${base}/items/1`)).status).toBe(404);
  });
});

test('compareVersions sorts numbers numerically and the rest by code unit', () => {
  expect(['10', '2', 'beta', '1', 'alpha'].sort(compareVersions)).toEqual([
    '1',
    '2',
    '10',
    'alpha',
    'beta',
  ]);
});
