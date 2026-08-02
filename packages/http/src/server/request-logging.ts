import { Logger, RequestContext } from '@dunx/core';
import type { BunRequest } from 'bun';
import type { RouteContext } from './context.js';
import { HttpError } from './errors.js';
import type { Middleware, Next } from './middleware.js';
import { HttpStatusCode } from './status.js';

export const REQUEST_ID_HEADER = 'x-request-id';

export interface RequestLoggingOptions {
  /** Bodies past this many characters are logged as a size. Default 2048. `0` omits them. */
  readonly maxBodyLength?: number;
  /**
   * Log the request body. Default **`false`**.
   *
   * Reading it means `req.clone().text()` — a second copy of every payload,
   * buffered and parsed, on the hot path. Measured on the `validate` scenario in
   * `tools/bench`, turning both body options on costs roughly two thirds of the
   * throughput. It is also the field most likely to contain a password.
   *
   * Turn it on in development, where seeing the payload is the point.
   */
  readonly requestBody?: boolean;
  /** Log the response body. Default **`false`** — same clone-and-buffer cost. */
  readonly responseBody?: boolean;
  /** Paths to skip entirely — a health check polled every second, say. */
  readonly ignore?: readonly string[];
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
 *
 * Installed by `HttpFactory.create` unless `requestLogging: false`. It injects
 * `Logger` and `RequestContext` — both `@dunx/core` contracts, both bound by
 * default — so it works with no logging module imported, and picks up
 * `@arkv/logger` automatically once `@dunx/infra/logger` is.
 *
 * **One entry, not two.** Nest needs a middleware for the inbound half and an
 * interceptor for the outbound one, because they are different classes and the
 * interceptor cannot see what the middleware saw. Here they are the same
 * closure, so there is no pair to correlate by `requestId` to find out how a
 * call ended. A 4xx is the same line at `warn`, a 5xx at `error`.
 *
 * Everything the handler logs in between carries `requestId`, `method`, `event`
 * and `context` without being passed anything, because the whole call runs
 * inside `runWithContext`.
 *
 * **Nothing here is `async`.** Reading the request or the response body are the
 * only steps that can ever wait, both are off by default, and both are adopted
 * with `.then` rather than awaited — the same rule `input.ts` follows, for the
 * same measured reason. An `async` scope callback alone cost 0.44 µs/request
 * against a synchronous one on raw `Bun.serve`.
 */
export class RequestLoggingMiddleware implements Middleware {
  readonly #limit: number;
  readonly #requestBody: boolean;
  readonly #responseBody: boolean;
  readonly #ignore: ReadonlySet<string>;

  constructor(
    private readonly logger: Logger,
    private readonly context: RequestContext,
    options: RequestLoggingOptions = {},
  ) {
    this.#limit = options.maxBodyLength ?? 2048;
    this.#requestBody = options.requestBody ?? false;
    this.#responseBody = options.responseBody ?? false;
    this.#ignore = new Set(options.ignore ?? []);
  }

  handle(req: BunRequest, ctx: RouteContext, next: Next): Promise<Response> {
    // `new URL(req.url)` parses the scheme, host, port, query and hash to reach one
    // string. This finds the same two offsets once and slices both the pathname and
    // the query out of them, which is what every request needs and all that most of
    // them need.
    const url = req.url;
    const from = url.indexOf('/', url.indexOf('://') + 3);
    const mark = from === -1 ? -1 : url.indexOf('?', from);
    const path =
      from === -1 ? '/' : mark === -1 ? url.slice(from) : url.slice(from, mark);
    if (this.#ignore.size > 0 && this.#ignore.has(path)) return next();

    const started = Bun.nanoseconds();
    // An inbound id is honoured so a trace survives across services; otherwise
    // this is where one is minted.
    const requestId = req.headers.get(REQUEST_ID_HEADER) ?? crypto.randomUUID();

    return this.context.runWithContext(
      {
        requestId,
        method: ctx.method,
        event: path,
        flow: 'http',
        context: `${ctx.controller}.${ctx.handler}`,
      },
      () => {
        const request: RequestFields = {};
        if (mark !== -1) {
          request['query'] = Object.fromEntries(
            new URLSearchParams(url.slice(mark + 1)),
          );
        }
        const body = this.#body(req);
        if (body === undefined) {
          request['userAgent'] = req.headers.get('user-agent');
          return this.#dispatch(req, path, requestId, started, request, next);
        }
        return body.then((value) => {
          if (value !== undefined) request['body'] = value;
          request['userAgent'] = req.headers.get('user-agent');
          return this.#dispatch(req, path, requestId, started, request, next);
        });
      },
    );
  }

  #dispatch(
    req: BunRequest,
    path: string,
    requestId: string,
    started: number,
    request: RequestFields,
    next: Next,
  ): Promise<Response> {
    // `next()` is only ever a promise once the chain bottoms out in a route, but a
    // user middleware ahead of the route may throw out of `handle` synchronously,
    // and that request is still one this middleware promised to log.
    let settled: Promise<Response>;
    try {
      settled = next();
    } catch (error) {
      this.#failed(req, path, started, request, error);
      throw error;
    }
    return settled.then(
      (response) =>
        this.#succeeded(req, path, requestId, started, request, response),
      (error: unknown) => {
        this.#failed(req, path, started, request, error);
        throw error;
      },
    );
  }

  /**
   * Logged and rethrown: the error mapper still owns the status and the response
   * shape. A 404 or a rejected body is the caller's fault, and logging every probe
   * at `error` would drown the ones that matter.
   */
  #failed(
    req: BunRequest,
    path: string,
    started: number,
    request: RequestFields,
    error: unknown,
  ): void {
    const status =
      error instanceof HttpError
        ? error.status
        : HttpStatusCode.INTERNAL_SERVER_ERROR;
    const entry = {
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
  ): Response | Promise<Response> {
    const body = this.#responseFields(response);
    if (body === undefined) {
      this.logger.info(`${req.method} ${path} ${response.status}`, {
        request,
        statusCode: response.status,
        elapsedMs: elapsedMs(started),
      });
      response.headers.set(REQUEST_ID_HEADER, requestId);
      return response;
    }
    return body.then((value) => {
      this.logger.info(`${req.method} ${path} ${response.status}`, {
        request,
        statusCode: response.status,
        ...(value === undefined ? {} : { responseBody: value }),
        elapsedMs: elapsedMs(started),
      });
      response.headers.set(REQUEST_ID_HEADER, requestId);
      return response;
    });
  }

  /**
   * `undefined` — the default — means there is nothing to read, and the caller
   * stays on the synchronous path. Clones when there is, so the handler's own
   * stream is never the one that was consumed.
   */
  #body(req: BunRequest): Promise<unknown> | undefined {
    if (!this.#requestBody) return undefined;
    if (req.method === 'GET' || req.method === 'HEAD') return undefined;
    if (!(req.headers.get('content-type') ?? '').includes('application/json')) {
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
