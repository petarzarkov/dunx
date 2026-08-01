import type { BunRequest } from 'bun';
import type { Middleware, Next, RouteContext } from '@dunx/http';

/** The observable side effect: whatever the middleware saw is readable after. */
export class RequestLog {
  readonly entries: string[] = [];
}

/**
 * A class with `handle(req, ctx, next)`, resolved from the container — which is
 * what lets it inject. Chains are folded into one closure per route at boot, and
 * `ctx` is the route it was folded into: names, method, path, and its metadata.
 *
 * **This does not log.** `@dunx/http` already installs
 * `RequestLoggingMiddleware` by default — one structured entry per request,
 * with `requestId` propagated through `RequestContext` — so an app writing its
 * own would be logging everything twice. What is left here is the part a
 * framework cannot supply: an app-specific side effect, kept because the tour
 * asserts on it and because it is the smallest possible example of the seam.
 */
export class RequestLoggerMiddleware implements Middleware {
  constructor(private readonly log: RequestLog) {}

  async handle(
    req: BunRequest,
    ctx: RouteContext,
    next: Next,
  ): Promise<Response> {
    const response = await next();
    this.log.entries.push(
      `${req.method} ${new URL(req.url).pathname} -> ${response.status} ` +
        `(${ctx.controller}.${ctx.handler})`,
    );
    response.headers.set('x-handled-by', 'request-logger');
    return response;
  }
}
