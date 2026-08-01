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

/**
 * `new URL(req.url)` parses the scheme, host, port, query and hash to reach one
 * string. This slices it out instead, which is what every request needs and all
 * that most of them need.
 */
const pathnameOf = (url: string): string => {
  const start = url.indexOf('/', url.indexOf('://') + 3);
  if (start === -1) return '/';
  const end = url.indexOf('?', start);
  return end === -1 ? url.slice(start) : url.slice(start, end);
};

const queryOf = (url: string): Record<string, string> | undefined => {
  const start = url.indexOf('?');
  if (start === -1) return undefined;
  return Object.fromEntries(new URLSearchParams(url.slice(start + 1)));
};

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
    const path = pathnameOf(req.url);
    if (this.#ignore.has(path)) return next();

    const started = Bun.nanoseconds();
    const elapsed = (): number =>
      Math.round((Bun.nanoseconds() - started) / 1e6);
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
      async () => {
        const query = queryOf(req.url);
        const request = {
          ...(query === undefined ? {} : { query }),
          ...(await this.#body(req)),
          userAgent: req.headers.get('user-agent'),
        };

        try {
          const response = await next();
          this.logger.info(`${req.method} ${path} ${response.status}`, {
            request,
            statusCode: response.status,
            ...(await this.#responseFields(response)),
            elapsedMs: elapsed(),
          });
          response.headers.set(REQUEST_ID_HEADER, requestId);
          return response;
        } catch (error) {
          // Logged and rethrown: the error mapper still owns the status and the
          // response shape. A 404 or a rejected body is the caller's fault, and
          // logging every probe at `error` would drown the ones that matter.
          const status =
            error instanceof HttpError
              ? error.status
              : HttpStatusCode.INTERNAL_SERVER_ERROR;
          const entry = {
            request,
            err: error,
            statusCode: status,
            elapsedMs: elapsed(),
          };
          const line = `${req.method} ${path} ${status}`;
          if (status < HttpStatusCode.INTERNAL_SERVER_ERROR) {
            this.logger.warn(line, entry);
          } else {
            this.logger.error(line, entry);
          }
          throw error;
        }
      },
    );
  }

  /** Clones, so the handler's own stream is never the one that was consumed. */
  async #body(req: BunRequest): Promise<{ body?: unknown }> {
    if (!this.#requestBody) return {};
    if (req.method === 'GET' || req.method === 'HEAD') return {};
    if (!(req.headers.get('content-type') ?? '').includes('application/json')) {
      return {};
    }
    const body = parse(await req.clone().text(), this.#limit);
    return body === undefined ? {} : { body };
  }

  async #responseFields(
    response: Response,
  ): Promise<{ responseBody?: unknown }> {
    if (!this.#responseBody) return {};
    if (
      !(response.headers.get('content-type') ?? '').includes('application/json')
    ) {
      return {};
    }
    const body = parse(await response.clone().text(), this.#limit);
    return body === undefined ? {} : { responseBody: body };
  }
}
