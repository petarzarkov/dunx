import { describe, expect, it } from 'bun:test';
import { TRACEPARENT_HEADER, TraceContext } from './trace-context.js';

const REQUEST_ID = '0189d7f2-5c3a-7b1e-9f44-2a6c8d1e3b70';
const INBOUND_TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const INBOUND_SPAN = '00f067aa0ba902b7';

const requestWith = (headers: Record<string, string> = {}): Request =>
  new Request('http://localhost/items', { headers });

describe('TraceContext.adopt', () => {
  it('continues a valid inbound trace as a child span', () => {
    const trace = TraceContext.adopt(
      requestWith({
        [TRACEPARENT_HEADER]: `00-${INBOUND_TRACE}-${INBOUND_SPAN}-01`,
      }),
      REQUEST_ID,
    );
    expect(trace.traceId).toBe(INBOUND_TRACE);
    expect(trace.parentSpanId).toBe(INBOUND_SPAN);
    // A span of its own, not the caller's reused.
    expect(trace.spanId).not.toBe(INBOUND_SPAN);
    expect(trace.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(trace.flags).toBe('01');
  });

  it('derives a trace id from the request id when nothing arrives', () => {
    const trace = TraceContext.adopt(requestWith(), REQUEST_ID);
    // A UUID is 16 bytes, which is exactly a trace id - so one identifier, two
    // spellings, and no second crypto call.
    expect(trace.traceId).toBe(REQUEST_ID.replaceAll('-', ''));
    expect(trace.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(trace.parentSpanId).toBeUndefined();
  });

  it('mints a distinct span per request', () => {
    const first = TraceContext.adopt(requestWith(), REQUEST_ID);
    const second = TraceContext.adopt(requestWith(), REQUEST_ID);
    expect(first.spanId).not.toBe(second.spanId);
  });

  it.each([
    ['not hex', `00-zzf92f3577b34da6a3ce929d0e0e4736-${INBOUND_SPAN}-01`],
    ['short trace id', `00-4bf92f35-${INBOUND_SPAN}-01`],
    ['all-zero trace id', `00-${'0'.repeat(32)}-${INBOUND_SPAN}-01`],
    ['all-zero span id', `00-${INBOUND_TRACE}-${'0'.repeat(16)}-01`],
    ['reserved version ff', `ff-${INBOUND_TRACE}-${INBOUND_SPAN}-01`],
    ['too few fields', `00-${INBOUND_TRACE}-${INBOUND_SPAN}`],
    [
      'version 00 with extra fields',
      `00-${INBOUND_TRACE}-${INBOUND_SPAN}-01-x`,
    ],
    ['empty', ''],
  ])('discards a malformed traceparent (%s)', (_name, header) => {
    const trace = TraceContext.adopt(
      requestWith({ [TRACEPARENT_HEADER]: header }),
      REQUEST_ID,
    );
    // Discarded rather than repaired: the caller's trace is unknown, so this
    // request starts one instead of joining a trace that may not exist.
    expect(trace.traceId).toBe(REQUEST_ID.replaceAll('-', ''));
    expect(trace.parentSpanId).toBeUndefined();
  });

  it('keeps the first four fields of a future version', () => {
    const trace = TraceContext.adopt(
      requestWith({
        [TRACEPARENT_HEADER]: `01-${INBOUND_TRACE}-${INBOUND_SPAN}-01-something`,
      }),
      REQUEST_ID,
    );
    expect(trace.traceId).toBe(INBOUND_TRACE);
    expect(trace.parentSpanId).toBe(INBOUND_SPAN);
  });

  it('carries tracestate through, but only alongside a valid traceparent', () => {
    const joined = TraceContext.adopt(
      requestWith({
        [TRACEPARENT_HEADER]: `00-${INBOUND_TRACE}-${INBOUND_SPAN}-01`,
        tracestate: 'vendor=opaque',
      }),
      REQUEST_ID,
    );
    expect(joined.state).toBe('vendor=opaque');

    // A tracestate belongs to a trace this request is not part of.
    const orphan = TraceContext.adopt(
      requestWith({ tracestate: 'vendor=opaque' }),
      REQUEST_ID,
    );
    expect(orphan.state).toBeUndefined();
  });

  it('reads back off the request', () => {
    const req = requestWith();
    expect(TraceContext.of(req)).toBeUndefined();
    const trace = TraceContext.adopt(req, REQUEST_ID);
    expect(TraceContext.of(req)).toEqual(trace);
  });
});

describe('TraceContext.header', () => {
  it('sends this span as the callee parent', () => {
    const trace = TraceContext.adopt(requestWith(), REQUEST_ID);
    expect(TraceContext.header(trace)).toBe(
      `00-${trace.traceId}-${trace.spanId}-01`,
    );
  });

  it('round-trips through adopt', () => {
    const first = TraceContext.adopt(requestWith(), REQUEST_ID);
    const second = TraceContext.adopt(
      requestWith({ [TRACEPARENT_HEADER]: TraceContext.header(first) }),
      '0189d7f2-5c3a-7b1e-9f44-2a6c8d1e3b71',
    );
    expect(second.traceId).toBe(first.traceId);
    expect(second.parentSpanId).toBe(first.spanId);
  });
});

describe('TraceContext.sampled', () => {
  it('reads bit 0 of the flags', () => {
    expect(TraceContext.sampled({ flags: '01' })).toBe(true);
    expect(TraceContext.sampled({ flags: '00' })).toBe(false);
    expect(TraceContext.sampled({ flags: '03' })).toBe(true);
    expect(TraceContext.sampled({ flags: '02' })).toBe(false);
  });
});
