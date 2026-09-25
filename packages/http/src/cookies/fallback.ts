import type { CookieMap } from 'bun';
import type { ServedHandler } from '../server/middleware.js';

/**
 * `req.cookies` for the `fetch` fallback, where Bun gives none.
 *
 * `Bun.serve` builds a `CookieMap` for a route-table request and writes its
 * changes onto whatever `Response` the handler returns. The fallback's request
 * has no `cookies` at all, so a global guard reading one on an unmatched path
 * threw a `TypeError`, and a claimed path could not set one. This gives it a map,
 * built on first read, and writes the changes the same way. A request that
 * already has Bun's map is passed through.
 */
export const withRequestCookies =
  (handler: ServedHandler): ServedHandler =>
  (req, server) => {
    // Typed as having one, which is the claim this exists to make true.
    const request: Request = req;
    if ('cookies' in request) return handler(req, server);
    let map: CookieMap | undefined;
    Object.defineProperty(req, 'cookies', {
      get: () => (map ??= new Bun.CookieMap(req.headers.get('cookie') ?? '')),
    });
    const apply = (response: Response): Response => {
      for (const header of map?.toSetCookieHeaders() ?? []) {
        response.headers.append('set-cookie', header);
      }
      return response;
    };
    const response = handler(req, server);
    return response instanceof Promise ? response.then(apply) : apply(response);
  };
