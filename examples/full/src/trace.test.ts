import { afterAll, beforeAll, expect, it } from 'bun:test';
import type { HttpApp } from '@dunx/http';
import { createApp } from './main.js';

/**
 * W3C Trace Context, against the same `createApp()` that `bun start` uses.
 *
 * Its own file rather than `service.test.ts`, which is at the 500-line cap.
 * `bootstrap.ts` sets no `trace` option: the fields reach `RequestContext`
 * because request logging adopts a trace by default, and `TraceController` reads
 * them back out inside a handler - so this covers the whole path, not just the
 * parser.
 */
let app: HttpApp;
let base = '';

const UPSTREAM_TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const UPSTREAM_SPAN = '00f067aa0ba902b7';

interface SeenTrace {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  traceFlags?: string;
}

beforeAll(async () => {
  app = await createApp();
  base = await app.listen(0);
});

afterAll(async () => {
  await app.shutdown();
});

const traced = async (traceparent?: string): Promise<SeenTrace> => {
  const response = await fetch(new URL('api/trace', base), {
    headers: traceparent === undefined ? {} : { traceparent },
  });
  return (await response.json()) as SeenTrace;
};

const tracedResponse = async (traceparent?: string): Promise<Response> =>
  fetch(new URL('api/trace', base), {
    headers: traceparent === undefined ? {} : { traceparent },
  });

it('starts a trace when the caller sent none, with nothing configured', async () => {
  const seen = await traced();
  expect(seen.traceId).toMatch(/^[0-9a-f]{32}$/);
  expect(seen.spanId).toMatch(/^[0-9a-f]{16}$/);
  expect(seen.parentSpanId).toBeUndefined();
  expect(seen.traceFlags).toBe('01');
});

it('answers with traceresponse naming the span that handled it', async () => {
  const response = await tracedResponse();
  const seen = (await response.json()) as SeenTrace;
  expect(response.headers.get('traceresponse')).toBe(
    `00-${String(seen.traceId)}-${String(seen.spanId)}-01`,
  );
});

it('keeps an inbound sampling decision rather than re-sampling', async () => {
  const seen = await traced(`00-${UPSTREAM_TRACE}-${UPSTREAM_SPAN}-00`);
  expect(seen.traceFlags).toBe('00');
});

it('continues an inbound trace as a child span', async () => {
  const seen = await traced(`00-${UPSTREAM_TRACE}-${UPSTREAM_SPAN}-01`);
  expect(seen.traceId).toBe(UPSTREAM_TRACE);
  expect(seen.parentSpanId).toBe(UPSTREAM_SPAN);
  expect(seen.spanId).not.toBe(UPSTREAM_SPAN);
});

it('starts a fresh trace rather than trusting a malformed one', async () => {
  const seen = await traced('00-not-a-trace-id-01');
  expect(seen.traceId).not.toBe(UPSTREAM_TRACE);
  expect(seen.traceId).toMatch(/^[0-9a-f]{32}$/);
  expect(seen.parentSpanId).toBeUndefined();
});

it('gives every request its own trace and span', async () => {
  const first = await traced();
  const second = await traced();
  expect(first.spanId).not.toBe(second.spanId);
  expect(first.traceId).not.toBe(second.traceId);
});
