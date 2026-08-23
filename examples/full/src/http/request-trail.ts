import type { BunRequest } from 'bun';
import type { Middleware, Next, RouteContext } from '@dunx/http';

/** The observable side effect: whatever the middleware saw is readable after. */
export class RequestTrail {
  readonly entries: string[] = [];
}

/**
 * A class with `handle(req, ctx, next)`, resolved from the container so it can
 * inject. `ctx` is the route the chain was folded into.
 *
 * It does not log: `@dunx/http` writes the request entry itself, so an app doing
 * its own would write everything twice. What is left is the app-specific side
 * effect a framework cannot supply.
 */
export class RequestTrailMiddleware implements Middleware {
  constructor(private readonly trail: RequestTrail) {}

  async handle(
    req: BunRequest,
    ctx: RouteContext,
    next: Next,
  ): Promise<Response> {
    const response = await next();
    this.trail.entries.push(
      `${req.method} ${new URL(req.url).pathname} -> ${response.status} ` +
        `(${ctx.controller}.${ctx.handler})`,
    );
    response.headers.set('x-handled-by', 'request-trail');
    return response;
  }
}
