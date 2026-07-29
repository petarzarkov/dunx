import { AppError } from '@dunx/core';
import type { DiscoveredRoute } from '../route/discover.js';
import type { HttpMethod } from '../route/marker.js';
import type { UpgradeHandler } from '../ws/adapter.js';
import { preflight, withCors, type CorsOptions } from './cors.js';
import { defaultErrorMapper, type ErrorMapper } from './errors.js';
import { buildInputReader } from './input.js';
import { compose, type Middleware, type RouteHandler } from './middleware.js';
import { HttpStatusCode } from './status.js';

/** `OPTIONS` is never a `@Get`-style route — only CORS mounts one. */
export type RouteMethod = HttpMethod | 'OPTIONS';

export type BunRoutes = Record<
  string,
  Partial<Record<RouteMethod, RouteHandler>>
>;

/**
 * What `listen()` hands `Bun.serve`: the HTTP table plus one `GET` per gateway,
 * whose handler may answer `undefined` because the socket was upgraded.
 */
export type ServeRoutes = Record<
  string,
  Partial<Record<RouteMethod, RouteHandler | UpgradeHandler>>
>;

/**
 * A `Response` passes through untouched — that is the escape hatch, and nothing
 * about it is worth second-guessing. Nothing at all is a 204: `Response.json(null)`
 * would be a body claiming to be no body.
 */
const toResponse = (value: unknown, status: number): Response => {
  if (value instanceof Response) return value;
  if (value === undefined || value === null) {
    return new Response(null, { status: HttpStatusCode.NO_CONTENT });
  }
  return Response.json(value, { status });
};

/** Nest's rule: an explicit `status`, else 201 for POST, else 200. */
const statusFor = (route: DiscoveredRoute): number =>
  route.options?.status ??
  (route.method === 'POST' ? HttpStatusCode.CREATED : HttpStatusCode.OK);

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

/**
 * A gateway's upgrade is a native route like any other, so a path claimed by both a
 * controller and a gateway would lose one of them when the two tables merge.
 */
export const assertNoGatewayCollisions = (
  discovered: readonly DiscoveredRoute[],
  gatewayPaths: readonly string[],
): void => {
  const gateways = new Set(gatewayPaths);

  for (const route of discovered) {
    if (gateways.has(route.path)) {
      throw new AppError(
        `Gateway path collision: ${route.path} is served by a gateway and by ` +
          `${route.controller}.${route.handlerName}(). The upgrade is a route too, ` +
          'so one of them would be dropped.',
      );
    }
  }
};

/**
 * The two tables in one. A gateway's `GET` is what Bun's router matches on an
 * upgrade — the reason no `fetch` handler is needed for a socket to connect.
 */
export const withUpgradeRoutes = (
  routes: BunRoutes,
  gateways: ReadonlyMap<string, UpgradeHandler>,
): ServeRoutes => {
  const merged: ServeRoutes = { ...routes };
  for (const [path, upgrade] of gateways) merged[path] = { GET: upgrade };
  return merged;
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
    // Schemas, parsers and the status resolve here, once. What survives into the
    // request path is one closure that reads no metadata.
    const read = buildInputReader(route.options);
    const status = statusFor(route);
    const chained = compose(middleware, async (req) =>
      toResponse(await route.handler(await read(req)), status),
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
