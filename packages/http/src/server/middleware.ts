import type { BunRequest, Server } from 'bun';
import type { RouteContext } from './context.js';

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
}

export const hasClaimedPaths = (value: object): value is ClaimsPaths =>
  typeof (value as Partial<ClaimsPaths>).claimedPaths === 'function';
