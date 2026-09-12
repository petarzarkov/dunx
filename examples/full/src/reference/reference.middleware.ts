import type { BunRequest } from 'bun';
import {
  type Middleware,
  type Next,
  type RouteContext,
  UNMATCHED,
} from '@dunx/http';
import { OpenApiExplorer } from '@dunx/openapi';
import { ScalarRenderer } from '@dunx/openapi/scalar';

/** Where this page and its one asset answer. `/api/docs` is Swagger UI's. */
export const REFERENCE_PATH = '/api/reference';

/**
 * The second renderer, mounted by hand. `OpenApiModule` takes one `renderer`, so
 * a page beside it is a middleware over the same `OpenApiExplorer` document: the
 * renderer is an object with `page()` and `asset()` on it, and nothing about it
 * needs the module.
 *
 * `/api` is the global prefix `main.ts` sets, so the document is asked for under
 * that prefix and the asset hrefs hang off this mount.
 */
export class ReferenceMiddleware implements Middleware {
  readonly #renderer = new ScalarRenderer({
    theme: 'purple',
    title: 'dunx full example - Scalar',
  });
  #page: string | undefined;

  constructor(private readonly explorer: OpenApiExplorer) {}

  async handle(
    req: BunRequest,
    ctx: RouteContext,
    next: Next,
  ): Promise<Response> {
    if (ctx.get(UNMATCHED) !== true || req.method !== 'GET') return next();

    const { pathname } = new URL(req.url);
    if (pathname === REFERENCE_PATH) {
      return new Response(await this.#html(), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    if (!pathname.startsWith(`${REFERENCE_PATH}/`)) return next();

    return this.#renderer.asset(pathname.slice(REFERENCE_PATH.length + 1));
  }

  async #html(): Promise<string> {
    this.#page ??= await this.#renderer.page(this.explorer.document('/api'), {
      jsonHref: '/api/openapi.json',
      warnings: this.explorer.warnings,
      mountedAt: REFERENCE_PATH,
    });
    return this.#page;
  }
}
