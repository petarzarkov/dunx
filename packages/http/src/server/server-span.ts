import type { ActiveSpan, SpanOptions, Tracer } from '@dunx/core';
import type { BunRequest } from 'bun';
import { UNMATCHED } from '../route/metadata.js';
import type { RouteContext } from './context.js';
import { HttpError } from './errors.js';
import { HttpStatusCode } from './status.js';
import { TraceContext, type Trace } from './trace-context.js';

/** A rejection carried through the span as a value, so the span alone decides its status. */
class Failed {
  constructor(readonly error: unknown) {}
}

const unwrap = (outcome: Response | Failed): Response => {
  if (outcome instanceof Failed) throw outcome.error;
  return outcome;
};

const settle = (span: ActiveSpan, status: number, error: unknown): void => {
  span.setAttribute('http.response.status_code', status);
  if (status >= HttpStatusCode.INTERNAL_SERVER_ERROR) span.recordError(error);
};

/**
 * One SERVER span around `run`, parented to the inbound `traceparent` and named
 * by route template rather than path, which would give every id its own name.
 * When an SDK records it, `run` gets the trace with the span's ids, so the scope,
 * the log line and `traceresponse` all name the exported span.
 *
 * A 4xx leaves the status unset, as the HTTP semantic conventions ask of a
 * server. A rejection reaching `Tracer.span` would be recorded as an error
 * whatever its status, so the failure crosses the span as a value.
 */
export const serveInSpan = (
  tracer: Tracer,
  req: BunRequest,
  ctx: RouteContext,
  path: string,
  trace: Trace,
  run: (trace: Trace) => Promise<Response>,
): Promise<Response> => {
  const unmatched = ctx.get(UNMATCHED) === true;
  const parent = TraceContext.parentOf(trace);
  const options: SpanOptions = {
    kind: 'server',
    attributes: unmatched
      ? { 'http.request.method': req.method, 'url.path': path }
      : {
          'http.request.method': req.method,
          'url.path': path,
          'http.route': ctx.path,
        },
    ...(parent === undefined ? {} : { parent }),
  };
  const name = unmatched ? req.method : `${req.method} ${ctx.path}`;

  return tracer
    .span(name, options, (span): Promise<Response | Failed> => {
      const ids = span.ids();
      const failed = (error: unknown): Failed => {
        settle(
          span,
          error instanceof HttpError
            ? error.status
            : HttpStatusCode.INTERNAL_SERVER_ERROR,
          error,
        );
        return new Failed(error);
      };
      let settled: Promise<Response>;
      try {
        settled = run(
          ids === undefined ? trace : TraceContext.join(req, trace, ids),
        );
      } catch (error) {
        return Promise.resolve(failed(error));
      }
      return settled.then((response) => {
        settle(span, response.status, `HTTP ${response.status}`);
        return response;
      }, failed);
    })
    .then(unwrap);
};
