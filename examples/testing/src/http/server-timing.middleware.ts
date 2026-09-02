import type { BunRequest } from 'bun';
import type { Middleware, Next, RouteContext } from '@dunx/http';

/**
 * Global middleware, so it runs for every route rather than the ones a decorator
 * names. It reports how long the handler took in `Server-Timing`, which a
 * browser's network panel reads without any tooling.
 *
 * `next()` returns the handler's `Response`, and a `Response` built by a route is
 * safe to copy but not always to mutate, so the header goes on a new one.
 *
 * Correlation is not this middleware's job: `@dunx/http` adopts W3C Trace Context
 * for every request and answers with `traceresponse` on its own.
 */
export class ServerTiming implements Middleware {
  async handle(
    _req: BunRequest,
    _ctx: RouteContext,
    next: Next,
  ): Promise<Response> {
    const started = Bun.nanoseconds();
    const response = await next();
    const ms = (Bun.nanoseconds() - started) / 1e6;
    const headers = new Headers(response.headers);
    headers.set('server-timing', `handler;dur=${ms.toFixed(1)}`);
    return new Response(response.body, { status: response.status, headers });
  }
}
