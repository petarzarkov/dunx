import type { BunRequest } from 'bun';
import type { RouteContext } from './context.js';

export type Next = () => Promise<Response>;

/**
 * The single extension point. A guard is middleware that throws, an interceptor
 * wraps `next()`, a filter is the error mapper. `ctx` names the route and carries
 * what its decorators declared, resolved at boot — so a guard costs a Map lookup.
 */
export interface Middleware {
  handle(req: BunRequest, ctx: RouteContext, next: Next): Promise<Response>;
}

export type RouteHandler = (req: BunRequest) => Promise<Response>;

/**
 * What goes into the `Bun.serve` route table. Wider than `RouteHandler` because
 * Bun accepts a plain `Response`, which is what lets a route with nothing to
 * await skip promises altogether — see `buildRoutes`.
 */
export type ServedHandler = (req: BunRequest) => Response | Promise<Response>;

/** Folded into one closure per route at boot — no per-request array iteration. */
export const compose = (
  middleware: readonly Middleware[],
  ctx: RouteContext,
  handler: RouteHandler,
): RouteHandler =>
  middleware.reduceRight<RouteHandler>(
    (next, current) => (req) => current.handle(req, ctx, () => next(req)),
    handler,
  );
