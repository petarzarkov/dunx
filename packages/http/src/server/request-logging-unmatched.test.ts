import { describe, expect, it } from 'bun:test';
import type { BunRequest } from 'bun';
import { AsyncRequestContext, ConsoleLogger, Module } from '@dunx/core';
import { UNMATCHED, type MetaKey } from '../route/metadata.js';
import { Controller, Get, Post } from '../route/decorators.js';
import type { Input } from '../route/schema.js';
import type { RouteContext } from './context.js';
import { HttpError } from './errors.js';
import { HttpFactory } from './factory.js';
import { RequestMetrics, UNMATCHED_ROUTE } from './metrics.js';
import type { Middleware, Next } from './middleware.js';
import { RequestLoggingMiddleware } from './request-logging.js';
import { serving } from './serving.fixture.js';
import { captured, validated } from './request-logging.fixture.test.js';
import { ThrottledWarning } from './throttled-warning.js';

/**
 * A scanner's burst of unmatched paths is one warn a second; a 4xx on a real
 * route, or on a path a middleware claims, keeps a line of its own.
 */
@Controller('things')
class ThingsController {
  @Get('/gone')
  gone(): never {
    throw new HttpError(404, 'NOT_FOUND');
  }

  @Get('/locked')
  locked(): never {
    throw new HttpError(401, 'UNAUTHORIZED');
  }

  @Post('/', validated)
  create(_input: Input<typeof validated>): { ok: true } {
    return { ok: true };
  }
}

/** Serves `/rpc` off the fallback, and refuses what it is sent. */
class RpcMiddleware implements Middleware {
  claimedPaths(): readonly string[] {
    return ['/rpc'];
  }

  claimedMethods(): readonly string[] {
    return ['POST'];
  }

  handle(req: BunRequest, _ctx: RouteContext, next: Next): Promise<Response> {
    if (new URL(req.url).pathname !== '/rpc') return next();
    return Promise.reject(new HttpError(400, 'BAD_RPC'));
  }
}

@Module({ controllers: [ThingsController], providers: [RpcMiddleware] })
class AppModule {}

const run = (fn: (url: string) => Promise<void>): Promise<RequestMetrics> => {
  let metrics: RequestMetrics | undefined;
  return serving(
    async () => {
      const app = await HttpFactory.create(AppModule, {
        bootLogging: false,
        metrics: true,
      });
      app.use(RpcMiddleware);
      metrics = app.get(RequestMetrics);
      return app;
    },
    (_app, url) => fn(url),
  ).then(() => metrics as RequestMetrics);
};

const warnings = (entries: readonly Record<string, unknown>[]) =>
  entries.filter((entry) => entry['level'] === 'warn');

const count = (metrics: RequestMetrics): number =>
  metrics.snapshot().routes.reduce((sum, route) => sum + route.count, 0);

describe('request logging, unmatched paths', () => {
  it('writes one warn for a burst of unmatched paths, and counts every one', async () => {
    let metrics: RequestMetrics | undefined;
    const entries = await captured(async () => {
      metrics = await run(async (url) => {
        for (const path of [
          'wp-admin',
          '.env',
          'wp-login.php',
          '.git/config',
        ]) {
          await (await fetch(new URL(path, url))).text();
        }
      });
    });
    expect(warnings(entries).map((entry) => entry['message'])).toEqual([
      'GET /wp-admin 404',
    ]);
    const unmatched = metrics
      ?.snapshot()
      .routes.find((route) => route.route === UNMATCHED_ROUTE);
    expect(unmatched?.count).toBe(4);
  });

  it('writes a line for each 404, 401 and 400 on a matched route', async () => {
    let metrics: RequestMetrics | undefined;
    const entries = await captured(async () => {
      metrics = await run(async (url) => {
        for (let i = 0; i < 3; i++) {
          await (await fetch(new URL('things/gone', url))).text();
          await (await fetch(new URL('things/locked', url))).text();
          await (
            await fetch(new URL('things', url), { method: 'POST', body: '{}' })
          ).text();
        }
      });
    });
    expect(warnings(entries)).toHaveLength(9);
    expect(count(metrics as RequestMetrics)).toBe(9);
  });

  it('writes a line for each 4xx on a claimed path', async () => {
    const entries = await captured(async () => {
      await run(async (url) => {
        for (let i = 0; i < 3; i++) {
          const response = await fetch(new URL('rpc', url), { method: 'POST' });
          expect(response.status).toBe(400);
        }
      });
    });
    expect(warnings(entries)).toHaveLength(3);
  });
});

describe('request logging, the unmatched window', () => {
  class Recorder extends ConsoleLogger {
    readonly warned: { message: string; suppressed: unknown }[] = [];

    constructor() {
      super(undefined, 'info', false);
    }

    override warn(message: unknown, ...rest: unknown[]): void {
      const fields = rest[0] as Record<string, unknown>;
      this.warned.push({
        message: String(message),
        suppressed: fields['suppressed'],
      });
    }
  }

  const miss: RouteContext = {
    controller: '(unmatched)',
    handler: '(none)',
    method: 'GET',
    path: '/.env',
    parsesBody: false,
    get: <T>(key: MetaKey<T>): T | undefined =>
      (key.id === UNMATCHED.id ? true : undefined) as T | undefined,
  };

  it('carries the count it dropped on the first line after the window', async () => {
    const recorder = new Recorder();
    const metrics = new RequestMetrics();
    let now = 0;
    const logging = new RequestLoggingMiddleware(
      recorder,
      new AsyncRequestContext(),
      {},
      metrics,
      undefined,
      undefined,
      new ThrottledWarning(recorder, 1000, () => now),
    );
    const refuse: Next = () => Promise.reject(new HttpError(404, 'NOT_FOUND'));
    const request = new Request('http://app.test/.env') as BunRequest;

    for (const at of [0, 100, 200, 999, 1000, 1500]) {
      now = at;
      await logging.handle(request, miss, refuse).catch(() => undefined);
    }

    expect(recorder.warned).toEqual([
      { message: 'GET /.env 404', suppressed: undefined },
      { message: 'GET /.env 404', suppressed: 3 },
    ]);
    expect(count(metrics)).toBe(6);
  });
});
