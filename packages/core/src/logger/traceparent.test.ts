import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_TRACE_FLAGS,
  formatTraceparent,
  isSampled,
  mintSpanId,
  mintTraceId,
  parseTraceparent,
  traceparentOf,
} from './traceparent.js';

const TRACE = 'a'.repeat(32);
const SPAN = 'b'.repeat(16);

describe('formatTraceparent', () => {
  it('writes the version, the two ids and the flags', () => {
    expect(
      formatTraceparent({ traceId: TRACE, spanId: SPAN, flags: '01' }),
    ).toBe(`00-${TRACE}-${SPAN}-01`);
  });
});

describe('parseTraceparent', () => {
  it('reads a well formed header', () => {
    expect(parseTraceparent(`00-${TRACE}-${SPAN}-01`)).toEqual({
      traceId: TRACE,
      spanId: SPAN,
      flags: '01',
    });
  });

  it('has nothing to read from an absent header', () => {
    expect(parseTraceparent(null)).toBeUndefined();
    expect(parseTraceparent(undefined)).toBeUndefined();
  });

  /**
   * The standard requires a malformed value to be discarded rather than
   * repaired, so every one of these starts a fresh trace at the receiver.
   */
  it.each([
    ['too few fields', `00-${TRACE}-${SPAN}`],
    ['a non-hex version', `zz-${TRACE}-${SPAN}-01`],
    ['the reserved ff version', `ff-${TRACE}-${SPAN}-01`],
    ['a fifth field on version 00', `00-${TRACE}-${SPAN}-01-extra`],
    ['a short trace id', `00-${'a'.repeat(31)}-${SPAN}-01`],
    ['an all-zero trace id', `00-${'0'.repeat(32)}-${SPAN}-01`],
    ['a short span id', `00-${TRACE}-${'b'.repeat(15)}-01`],
    ['an all-zero span id', `00-${TRACE}-${'0'.repeat(16)}-01`],
    ['non-hex flags', `00-${TRACE}-${SPAN}-zz`],
  ])('discards %s', (_why, header) => {
    expect(parseTraceparent(header)).toBeUndefined();
  });

  /** A version this code does not know keeps the four fields it does know. */
  it('keeps the first four fields of a later version', () => {
    expect(parseTraceparent(`01-${TRACE}-${SPAN}-01-vendor`)?.traceId).toBe(
      TRACE,
    );
  });
});

describe('isSampled', () => {
  it('reads bit 0, which is the only flag the standard defines', () => {
    expect(isSampled({ flags: '01' })).toBe(true);
    expect(isSampled({ flags: '03' })).toBe(true);
    expect(isSampled({ flags: '00' })).toBe(false);
    expect(isSampled({ flags: '02' })).toBe(false);
  });
});

describe('minting ids', () => {
  it('returns the width the standard states, and a different one each call', () => {
    expect(mintTraceId()).toMatch(/^[0-9a-f]{32}$/);
    expect(mintSpanId()).toMatch(/^[0-9a-f]{16}$/);
    expect(mintSpanId()).not.toBe(mintSpanId());
  });
});

describe('traceparentOf', () => {
  it('builds the header an outbound call sends', () => {
    expect(
      traceparentOf({ traceId: TRACE, spanId: SPAN, traceFlags: '00' }),
    ).toBe(`00-${TRACE}-${SPAN}-00`);
  });

  /** Sending a fixed `01` would re-sample a trace the caller had decided not to. */
  it('defaults the flags only when the scope carries none', () => {
    expect(traceparentOf({ traceId: TRACE, spanId: SPAN })).toEndWith(
      `-${DEFAULT_TRACE_FLAGS}`,
    );
  });

  it('has nothing to send when the scope holds no trace', () => {
    expect(traceparentOf({})).toBeUndefined();
    expect(traceparentOf({ traceId: TRACE })).toBeUndefined();
    expect(traceparentOf({ spanId: SPAN })).toBeUndefined();
  });
});
