import type { BunRequest } from 'bun';
import {
  HttpError,
  HttpStatusCode,
  PUBLIC,
  type Middleware,
  type Next,
  type RouteContext,
} from '@dunx/http';
import { ApiKeys } from './api-keys.js';

/**
 * A guard is middleware that throws. It has dependencies like anything else, which
 * is exactly why it is worth a test: the key store is injected, so a suite can bind
 * a known set of keys instead of reaching for the real one.
 */
export class ApiKeyGuard implements Middleware {
  constructor(private readonly keys: ApiKeys) {}

  handle(req: BunRequest, ctx: RouteContext, next: Next): Promise<Response> {
    if (ctx.get(PUBLIC)) return next();

    const presented = req.headers.get('x-api-key');
    if (presented === null) {
      throw new HttpError(HttpStatusCode.UNAUTHORIZED, 'No API key');
    }
    if (!this.keys.accepts(presented)) {
      throw new HttpError(HttpStatusCode.FORBIDDEN, 'Unknown API key');
    }
    return next();
  }
}
