import { describe, expect, it } from 'bun:test';
import {
  AsyncRequestContext,
  ConsoleLogger,
  Logger,
  Module,
  provide,
} from '@dunx/core';
import { Controller, Get } from '../route/decorators.js';
import { HttpError } from './errors.js';
import { HttpFactory, type HttpApp } from './factory.js';
import {
  MetricsMiddleware,
  RequestMetrics,
  UNMATCHED_ROUTE,
} from './metrics.js';
import { UNMATCHED } from '../route/metadata.js';
import type { RouteContext } from './context.js';

const contextFor = (
  init: Partial<RouteContext> & { unmatched?: boolean } = {},
): RouteContext =>
  Object.freeze({
    controller: init.controller ?? 'ThingsController',
    handler: init.handler ?? 'list',
    method: init.method ?? 'GET',
    path: init.path ?? '/things/:id',
    parsesBody: false,
    get: <T>(key: { id: symbol }): T | undefined =>
      init.unmatched === true && key.id === UNMATCHED.id
        ? (true as T)
        : undefined,
  }) as RouteContext;

describe('RequestMetrics', () => {
  it('keys one series per route pattern, not per concrete path', () => {
    const metrics = new RequestMetrics();
    // The same frozen context every request on that route is handed, which is
    // what `buildContext` makes once at boot.
    const users = contextFor({ path: '/users/:id' });
    metrics.observe(users, 200, 1_000_000);
    metrics.observe(users, 200, 2_000_000);
    metrics.observe(users, 404, 500_000);

    const { routes } = metrics.snapshot();
    expect(routes).toHaveLength(1);
    expect(routes[0]?.route).toBe('/users/:id');
    expect(routes[0]?.method).toBe('GET');
    expect(routes[0]?.count).toBe(3);
    expect(routes[0]?.byStatus).toEqual({ '200': 2, '404': 1 });
    expect(routes[0]?.duration.count).toBe(3);
    expect(routes[0]?.duration.max).toBe(2_000_000);
  });

  it('separates two routes, and two methods on one path', () => {
    const metrics = new RequestMetrics();
    metrics.observe(contextFor({ path: '/a' }), 200, 1000);
    metrics.observe(contextFor({ path: '/b' }), 200, 1000);
    metrics.observe(contextFor({ path: '/a', method: 'POST' }), 201, 1000);
    expect(metrics.snapshot().routes).toHaveLength(3);
  });

  /**
   * `unmatchedContext` sets the concrete pathname so a 404's log line names what
   * missed. Keyed on that, a metric would grow one series per probe url.
   */
  it('collapses every unmatched path into one series', () => {
    const metrics = new RequestMetrics();
    metrics.observe(contextFor({ path: '/wp-admin', unmatched: true }), 404, 1);
    metrics.observe(contextFor({ path: '/.env', unmatched: true }), 404, 1);
    metrics.observe(contextFor({ path: '/phpinfo', unmatched: true }), 404, 1);

    const { routes } = metrics.snapshot();
    expect(routes).toHaveLength(1);
    expect(routes[0]?.route).toBe(UNMATCHED_ROUTE);
    expect(routes[0]?.count).toBe(3);
  });

  /**
   * The reason misses are keyed by method rather than by context. Each carries a
   * fresh context holding the concrete pathname, so keying on identity grew one
   * series and one histogram per probe url for as long as a scanner ran.
   */
  it('stays bounded under a scanner walking a thousand urls', () => {
    const metrics = new RequestMetrics();
    for (let i = 0; i < 1_000; i += 1) {
      metrics.observe(
        contextFor({ path: `/probe-${i}`, unmatched: true }),
        404,
        1,
      );
    }
    metrics.observe(
      contextFor({ path: '/probe', method: 'POST', unmatched: true }),
      404,
      1,
    );

    // One series per method that missed, and no more.
    const { routes } = metrics.snapshot();
    expect(routes).toHaveLength(2);
    expect(routes.every((r) => r.route === UNMATCHED_ROUTE)).toBe(true);
    expect(routes.find((r) => r.method === 'GET')?.count).toBe(1_000);
    expect(routes.find((r) => r.method === 'POST')?.count).toBe(1);
  });

  it('names the trace of the slowest request, and only that one', () => {
    const metrics = new RequestMetrics();
    const ctx = contextFor();
    metrics.observe(ctx, 200, 1_000, 'trace-fast');
    metrics.observe(ctx, 200, 9_000, 'trace-slow');
    metrics.observe(ctx, 200, 2_000, 'trace-middling');
    expect(metrics.snapshot().routes[0]?.slowestTraceId).toBe('trace-slow');
  });

  it('omits the exemplar when nothing supplied a trace', () => {
    const metrics = new RequestMetrics();
    metrics.observe(contextFor(), 200, 1_000);
    expect(metrics.snapshot().routes[0]).not.toHaveProperty('slowestTraceId');
  });

  it('clamps a sub-nanosecond duration rather than throwing', () => {
    const metrics = new RequestMetrics();
    expect(() => {
      metrics.observe(contextFor(), 200, 0);
    }).not.toThrow();
    expect(metrics.snapshot().routes[0]?.duration.min).toBe(1);
  });

  it('drops a route entirely on reset, and moves `since` forward', async () => {
    const metrics = new RequestMetrics();
    const first = metrics.snapshot().since;
    metrics.observe(contextFor(), 200, 1_000);
    await Bun.sleep(5);
    metrics.reset();

    const after = metrics.snapshot();
    expect(after.routes).toEqual([]);
    expect(Date.parse(after.since)).toBeGreaterThan(Date.parse(first));
  });

  it('reports zero in-flight before a server is attached', () => {
    const report = new RequestMetrics().snapshot();
    expect(report.inFlight).toBe(0);
    expect(report.pendingWebSockets).toBe(0);
  });

  it('serialises, which is what a scrape and the dashboard both need', () => {
    const metrics = new RequestMetrics();
    metrics.observe(contextFor(), 200, 1_000, 'abc');
    const report = metrics.snapshot();
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });
});

@Controller('things')
class ThingsController {
  @Get('/')
  list(): readonly string[] {
    return ['one'];
  }

  @Get('/boom')
  boom(): never {
    throw new HttpError(418, 'teapot');
  }
}

const quiet = provide(Logger, {
  useValue: new ConsoleLogger(new AsyncRequestContext(), 'fatal'),
});

@Module({ controllers: [ThingsController], providers: [quiet] })
class AppModule {}

const withApp = async (
  options: Parameters<typeof HttpFactory.create>[1],
  run: (app: HttpApp, url: string) => Promise<void>,
): Promise<void> => {
  const app = await HttpFactory.create(AppModule, options);
  const url = await app.listen(0);
  try {
    await run(app, url);
  } finally {
    await app.shutdown();
  }
};

describe('metrics against a real server', () => {
  it('records nothing at all unless metrics: true', async () => {
    await withApp({ bootLogging: false }, async (app, url) => {
      await fetch(new URL('things', url));
      expect(app.get(RequestMetrics).snapshot().routes).toEqual([]);
    });
  });

  it('observes through request logging, the shipped configuration', async () => {
    await withApp({ metrics: true, bootLogging: false }, async (app, url) => {
      await fetch(new URL('things', url));
      await fetch(new URL('things/boom', url));

      const { routes } = app.get(RequestMetrics).snapshot();
      const list = routes.find((r) => r.route === '/things');
      expect(list?.count).toBe(1);
      expect(list?.byStatus).toEqual({ '200': 1 });
      // A thrown HttpError is recorded under the status the mapper will send.
      expect(routes.find((r) => r.route === '/things/boom')?.byStatus).toEqual({
        '418': 1,
      });
    });
  });

  it('carries the trace of the slowest request as the exemplar', async () => {
    await withApp({ metrics: true, bootLogging: false }, async (app, url) => {
      await fetch(new URL('things', url));
      const exemplar = app
        .get(RequestMetrics)
        .snapshot()
        .routes.find((r) => r.route === '/things')?.slowestTraceId;
      // Trace context is on by default, so the exemplar joins onto the log line.
      expect(exemplar).toMatch(/^[0-9a-f]{32}$/);
    });
  });

  it('has no exemplar when trace is off, and still counts', async () => {
    await withApp(
      { metrics: true, bootLogging: false, requestLogging: { trace: false } },
      async (app, url) => {
        await fetch(new URL('things', url));
        const series = app
          .get(RequestMetrics)
          .snapshot()
          .routes.find((r) => r.route === '/things');
        expect(series?.count).toBe(1);
        expect(series).not.toHaveProperty('slowestTraceId');
      },
    );
  });

  it('counts an unmatched path under the one collapsed series', async () => {
    await withApp({ metrics: true, bootLogging: false }, async (app, url) => {
      await fetch(new URL('nope', url));
      await fetch(new URL('also-nope', url));
      const series = app
        .get(RequestMetrics)
        .snapshot()
        .routes.find((r) => r.route === UNMATCHED_ROUTE);
      expect(series?.count).toBe(2);
      expect(series?.byStatus).toEqual({ '404': 2 });
    });
  });

  it('falls back to its own middleware when request logging is off', async () => {
    await withApp(
      { metrics: true, bootLogging: false, requestLogging: false },
      async (app, url) => {
        await fetch(new URL('things', url));
        await fetch(new URL('things/boom', url));

        const { routes } = app.get(RequestMetrics).snapshot();
        expect(routes.find((r) => r.route === '/things')?.count).toBe(1);
        expect(
          routes.find((r) => r.route === '/things/boom')?.byStatus,
        ).toEqual({ '418': 1 });
      },
    );
  });

  /**
   * `ignore` is about log volume. A health check polled every second is exactly
   * the thing worth a metric and not worth an entry, so silencing the log must
   * not silence the counter.
   */
  it('counts an ignored path even though it writes no entry', async () => {
    await withApp(
      {
        metrics: true,
        bootLogging: false,
        requestLogging: { ignore: ['/things'] },
      },
      async (app, url) => {
        await fetch(new URL('things', url));
        await fetch(new URL('things', url));
        const series = app
          .get(RequestMetrics)
          .snapshot()
          .routes.find((r) => r.route === '/things');
        expect(series?.count).toBe(2);
        expect(series?.byStatus).toEqual({ '200': 2 });
      },
    );
  });

  it('counts an ignored path under correlateIgnored too', async () => {
    await withApp(
      {
        metrics: true,
        bootLogging: false,
        requestLogging: { ignore: ['/things'], correlateIgnored: true },
      },
      async (app, url) => {
        await fetch(new URL('things', url));
        const series = app
          .get(RequestMetrics)
          .snapshot()
          .routes.find((r) => r.route === '/things');
        expect(series?.count).toBe(1);
        // The trace is adopted on this path, so the exemplar is there too.
        expect(series?.slowestTraceId).toMatch(/^[0-9a-f]{32}$/);
      },
    );
  });

  it('counts an ignored path that fails, which nothing else would see', async () => {
    await withApp(
      {
        metrics: true,
        bootLogging: false,
        requestLogging: { ignore: ['/things/boom'] },
      },
      async (app, url) => {
        await fetch(new URL('things/boom', url));
        const series = app
          .get(RequestMetrics)
          .snapshot()
          .routes.find((r) => r.route === '/things/boom');
        // The status the mapper will send, the same one `#failed` records.
        expect(series?.byStatus).toEqual({ '418': 1 });
      },
    );
  });

  it('installs exactly one observer, so a request is not counted twice', async () => {
    await withApp({ metrics: true, bootLogging: false }, async (app, url) => {
      await fetch(new URL('things', url));
      expect(
        app
          .get(RequestMetrics)
          .snapshot()
          .routes.find((r) => r.route === '/things')?.count,
      ).toBe(1);
    });
  });

  it('reads in-flight off the live server rather than counting', async () => {
    await withApp({ metrics: true, bootLogging: false }, async (app, url) => {
      await fetch(new URL('things', url));
      // Idle by the time this runs; the point is that the number comes from
      // `Bun.serve` and is therefore present at all.
      expect(app.get(RequestMetrics).snapshot().inFlight).toBe(0);
    });
  });

  it('binds one instance, so a second consumer is not a boot error', async () => {
    await withApp({ metrics: true, bootLogging: false }, async (app) => {
      expect(app.get(RequestMetrics)).toBe(app.get(RequestMetrics));
    });
  });
});

describe('MetricsMiddleware', () => {
  it('records the status a rejected next() will map to', async () => {
    const metrics = new RequestMetrics();
    const middleware = new MetricsMiddleware(metrics);
    const ctx = contextFor({ path: '/boom' });

    await expect(
      middleware.handle(
        new Request('http://localhost/boom') as never,
        ctx,
        () => Promise.reject(new HttpError(429, 'slow down')),
      ),
    ).rejects.toThrow('slow down');
    expect(metrics.snapshot().routes[0]?.byStatus).toEqual({ '429': 1 });
  });

  it('records 500 for a rejection that is not an HttpError', async () => {
    const metrics = new RequestMetrics();
    const middleware = new MetricsMiddleware(metrics);

    await expect(
      middleware.handle(
        new Request('http://localhost/boom') as never,
        contextFor(),
        () => Promise.reject(new Error('kaboom')),
      ),
    ).rejects.toThrow('kaboom');
    expect(metrics.snapshot().routes[0]?.byStatus).toEqual({ '500': 1 });
  });
});
