import { afterAll, beforeAll, expect, it } from 'bun:test';
import { SpanKind } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-node';
import type { HttpApp } from '@dunx/http';
import { createApp } from './main.js';

/**
 * `OtelModule` against the same `createApp()` that `bun start` uses, with the
 * SDK `otel.preload.ts` would register swapped for an in-memory exporter. One
 * provider per process: `bun test` runs every file in one, and the API's global
 * can be set once.
 *
 * The Redis, queue and broker cases pass without asserting when their service is
 * unreachable, the contract `cache`, `jobs` and `messaging` tests keep.
 */
const exporter = new InMemorySpanExporter();
new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
}).register();

let app: HttpApp;
let base = '';

beforeAll(async () => {
  app = await createApp();
  base = await app.listen(0);
});

afterAll(async () => {
  await app.shutdown();
});

interface Traced {
  readonly response: Response;
  readonly traceId: string;
  readonly spanId: string;
}

/** A request, and the ids its `traceresponse` names. */
const request = async (path: string, init?: RequestInit): Promise<Traced> => {
  const response = await fetch(new URL(`api/${path}`, base), init);
  const [, traceId = '', spanId = ''] =
    response.headers.get('traceresponse')?.split('-') ?? [];
  return { response, traceId, spanId };
};

const inTrace = (traceId: string): readonly ReadableSpan[] =>
  exporter
    .getFinishedSpans()
    .filter((span) => span.spanContext().traceId === traceId);

const serverSpan = ({ traceId, spanId }: Traced): ReadableSpan => {
  const found = inTrace(traceId).find(
    (span) => span.spanContext().spanId === spanId,
  );
  if (found === undefined) throw new Error(`no span ${spanId} in ${traceId}`);
  return found;
};

/** Whether `span` descends from `ancestor`, through whatever sits between. */
const descends = (span: ReadableSpan, ancestor: ReadableSpan): boolean => {
  const byId = new Map(
    inTrace(span.spanContext().traceId).map((each) => [
      each.spanContext().spanId,
      each,
    ]),
  );
  let parent = span.parentSpanContext?.spanId;
  while (parent !== undefined) {
    if (parent === ancestor.spanContext().spanId) return true;
    parent = byId.get(parent)?.parentSpanContext?.spanId;
  }
  return false;
};

/** Consumers finish after the response, so their spans are polled for. */
const eventually = async (
  find: () => ReadableSpan | undefined,
): Promise<ReadableSpan> => {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const found = find();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error('span never finished');
    await Bun.sleep(25);
  }
};

it('names the SERVER span in traceresponse and in RequestContext', async () => {
  const traced = await request('trace');
  const seen = (await traced.response.json()) as {
    traceId: string;
    spanId: string;
  };
  const server = serverSpan(traced);

  expect(server.kind).toBe(SpanKind.SERVER);
  expect(server.name).toBe('GET /api/trace');
  expect(server.attributes['http.response.status_code']).toBe(200);
  expect(seen).toMatchObject({
    traceId: server.spanContext().traceId,
    spanId: server.spanContext().spanId,
  });
});

it('puts each sqlite query under the request that ran it', async () => {
  const traced = await request('users');
  expect(traced.response.status).toBe(200);
  const server = serverSpan(traced);
  const queries = inTrace(traced.traceId).filter(
    (span) => span.attributes['db.system.name'] === 'sqlite',
  );

  expect(server.attributes['http.route']).toBe('/api/users');
  expect(queries.length).toBeGreaterThan(0);
  for (const query of queries) {
    expect(query.kind).toBe(SpanKind.CLIENT);
    expect(descends(query, server)).toBe(true);
  }
});

it('puts a Redis command under the request that sent it', async () => {
  const traced = await request('cache/otel-probe');
  if (traced.response.status === 503) return;
  const command = inTrace(traced.traceId).find(
    (span) => span.attributes['db.operation.name'] === 'GET',
  );

  expect(command?.kind).toBe(SpanKind.CLIENT);
  expect(command && descends(command, serverSpan(traced))).toBe(true);
});

it('opens a PRODUCER span for a job the request enqueued', async () => {
  const traced = await request('jobs/thumbnails', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ width: 16, format: 'png' }),
  });
  if (traced.response.status !== 201) return;
  const publish = inTrace(traced.traceId).find(
    (span) => span.name === 'publish thumbnails',
  );

  expect(publish?.kind).toBe(SpanKind.PRODUCER);
  expect(publish && descends(publish, serverSpan(traced))).toBe(true);
});

it('carries one trace from the HTTP request through RabbitMQ to its consumer', async () => {
  const traced = await request('messaging/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: `otel-${Date.now()}`, total: 3 }),
  });
  if (traced.response.status !== 201) return;
  const server = serverSpan(traced);
  const publish = inTrace(traced.traceId).find(
    (span) => span.kind === SpanKind.PRODUCER,
  );
  const consume = await eventually(() =>
    inTrace(traced.traceId).find((span) => span.kind === SpanKind.CONSUMER),
  );

  expect(publish && descends(publish, server)).toBe(true);
  expect(publish && descends(consume, publish)).toBe(true);
});
