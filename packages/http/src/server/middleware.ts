import type { BunRequest } from 'bun';

export type Next = () => Promise<Response>;

/**
 * The single extension point. A guard is middleware that throws, an interceptor
 * wraps `next()`, a filter is the error mapper.
 */
export interface Middleware {
  handle(req: BunRequest, next: Next): Promise<Response>;
}

export type RouteHandler = (req: BunRequest) => Promise<Response>;

/** Folded into one closure per route at boot — no per-request array iteration. */
export const compose = (
  middleware: readonly Middleware[],
  handler: RouteHandler,
): RouteHandler =>
  middleware.reduceRight<RouteHandler>(
    (next, current) => (req) => current.handle(req, () => next(req)),
    handler,
  );
