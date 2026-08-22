import type { BunRequest } from 'bun';
import type { Middleware, Next, RouteContext } from '@dunx/http';

/** The observable side effect: whatever the middleware saw is readable after. */
export class RequestTrail {
  readonly entries: string[] = [];
}

/**
 * A class with `handle(req, ctx, next)`, resolved from the container - which is
 * what lets it inject. Chains are folded into one closure per route at boot, and
 * `ctx` is the route it was folded into: names, method, path, and its metadata.
 *
 * **This does not log**, which is what the name says now and did not before.
 * `@dunx/http` installs `RequestLoggingMiddleware` itself - one structured entry
 * per request, tuned through `requestLogging` in bootstrap.ts - so an app writing
 * its own would write everything twice. What is left here is the part a framework
 * cannot supply: an app-specific side effect on a response the middleware can see.
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
