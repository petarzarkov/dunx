import {
  Logger,
  RequestContext,
  type RequestFields as ScopeFields,
} from '@dunx/core';
import type { BunRequest } from 'bun';
import type { RouteContext } from './context.js';
import { HttpError } from './errors.js';
import type { Middleware, Next } from './middleware.js';
import { RawBody } from './raw-body.js';
import { REQUEST_ID_HEADER, RequestIds } from './request-id.js';
import { TraceContext } from './trace-context.js';
import { HttpStatusCode } from './status.js';

export interface RequestLoggingOptions {
  /** Bodies past this many characters are logged as a size. Default 2048. `0` omits them. */
  readonly maxBodyLength?: number;
  /**
   * Log the request body. Default `false`, and the cost depends on whether the
   * route declares a `body` schema: +1.9 us when it does, +28.8 us when it does
   * not, because the logger has to `req.clone()` an unread network stream.
   *
   * It is the field most likely to contain a password.
   */
  readonly requestBody?: boolean;
  /** Log the response body. Default `false`, +2.6 us. A response is already a
   * materialised string by the time this clones it. */
  readonly responseBody?: boolean;
  /**
   * Paths to skip entirely: no entry, no `x-request-id`, and no
   * `AsyncLocalStorage` scope, so anything the handler logs is uncorrelated.
   * `correlateIgnored` buys the correlation back.
   */
  readonly ignore?: readonly string[];
  /**
   * Path prefixes to skip, for a whole mount rather than one path. `ignore` is an
   * exact-match `Set`; this is a loop, so keep the list short. Scanned only when
   * non-empty.
   *
   * ```ts
   * requestLogging: { ignorePrefix: ['/_dunx'] }
   * ```
   */
  readonly ignorePrefix?: readonly string[];
  /**
   * Keep the request id and the async scope on an `ignore`d path. Default
   * `false`. The path still writes no entry; it gets an id on the response and
   * everything the handler logs carries it. Costs ~2.2 us of the ~5.4 us the
   * default path spends.
   */
  readonly correlateIgnored?: boolean;
  /**
   * Wrap every request in an `AsyncLocalStorage` scope. Default `true`, +0.91 us.
   * It is what lets a service four frames down log `requestId` without being
   * handed a request. `correlate: false` skips it; this middleware's own entry is
   * unchanged, but every other line the request writes loses its id.
   */
  readonly correlate?: boolean;
  /**
   * Put `x-request-id` on the response. Default `true`, and ~500 ns of the 4.7 us
   * the path costs, which is the largest thing here that can go without losing a
   * field from a line.
   *
   * `false` keeps the id on this middleware's own lines and in the async scope,
   * and withholds it from every response including a failure's: the error mapper
   * stamps from what `RequestIds.assign` recorded, and this stops it recording.
   */
  readonly requestIdHeader?: boolean;
  /**
   * Adopt W3C Trace Context, so `traceId`, `spanId` and `parentSpanId` join
   * `requestId`. Default `false`: it costs a header read and 8 random bytes, and
   * `requestId` already spans two dunx services. `@dunx/http/client` sends the
   * adopted trace upstream.
   */
  readonly trace?: boolean;
}

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
  readonly #requestIdHeader: boolean;

  constructor(
    private readonly logger: Logger,
    private readonly context: RequestContext,
    options: RequestLoggingOptions = {},
  ) {
    this.#limit = options.maxBodyLength ?? 2048;
    this.#requestBody = options.requestBody ?? false;
    this.#responseBody = options.responseBody ?? false;
    this.#ignore = new Set(options.ignore ?? []);
    this.#ignorePrefix = options.ignorePrefix ?? [];
    this.#correlateIgnored = options.correlateIgnored ?? false;
    this.#correlate = options.correlate ?? true;
    this.#trace = options.trace ?? false;
    this.#requestIdHeader = options.requestIdHeader ?? true;
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
      return this.#correlateIgnored
        ? this.#correlated(req, ctx, path, next)
        : next();
    }

    const started = Bun.nanoseconds();
    const requestId = RequestIds.assign(req, this.#requestIdHeader);
    const scope: ScopeFields = {
      requestId,
      method: ctx.method,
      event: path,
      flow: 'http',
      context: `${ctx.controller}.${ctx.handler}`,
    };
    if (this.#trace) {
      const trace = TraceContext.adopt(req, requestId);
      scope.traceId = trace.traceId;
      scope.spanId = trace.spanId;
      if (trace.parentSpanId !== undefined) {
        scope.parentSpanId = trace.parentSpanId;
      }
    }

    // The same five fields either way: into the store under `correlate`, else
    // merged straight onto this entry.
    return this.#correlate
      ? this.context.runWithContext(scope, () =>
          this.#begin(
            req,
            ctx,
            url,
            mark,
            path,
            requestId,
            started,
            next,
            undefined,
          ),
        )
      : this.#begin(req, ctx, url, mark, path, requestId, started, next, scope);
  }

  #begin(
    req: BunRequest,
    ctx: RouteContext,
    url: string,
    mark: number,
    path: string,
    requestId: string,
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
      return this.#dispatch(
        req,
        path,
        requestId,
        started,
        request,
        next,
        scope,
      );
    }
    return body.then((value) => {
      if (value !== undefined) request['body'] = value;
      request['userAgent'] = req.headers.get('user-agent');
      return this.#dispatch(
        req,
        path,
        requestId,
        started,
        request,
        next,
        scope,
      );
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
   * An ignored path under `correlateIgnored`: the scope and the response header,
   * no entry, nothing timed. Under `correlate: false` only the header is left.
   */
  #correlated(
    req: BunRequest,
    ctx: RouteContext,
    path: string,
    next: Next,
  ): Promise<Response> {
    const requestId = RequestIds.assign(req, this.#requestIdHeader);
    const stamp = (response: Response): Response => {
      if (this.#requestIdHeader) {
        response.headers.set(REQUEST_ID_HEADER, requestId);
      }
      return response;
    };
    if (!this.#correlate) return next().then(stamp);
    return this.context.runWithContext(
      {
        requestId,
        method: ctx.method,
        event: path,
        flow: 'http',
        context: `${ctx.controller}.${ctx.handler}`,
      },
      () => next().then(stamp),
    );
  }

  #dispatch(
    req: BunRequest,
    path: string,
    requestId: string,
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
      this.#failed(req, path, started, request, error, scope);
      throw error;
    }
    return settled.then(
      (response) =>
        this.#succeeded(
          req,
          path,
          requestId,
          started,
          request,
          response,
          scope,
        ),
      (error: unknown) => {
        this.#failed(req, path, started, request, error, scope);
        throw error;
      },
    );
  }

  /** Logged and rethrown: the error mapper still owns the status and the shape. */
  #failed(
    req: BunRequest,
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
    const line = `${req.method} ${path} ${status}`;
    if (status < HttpStatusCode.INTERNAL_SERVER_ERROR) {
      this.logger.warn(line, entry);
    } else {
      this.logger.error(line, entry);
    }
  }

  #succeeded(
    req: BunRequest,
    path: string,
    requestId: string,
    started: number,
    request: RequestFields,
    response: Response,
    scope: ScopeFields | undefined,
  ): Response | Promise<Response> {
    this.#shared(req, request);
    const body = this.#responseFields(response);
    if (body === undefined) {
      this.logger.info(`${req.method} ${path} ${response.status}`, {
        ...scope,
        request,
        statusCode: response.status,
        elapsedMs: elapsedMs(started),
      });
      if (this.#requestIdHeader) {
        response.headers.set(REQUEST_ID_HEADER, requestId);
      }
      return response;
    }
    return body.then((value) => {
      this.logger.info(`${req.method} ${path} ${response.status}`, {
        ...scope,
        request,
        statusCode: response.status,
        ...(value === undefined ? {} : { responseBody: value }),
        elapsedMs: elapsedMs(started),
      });
      if (this.#requestIdHeader) {
        response.headers.set(REQUEST_ID_HEADER, requestId);
      }
      return response;
    });
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
