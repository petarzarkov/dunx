import {
  context,
  createTraceState,
  ROOT_CONTEXT,
  SpanKind as OtelSpanKind,
  SpanStatusCode,
  trace,
  type Context,
  type Span,
  type SpanOptions as OtelSpanOptions,
} from '@opentelemetry/api';
import type { TraceIds } from '../logger/traceparent.js';
import {
  ActiveSpan,
  Tracer,
  type SpanAttributeValue,
  type SpanKind,
  type SpanOptions,
} from '../tracing/tracer.js';

const KINDS: Readonly<Record<SpanKind, OtelSpanKind>> = {
  server: OtelSpanKind.SERVER,
  client: OtelSpanKind.CLIENT,
  producer: OtelSpanKind.PRODUCER,
  consumer: OtelSpanKind.CONSUMER,
  internal: OtelSpanKind.INTERNAL,
};

class OtelSpan extends ActiveSpan {
  constructor(readonly span: Span) {
    super();
  }

  override setAttribute(key: string, value: SpanAttributeValue): void {
    this.span.setAttribute(key, value);
  }

  override recordError(error: unknown): void {
    if (error instanceof Error) this.span.recordException(error);
    this.span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  override ids(): TraceIds | undefined {
    if (!this.span.isRecording()) return undefined;
    const { traceId, spanId, traceFlags } = this.span.spanContext();
    return { traceId, spanId, flags: traceFlags.toString(16).padStart(2, '0') };
  }
}

/**
 * {@link Tracer} on `@opentelemetry/api`. It starts spans and never configures
 * where they go: the app registers its own SDK, and until it does every span is
 * the API's non-recording one, so dunx keeps the ids it mints itself.
 *
 * The API is a peer rather than a dependency because two copies share one global
 * only one way: a provider registered through 1.8 drops spans started through 1.9.
 */
export class OtelTracer extends Tracer {
  readonly #tracer = trace.getTracer('@dunx/core');

  override span<T>(
    name: string,
    options: SpanOptions,
    fn: (span: ActiveSpan) => T,
  ): T {
    const parent = this.#parent(options);
    const started: OtelSpanOptions = {
      kind: KINDS[options.kind ?? 'internal'],
    };
    if (options.attributes !== undefined) {
      started.attributes = options.attributes;
    }
    if (options.startTime !== undefined) started.startTime = options.startTime;
    const span = this.#tracer.startSpan(name, started, parent);
    const active = new OtelSpan(span);
    const failed = (error: unknown): never => {
      active.recordError(error);
      span.end();
      throw error;
    };

    return context.with(trace.setSpan(parent, span), () => {
      let result: T;
      try {
        result = fn(active);
      } catch (error) {
        return failed(error);
      }
      if (!(result instanceof Promise)) {
        span.end();
        return result;
      }
      return result.then((value: unknown) => {
        span.end();
        return value;
      }, failed) as T;
    });
  }

  /** A remote parent starts from the root, so nothing active leaks into it. */
  #parent(options: SpanOptions): Context {
    const remote = options.parent;
    if (remote === undefined) return context.active();
    return trace.setSpanContext(ROOT_CONTEXT, {
      traceId: remote.traceId,
      spanId: remote.spanId,
      traceFlags: Number.parseInt(remote.flags, 16),
      isRemote: true,
      ...(remote.state === undefined
        ? {}
        : { traceState: createTraceState(remote.state) }),
    });
  }
}
