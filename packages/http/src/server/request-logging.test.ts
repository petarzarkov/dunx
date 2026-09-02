import { describe, expect, it } from 'bun:test';
import { Logger, RequestContext } from '@dunx/core';
import { HttpError } from './errors.js';
import type { Middleware } from './middleware.js';
import {
  captured,
  handlerLogger,
  withApp,
} from './request-logging.fixture.test.js';

const HEX_32 = /^[0-9a-f]{32}$/;
const TRACERESPONSE = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;
const INBOUND_TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const INBOUND_SPAN = '00f067aa0ba902b7';

describe('request logging', () => {
  it('is on with no logging module imported at all', async () => {
    const entries = await captured(async () => {
      await withApp(async (_app, url) => {
        await fetch(new URL('things', url));
      });
    });

    // Core binds a default ConsoleLogger and RequestContext, which is what lets
    // this work in an app that configured nothing.
    const entry = entries.find((e) => e['message'] === 'GET /things 200');
    expect(entry).toBeDefined();
    expect(entry?.['statusCode']).toBe(200);
    expect(entry?.['context']).toBe('ThingsController.list');
    // Trace context is on by default, so a line is correlated with nothing
    // configured at all.
    expect(entry?.['traceId']).toMatch(HEX_32);
    expect(entry?.['spanId']).toMatch(/^[0-9a-f]{16}$/);
    expect(entry?.['traceFlags']).toBe('01');
    expect(typeof entry?.['elapsedMs']).toBe('number');
    // Bodies are off by default: reading one means cloning and buffering every
    // payload, which measured at two thirds of the throughput on internal/bench's
    // `validate` scenario.
    expect(entry?.['responseBody']).toBeUndefined();
  });

  it('emits exactly one entry per request, carrying both halves', async () => {
    const entries = await captured(async () => {
      await withApp(
        async (_app, url) => {
          await fetch(new URL('things', url), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'ada' }),
          });
        },
        { requestLogging: { requestBody: true, responseBody: true } },
      );
    });

    const matched = entries.filter((e) =>
      String(e['message']).startsWith('POST /things'),
    );
    expect(matched).toHaveLength(1);
    expect(matched[0]?.['request']).toMatchObject({ body: { name: 'ada' } });
    expect(matched[0]?.['responseBody']).toEqual({ name: 'ada' });
  });

  it('omits both bodies unless asked, and the handler still reads its own', async () => {
    const entries = await captured(async () => {
      await withApp(async (_app, url) => {
        const response = await fetch(new URL('things', url), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'grace' }),
        });
        // The middleware did not consume the stream the handler needed.
        expect(await response.json()).toEqual({ name: 'grace' });
      });
    });

    const entry = entries.find((e) =>
      String(e['message']).startsWith('POST /things'),
    );
    expect(entry?.['responseBody']).toBeUndefined();
    expect(entry?.['request']).not.toHaveProperty('body');
  });

  it('continues an inbound traceparent and answers with traceresponse', async () => {
    // A holder, not a `let`: assigning inside a closure keeps TypeScript's
    // narrowing from the initialiser, and `null` is not a useful type.
    const seen: { header?: string | undefined } = {};
    const entries = await captured(async () => {
      await withApp(async (_app, url) => {
        const response = await fetch(new URL('things', url), {
          headers: { traceparent: `00-${INBOUND_TRACE}-${INBOUND_SPAN}-01` },
        });
        seen.header = response.headers.get('traceresponse') ?? undefined;
      });
    });

    const entry = entries.find((e) => e['traceId'] === INBOUND_TRACE);
    expect(entry?.['parentSpanId']).toBe(INBOUND_SPAN);
    // The response names the span that answered, not the caller's.
    expect(seen.header).toBe(
      `00-${INBOUND_TRACE}-${String(entry?.['spanId'])}-01`,
    );
  });

  /**
   * The trust boundary: `traceparent` is a caller-supplied string that ends up in
   * every line the request writes. A malformed one is discarded, not repaired.
   */
  it('starts its own trace when the inbound traceparent is malformed', async () => {
    const seen: { header?: string | undefined } = {};
    const entries = await captured(async () => {
      await withApp(async (_app, url) => {
        const response = await fetch(new URL('things', url), {
          headers: { traceparent: 'MY-OWN-TRACE' },
        });
        seen.header = response.headers.get('traceresponse') ?? undefined;
      });
    });

    expect(seen.header).toMatch(TRACERESPONSE);
    const entry = entries.find((e) => e['message'] === 'GET /things 200');
    expect(entry?.['traceId']).toMatch(HEX_32);
    expect(entry?.['parentSpanId']).toBeUndefined();
  });

  it('puts an inbound tracestate in the scope, for the client to forward', async () => {
    const entries = await captured(async () => {
      await withApp(async (_app, url) => {
        await fetch(new URL('things', url), {
          headers: {
            traceparent: `00-${INBOUND_TRACE}-${INBOUND_SPAN}-01`,
            tracestate: 'vendor=opaque',
          },
        });
      });
    });

    const entry = entries.find((e) => e['traceId'] === INBOUND_TRACE);
    expect(entry?.['traceState']).toBe('vendor=opaque');
  });

  it('carries no trace at all under trace: false', async () => {
    const seen: { header?: string | undefined } = {};
    const entries = await captured(async () => {
      await withApp(
        async (_app, url) => {
          const response = await fetch(new URL('things', url));
          seen.header = response.headers.get('traceresponse') ?? undefined;
        },
        { requestLogging: { trace: false } },
      );
    });

    expect(seen.header).toBeUndefined();
    const entry = entries.find((e) => e['message'] === 'GET /things 200');
    // The entry is still written, and still carries the route fields.
    expect(entry?.['context']).toBe('ThingsController.list');
    expect(entry?.['traceId']).toBeUndefined();
    expect(entry?.['spanId']).toBeUndefined();
    expect(entry?.['traceFlags']).toBeUndefined();
  });

  it('logs a 4xx at warn and a 5xx at error', async () => {
    const entries = await captured(async () => {
      await withApp(async (_app, url) => {
        await fetch(new URL('things/boom', url));
        await fetch(new URL('things/broken', url));
      });
    });

    expect(
      entries.find((e) => e['message'] === 'GET /things/boom 418')?.['level'],
    ).toBe('warn');
    expect(
      entries.find((e) => e['message'] === 'GET /things/broken 500')?.['level'],
    ).toBe('error');
  });

  /**
   * `next()` is adopted with `.then` rather than awaited, so a middleware that
   * throws out of `handle` *synchronously* no longer arrives as a rejection. It is
   * still a request this middleware promised to log, and the branch that catches it
   * exists only for this case.
   */
  it('logs a downstream middleware that throws synchronously', async () => {
    class SyncThrow implements Middleware {
      handle(): Promise<Response> {
        throw new HttpError(403, 'nope');
      }
    }

    const entries = await captured(async () => {
      await withApp(
        async (_app, url) => {
          const response = await fetch(new URL('things', url));
          expect(response.status).toBe(403);
        },
        { middleware: [SyncThrow] },
      );
    });

    const entry = entries.find((e) => e['message'] === 'GET /things 403');
    expect(entry?.['level']).toBe('warn');
    expect(entry?.['statusCode']).toBe(403);
  });

  it('puts the handler’s own entries in the same request scope', async () => {
    const entries = await captured(async () => {
      await withApp(async (app, url) => {
        handlerLogger.current = app.get(Logger);
        await fetch(new URL('things/inner', url));
        handlerLogger.current = undefined;
      });
    });

    const inner = entries.find((e) => e['message'] === 'from the handler');
    const outer = entries.find((e) => e['message'] === 'GET /things/inner 200');
    expect(inner).toBeDefined();
    // Nothing was passed to the handler: AsyncLocalStorage carried it.
    expect(inner?.['traceId']).toBe(outer?.['traceId']);
    expect(inner?.['spanId']).toBe(outer?.['spanId']);
    expect(inner?.['context']).toBe('ThingsController.inner');
  });

  it('logs an unmatched path, which Bun would otherwise answer silently', async () => {
    const entries = await captured(async () => {
      await withApp(async (_app, url) => {
        await fetch(new URL('nope', url));
      });
    });

    const entry = entries.find((e) => e['message'] === 'GET /nope 404');
    expect(entry?.['level']).toBe('warn');
    expect(entry?.['context']).toBe('(unmatched).(none)');
  });

  it('logs nothing when turned off', async () => {
    const entries = await captured(async () => {
      await withApp(
        async (_app, url) => {
          await fetch(new URL('things', url));
        },
        { requestLogging: false },
      );
    });

    expect(entries.filter((e) => e['statusCode'] !== undefined)).toEqual([]);
  });

  it('honours ignore and the body switches', async () => {
    const entries = await captured(async () => {
      await withApp(
        async (_app, url) => {
          await fetch(new URL('things', url));
          await fetch(new URL('things/boom', url));
        },
        { requestLogging: { ignore: ['/things'], responseBody: false } },
      );
    });

    expect(
      entries.find((e) => e['message'] === 'GET /things 200'),
    ).toBeUndefined();
    const boom = entries.find((e) => e['message'] === 'GET /things/boom 418');
    expect(boom).toBeDefined();
    expect(boom?.['responseBody']).toBeUndefined();
  });

  /** What `ignore` costs on its own, so the guide can say it plainly. */
  it('drops the trace along with the entry on an ignored path', async () => {
    const seen: { header?: string | undefined } = {};
    await captured(async () => {
      await withApp(
        async (_app, url) => {
          const response = await fetch(new URL('things', url));
          seen.header = response.headers.get('traceresponse') ?? undefined;
        },
        { requestLogging: { ignore: ['/things'] } },
      );
    });

    expect(seen.header).toBeUndefined();
  });

  it('keeps the trace and the scope on an ignored path when asked', async () => {
    const seen: { header?: string | undefined } = {};
    const entries = await captured(async () => {
      await withApp(
        async (app, url) => {
          handlerLogger.current = app.get(Logger);
          const response = await fetch(new URL('things/inner', url));
          seen.header = response.headers.get('traceresponse') ?? undefined;
          handlerLogger.current = undefined;
        },
        {
          requestLogging: {
            ignore: ['/things/inner'],
            correlateIgnored: true,
          },
        },
      );
    });

    // No entry for the request itself, which is what `ignore` is for.
    expect(
      entries.find((e) => e['message'] === 'GET /things/inner 200'),
    ).toBeUndefined();
    expect(seen.header).toMatch(TRACERESPONSE);
    // But the handler's own line is still correlated with the response header.
    const inner = entries.find((e) => e['message'] === 'from the handler');
    expect(seen.header).toBe(
      `00-${String(inner?.['traceId'])}-${String(inner?.['spanId'])}-01`,
    );
    expect(inner?.['context']).toBe('ThingsController.inner');
  });

  it('continues an inbound trace on a correlated ignored path', async () => {
    const seen: { header?: string | undefined } = {};
    await captured(async () => {
      await withApp(
        async (_app, url) => {
          const response = await fetch(new URL('things', url), {
            headers: { traceparent: `00-${INBOUND_TRACE}-${INBOUND_SPAN}-00` },
          });
          seen.header = response.headers.get('traceresponse') ?? undefined;
        },
        { requestLogging: { ignore: ['/things'], correlateIgnored: true } },
      );
    });

    expect(seen.header).toMatch(
      new RegExp(`^00-${INBOUND_TRACE}-[0-9a-f]{16}-00$`),
    );
  });

  it('logs the same entry without the scope under correlate: false', async () => {
    const seen: { header?: string | undefined } = {};
    const entries = await captured(async () => {
      await withApp(
        async (app, url) => {
          handlerLogger.current = app.get(Logger);
          const response = await fetch(new URL('things/inner', url));
          seen.header = response.headers.get('traceresponse') ?? undefined;
        },
        { requestLogging: { correlate: false } },
      );
    });

    const entry = entries.find(
      (e) => e['message'] === 'GET /things/inner 200',
    ) as Record<string, unknown>;
    expect(seen.header).toBe(
      `00-${String(entry['traceId'])}-${String(entry['spanId'])}-01`,
    );
    expect(entry['method']).toBe('GET');
    expect(entry['event']).toBe('/things/inner');
    expect(entry['flow']).toBe('http');
    expect(entry['context']).toBe('ThingsController.inner');
    expect(entry['statusCode']).toBe(200);

    // The trade, and the whole reason it is not the default: the handler's own
    // line has no store to read the trace back out of.
    const inner = entries.find((e) => e['message'] === 'from the handler');
    expect(inner?.['traceId']).toBeUndefined();
  });

  it('keeps the fields on a failure under correlate: false', async () => {
    const entries = await captured(async () => {
      await withApp(
        async (_app, url) => {
          await fetch(new URL('things/boom', url));
        },
        { requestLogging: { correlate: false } },
      );
    });

    const entry = entries.find((e) => e['level'] === 'warn') as Record<
      string,
      unknown
    >;
    expect(entry['statusCode']).toBe(418);
    expect(entry['traceId']).toMatch(HEX_32);
    expect(entry['context']).toBe('ThingsController.boom');
  });

  it('still stamps the response on an ignored path under correlate: false', async () => {
    const seen: { header?: string | undefined } = {};
    const entries = await captured(async () => {
      await withApp(
        async (_app, url) => {
          const response = await fetch(new URL('things', url));
          seen.header = response.headers.get('traceresponse') ?? undefined;
        },
        {
          requestLogging: {
            correlate: false,
            ignore: ['/things'],
            correlateIgnored: true,
          },
        },
      );
    });

    expect(seen.header).toMatch(TRACERESPONSE);
    expect(
      entries.find((e) => e['message'] === 'GET /things 200'),
    ).toBeUndefined();
  });

  it('binds RequestContext by default, so an app can use it directly', async () => {
    await withApp(
      async (app) => {
        const context = app.get(RequestContext);
        const seen = context.runWithContext({ traceId: 't1' }, () =>
          context.getContext(),
        );
        expect(seen['traceId']).toBe('t1');
        expect(context.getContext()).toEqual({});
      },
      { requestLogging: false },
    );
  });
});
