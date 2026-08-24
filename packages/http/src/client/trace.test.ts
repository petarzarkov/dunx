import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { AsyncRequestContext, ConsoleLogger } from '@dunx/core';
import { HttpClientOptions, type HttpClientOptionsInit } from './options.js';
import { HttpService } from './service.js';

/**
 * Outbound W3C Trace Context. Its own file rather than `client.test.ts`, which
 * is at the 500-line cap - and its server answers one question, where that one's
 * answers a dozen.
 */
let server: ReturnType<typeof Bun.serve>;
let base = '';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN = '00f067aa0ba902b7';

interface Echoed {
  traceparent: string | null;
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: (request) =>
      Response.json({ traceparent: request.headers.get('traceparent') }),
  });
  base = `http://localhost:${server.port}/`;
});

afterAll(async () => {
  await server.stop(true);
});

const clientFor = (
  init: HttpClientOptionsInit = {},
  context: AsyncRequestContext = new AsyncRequestContext(),
): HttpService =>
  new HttpService(
    new HttpClientOptions({ baseUrl: base, ...init }),
    new ConsoleLogger(context, 'fatal'),
    context,
  );

describe('traceparent propagation', () => {
  it('forwards the trace in scope, so this span becomes the callee parent', async () => {
    const context = new AsyncRequestContext();
    const client = clientFor({}, context);

    const echoed = await context.runWithContext(
      { traceId: TRACE, spanId: SPAN },
      () => client.get(base) as Promise<Echoed>,
    );
    expect(echoed.traceparent).toBe(`00-${TRACE}-${SPAN}-01`);
  });

  it('sends nothing when no trace is in scope', async () => {
    // `requestLogging: { trace: true }` on the inbound side is what puts one
    // there. Without it there is nothing to forward.
    expect(((await clientFor().get(base)) as Echoed).traceparent).toBeNull();
  });

  it('sends nothing when propagation is turned off', async () => {
    const context = new AsyncRequestContext();
    const client = clientFor({ propagateTrace: false }, context);

    const echoed = await context.runWithContext(
      { traceId: TRACE, spanId: SPAN },
      () => client.get(base) as Promise<Echoed>,
    );
    expect(echoed.traceparent).toBeNull();
  });

  it('sends nothing when the scope has a trace id but no span', async () => {
    const context = new AsyncRequestContext();
    const client = clientFor({}, context);

    const echoed = await context.runWithContext(
      { traceId: TRACE },
      () => client.get(base) as Promise<Echoed>,
    );
    expect(echoed.traceparent).toBeNull();
  });
});
