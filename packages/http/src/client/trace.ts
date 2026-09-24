import type { ActiveSpan, RequestFields, TraceIds, Tracer } from '@dunx/core';
import {
  TRACEPARENT_HEADER,
  TRACESTATE_HEADER,
  TraceContext,
} from '../server/trace-context.js';

/**
 * One CLIENT span per attempt, since a resend is a request of its own, named by
 * method alone because a url carries ids. Without a tracer `run` is called bare.
 */
export const clientSpan = <T>(
  tracer: Tracer | undefined,
  method: string,
  url: URL,
  run: (span?: ActiveSpan) => Promise<T>,
): Promise<T> => {
  if (tracer === undefined) return run();
  return tracer.span(
    method,
    {
      kind: 'client',
      attributes: {
        'http.request.method': method,
        'url.full': url.href,
        'server.address': url.hostname,
        'server.port':
          Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
      },
    },
    run,
  );
};

/**
 * `traceparent` and `tracestate` for the trace in `stored`, or nothing when it
 * holds none. A recording client span replaces the ids, so the callee's span
 * is its child; `tracestate` is the store's either way.
 */
export const traceHeaders = (
  stored: RequestFields,
  span: TraceIds | undefined,
): Record<string, string> => {
  const traceId = span?.traceId ?? stored.traceId;
  const spanId = span?.spanId ?? stored.spanId;
  if (typeof traceId !== 'string' || typeof spanId !== 'string') return {};
  return {
    [TRACEPARENT_HEADER]: TraceContext.header({
      traceId,
      spanId,
      // The inbound decision, not a fresh one. `traceFlags` is absent only if
      // something wrote a trace into the store by hand.
      flags:
        span?.flags ??
        (typeof stored.traceFlags === 'string' ? stored.traceFlags : '01'),
    }),
    // Forwarded unchanged alongside it, which the standard requires of a
    // participant: this service does not read the vendor data, and dropping it
    // would strip whatever an upstream put there.
    ...(typeof stored.traceState === 'string'
      ? { [TRACESTATE_HEADER]: stored.traceState }
      : {}),
  };
};
