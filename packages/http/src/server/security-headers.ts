import { mapRoutes, type ServedHandler } from './middleware.js';
import type { BunRoutes } from './routes.js';

/**
 * Each field is the header's value, or `false` to leave that header off. A field
 * left out takes the default listed on it.
 */
export interface SecurityHeadersOptions {
  /**
   * Off unless set. `true` sends {@link STRICT_CSP}; a string is sent as given.
   * dunx's own pages (the API explorer, the dashboard, bull-board) send a policy
   * of their own, which a response keeps.
   */
  readonly contentSecurityPolicy?: boolean | string;
  /**
   * @default 'max-age=31536000; includeSubDomains'. A browser ignores it over
   * plain HTTP, and behind a TLS-terminating proxy the app cannot tell, so it is
   * sent on every response.
   */
  readonly strictTransportSecurity?: string | false;
  /** @default 'nosniff' */
  readonly xContentTypeOptions?: string | false;
  /** @default 'no-referrer' */
  readonly referrerPolicy?: string | false;
  /** @default 'DENY' */
  readonly xFrameOptions?: string | false;
  /** @default 'same-origin' */
  readonly crossOriginOpenerPolicy?: string | false;
  /** @default 'off' */
  readonly xDnsPrefetchControl?: string | false;
  /** @default '?1' */
  readonly originAgentCluster?: string | false;
}

/** What `contentSecurityPolicy: true` sends. Same-origin scripts and styles only. */
export const STRICT_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; " +
  "object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

const DEFAULTS = {
  strictTransportSecurity: 'max-age=31536000; includeSubDomains',
  xContentTypeOptions: 'nosniff',
  referrerPolicy: 'no-referrer',
  xFrameOptions: 'DENY',
  crossOriginOpenerPolicy: 'same-origin',
  xDnsPrefetchControl: 'off',
  originAgentCluster: '?1',
} as const;

const NAMES: Readonly<Record<keyof typeof DEFAULTS, string>> = {
  strictTransportSecurity: 'strict-transport-security',
  xContentTypeOptions: 'x-content-type-options',
  referrerPolicy: 'referrer-policy',
  xFrameOptions: 'x-frame-options',
  crossOriginOpenerPolicy: 'cross-origin-opener-policy',
  xDnsPrefetchControl: 'x-dns-prefetch-control',
  originAgentCluster: 'origin-agent-cluster',
};

export type HeaderPairs = readonly (readonly [string, string])[];

/** The header list, resolved once at `listen()`. */
export const securityHeaderPairs = (
  options: SecurityHeadersOptions,
): HeaderPairs => {
  const pairs: [string, string][] = [];
  const csp = options.contentSecurityPolicy;
  if (csp !== undefined && csp !== false) {
    pairs.push(['content-security-policy', csp === true ? STRICT_CSP : csp]);
  }
  for (const key of Object.keys(DEFAULTS) as (keyof typeof DEFAULTS)[]) {
    const value = options[key] ?? DEFAULTS[key];
    if (value !== false) pairs.push([NAMES[key], value]);
  }
  return pairs;
};

/**
 * A header the response already carries is kept, which is how one route relaxes
 * one header: it sets its own. Measured against the alternatives in
 * docs/architecture/constraints.md, "Security response headers".
 */
/**
 * Sets each header the response does not already carry, and returns it. A header
 * the handler set is its own override, which is how a route or a framework page
 * keeps a policy of its own under `securityHeaders`.
 */
export const setAbsentHeaders = (
  response: Response,
  pairs: HeaderPairs,
): Response => {
  const headers = response.headers;
  for (const [name, value] of pairs) {
    if (!headers.has(name)) headers.set(name, value);
  }
  return response;
};

/**
 * Runs `stamp` on every response `handler` gives. Not `async`: a handler that
 * answered synchronously still does, so the direct path keeps its measured
 * advantage.
 */
export const withResponseStamp =
  (
    stamp: (response: Response) => Response,
    handler: ServedHandler,
  ): ServedHandler =>
  (req, server) => {
    const response = handler(req, server);
    return response instanceof Promise ? response.then(stamp) : stamp(response);
  };

/**
 * The security headers for one app, with the responses dunx builds itself built
 * already carrying them. `stamp` then skips those, and does the `has`/`set` walk
 * only for a `Response` a handler returned or an error mapper built.
 *
 * Measured on Bun 1.4.2: a JSON response with the walk cost 983 ns, prebuilt and
 * marked 435 ns, and 305 ns with no security headers at all. The walk alone is
 * most of it, because the first touch of `response.headers` materialises them.
 */
export class SecuredResponses {
  readonly #pairs: HeaderPairs;
  /** Copied by every `Response` built from it, so a later `set` stays local. */
  readonly #init: Headers;
  readonly #stamped = new WeakSet<Response>();

  constructor(pairs: HeaderPairs) {
    this.#pairs = pairs;
    this.#init = new Headers(pairs as [string, string][]);
  }

  /** `Response.json(value, { status })`, already carrying every header. */
  json(value: unknown, status: number): Response {
    return this.#mark(Response.json(value, { status, headers: this.#init }));
  }

  /** A bodiless response, already carrying every header. */
  empty(status: number): Response {
    return this.#mark(new Response(null, { status, headers: this.#init }));
  }

  stamp(response: Response): Response {
    return this.#stamped.has(response)
      ? response
      : setAbsentHeaders(response, this.#pairs);
  }

  /** One table entry, stamped. */
  wrap(handler: ServedHandler): ServedHandler {
    return withResponseStamp((response) => this.stamp(response), handler);
  }

  /** Every entry of the route table, `OPTIONS` preflights included. */
  routes(routes: BunRoutes): BunRoutes {
    return mapRoutes(routes, (handler) => this.wrap(handler));
  }

  #mark(response: Response): Response {
    this.#stamped.add(response);
    return response;
  }
}
