import { AppError } from '@dunx/core';
import type { DiscoveredRoute } from '../route/discover.js';
import type { HttpMethod } from '../route/marker.js';
import { preflight, withCors, type CorsOptions } from './cors.js';
import { defaultErrorMapper, type ErrorMapper } from './errors.js';
import { compose, type Middleware, type RouteHandler } from './middleware.js';
import { HttpStatusCode } from './status.js';

/** `OPTIONS` is never a `@Get`-style route — only CORS mounts one. */
export type RouteMethod = HttpMethod | 'OPTIONS';

export type BunRoutes = Record<
  string,
  Partial<Record<RouteMethod, RouteHandler>>
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
 * boot error naming both handlers. Run twice: once at `create()` on the discovered
 * paths, and again from `buildRoutes` at `listen()` on the final, prefixed ones.
 */
export const assertNoCollisions = (
  discovered: readonly DiscoveredRoute[],
): void => {
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
  }
};

export const buildRoutes = (
  discovered: readonly DiscoveredRoute[],
  middleware: readonly Middleware[] = [],
  onError: ErrorMapper = defaultErrorMapper,
  cors?: CorsOptions,
): BunRoutes => {
  assertNoCollisions(discovered);
  const routes: BunRoutes = {};

  for (const route of discovered) {
    const chained = compose(middleware, async (req) =>
      toResponse(await route.handler(req)),
    );
    const guarded: RouteHandler = async (req) => {
      try {
        return await chained(req);
      } catch (error) {
        return onError(error, req);
      }
    };

    const byMethod = (routes[route.path] ??= {});
    // Outside the error mapper, so a mapped 500 still carries the CORS headers the
    // browser needs in order to show it.
    byMethod[route.method] = cors ? withCors(cors, guarded) : guarded;
  }

  if (cors) {
    for (const byMethod of Object.values(routes)) {
      byMethod.OPTIONS = preflight(cors, Object.keys(byMethod));
    }
  }

  return routes;
};
