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
  tracestate: string | null;
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: (request) =>
      Response.json({
        traceparent: request.headers.get('traceparent'),
        tracestate: request.headers.get('tracestate'),
      }),
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
      { traceId: TRACE, spanId: SPAN, traceFlags: '01' },
      () => client.get(base) as Promise<Echoed>,
    );
    expect(echoed.traceparent).toBe(`00-${TRACE}-${SPAN}-01`);
  });

  it('forwards the inbound sampling decision rather than re-sampling', async () => {
    const context = new AsyncRequestContext();
    const client = clientFor({}, context);

    const echoed = await context.runWithContext(
      { traceId: TRACE, spanId: SPAN, traceFlags: '00' },
      () => client.get(base) as Promise<Echoed>,
    );
    expect(echoed.traceparent).toBe(`00-${TRACE}-${SPAN}-00`);
  });

  it('falls back to sampled when the scope carries no flags', async () => {
    const context = new AsyncRequestContext();
    const client = clientFor({}, context);

    const echoed = await context.runWithContext(
      { traceId: TRACE, spanId: SPAN },
      () => client.get(base) as Promise<Echoed>,
    );
    expect(echoed.traceparent).toBe(`00-${TRACE}-${SPAN}-01`);
  });

  it('forwards tracestate unchanged beside traceparent', async () => {
    const context = new AsyncRequestContext();
    const client = clientFor({}, context);

    const echoed = await context.runWithContext(
      {
        traceId: TRACE,
        spanId: SPAN,
        traceFlags: '01',
        traceState: 'vendor=opaque,other=1',
      },
      () => client.get(base) as Promise<Echoed>,
    );
    // The standard requires a participant to pass it on untouched, and this
    // service does not read it.
    expect(echoed.tracestate).toBe('vendor=opaque,other=1');
  });

  it('sends no tracestate when the scope carries none', async () => {
    const context = new AsyncRequestContext();
    const client = clientFor({}, context);

    const echoed = await context.runWithContext(
      { traceId: TRACE, spanId: SPAN, traceFlags: '01' },
      () => client.get(base) as Promise<Echoed>,
    );
    expect(echoed.traceparent).not.toBeNull();
    expect(echoed.tracestate).toBeNull();
  });

  it('sends nothing when no trace is in scope', async () => {
    // The inbound side puts one there unless `requestLogging: { trace: false }`
    // removed it. Without one there is nothing to forward.
    expect(((await clientFor().get(base)) as Echoed).traceparent).toBeNull();
  });

  it('sends nothing when propagation is turned off', async () => {
    const context = new AsyncRequestContext();
    const client = clientFor({ propagateTrace: false }, context);

    const echoed = await context.runWithContext(
      { traceId: TRACE, spanId: SPAN, traceFlags: '01' },
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
