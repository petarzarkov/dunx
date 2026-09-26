import type { BunRequest, Server } from 'bun';
import type { RouteContext } from './context.js';
import type { BunRoutes, RouteMethod } from './routes.js';

export type Next = () => Promise<Response>;

/**
 * The single extension point. A guard is middleware that throws, an interceptor
 * wraps `next()`, a filter is the error mapper. `ctx` names the route and carries
 * what its decorators declared, resolved at boot - so a guard costs a Map lookup.
 */
export interface Middleware {
  handle(req: BunRequest, ctx: RouteContext, next: Next): Promise<Response>;
}

export type RouteHandler = (req: BunRequest) => Promise<Response>;

/**
 * What goes into the `Bun.serve` route table. Wider than `RouteHandler` because
 * Bun accepts a plain `Response`, which is what lets a route with nothing to
 * await skip promises altogether - see `buildRoutes`.
 */
export type ServedHandler = (
  req: BunRequest,
  /** The server that received the request. Bun always passes it; optional so a
   * test can call a handler with the request alone. See `STREAMS`. */
  server?: Server<unknown>,
) => Response | Promise<Response>;

/**
 * A copy of the route table with every handler replaced by `wrap(handler, method)`.
 * Fresh per-method objects, so the trailing-slash aliases built afterwards share
 * the wrapped ones.
 */
export const mapRoutes = (
  routes: BunRoutes,
  wrap: (handler: ServedHandler, method: RouteMethod) => ServedHandler,
): BunRoutes => {
  const mapped: BunRoutes = {};
  for (const [path, byMethod] of Object.entries(routes)) {
    const wrapped: BunRoutes[string] = {};
    for (const [method, handler] of Object.entries(byMethod)) {
      wrapped[method as RouteMethod] = wrap(handler, method as RouteMethod);
    }
    mapped[path] = wrapped;
  }
  return mapped;
};

/**
 * Runs `stamp` on every response `handler` gives, with the request it answered. Not `async`: a handler that
 * answered synchronously still does, so the direct path keeps its measured
 * advantage.
 */
export const withResponseStamp =
  (
    stamp: (response: Response, req: BunRequest) => Response,
    handler: ServedHandler,
  ): ServedHandler =>
  (req, server) => {
    const response = handler(req, server);
    return response instanceof Promise
      ? response.then((settled) => stamp(settled, req))
      : stamp(response, req);
  };

/** Folded into one closure per route at boot - no per-request array iteration. */
export const compose = (
  middleware: readonly Middleware[],
  ctx: RouteContext,
  handler: RouteHandler,
): RouteHandler =>
  middleware.reduceRight<RouteHandler>(
    (next, current) => (req) => current.handle(req, ctx, () => next(req)),
    handler,
  );

/**
 * Middleware that answers a fixed set of paths itself, on the unmatched path.
 * `buildRoutes` cross-checks them against the route table: Bun matches a route
 * first, so a controller on one of these would shadow it with nothing said.
 */
export interface ClaimsPaths {
  claimedPaths(): readonly string[];
  /**
   * The methods those paths answer. `preflight` is mounted over the route table,
   * which a claimed path is not in, so an `OPTIONS` would reach the 404.
   */
  claimedMethods(): readonly string[];
}

export const hasClaimedPaths = (value: object): value is ClaimsPaths =>
  typeof (value as Partial<ClaimsPaths>).claimedPaths === 'function';
