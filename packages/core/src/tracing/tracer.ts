import type { TraceIds } from '../logger/traceparent.js';

/** OpenTelemetry's span kinds, as strings: oxlint bans `enum`. */
export type SpanKind =
  | 'server'
  | 'client'
  | 'producer'
  | 'consumer'
  | 'internal';

export type SpanAttributeValue = string | number | boolean;

export type SpanAttributes = Readonly<Record<string, SpanAttributeValue>>;

/** A caller's span, read off an inbound `traceparent`, job or message header. */
export interface RemoteParent extends TraceIds {
  /** `tracestate` verbatim. */
  readonly state?: string;
}

export interface SpanOptions {
  /** Default `'internal'`. */
  readonly kind?: SpanKind;
  /** Set at start, which is when a sampler reads them. */
  readonly attributes?: SpanAttributes;
  /** Replaces whatever span is active as this one's parent. */
  readonly parent?: RemoteParent;
}

/** The span a {@link Tracer.span} callback runs inside. */
export abstract class ActiveSpan {
  abstract setAttribute(key: string, value: SpanAttributeValue): void;
  /** Marks the span ERROR. An `Error` is also recorded as an exception event. */
  abstract recordError(error: unknown): void;
  /**
   * This span's ids while an SDK is recording it, else `undefined`. What a seam
   * writes into `RequestContext`, so log lines join the exported span; when it is
   * `undefined` the seam keeps the ids it minted itself.
   */
  abstract ids(): TraceIds | undefined;
}

/**
 * The third always-bound contract, next to `Logger` and `RequestContext`. Every
 * dunx seam that does work worth a span (a request served, a call made, a query,
 * a job) opens one through this, so binding an implementation is the whole of
 * turning tracing on. `@dunx/core/otel` is the one that ships.
 *
 * ```ts
 * class Payments {
 *   constructor(private readonly tracer: Tracer) {}
 *   charge(order: Order) {
 *     return this.tracer.span('charge', {}, () => this.gateway.charge(order));
 *   }
 * }
 * ```
 */
export abstract class Tracer {
  /**
   * Runs `fn` inside a new span, active for its whole async tree, and ends it
   * when `fn` returns or its promise settles. A throw or rejection is recorded
   * with {@link ActiveSpan.recordError} and passed on.
   */
  abstract span<T>(
    name: string,
    options: SpanOptions,
    fn: (span: ActiveSpan) => T,
  ): T;
}

class NoopSpan extends ActiveSpan {
  override setAttribute(): void {
    // Nothing is recording.
  }
  override recordError(): void {
    // Nothing is recording.
  }
  override ids(): undefined {
    return undefined;
  }
}

const NOOP_SPAN = new NoopSpan();

/**
 * The default binding. A seam on a hot path checks `instanceof NoopTracer` once,
 * at construction, and then skips building span options at all: a new seam
 * measured 1.26 us a request, and tracing stays opt-in.
 */
export class NoopTracer extends Tracer {
  override span<T>(
    _name: string,
    _options: SpanOptions,
    fn: (span: ActiveSpan) => T,
  ): T {
    return fn(NOOP_SPAN);
  }
}
