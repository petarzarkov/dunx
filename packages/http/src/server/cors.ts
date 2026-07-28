import type { RouteHandler } from './middleware.js';
import { HttpStatusCode } from './status.js';

export type CorsOrigin =
  | string
  | readonly string[]
  | ((origin: string) => boolean);

export interface CorsOptions {
  /**
   * `'*'` by default. A concrete string, a list, or a predicate all answer with the
   * caller's own origin only when it is allowed — a request from anywhere else gets
   * no CORS headers at all, which is what makes the browser block it.
   */
  readonly origin?: CorsOrigin;
  /** Defaults to the methods actually declared on the path. */
  readonly methods?: readonly string[];
  /** Echoes `Access-Control-Request-Headers` when omitted. */
  readonly allowedHeaders?: readonly string[];
  readonly exposedHeaders?: readonly string[];
  readonly credentials?: boolean;
  /** Seconds a browser may cache the preflight for. */
  readonly maxAge?: number;
}

const ORIGIN = 'access-control-allow-origin';

/**
 * `*` is illegal alongside credentials — a browser rejects the pair — so a
 * credentialed wildcard reflects the caller instead.
 */
const allowedOrigin = (
  options: CorsOptions,
  requested: string | null,
): string | undefined => {
  const origin = options.origin ?? '*';

  if (typeof origin === 'string') {
    if (origin !== '*') return origin === requested ? origin : undefined;
    if (!options.credentials) return '*';
    return requested ?? undefined;
  }
  if (requested === null) return undefined;

  const allowed =
    typeof origin === 'function'
      ? origin(requested)
      : origin.includes(requested);
  return allowed ? requested : undefined;
};

const applyCors = (
  options: CorsOptions,
  req: Request,
  response: Response,
): Response => {
  const origin = allowedOrigin(options, req.headers.get('origin'));
  if (origin === undefined) return response;

  response.headers.set(ORIGIN, origin);
  // The response body varies by request origin unless every origin gets the same
  // wildcard, so a shared cache must not serve one origin's copy to another.
  if (origin !== '*') response.headers.append('vary', 'Origin');
  if (options.credentials) {
    response.headers.set('access-control-allow-credentials', 'true');
  }
  if (options.exposedHeaders?.length) {
    response.headers.set(
      'access-control-expose-headers',
      options.exposedHeaders.join(', '),
    );
  }
  return response;
};

/** Adds the response-side CORS headers. One extra closure per route, at boot. */
export const withCors = (
  options: CorsOptions,
  handler: RouteHandler,
): RouteHandler => {
  return async (req) => applyCors(options, req, await handler(req));
};

/**
 * `Bun.serve({ routes })` answers a method miss with 404, so a preflight cannot be
 * inferred — every CORS-enabled path gets its own `OPTIONS` handler, built at boot
 * from the methods that path actually declares.
 */
export const preflight = (
  options: CorsOptions,
  methods: readonly string[],
): RouteHandler => {
  const allowMethods = (options.methods ?? methods).join(', ');

  return async (req) => {
    const response = applyCors(
      options,
      req,
      new Response(null, { status: HttpStatusCode.NO_CONTENT }),
    );
    // Origin not allowed: 204 with no CORS headers, which fails the preflight.
    if (!response.headers.has(ORIGIN)) return response;

    response.headers.set('access-control-allow-methods', allowMethods);

    const allowHeaders =
      options.allowedHeaders ??
      (req.headers.get('access-control-request-headers') ?? '')
        .split(',')
        .map((header) => header.trim())
        .filter((header) => header.length > 0);
    if (allowHeaders.length > 0) {
      response.headers.set(
        'access-control-allow-headers',
        allowHeaders.join(', '),
      );
    }
    if (options.maxAge !== undefined) {
      response.headers.set('access-control-max-age', String(options.maxAge));
    }
    return response;
  };
};
