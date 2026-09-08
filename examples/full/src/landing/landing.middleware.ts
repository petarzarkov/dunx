import type { BunRequest } from 'bun';
import {
  type Middleware,
  type Next,
  type RouteContext,
  UNMATCHED,
} from '@dunx/http';

/**
 * What `/` answers with, and the three files that page pulls. An allow-list
 * rather than a directory: `StaticFiles` handles trees, and these four sit at
 * the root because an unfurler reads `og:image` before anything else.
 */
const FILES: Readonly<Record<string, string>> = {
  '/': 'index.html',
  '/landing.css': 'landing.css',
  '/landing.js': 'landing.js',
  '/og.png': 'og.png',
};

const TYPES: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  png: 'image/png',
};

/**
 * The page at `/`, which `StaticFiles` has no index fallback for by design. It
 * answers its own four paths alone, so every other miss stays the 404 the tour
 * narrates.
 */
export class LandingMiddleware implements Middleware {
  readonly #dir = new URL('./public/', import.meta.url).pathname;

  async handle(
    req: BunRequest,
    ctx: RouteContext,
    next: Next,
  ): Promise<Response> {
    // A miss is thrown rather than returned, so the flag is what reports one.
    if (ctx.get(UNMATCHED) !== true || req.method !== 'GET') return next();

    const name = FILES[new URL(req.url).pathname];
    if (name === undefined) return next();

    const file = Bun.file(`${this.#dir}${name}`);
    if (!(await file.exists())) return next();

    return new Response(file, {
      headers: {
        'content-type': TYPES[name.split('.').pop() ?? ''] ?? 'text/plain',
        // The card is committed; the page is redeployed and must not be held.
        'cache-control':
          name === 'og.png' ? 'public, max-age=86400' : 'no-cache',
      },
    });
  }
}
