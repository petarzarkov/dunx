export const TRACEPARENT_HEADER = 'traceparent';
export const TRACESTATE_HEADER = 'tracestate';
/**
 * The span that answered, sent back so a caller can record which of the callee's
 * spans its own span points at. Same four fields as `traceparent`, and the
 * the one correlation id a response carries.
 *
 * A W3C Distributed Tracing Working Group proposal rather than a ratified
 * standard: `traceparent` and `tracestate` are the Recommendation, and the
 * published Trace Context Level 2 Candidate Recommendation Draft covers those two
 * request headers and not this response one. The format is specified and stable,
 * and adoption is thin, so treat a caller reading it as a bonus.
 */
export const TRACERESPONSE_HEADER = 'traceresponse';

const HEX_32 = /^[0-9a-f]{32}$/;
const HEX_16 = /^[0-9a-f]{16}$/;
const HEX_2 = /^[0-9a-f]{2}$/;
const ZERO_TRACE = '0'.repeat(32);
const ZERO_SPAN = '0'.repeat(16);

/** The sampled bit, which is the only flag the standard currently defines. */
const SAMPLED = 0x01;

/** What a request that started its own trace sends on, and what `sampled` reads. */
const DEFAULT_FLAGS = '01';

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
  [EXPOSE]?: true;
}

/**
 * Where the trace sits between the middleware that adopted it and anything that
 * reads it back: the error mapper, which builds its `Response` outside the chain.
 * Symbol-keyed on the request, the same channel the socket's gateway runtime and
 * `RawBody` travel on. It stays out of anything that enumerates the object, and a
 * property write measured 9.5 ns against 29 ns for a `WeakMap` entry.
 */
const TRACE: unique symbol = Symbol.for('dunx.http.trace');

/**
 * Whether {@link TraceContext.stamp} may answer for this request. Separate from
 * {@link TRACE} because the trace is read back internally - the metrics exemplar
 * takes its `traceId` from it - so "do not send the header" cannot be expressed
 * by not recording.
 */
const EXPOSE: unique symbol = Symbol.for('dunx.http.trace.expose');

/**
 * `n` random bytes as hex. `Uint8Array.prototype.toHex` is 49.2 ns for a trace id
 * and a span id together, against 260.5 ns for a `crypto.randomUUID()` pair.
 */
const mint = (bytes: number): string =>
  crypto.getRandomValues(new Uint8Array(bytes)).toHex();

/**
 * W3C Trace Context, propagated across services.
 *
 * The whole of it is one header parsed and two written. There is no exporter, no
 * sampler and no dependency: every log line a request writes carries the same
 * `traceId` the service upstream logged, so the two join without either of them
 * running a collector.
 *
 * `traceId`, `spanId` and `parentSpanId` are the OpenTelemetry log data model's
 * own fields, so a collector that ingests these lines correlates them with spans
 * emitted by anything else speaking the standard. Bun 1.4.0 runs OpenTelemetry's
 * Node instrumentation, and a trace adopted here is the trace those spans join.
 *
 * On by default. `requestLogging: { trace: false }` removes it, at which point a
 * request carries no correlation id at all.
 */
export class TraceContext {
  /**
   * The inbound `traceparent`, or a fresh trace. A malformed header is discarded
   * rather than repaired, as the standard requires. Version `ff` is invalid; a
   * higher version keeps its first four fields, so a future format still
   * propagates.
   *
   * A trace that arrived is continued with a span of this server's own, and the
   * caller's sampling decision is kept rather than overridden.
   *
   * `expose: false` adopts the trace without marking it for {@link stamp}, so no
   * `traceresponse` is written - by this middleware or by the error mapper, which
   * builds its own `Response` from what was recorded here. Everything inward is
   * unchanged: the scope, the log lines, the metrics exemplar.
   */
  static adopt(req: Request, expose = true): Trace {
    const inbound = TraceContext.#parse(req.headers.get(TRACEPARENT_HEADER));
    const state = req.headers.get(TRACESTATE_HEADER);
    const trace: Trace =
      inbound === undefined
        ? { traceId: mint(16), spanId: mint(8), flags: DEFAULT_FLAGS }
        : {
            traceId: inbound.traceId,
            spanId: mint(8),
            parentSpanId: inbound.spanId,
            flags: inbound.flags,
            ...(state === null ? {} : { state }),
          };
    (req as Traced)[TRACE] = trace;
    if (expose) (req as Traced)[EXPOSE] = true;
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

  /**
   * The response, carrying `traceresponse` if this request adopted a trace.
   *
   * The logging middleware sets the header on a response it returns, and a
   * failure is never one: the error mapper builds a fresh `Response` outside the
   * chain, so a guard's 401, a validation 400 and every unmatched 404 would go out
   * bare. Read back from the request rather than threaded through the mapper,
   * which an app writes its own of.
   */
  static stamp(response: Response, req: Request): Response {
    const traced = req as Traced;
    const trace = traced[TRACE];
    if (trace !== undefined && traced[EXPOSE] === true) {
      response.headers.set(TRACERESPONSE_HEADER, TraceContext.header(trace));
    }
    return response;
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
