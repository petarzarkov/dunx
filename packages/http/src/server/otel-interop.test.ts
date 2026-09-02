import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  AsyncRequestContext,
  ConsoleLogger,
  Logger,
  Module,
  provide,
} from '@dunx/core';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { context, propagation, trace } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { HttpClientOptions } from '../client/options.js';
import { HttpService } from '../client/service.js';
import { Controller, Get } from '../route/decorators.js';
import type { Input, RouteSchemas } from '../route/schema.js';
import { HttpFactory, type HttpApp } from './factory.js';
import { TRACEPARENT_HEADER, TRACERESPONSE_HEADER } from './trace-context.js';

/**
 * dunx against a real OpenTelemetry SDK, both directions.
 *
 * `TraceContext` implements W3C Trace Context rather than wrapping
 * `@opentelemetry/api`, so nothing but this proves the two agree. Asserting our
 * own parser against our own writer would pass on a format only dunx speaks.
 *
 * `@opentelemetry/*` are `devDependencies` of this package and reach no manifest
 * a consumer installs. Bun 1.4.0 is what makes the SDK runnable here at all.
 */
@Controller('trace')
class TraceController {
  @Get('/')
  current(input: Input<RouteSchemas>): { inbound: string | null } {
    return { inbound: input.req.headers.get(TRACEPARENT_HEADER) };
  }
}

/**
 * Request logging stays on: it is what adopts the trace, so `requestLogging:
 * false` would leave nothing for the SDK to read. The logger is silenced rather
 * than removed.
 */
@Module({
  controllers: [TraceController],
  providers: [
    provide(Logger, {
      useValue: new ConsoleLogger(new AsyncRequestContext(), 'fatal'),
    }),
  ],
})
class AppModule {}

const exporter = new InMemorySpanExporter();
let app: HttpApp;
let base = '';

beforeAll(async () => {
  new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  }).register({ propagator: new W3CTraceContextPropagator() });

  app = await HttpFactory.create(AppModule);
  base = await app.listen(0);
});

afterAll(async () => {
  await app.shutdown();
});

const tracer = (): ReturnType<typeof trace.getTracer> =>
  trace.getTracer('dunx-interop');

describe('inbound: an OpenTelemetry caller reaches dunx', () => {
  it('continues the SDK-injected trace, with the SDK span as parent', async () => {
    const span = tracer().startSpan('caller');
    const carrier: Record<string, string> = {};
    propagation.inject(trace.setSpan(context.active(), span), carrier);
    span.end();

    const response = await fetch(new URL('trace', base), {
      headers: carrier,
    });
    const answered = response.headers.get(TRACERESPONSE_HEADER);
    expect(answered).not.toBeNull();

    const caller = span.spanContext();
    // The SDK wrote it, dunx parsed it, and dunx answered inside the same trace.
    const [, , traceId, spanId] = /^(\d\d)-(\w{32})-(\w{16})-\w\w$/.exec(
      String(answered),
    ) as RegExpExecArray;
    expect(traceId).toBe(caller.traceId);
    expect(spanId).not.toBe(caller.spanId);
  });

  it('is read back by the SDK as a remote parent of a new span', async () => {
    const response = await fetch(new URL('trace', base));
    const answered = String(response.headers.get(TRACERESPONSE_HEADER));

    // The reverse direction of the same header: an SDK downstream of dunx picks
    // dunx's span up as its parent with no adapter in between.
    const extracted = propagation.extract(context.active(), {
      traceparent: answered,
    });
    const parent = trace.getSpanContext(extracted);
    expect(parent?.isRemote).toBe(true);
    expect(answered).toBe(
      `00-${String(parent?.traceId)}-${String(parent?.spanId)}-01`,
    );

    const child = tracer().startSpan('downstream', undefined, extracted);
    child.end();
    const recorded = exporter.getFinishedSpans().at(-1);
    expect(recorded?.spanContext().traceId).toBe(parent?.traceId);
    expect(recorded?.parentSpanContext?.spanId).toBe(parent?.spanId);
  });

  it('declines to trust a traceparent the SDK would also reject', async () => {
    const response = await fetch(new URL('trace', base), {
      headers: {
        [TRACEPARENT_HEADER]: `00-${'0'.repeat(32)}-${'0'.repeat(16)}-01`,
      },
    });
    const answered = String(response.headers.get(TRACERESPONSE_HEADER));
    expect(answered).not.toContain('0'.repeat(32));

    // The SDK agrees the all-zero id is not a trace: extract yields nothing.
    expect(
      trace.getSpanContext(
        propagation.extract(context.active(), {
          traceparent: `00-${'0'.repeat(32)}-${'0'.repeat(16)}-01`,
        }),
      ),
    ).toBeUndefined();
  });
});

describe('outbound: dunx reaches an OpenTelemetry callee', () => {
  it('sends a traceparent the SDK extracts into the same trace', async () => {
    const seen: { header?: string | undefined } = {};
    const upstream = Bun.serve({
      port: 0,
      fetch: (request) => {
        seen.header = request.headers.get(TRACEPARENT_HEADER) ?? undefined;
        return Response.json({ ok: true });
      },
    });

    try {
      const requests = new AsyncRequestContext();
      const client = new HttpService(
        new HttpClientOptions({
          baseUrl: `http://localhost:${upstream.port}/`,
        }),
        new ConsoleLogger(requests, 'fatal'),
        requests,
      );

      // What `RequestLoggingMiddleware` puts in the store for an inbound request.
      const span = tracer().startSpan('inbound');
      const inbound = span.spanContext();
      span.end();

      await requests.runWithContext(
        {
          traceId: inbound.traceId,
          spanId: inbound.spanId,
          traceFlags: '01',
        },
        () => client.get('/'),
      );

      const extracted = propagation.extract(context.active(), {
        traceparent: String(seen.header),
      });
      const parent = trace.getSpanContext(extracted);
      expect(parent?.traceId).toBe(inbound.traceId);
      expect(parent?.spanId).toBe(inbound.spanId);
      expect(parent?.traceFlags).toBe(1);
    } finally {
      await upstream.stop(true);
    }
  });

  it('forwards an unsampled decision the SDK reads back as unsampled', async () => {
    const seen: { header?: string | undefined } = {};
    const upstream = Bun.serve({
      port: 0,
      fetch: (request) => {
        seen.header = request.headers.get(TRACEPARENT_HEADER) ?? undefined;
        return Response.json({ ok: true });
      },
    });

    try {
      const requests = new AsyncRequestContext();
      const client = new HttpService(
        new HttpClientOptions({
          baseUrl: `http://localhost:${upstream.port}/`,
        }),
        new ConsoleLogger(requests, 'fatal'),
        requests,
      );

      await requests.runWithContext(
        {
          traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
          spanId: '00f067aa0ba902b7',
          traceFlags: '00',
        },
        () => client.get('/'),
      );

      const parent = trace.getSpanContext(
        propagation.extract(context.active(), {
          traceparent: String(seen.header),
        }),
      );
      expect(parent?.traceFlags).toBe(0);
    } finally {
      await upstream.stop(true);
    }
  });
});
