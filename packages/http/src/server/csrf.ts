import { AppError, type Logger } from '@dunx/core';
import { forwardedEntry, trustedHops } from './client-address.js';
import type { ErrorMapper } from './errors.js';
import { HttpError } from './errors.js';
import { mapRoutes, type ServedHandler } from './middleware.js';
import type { BunRoutes } from './routes.js';
import { HttpStatusCode } from './status.js';
import { ThrottledWarning } from './throttled-warning.js';

export interface CsrfOptions {
  /**
   * Origins allowed to send an unsafe request cross-site, each a bare
   * `scheme://host[:port]` compared exactly with the `Origin` header. A malformed
   * entry is a boot error. A CORS origin that posts with credentials belongs here
   * too: CORS decides who may read a response, this decides who may send one.
   */
  readonly trustedOrigins?: readonly string[];
}

/** Go's `net/http.CrossOriginProtection` exempts the same three. */
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Validated once at boot, the way Go's `AddTrustedOrigin` does. */
export const trustedOriginSet = (
  origins: readonly string[] = [],
): ReadonlySet<string> => {
  for (const origin of origins) {
    const parsed = URL.parse(origin);
    if (
      parsed === null ||
      parsed.host === '' ||
      parsed.origin === 'null' ||
      origin !== parsed.origin
    ) {
      throw new AppError(
        `csrf.trustedOrigins: ${origin} is not a bare origin. Write it as ` +
          'scheme://host[:port], with no path, query or trailing slash.',
      );
    }
  }
  return new Set(origins);
};

/** `undefined` for an opaque (`null`) or unparseable `Origin`: a mismatch. */
const hostOf = (origin: string): string | undefined => {
  const host = URL.parse(origin)?.host;
  return host === '' ? undefined : host;
};

/**
 * The host the browser addressed: behind trusted proxies, the `X-Forwarded-Host`
 * entry `ClientAddress` would pick from `X-Forwarded-For`.
 */
const addressedHost = (req: Request, hops: number): string | null =>
  forwardedEntry(req.headers.get('x-forwarded-host'), hops) ??
  req.headers.get('host');

/** Which rule refused: `Sec-Fetch-Site`, or the `Origin` fallback. */
export type CsrfRefusal = 'cross-origin' | 'origin-mismatch';

/**
 * Why an unsafe request is refused, or `undefined` to let it through.
 * `Sec-Fetch-Site` when the browser sent it, else `Origin` against the addressed
 * host, else a client that is not a browser. Measured in
 * docs/architecture/constraints.md, "CSRF protection".
 */
export const crossOriginCheck = (
  options: CsrfOptions,
  trustProxy: boolean | number,
): ((req: Request) => CsrfRefusal | undefined) => {
  const hops = trustedHops(trustProxy);
  const trusted = trustedOriginSet(options.trustedOrigins);
  const isTrusted = (origin: string | null): boolean =>
    origin !== null && trusted.has(origin);

  return (req) => {
    const site = req.headers.get('sec-fetch-site');
    if (site !== null) {
      return site === 'same-origin' ||
        site === 'none' ||
        isTrusted(req.headers.get('origin'))
        ? undefined
        : 'cross-origin';
    }
    const origin = req.headers.get('origin');
    if (origin === null) return undefined;
    const host = hostOf(origin);
    return (host !== undefined && host === addressedHost(req, hops)) ||
      isTrusted(origin)
      ? undefined
      : 'origin-mismatch';
  };
};

/** Wraps one route-table handler with the check. */
export type CsrfWrap = (handler: ServedHandler) => ServedHandler;

/**
 * The check, the refusal and its log line as one wrapper, built once at boot.
 * Not `async`, so a handler that answered synchronously still does. A refusal
 * goes through the app's error mapper, so it has the shape every other error
 * has, and is logged through a {@link ThrottledWarning}.
 *
 * The trace context is adopted by request logging, which a refusal never
 * reaches, so the inbound `traceparent` is copied as received.
 */
export const csrfWrapper = (
  options: CsrfOptions,
  trustProxy: boolean | number,
  logger: Logger,
  onError: ErrorMapper,
): CsrfWrap => {
  const check = crossOriginCheck(options, trustProxy);
  const warning = new ThrottledWarning(logger);

  const refuse = (req: Request, reason: CsrfRefusal): Response => {
    const path = new URL(req.url).pathname;
    const traceparent = req.headers.get('traceparent');
    warning.warn(`CSRF refused ${req.method} ${path}`, {
      method: req.method,
      path,
      secFetchSite: req.headers.get('sec-fetch-site'),
      origin: req.headers.get('origin'),
      reason,
      ...(traceparent !== null && { traceparent }),
    });
    return onError(
      new HttpError(HttpStatusCode.FORBIDDEN, 'CROSS_ORIGIN_REQUEST'),
      req,
    );
  };

  return (handler) => (req, server) => {
    if (SAFE.has(req.method)) return handler(req, server);
    const reason = check(req);
    return reason === undefined ? handler(req, server) : refuse(req, reason);
  };
};

/** Every unsafe-method entry of the table. A `GET` entry is left as it was. */
export const withCsrfRoutes = (wrap: CsrfWrap, routes: BunRoutes): BunRoutes =>
  mapRoutes(routes, (handler, method) =>
    SAFE.has(method) ? handler : wrap(handler),
  );
