import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  AsyncRequestContext,
  ConsoleLogger,
  inject,
  Logger,
  Module,
  provide,
} from '@dunx/core';
import { OtelModule, OtelTracer } from '@dunx/core/otel';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { spansOf } from '../otel.fixture.js';
import { Controller, Get } from '../route/decorators.js';
import { HttpFactory } from '../server/factory.js';
import { serving } from '../server/serving.fixture.js';
import { HttpModule } from './module.js';
import { HttpClientOptions } from './options.js';
import { HttpService } from './service.js';

/**
 * The CLIENT span `HttpService` opens per attempt once it is handed an
 * `OtelTracer`. The `traceparent` it sends names that span, so the callee's
 * server span is its child rather than a sibling.
 */
let server: ReturnType<typeof Bun.serve>;
let base = '';
const received: string[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    routes: {
      '/ok': (request) => {
        received.push(request.headers.get('traceparent') ?? '');
        return Response.json({ ok: true });
      },
      '/down': () => new Response('down', { status: 503 }),
    },
  });
  base = `http://localhost:${server.port}/`;
});

afterAll(async () => {
  await server.stop(true);
});

const tracer = new OtelTracer();

/** A server span around the call, its ids in the store, as the inbound side leaves them. */
const within = <T>(
  run: (client: HttpService) => Promise<T>,
  retries = 0,
): Promise<{ traceId: string; parent: string }> => {
  const context = new AsyncRequestContext();
  const client = new HttpService(
    new HttpClientOptions({
      baseUrl: base,
      retry: { maxRetries: retries, retryDelayMs: 1, backoff: { jitterMs: 0 } },
    }),
    new ConsoleLogger(context, 'fatal'),
    context,
    tracer,
  );
  return tracer.span('inbound', { kind: 'server' }, async (span) => {
    const ids = span.ids();
    if (ids === undefined) throw new Error('the SDK is not recording');
    await context
      .runWithContext(
        { traceId: ids.traceId, spanId: ids.spanId, traceFlags: ids.flags },
        () => run(client),
      )
      .catch(() => undefined);
    return { traceId: ids.traceId, parent: ids.spanId };
  });
};

const clientSpans = (traceId: string) =>
  spansOf(traceId).filter((span) => span.kind === SpanKind.CLIENT);

describe('HttpService with a Tracer', () => {
  it('sends the client span as the callee parent', async () => {
    received.length = 0;
    const { traceId, parent } = await within((client) => client.get('ok'));

    const [span] = clientSpans(traceId);
    expect(span?.name).toBe('GET');
    expect(span?.parentSpanContext?.spanId).toBe(parent);
    expect(received).toEqual([
      `00-${traceId}-${String(span?.spanContext().spanId)}-01`,
    ]);
    expect(span?.attributes).toMatchObject({
      'http.request.method': 'GET',
      'url.full': `${base}ok`,
      'server.address': 'localhost',
      'server.port': server.port,
      'http.response.status_code': 200,
    });
  });

  it('marks a failed status ERROR', async () => {
    const { traceId } = await within((client) => client.get('down'));

    const [span] = clientSpans(traceId);
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.attributes['http.response.status_code']).toBe(503);
    expect(span?.events.map((event) => event.name)).toEqual(['exception']);
  });

  it('opens one span per attempt, as a resend is its own request', async () => {
    const { traceId } = await within((client) => client.get('down'), 1);
    expect(clientSpans(traceId)).toHaveLength(2);
  });
});

describe('HttpModule under OtelModule', () => {
  @Controller('proxy')
  class ProxyController {
    readonly http = inject(HttpService);

    @Get('/')
    proxy(): Promise<unknown> {
      return this.http.get('ok');
    }
  }

  it('parents the client span to the server span that made the call', async () => {
    received.length = 0;
    @Module({
      imports: [OtelModule, HttpModule.forRoot({ baseUrl: base })],
      controllers: [ProxyController],
      providers: [
        provide(Logger, {
          useValue: new ConsoleLogger(new AsyncRequestContext(), 'fatal'),
        }),
      ],
    })
    class Root {}

    const traceId = crypto.getRandomValues(new Uint8Array(16)).toHex();
    await serving(
      () => HttpFactory.create(Root, { bootLogging: false }),
      async (_app, url) => {
        await fetch(new URL('proxy', url), {
          headers: { traceparent: `00-${traceId}-00f067aa0ba902b7-01` },
        });
      },
    );

    const inbound = spansOf(traceId).find(
      (span) => span.kind === SpanKind.SERVER,
    );
    const [outbound] = clientSpans(traceId);
    expect(outbound?.parentSpanContext?.spanId).toBe(
      String(inbound?.spanContext().spanId),
    );
    expect(received).toEqual([
      `00-${traceId}-${String(outbound?.spanContext().spanId)}-01`,
    ]);
  });
});
