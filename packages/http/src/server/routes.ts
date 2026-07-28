import { AppError } from '@dunx/core';
import type { DiscoveredRoute } from '../route/discover.js';
import type { HttpMethod } from '../route/marker.js';
import { defaultErrorMapper, type ErrorMapper } from './errors.js';
import { compose, type Middleware, type RouteHandler } from './middleware.js';
import { HttpStatusCode } from './status.js';

export type BunRoutes = Record<
  string,
  Partial<Record<HttpMethod, RouteHandler>>
>;

const toResponse = (value: unknown): Response => {
  if (value instanceof Response) return value;
  if (value === undefined) {
    return new Response(null, { status: HttpStatusCode.NO_CONTENT });
  }
  return Response.json(value);
};

/**
 * Bun silently lets one route win on a collision, so a duplicate method+path is a
 * boot error naming both handlers.
 */
export const buildRoutes = (
  discovered: readonly DiscoveredRoute[],
  middleware: readonly Middleware[] = [],
  onError: ErrorMapper = defaultErrorMapper,
): BunRoutes => {
  const routes: BunRoutes = {};
  const owners = new Map<string, string>();

  for (const route of discovered) {
    const key = `${route.method} ${route.path}`;
    const owner = `${route.controller}.${route.handlerName}`;
    const existing = owners.get(key);

    if (existing !== undefined) {
      throw new AppError(
        `Route collision: ${key} is declared by ${existing} and by ${owner}. ` +
          'Bun would keep only one of them.',
      );
    }
    owners.set(key, owner);

    const chained = compose(middleware, async (req) =>
      toResponse(await route.handler(req)),
    );
    const byMethod = (routes[route.path] ??= {});
    byMethod[route.method] = async (req) => {
      try {
        return await chained(req);
      } catch (error) {
        return onError(error, req);
      }
    };
  }

  return routes;
};
