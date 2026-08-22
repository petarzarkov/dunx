export const TRACEPARENT_HEADER = 'traceparent';
export const TRACESTATE_HEADER = 'tracestate';

const HEX_32 = /^[0-9a-f]{32}$/;
const HEX_16 = /^[0-9a-f]{16}$/;
const HEX_2 = /^[0-9a-f]{2}$/;
const ZERO_TRACE = '0'.repeat(32);
const ZERO_SPAN = '0'.repeat(16);

/** The sampled bit, which is the only flag the standard currently defines. */
const SAMPLED = 0x01;

export interface Trace {
  /** 32 hex digits, shared by every span in the trace. */
  readonly traceId: string;
  /** 16 hex digits identifying this server's work on this request. */
  readonly spanId: string;
  /** The caller's span, when one arrived in `traceparent`. */
  readonly parentSpanId?: string;
  /** Two hex digits. Bit 0 is `sampled`. */
  readonly flags: string;
  /** `tracestate` verbatim, when one arrived. Vendor data this server does not read. */
  readonly state?: string;
}

interface Traced {
  [TRACE]?: Trace;
}

/**
 * Where the trace sits between the middleware that adopted it and anything that
 * reads it back. Symbol-keyed on the request, the same channel `RequestIds` uses
 * and for the same reasons.
 */
const TRACE: unique symbol = Symbol.for('dunx.http.trace');

/** 8 random bytes as 16 hex digits, which is what a span id is. */
const mintSpanId = (): string =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString('hex');

/**
 * W3C Trace Context, propagated across services.
 *
 * The whole of it is one header parsed and one header written. There is no
 * exporter, no sampler and no dependency: what this buys is that every log line a
 * request writes carries the same `traceId` the service upstream logged, so the
 * two can be joined without either of them running a collector.
 *
 * `@dunx/http` does not turn this on by itself - `requestLogging: { trace: true }`
 * does. Adopting a trace costs a header read and 8 random bytes on every request,
 * which is not worth spending in a service that has nothing to correlate with.
 */
export class TraceContext {
  /**
   * The inbound `traceparent`, or a fresh trace.
   *
   * A malformed header is discarded rather than repaired, which is what the
   * standard requires: an unparseable `traceparent` means the caller's trace is
   * unknown, not that this request has none. Version `ff` is invalid, and a
   * higher version keeps its first four fields and drops the rest, so a future
   * format still propagates through this service instead of being dropped.
   *
   * When nothing arrives, `traceId` is the request id with its hyphens removed -
   * a UUID is 16 bytes, which is exactly a trace id, and reusing it means one
   * identifier in two spellings rather than a second `crypto` call per request.
   */
  static adopt(req: Request, requestId: string): Trace {
    const inbound = TraceContext.#parse(req.headers.get(TRACEPARENT_HEADER));
    const state = req.headers.get(TRACESTATE_HEADER);
    const trace: Trace = {
      traceId: inbound?.traceId ?? requestId.replaceAll('-', ''),
      spanId: mintSpanId(),
      ...(inbound === undefined ? {} : { parentSpanId: inbound.spanId }),
      flags: inbound?.flags ?? '01',
      ...(inbound !== undefined && state !== null ? { state } : {}),
    };
    (req as Traced)[TRACE] = trace;
    return trace;
  }

  /** The trace adopted for this request, if one was. */
  static of(req: Request): Trace | undefined {
    return (req as Traced)[TRACE];
  }

  /**
   * The `traceparent` to send upstream. This server's span becomes the callee's
   * parent, so the two link without inventing a span nothing logged.
   */
  static header(trace: Pick<Trace, 'traceId' | 'spanId' | 'flags'>): string {
    return `00-${trace.traceId}-${trace.spanId}-${trace.flags}`;
  }

  static sampled(trace: Pick<Trace, 'flags'>): boolean {
    return (Number.parseInt(trace.flags, 16) & SAMPLED) === SAMPLED;
  }

  static #parse(
    header: string | null,
  ): { traceId: string; spanId: string; flags: string } | undefined {
    if (header === null) return undefined;
    const parts = header.split('-');
    if (parts.length < 4) return undefined;

    const [version, traceId, spanId, flags] = parts as [
      string,
      string,
      string,
      string,
    ];
    // `ff` is reserved as invalid; a version this code does not know keeps the
    // four fields it does know.
    if (!HEX_2.test(version) || version === 'ff') return undefined;
    if (version === '00' && parts.length !== 4) return undefined;
    if (!HEX_32.test(traceId) || traceId === ZERO_TRACE) return undefined;
    if (!HEX_16.test(spanId) || spanId === ZERO_SPAN) return undefined;
    if (!HEX_2.test(flags)) return undefined;

    return { traceId, spanId, flags };
  }
}
