import { describe, expect, it } from 'bun:test';
import {
  AsyncRequestContext,
  ConsoleLogger,
  inject,
  Logger,
  Module,
  provide,
  RequestContext,
  type RequestFields,
} from '@dunx/core';
import { OtelModule } from '@dunx/core/otel';
import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { spansOf } from '../otel.fixture.js';
import { Controller, Get } from '../route/decorators.js';
import type { Input, RouteSchemas } from '../route/schema.js';
import { HttpError } from './errors.js';
import { HttpFactory, type HttpOptions } from './factory.js';
import { serving } from './serving.fixture.js';
import { TRACEPARENT_HEADER, TRACERESPONSE_HEADER } from './trace-context.js';

/**
 * The SERVER span `RequestLoggingMiddleware` opens once `Tracer` is bound to
 * `OtelTracer`. What has to hold is that the log line and the span are one
 * thing: the handler's `RequestContext` carries the exported span's own ids.
 */
let seen: RequestFields = {};

@Controller('spans')
class SpansController {
  readonly context = inject(RequestContext);

  @Get('/items/:id')
  async item(_input: Input<RouteSchemas>): Promise<{ ok: true }> {
    await Bun.sleep(0);
    seen = this.context.getContext();
    trace.getTracer('user').startSpan('user.work').end();
    return { ok: true };
  }

  @Get('/broken')
  broken(): never {
    throw new Error('exploded');
  }

  @Get('/missing')
  missing(): never {
    throw new HttpError(404, 'NOT_FOUND');
  }
}

const quiet = provide(Logger, {
  useValue: new ConsoleLogger(new AsyncRequestContext(), 'fatal'),
});

@Module({ controllers: [SpansController], providers: [quiet] })
class Plain {}

@Module({
  imports: [OtelModule],
  controllers: [SpansController],
  providers: [quiet],
})
class Traced {}

const CALLER = '00f067aa0ba902b7';

/** A fresh trace id per test, so `spansOf` sees only that test's spans. */
const inbound = (flags = '01'): { traceId: string; header: string } => {
  const traceId = crypto.getRandomValues(new Uint8Array(16)).toHex();
  return { traceId, header: `00-${traceId}-${CALLER}-${flags}` };
};

const call = async (
  root: typeof Plain,
  path: string,
  header: string,
  options: HttpOptions = {},
): Promise<Response> => {
  let response: Response | undefined;
  await serving(
    () => HttpFactory.create(root, { bootLogging: false, ...options }),
    async (_app, url) => {
      response = await fetch(new URL(path, url), {
        headers: { [TRACEPARENT_HEADER]: header },
      });
      await response.arrayBuffer();
    },
  );
  if (response === undefined) throw new Error('no response');
  return response;
};

const serverSpan = (traceId: string) => {
  const found = spansOf(traceId).find((span) => span.kind === SpanKind.SERVER);
  if (found === undefined) throw new Error('no server span exported');
  return found;
};

describe('with no Tracer bound', () => {
  it('mints its own ids, correlates the handler and exports nothing', async () => {
    seen = {};
    const { traceId, header } = inbound();
    const response = await call(Plain, 'spans/items/1', header);

    expect(seen.traceId).toBe(traceId);
    expect(seen.parentSpanId).toBe(CALLER);
    expect(seen.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(response.headers.get(TRACERESPONSE_HEADER)).toBe(
      `00-${traceId}-${String(seen.spanId)}-01`,
    );
    // With no server span to join, even the user's span starts a trace of its own.
    expect(spansOf(traceId)).toEqual([]);
  });
});

describe('with OtelModule', () => {
  it('exports a server span continuing the inbound traceparent', async () => {
    const { traceId, header } = inbound();
    await call(Traced, 'spans/items/7', header);

    const span = serverSpan(traceId);
    expect(span.name).toBe('GET /spans/items/:id');
    expect(span.parentSpanContext?.spanId).toBe(CALLER);
    expect(span.parentSpanContext?.isRemote).toBe(true);
    expect(span.attributes).toMatchObject({
      'http.request.method': 'GET',
      'http.route': '/spans/items/:id',
      'url.path': '/spans/items/7',
      'http.response.status_code': 200,
    });
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('puts the span ids in RequestContext and in traceresponse', async () => {
    seen = {};
    const { traceId, header } = inbound();
    const response = await call(Traced, 'spans/items/7', header);

    const span = serverSpan(traceId).spanContext();
    expect(seen.traceId).toBe(traceId);
    expect(seen.spanId).toBe(span.spanId);
    expect(seen.parentSpanId).toBe(CALLER);
    expect(seen.traceFlags).toBe('01');
    expect(response.headers.get(TRACERESPONSE_HEADER)).toBe(
      `00-${traceId}-${span.spanId}-01`,
    );
  });

  it('parents a span the handler starts to the server span', async () => {
    const { traceId, header } = inbound();
    await call(Traced, 'spans/items/7', header);

    const user = spansOf(traceId).find((span) => span.name === 'user.work');
    expect(user?.parentSpanContext?.spanId).toBe(
      serverSpan(traceId).spanContext().spanId,
    );
  });

  it('marks a thrown error ERROR with an exception event', async () => {
    const { traceId, header } = inbound();
    const response = await call(Traced, 'spans/broken', header);
    expect(response.status).toBe(500);

    const span = serverSpan(traceId);
    expect(span.status).toEqual({
      code: SpanStatusCode.ERROR,
      message: 'exploded',
    });
    expect(span.events.map((event) => event.name)).toEqual(['exception']);
    expect(span.attributes['http.response.status_code']).toBe(500);
  });

  it('leaves a 4xx unset: the caller erred, not this server', async () => {
    const { traceId, header } = inbound();
    await call(Traced, 'spans/missing', header);

    const span = serverSpan(traceId);
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
    expect(span.attributes['http.response.status_code']).toBe(404);
  });

  it('names an unmatched request by method alone, with no route', async () => {
    const { traceId, header } = inbound();
    const response = await call(Traced, 'nowhere/at/all', header);
    expect(response.status).toBe(404);

    const span = serverSpan(traceId);
    expect(span.name).toBe('GET');
    expect(span.attributes['http.route']).toBeUndefined();
    expect(span.attributes['http.response.status_code']).toBe(404);
  });

  it('keeps its own ids when the sampler drops the trace', async () => {
    seen = {};
    const { traceId, header } = inbound('00');
    await call(Traced, 'spans/items/7', header);

    expect(spansOf(traceId)).toEqual([]);
    expect(seen.traceId).toBe(traceId);
    expect(seen.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(seen.traceFlags).toBe('00');
  });

  it('opens no span on an ignored path', async () => {
    const { traceId, header } = inbound();
    await call(Traced, 'spans/items/7', header, {
      requestLogging: { ignore: ['/spans/items/7'] },
    });
    expect(spansOf(traceId)).toEqual([]);
  });

  it('opens one under correlateIgnored, which keeps the trace', async () => {
    seen = {};
    const { traceId, header } = inbound();
    await call(Traced, 'spans/items/7', header, {
      requestLogging: { ignore: ['/spans/items/7'], correlateIgnored: true },
    });
    expect(seen.spanId).toBe(serverSpan(traceId).spanContext().spanId);
  });

  it('still parents user spans under correlate: false', async () => {
    const { traceId, header } = inbound();
    await call(Traced, 'spans/items/7', header, {
      requestLogging: { correlate: false },
    });
    const user = spansOf(traceId).find((span) => span.name === 'user.work');
    expect(user?.parentSpanContext?.spanId).toBe(
      serverSpan(traceId).spanContext().spanId,
    );
  });
});
