import {
  Logger,
  NoopTracer,
  RequestContext,
  Tracer,
  type RequestFields as ScopeFields,
} from '@dunx/core';
import type { BunRequest } from 'bun';
import type { RouteContext } from './context.js';
import { HttpError } from './errors.js';
import type { Middleware, Next } from './middleware.js';
import type { RequestMetrics } from './metrics.js';
import { RawBody } from './raw-body.js';
import { serveInSpan } from './server-span.js';
import { TraceContext, type Trace } from './trace-context.js';
import { HttpStatusCode } from './status.js';
import type { RequestLoggingOptions } from './request-logging-options.js';

const parse = (text: string, limit: number): unknown => {
  if (limit === 0) return undefined;
  if (text.length === 0) return undefined;
  if (text.length > limit) return `[${text.length} bytes]`;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/** Written into the scope, from the adopted trace or the span that joined it. */
const traced = (scope: ScopeFields, trace: Trace): ScopeFields => {
  scope.traceId = trace.traceId;
  scope.spanId = trace.spanId;
  scope.traceFlags = trace.flags;
  if (trace.parentSpanId !== undefined) scope.parentSpanId = trace.parentSpanId;
  if (trace.state !== undefined) scope.traceState = trace.state;
  return scope;
};

const elapsedMs = (started: number): number =>
  Math.round((Bun.nanoseconds() - started) / 1e6);

/** What the entry's `request` field carries, built in the order it is logged. */
type RequestFields = Record<string, unknown>;

/**
 * One structured entry per request, carrying the request and its response.
 * Installed by `HttpFactory.create` unless `requestLogging: false`, and injecting
 * only core contracts, so it works with no logging module imported.
 *
 * One entry rather than a middleware and an interceptor to correlate: middleware
 * wraps `next()`, so both halves are the same closure. A 4xx logs at `warn`, a
 * 5xx at `error`.
 *
 * Nothing here is `async`. The two steps that can wait are off by default and
 * adopted with `.then`; an `async` scope callback alone cost 0.44 us/request.
 */
export class RequestLoggingMiddleware implements Middleware {
  readonly #limit: number;
  readonly #requestBody: boolean;
  readonly #responseBody: boolean;
  readonly #ignore: ReadonlySet<string>;
  readonly #ignorePrefix: readonly string[];
  readonly #correlateIgnored: boolean;
  readonly #correlate: boolean;
  readonly #trace: boolean;
  readonly #traceResponse: boolean;

  /**
   * Present only under `metrics: true`. The observation folds into the `.then`
   * this already allocates and reuses the `started` mark it already holds, which
   * is what makes it 35.2 ns rather than the 175.9 ns a middleware of its own
   * costs. `elapsedMs` cannot be the shared value: it rounds to milliseconds, so
   * every sub-millisecond request would record a 0 the histogram rejects.
   */
  readonly #metrics: RequestMetrics | undefined;

  /**
   * One SERVER span wherever a trace is adopted, so `ignore` without
   * `correlateIgnored`, `trace: false` and `requestLogging: false` open none.
   * Absent for the default `NoopTracer`, which leaves the path as it was.
   */
  readonly #tracer: Tracer | undefined;

  constructor(
    private readonly logger: Logger,
    private readonly context: RequestContext,
    options: RequestLoggingOptions = {},
    metrics?: RequestMetrics,
    tracer?: Tracer,
  ) {
    this.#limit = options.maxBodyLength ?? 2048;
    this.#requestBody = options.requestBody ?? false;
    this.#responseBody = options.responseBody ?? false;
    this.#ignore = new Set(options.ignore ?? []);
    this.#ignorePrefix = options.ignorePrefix ?? [];
    this.#correlateIgnored = options.correlateIgnored ?? false;
    this.#correlate = options.correlate ?? true;
    this.#trace = options.trace ?? true;
    this.#traceResponse = options.traceResponse ?? true;
    this.#metrics = metrics;
    this.#tracer = tracer instanceof NoopTracer ? undefined : tracer;
  }

  /** Both guards check emptiness first, so configuring neither costs two reads. */
  #ignored(path: string): boolean {
    if (this.#ignore.size > 0 && this.#ignore.has(path)) return true;
    if (this.#ignorePrefix.length === 0) return false;
    return this.#ignorePrefix.some((prefix) => path.startsWith(prefix));
  }

  handle(req: BunRequest, ctx: RouteContext, next: Next): Promise<Response> {
    // `new URL(req.url)` parses scheme, host, port, query and hash to reach one
    // string. This finds the same two offsets once and slices both out.
    const url = req.url;
    const from = url.indexOf('/', url.indexOf('://') + 3);
    const mark = from === -1 ? -1 : url.indexOf('?', from);
    const path =
      from === -1 ? '/' : mark === -1 ? url.slice(from) : url.slice(from, mark);
    if (this.#ignored(path)) {
      // `ignore` is about log volume, not about counting. A health check polled
      // every second is the clearest case of something worth a metric and not
      // worth an entry, so metrics are observed here even though nothing is
      // logged. Costs two `Bun.nanoseconds()` reads, and only under `metrics`.
      if (this.#metrics !== undefined) {
        return this.#ignoredWithMetrics(req, ctx, path, next);
      }
      return this.#correlateIgnored
        ? this.#correlated(req, ctx, path, next)
        : next();
    }

    const started = Bun.nanoseconds();
    const scope: ScopeFields = {
      method: ctx.method,
      event: path,
      flow: 'http',
      context: `${ctx.controller}.${ctx.handler}`,
    };
    if (!this.#trace) {
      return this.#enter(req, ctx, url, mark, path, started, next, scope);
    }
    const trace = TraceContext.adopt(req, this.#traceResponse);
    if (this.#tracer === undefined) {
      return this.#enter(
        req,
        ctx,
        url,
        mark,
        path,
        started,
        next,
        traced(scope, trace),
      );
    }
    return serveInSpan(this.#tracer, req, ctx, path, trace, (current) =>
      this.#enter(
        req,
        ctx,
        url,
        mark,
        path,
        started,
        next,
        traced(scope, current),
      ),
    );
  }

  /**
   * The same fields either way: into the store under `correlate`, else merged
   * straight onto this entry.
   */
  #enter(
    req: BunRequest,
    ctx: RouteContext,
    url: string,
    mark: number,
    path: string,
    started: number,
    next: Next,
    scope: ScopeFields,
  ): Promise<Response> {
    return this.#correlate
      ? this.context.runWithContext(scope, () =>
          this.#begin(req, ctx, url, mark, path, started, next, undefined),
        )
      : this.#begin(req, ctx, url, mark, path, started, next, scope);
  }

  #begin(
    req: BunRequest,
    ctx: RouteContext,
    url: string,
    mark: number,
    path: string,
    started: number,
    next: Next,
    scope: ScopeFields | undefined,
  ): Promise<Response> {
    const request: RequestFields = {};
    if (mark !== -1) {
      request['query'] = Object.fromEntries(
        new URLSearchParams(url.slice(mark + 1)),
      );
    }
    const body = this.#body(req, ctx);
    if (body === undefined) {
      request['userAgent'] = req.headers.get('user-agent');
      return this.#dispatch(req, ctx, path, started, request, next, scope);
    }
    return body.then((value) => {
      if (value !== undefined) request['body'] = value;
      request['userAgent'] = req.headers.get('user-agent');
      return this.#dispatch(req, ctx, path, started, request, next, scope);
    });
  }

  /**
   * The body text the reader buffered, parsed at log time rather than before the
   * handler. Same `parse` as the clone path, so the cap and the `[N bytes]` form
   * are unchanged.
   */
  #shared(req: BunRequest, request: RequestFields): void {
    if (!this.#requestBody) return;
    if (request['body'] !== undefined) return;
    const text = RawBody.read(req);
    if (text === undefined) return;
    const value = parse(text, this.#limit);
    if (value !== undefined) request['body'] = value;
  }

  /**
   * An ignored path under `metrics`. Both settlements are observed with the same
   * status mapping `#failed` uses, so an ignored route that throws is counted
   * rather than silently missing: with request logging on, `MetricsMiddleware` is
   * not installed and nothing else would see it.
   */
  #ignoredWithMetrics(
    req: BunRequest,
    ctx: RouteContext,
    path: string,
    next: Next,
  ): Promise<Response> {
    const started = Bun.nanoseconds();
    const failed = (error: unknown): never => {
      this.#observe(
        req,
        ctx,
        error instanceof HttpError
          ? error.status
          : HttpStatusCode.INTERNAL_SERVER_ERROR,
        started,
      );
      throw error;
    };

    let settled: Promise<Response>;
    try {
      settled = this.#correlateIgnored
        ? this.#correlated(req, ctx, path, next)
        : next();
    } catch (error) {
      // A user middleware ahead of the route may throw out of `handle`
      // synchronously, which never reaches the rejection handler below.
      return failed(error);
    }
    return settled.then((response) => {
      this.#observe(req, ctx, response.status, started);
      return response;
    }, failed);
  }

  /**
   * An ignored path under `correlateIgnored`: the scope and the response header,
   * no entry, nothing timed. Under `correlate: false` only the header is left.
   */
  #correlated(
    req: BunRequest,
    ctx: RouteContext,
    path: string,
    next: Next,
  ): Promise<Response> {
    if (!this.#trace) {
      return this.#correlate
        ? this.context.runWithContext(this.#scope(ctx, path), () => next())
        : next();
    }
    const trace = TraceContext.adopt(req, this.#traceResponse);
    return this.#tracer === undefined
      ? this.#stamped(req, ctx, path, trace, next)
      : serveInSpan(this.#tracer, req, ctx, path, trace, (current) =>
          this.#stamped(req, ctx, path, current, next),
        );
  }

  /**
   * `stamp` reads the mark `adopt` left, so `traceResponse: false` needs no
   * condition here or in the error mapper.
   */
  #stamped(
    req: BunRequest,
    ctx: RouteContext,
    path: string,
    trace: Trace,
    next: Next,
  ): Promise<Response> {
    const stamp = (response: Response): Response =>
      TraceContext.stamp(response, req);
    if (!this.#correlate) return next().then(stamp);
    return this.context.runWithContext(
      traced(this.#scope(ctx, path), trace),
      () => next().then(stamp),
    );
  }

  #scope(ctx: RouteContext, path: string): ScopeFields {
    return {
      method: ctx.method,
      event: path,
      flow: 'http',
      context: `${ctx.controller}.${ctx.handler}`,
    };
  }

  #dispatch(
    req: BunRequest,
    ctx: RouteContext,
    path: string,
    started: number,
    request: RequestFields,
    next: Next,
    scope: ScopeFields | undefined,
  ): Promise<Response> {
    // A user middleware ahead of the route may throw out of `handle`
    // synchronously, and that request is still one this promised to log.
    let settled: Promise<Response>;
    try {
      settled = next();
    } catch (error) {
      this.#failed(req, ctx, path, started, request, error, scope);
      throw error;
    }
    return settled.then(
      (response) =>
        this.#succeeded(req, ctx, path, started, request, response, scope),
      (error: unknown) => {
        this.#failed(req, ctx, path, started, request, error, scope);
        throw error;
      },
    );
  }

  /** Logged and rethrown: the error mapper still owns the status and the shape. */
  #failed(
    req: BunRequest,
    ctx: RouteContext,
    path: string,
    started: number,
    request: RequestFields,
    error: unknown,
    scope: ScopeFields | undefined,
  ): void {
    this.#shared(req, request);
    const status =
      error instanceof HttpError
        ? error.status
        : HttpStatusCode.INTERNAL_SERVER_ERROR;
    const entry = {
      ...scope,
      request,
      err: error,
      statusCode: status,
      elapsedMs: elapsedMs(started),
    };
    this.#observe(req, ctx, status, started);
    const line = `${req.method} ${path} ${status}`;
    if (status < HttpStatusCode.INTERNAL_SERVER_ERROR) {
      this.logger.warn(line, entry);
    } else {
      this.logger.error(line, entry);
    }
  }

  #succeeded(
    req: BunRequest,
    ctx: RouteContext,
    path: string,
    started: number,
    request: RequestFields,
    response: Response,
    scope: ScopeFields | undefined,
  ): Response | Promise<Response> {
    this.#shared(req, request);
    this.#observe(req, ctx, response.status, started);
    const body = this.#responseFields(response);
    if (body === undefined) {
      this.logger.info(`${req.method} ${path} ${response.status}`, {
        ...scope,
        request,
        statusCode: response.status,
        elapsedMs: elapsedMs(started),
      });
      return TraceContext.stamp(response, req);
    }
    return body.then((value) => {
      this.logger.info(`${req.method} ${path} ${response.status}`, {
        ...scope,
        request,
        statusCode: response.status,
        ...(value === undefined ? {} : { responseBody: value }),
        elapsedMs: elapsedMs(started),
      });
      return TraceContext.stamp(response, req);
    });
  }

  /**
   * The exemplar's trace is read back off the request, not out of the store:
   * `getContext()` spreads into a fresh object, which is not a thing to do per
   * request for one field. A symbol property read is 9.5 ns.
   */
  #observe(
    req: BunRequest,
    ctx: RouteContext,
    status: number,
    started: number,
  ): void {
    if (this.#metrics === undefined) return;
    this.#metrics.observe(
      ctx,
      status,
      Bun.nanoseconds() - started,
      TraceContext.of(req)?.traceId,
    );
  }

  /**
   * `undefined` means nothing to read here: either the body is not logged, or it
   * comes from `RawBody`. Either way the caller stays synchronous. When it does
   * clone it clones - reading `req` directly makes the handler's `req.json()`
   * throw `Body already used`.
   */
  #body(req: BunRequest, ctx: RouteContext): Promise<unknown> | undefined {
    if (!this.#requestBody) return undefined;
    if (req.method === 'GET' || req.method === 'HEAD') return undefined;
    if (!(req.headers.get('content-type') ?? '').includes('application/json')) {
      return undefined;
    }
    // The route declares a body schema, so the reader buffers it anyway: +0.38 us
    // instead of a ~20 us clone. `raw-body.ts` has the numbers.
    if (ctx.parsesBody) {
      RawBody.want(req);
      return undefined;
    }
    return req
      .clone()
      .text()
      .then((text) => parse(text, this.#limit));
  }

  #responseFields(response: Response): Promise<unknown> | undefined {
    if (!this.#responseBody) return undefined;
    if (
      !(response.headers.get('content-type') ?? '').includes('application/json')
    ) {
      return undefined;
    }
    return response
      .clone()
      .text()
      .then((text) => parse(text, this.#limit));
  }
}
