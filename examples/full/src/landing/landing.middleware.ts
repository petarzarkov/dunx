import type { BunRequest } from 'bun';
import {
  type Middleware,
  type Next,
  type RouteContext,
  UNMATCHED,
} from '@dunx/http';

/**
 * The page at `/`. `StaticFiles` has no index fallback by design and points an
 * app that wants one at a middleware outside it; this is that middleware. It
 * answers `/` alone, so every other miss stays the 404 the tour narrates.
 */
export class LandingMiddleware implements Middleware {
  readonly #page = new URL('./public/index.html', import.meta.url).pathname;

  async handle(
    req: BunRequest,
    ctx: RouteContext,
    next: Next,
  ): Promise<Response> {
    // A miss is thrown rather than returned, so the flag is what reports one.
    if (ctx.get(UNMATCHED) !== true || req.method !== 'GET') return next();
    if (new URL(req.url).pathname !== '/') return next();

    const page = Bun.file(this.#page);
    if (!(await page.exists())) return next();

    return new Response(page, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-cache',
      },
    });
  }
}
