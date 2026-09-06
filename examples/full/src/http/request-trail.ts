import type { BunRequest } from 'bun';
import type { Middleware, Next, RouteContext } from '@dunx/http';

/**
 * The observable side effect: whatever the middleware saw is readable after.
 *
 * Capped, because this grows by one entry on **every request** and this folder is
 * vendored into `@dunx/create-app`'s `http` feature. Unbounded it put 46 MiB on
 * the heap across 3.1 million requests in the soak run and read as a framework
 * leak until a heap census named the strings. A demo that keeps the last few
 * hundred shows the same thing and survives production traffic.
 */
const KEEP = 500;

export class RequestTrail {
  readonly entries: string[] = [];

  record(entry: string): void {
    this.entries.push(entry);
    if (this.entries.length > KEEP) {
      this.entries.splice(0, this.entries.length - KEEP);
    }
  }
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
    this.trail.record(
      `${req.method} ${new URL(req.url).pathname} -> ${response.status} ` +
        `(${ctx.controller}.${ctx.handler})`,
    );
    response.headers.set('x-handled-by', 'request-trail');
    return response;
  }
}
