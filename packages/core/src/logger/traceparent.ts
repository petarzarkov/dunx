import type { RequestFields } from './context.js';

export const TRACEPARENT_HEADER = 'traceparent';
export const TRACESTATE_HEADER = 'tracestate';

const HEX_32 = /^[0-9a-f]{32}$/;
const HEX_16 = /^[0-9a-f]{16}$/;
const HEX_2 = /^[0-9a-f]{2}$/;
const ZERO_TRACE = '0'.repeat(32);
const ZERO_SPAN = '0'.repeat(16);

/** The sampled bit, which is the only flag the standard currently defines. */
const SAMPLED = 0x01;

/** What a caller that started its own trace sends on, and what `sampled` reads. */
export const DEFAULT_TRACE_FLAGS = '01';

/** The three fields a `traceparent` carries past its version. */
export interface TraceIds {
  /** 32 hex digits, shared by every span in the trace. */
  readonly traceId: string;
  /** 16 hex digits identifying one participant's work. */
  readonly spanId: string;
  /** Two hex digits. Bit 0 is `sampled`. */
  readonly flags: string;
}

/**
 * The `traceparent` header value for these ids.
 *
 * In core rather than in `@dunx/http`, which parses the inbound header, because
 * `@dunx/infra/amqp` stamps the same value onto a message crossing a service
 * boundary and a second implementation would be a second spelling of a wire
 * format. The fields it formats are `RequestFields`' own, declared here already.
 */
export const formatTraceparent = (trace: TraceIds): string =>
  `00-${trace.traceId}-${trace.spanId}-${trace.flags}`;

/**
 * A `traceparent` header, or nothing when it is malformed. The standard requires
 * a malformed value to be discarded rather than repaired.
 *
 * Version `ff` is invalid; a higher version keeps its first four fields, so a
 * future format still propagates.
 */
export const parseTraceparent = (
  header: string | null | undefined,
): TraceIds | undefined => {
  if (header === null || header === undefined) return undefined;
  const parts = header.split('-');
  if (parts.length < 4) return undefined;

  const [version, traceId, spanId, flags] = parts as [
    string,
    string,
    string,
    string,
  ];
  if (!HEX_2.test(version) || version === 'ff') return undefined;
  if (version === '00' && parts.length !== 4) return undefined;
  if (!HEX_32.test(traceId) || traceId === ZERO_TRACE) return undefined;
  if (!HEX_16.test(spanId) || spanId === ZERO_SPAN) return undefined;
  if (!HEX_2.test(flags)) return undefined;

  return { traceId, spanId, flags };
};

export const isSampled = (trace: Pick<TraceIds, 'flags'>): boolean =>
  (Number.parseInt(trace.flags, 16) & SAMPLED) === SAMPLED;

/**
 * `n` random bytes as hex. `Uint8Array.prototype.toHex` is 49.2 ns for a trace id
 * and a span id together, against 260.5 ns for a `crypto.randomUUID()` pair.
 */
export const mintTraceId = (bytes: number): string =>
  crypto.getRandomValues(new Uint8Array(bytes)).toHex();

/**
 * The `traceparent` for the scope a `RequestContext` currently holds, or nothing
 * when it holds no trace. What an outbound call - an HTTP request, an AMQP
 * publish - sends so the far side joins this trace rather than starting one.
 */
export const traceparentOf = (
  fields: Pick<RequestFields, 'traceId' | 'spanId' | 'traceFlags'>,
): string | undefined => {
  const { traceId, spanId } = fields;
  if (traceId === undefined || spanId === undefined) return undefined;
  return formatTraceparent({
    traceId,
    spanId,
    flags: fields.traceFlags ?? DEFAULT_TRACE_FLAGS,
  });
};
