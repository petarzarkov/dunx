import type { BunRequest } from 'bun';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Module } from '@dunx/core';
import {
  Controller,
  Get,
  HttpError,
  HttpStatusCode,
  PUBLIC,
  type Middleware,
  type Next,
  type RouteContext,
} from '@dunx/http';
import { createTestServer, type TestServer } from '@dunx/testing';
import { OpenApiModule } from './module.js';
import { SwaggerRenderer } from './swagger/index.js';

const TOKEN = 'let-me-in';

@Controller('things')
class ThingsController {
  @Get('/')
  list(): readonly string[] {
    return ['one'];
  }
}

@Module({ controllers: [ThingsController] })
class ThingsModule {}

/**
 * The guard the explorer's routes opt out of. It is here so the suite proves the
 * thing `@Public()` plus `authorize` is for: a session guard that would answer
 * 401 never runs on these three paths, so the mount's own answer is the only one
 * a caller sees.
 */
class SessionGuard implements Middleware {
  handle(req: BunRequest, ctx: RouteContext, next: Next): Promise<Response> {
    if (ctx.get(PUBLIC) === true) return next();
    if (req.headers.get('x-session') === null) {
      throw new HttpError(HttpStatusCode.UNAUTHORIZED, 'UNAUTHORIZED');
    }
    return next();
  }
}

const byToken = (req: BunRequest): boolean =>
  req.headers.get('x-docs-token') === TOKEN;

/** The three paths one `authorize` decides: the document, the page, one asset. */
const MOUNTED = ['openapi.json', 'docs', 'docs/swagger-ui.css'] as const;

const allowed = { headers: { 'x-docs-token': TOKEN } };

describe('authorize on OpenApiModule', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await createTestServer({
      modules: OpenApiModule.forRoot({
        title: 'Gated API',
        version: '1.0.0',
        root: ThingsModule,
        renderer: new SwaggerRenderer(),
        authorize: byToken,
      }),
      middleware: [SessionGuard],
    });
  });

  afterAll(async () => {
    await server.close();
  });

  it('refuses the document, the page and the page assets alike', async () => {
    for (const path of MOUNTED) {
      const response = await server.request(path);
      expect(response.status).toBe(404);
      // The body an unmatched path gets, so a prober learns nothing from the
      // difference between a gated mount and no mount.
      expect(await response.json()).toEqual({
        error: 'NOT_FOUND',
        status: 404,
      });
    }
  });

  it('serves all three to a request the gate admits', async () => {
    for (const path of MOUNTED) {
      const response = await server.request(path, allowed);
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    }
  });

  it('answers before the session guard, so a refusal is 404 rather than 401', async () => {
    // The guard is live: a route that is not `@Public()` still answers 401.
    expect((await server.request('things')).status).toBe(401);
    // And it never sees the explorer's paths, with or without the token.
    expect((await server.request('docs')).status).toBe(404);
    expect((await server.request('docs', allowed)).status).toBe(200);
  });

  it('documents the app it is gating, not the gate', async () => {
    const { body } = await server.json<{ paths: Record<string, unknown> }>(
      'openapi.json',
      allowed,
    );
    expect(Object.keys(body.paths).sort()).toEqual(['/things']);
  });
});

describe('a gate that answers a browser', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await createTestServer({
      modules: OpenApiModule.forRoot({
        title: 'Gated API',
        version: '1.0.0',
        root: ThingsModule,
        renderer: new SwaggerRenderer(),
        // A visitor arrives with a cookie and no way to attach a bearer token, so
        // a bare 404 is a dead end. A `Response` is sent as written.
        authorize: (req) =>
          byToken(req) ||
          new Response(null, {
            status: 302,
            headers: { location: '/sign-in' },
          }),
      }),
      middleware: [],
    });
  });

  afterAll(async () => {
    await server.close();
  });

  it('sends the response the gate returned instead of the 404', async () => {
    const response = await server.request('docs', { redirect: 'manual' });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/sign-in');
  });

  it('leaves an admitted request alone', async () => {
    expect((await server.request('docs', allowed)).status).toBe(200);
  });
});

/**
 * The case the option exists for: `authorize` closes over something the container
 * owns, so it can only come out of the factory. The controller reads it through
 * the same closure the mount paths use, filled before any route is discovered.
 */
describe('authorize through forRootAsync', () => {
  class DocsPolicy {
    readonly token = 'from-config';

    admits(req: BunRequest): boolean {
      return req.headers.get('x-docs-token') === this.token;
    }
  }

  @Module({ providers: [DocsPolicy], exports: [DocsPolicy] })
  class DocsPolicyModule {}

  let server: TestServer;

  beforeAll(async () => {
    server = await createTestServer({
      modules: OpenApiModule.forRootAsync({
        root: ThingsModule,
        imports: [DocsPolicyModule],
        renderer: new SwaggerRenderer(),
        inject: [DocsPolicy] as const,
        useFactory: (policy: DocsPolicy) => ({
          title: 'Gated API',
          version: '1.0.0',
          path: '/reference',
          jsonPath: '/reference.json',
          authorize: (req: BunRequest) => policy.admits(req),
        }),
      }),
      middleware: [],
    });
  });

  afterAll(async () => {
    await server.close();
  });

  it('gates the paths the same factory named', async () => {
    for (const path of ['reference.json', 'reference']) {
      expect((await server.request(path)).status).toBe(404);
      expect(
        (
          await server.request(path, {
            headers: { 'x-docs-token': 'from-config' },
          })
        ).status,
      ).toBe(200);
    }
  });
});

describe('no authorize', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await createTestServer({
      modules: OpenApiModule.forRoot({
        title: 'Open API',
        version: '1.0.0',
        root: ThingsModule,
        renderer: new SwaggerRenderer(),
      }),
      middleware: [SessionGuard],
    });
  });

  afterAll(async () => {
    await server.close();
  });

  /**
   * Public by default and no boot warning for it, unlike the dashboard: a public
   * API's document being public is the point of publishing it.
   */
  it('serves the explorer to anyone, as it always has', async () => {
    for (const path of MOUNTED) {
      const response = await server.request(path);
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    }
  });
});
