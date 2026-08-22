import { AppError, type Ctor, type ModuleRef } from '@dunx/core';
import type { BunRequest } from 'bun';
import type { DiscoveredRoute } from '../route/discover.js';
import { defaultStatusFor, type HttpMethod } from '../route/marker.js';
import { PUBLIC, UNMATCHED, type MetaKey } from '../route/metadata.js';
import type { RouteInput } from '../route/schema.js';
import type { UpgradeHandler } from '../ws/adapter.js';
import { buildContext, type RouteContext } from './context.js';
import { preflight, withCors, type CorsOptions } from './cors.js';
import { defaultErrorMapper, HttpError, type ErrorMapper } from './errors.js';
import { buildInputReader, type InputReader } from './input.js';
import { RequestIds } from './request-id.js';
import {
  compose,
  type Middleware,
  type RouteHandler,
  type ServedHandler,
} from './middleware.js';
import { HttpStatusCode } from './status.js';

/** How a `@UseGuards` class becomes an instance. `listen()` passes `app.get`. */
/**
 * How a guard or a module's middleware becomes an instance.
 *
 * `from` names the module whose scope it resolves in - module middleware has to be
 * built from the module that declared it, or it could not inject that module's private
 * providers, which is the point of declaring it there.
 */
export type GuardResolver = (
  guard: Ctor<Middleware>,
  from?: ModuleRef,
) => Middleware;

const construct: GuardResolver = (guard) =>
  new (guard as new () => Middleware)();

/** `OPTIONS` is never a `@Get`-style route - only CORS mounts one. */
export type RouteMethod = HttpMethod | 'OPTIONS';

export type BunRoutes = Record<
  string,
  Partial<Record<RouteMethod, ServedHandler>>
>;

/**
 * What `listen()` hands `Bun.serve`: the HTTP table plus one `GET` per gateway,
 * whose handler may answer `undefined` because the socket was upgraded.
 */
export type ServeRoutes = Record<
  string,
  Partial<Record<RouteMethod, ServedHandler | UpgradeHandler>>
>;

/**
 * A `Response` passes through untouched - that is the escape hatch, and nothing
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

const statusFor = (route: DiscoveredRoute): number =>
  route.options?.status ?? defaultStatusFor(route.method);

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
 * upgrade - the reason no `fetch` handler is needed for a socket to connect.
 */
export const withUpgradeRoutes = (
  routes: BunRoutes,
  gateways: ReadonlyMap<string, UpgradeHandler>,
): ServeRoutes => {
  const merged: ServeRoutes = { ...routes };
  for (const [path, upgrade] of gateways) merged[path] = { GET: upgrade };
  return merged;
};

/**
 * The context an unmatched request gets. There is no controller and no handler,
 * and saying so is more useful to a log line than an empty string.
 *
 * A miss carries no route metadata, so a global guard reading none of it refuses,
 * which makes every 404 a 401 for an anonymous caller with no `@Public()`
 * anywhere to put. **That is deliberate and stays the default**: an unmatched
 * path answering 404 while every real path answers 401 tells a prober exactly
 * which paths exist.
 *
 * `notFound: 'public'` opts into the conventional 404 by reporting the miss as
 * public. Either way `UNMATCHED` is set, and no real route ever sets it, so a
 * guard can tell a genuinely public route from one that matched nothing.
 */
const unmatchedContext = (req: Request, isPublic: boolean): RouteContext =>
  Object.freeze({
    controller: '(unmatched)',
    handler: '(none)',
    method: req.method as HttpMethod,
    path: new URL(req.url).pathname,
    // Nothing matched, so no schema read this body and nothing recorded it.
    parsesBody: false,
    get: <T>(key: MetaKey<T>): T | undefined => {
      if (key.id === UNMATCHED.id) return true as T;
      if (key.id === PUBLIC.id && isPublic) return true as T;
      return undefined;
    },
  });

/**
 * Bun answers an unmatched path itself, so nothing in the middleware chain ever
 * sees it - which makes a 404 invisible to request logging, metrics and tracing.
 *
 * This is the only `fetch` handler dunx installs, and it is not a router: Bun
 * still does all the matching, and this runs only once Bun has decided nothing
 * matched. It puts the global middleware in front of a 404 in the framework's
 * own error shape.
 *
 * **The miss is a `throw`, not a returned `Response`.** `miss` raises
 * `HttpError(404)` and `compose` propagates it, so a middleware written as
 * `const response = await next(); if (response.status === 404) ...` never reaches
 * its own second line on an unmatched path - the rewrite it was written for is the
 * one case it cannot see. A middleware that means to act on a miss has to catch:
 *
 * ```ts
 * try {
 *   return await next();
 * } catch (error) {
 *   if (!(error instanceof HttpError) || error.status !== 404) throw error;
 *   return rewritten();
 * }
 * ```
 *
 * `ctx.get(UNMATCHED)` is the other half, and the cheaper one: it is set here and
 * by no real route, so a middleware can tell "nothing matched this path" from "a
 * handler answered 404 for a record that does not exist" **before** calling
 * `next()` at all. Only the second of those is a `Response` to inspect.
 *
 * Composed per request rather than at boot, because the context names the path
 * that missed. That allocation is on the 404 path only.
 */
export const buildFallback = (
  middleware: readonly Middleware[] = [],
  onError: ErrorMapper = defaultErrorMapper,
  cors?: CorsOptions,
  notFound: 'guarded' | 'public' = 'guarded',
): RouteHandler => {
  // The canonical status name, not a sentence naming the path back at the
  // caller: an unmatched path is the one place where echoing the request would
  // tell a prober something about the surface it just failed to find.
  const miss: RouteHandler = () => {
    throw new HttpError(HttpStatusCode.NOT_FOUND, 'NOT_FOUND');
  };

  const run: RouteHandler = async (req) => {
    try {
      return await compose(
        middleware,
        unmatchedContext(req, notFound === 'public'),
        miss,
      )(req);
    } catch (error) {
      return RequestIds.stamp(onError(error, req), req);
    }
  };

  return cors ? withCors(cors, run) : run;
};

/**
 * The direct path, taken when a route has no middleware and no CORS. Nothing here
 * is `async`: every step looks at what it got and only allocates a promise when
 * there is genuinely something to wait for.
 *
 * The general path is `async (req) => toResponse(await handler(await read(req)))`
 * inside an `async` try/catch - four `await`s across two async frames, on values
 * that are usually not thenable at all. A route with no declared schemas awaits
 * nothing; a route with only `query` or `params` awaits nothing either, because
 * every Standard Schema validator worth using is synchronous. Even a `body` route,
 * which really does have to wait for `req.json()`, pays one promise link instead of
 * six frames.
 *
 * Worth ~6 points of throughput against raw `Bun.serve` on the `params` scenario
 * when it covered only schema-less routes, and a further ~5 on `validate` when it
 * was extended to cover reading ones - which is most of what separated dunx from
 * Elysia, whose whole trick is compiling this shape ahead of time.
 *
 * A handler or a validator that *does* return a promise still works: it is adopted
 * here rather than awaited by a wrapper.
 */
const directOr = (
  guarded: RouteHandler,
  route: DiscoveredRoute,
  read: InputReader,
  status: number,
  onError: ErrorMapper,
  noMiddleware: boolean,
): ServedHandler => {
  if (!noMiddleware) return guarded;

  // `toResponse` throws on a value `JSON.stringify` cannot take, so it is inside
  // the mapper's reach on every branch - including the `then` callbacks, where a
  // throw would otherwise escape as an unhandled rejection instead of a 500.
  const settle = (value: unknown, req: BunRequest): Response => {
    try {
      return toResponse(value, status);
    } catch (error) {
      return onError(error, req);
    }
  };

  const invoke = (
    input: RouteInput,
    req: BunRequest,
  ): Response | Promise<Response> => {
    try {
      const value = route.handler(input);
      return value instanceof Promise
        ? value.then(
            (resolved) => settle(resolved, req),
            (error: unknown) => onError(error, req),
          )
        : settle(value, req);
    } catch (error) {
      return onError(error, req);
    }
  };

  return (req) => {
    try {
      const input = read(req);
      return input instanceof Promise
        ? input.then(
            (resolved) => invoke(resolved, req),
            (error: unknown) => onError(error, req),
          )
        : invoke(input, req);
    } catch (error) {
      return onError(error, req);
    }
  };
};

export const buildRoutes = (
  discovered: readonly DiscoveredRoute[],
  middleware: readonly Middleware[] = [],
  onError: ErrorMapper = defaultErrorMapper,
  cors?: CorsOptions,
  resolve: GuardResolver = construct,
): BunRoutes => {
  assertNoCollisions(discovered);
  const routes: BunRoutes = {};
  // One instance per guard class for the whole table - what the container returns,
  // and what the default resolver has to match to be interchangeable with it.
  const instances = new Map<Ctor<Middleware>, Middleware>();
  const guardOf = (guard: Ctor<Middleware>, from?: ModuleRef): Middleware => {
    const existing = instances.get(guard);
    if (existing) return existing;
    const created = resolve(guard, from);
    instances.set(guard, created);
    return created;
  };

  for (const route of discovered) {
    // Schemas, parsers, the status and the route context resolve here, once. What
    // survives into the request path is one closure that reads no metadata.
    const read = buildInputReader(route.options);
    const status = statusFor(route);
    /**
     * Global outermost, then the declaring module's middleware, then the controller's
     * guards, then the method's.
     *
     * There is no ancestor layer: a module's middleware applies to its own
     * controllers, so importing a module never changes the request path of the
     * importer's routes.
     */
    const chain = [
      ...middleware,
      ...(route.moduleMiddleware ?? []).map((entry) =>
        guardOf(entry, route.module),
      ),
      ...(route.guards ?? []).map((guard) => guardOf(guard, route.module)),
    ];
    const chained = compose(chain, buildContext(route), async (req) =>
      toResponse(await route.handler(await read(req)), status),
    );
    const guarded: RouteHandler = async (req) => {
      try {
        return await chained(req);
      } catch (error) {
        // The mapper builds a fresh Response, so the id the logging middleware
        // put on the one it returns is not on this one. Stamped here, where the
        // request that carries it is still in scope; a request that was never
        // given an id is left alone.
        return RequestIds.stamp(onError(error, req), req);
      }
    };

    const byMethod = (routes[route.path] ??= {});
    // Outside the error mapper, so a mapped 500 still carries the CORS headers the
    // browser needs in order to show it.
    byMethod[route.method] = cors
      ? withCors(cors, guarded)
      : directOr(guarded, route, read, status, onError, chain.length === 0);
  }

  if (cors) {
    for (const byMethod of Object.values(routes)) {
      byMethod.OPTIONS = preflight(cors, Object.keys(byMethod));
    }
  }

  return routes;
};
