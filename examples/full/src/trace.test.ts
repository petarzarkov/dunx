import { afterAll, beforeAll, expect, it } from 'bun:test';
import type { HttpApp } from '@dunx/http';
import { createApp } from './main.js';

/**
 * W3C Trace Context, against the same `createApp()` that `bun start` uses.
 *
 * Its own file rather than `service.test.ts`, which is at the 500-line cap.
 * `requestLogging: { trace: true }` in `main.ts` is what puts these fields
 * into `RequestContext`, and `TraceController` reads them back out inside a
 * handler - so this covers the whole path, not just the parser.
 */
let app: HttpApp;
let base = '';

const UPSTREAM_TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const UPSTREAM_SPAN = '00f067aa0ba902b7';

interface SeenTrace {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
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

it('starts a trace when the caller sent none', async () => {
  const seen = await traced();
  expect(seen.traceId).toMatch(/^[0-9a-f]{32}$/);
  expect(seen.spanId).toMatch(/^[0-9a-f]{16}$/);
  expect(seen.parentSpanId).toBeUndefined();
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
