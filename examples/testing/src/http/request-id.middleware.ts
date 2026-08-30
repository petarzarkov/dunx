import type { BunRequest } from 'bun';
import type { Middleware, Next, RouteContext } from '@dunx/http';

/**
 * Global middleware, so it runs for every route rather than the ones a decorator
 * names. It stamps the id a client quotes back in a bug report.
 *
 * `next()` returns the handler's `Response`, and a `Response` built by a route is
 * safe to copy but not always to mutate, so the header goes on a new one.
 */
export class RequestId implements Middleware {
  async handle(
    req: BunRequest,
    _ctx: RouteContext,
    next: Next,
  ): Promise<Response> {
    const id = req.headers.get('x-request-id') ?? Bun.randomUUIDv7();
    const response = await next();
    const headers = new Headers(response.headers);
    headers.set('x-request-id', id);
    return new Response(response.body, { status: response.status, headers });
  }
}
