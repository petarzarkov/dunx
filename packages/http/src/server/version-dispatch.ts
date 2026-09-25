import type { DiscoveredRoute } from '../route/discover.js';
import type { RouteVersioning } from '../route/version.js';
import type { CorsOptions } from './cors.js';
import type { ServedHandler } from './middleware.js';
import type { BunRoutes } from './routes.js';
import { withResponseStamp } from './security-headers.js';

/** What a header or media-type table entry needs besides its handlers. */
export interface VersionSelection {
  readonly versioning: RouteVersioning;
  /** The app's `fetch` fallback, so an unknown version is the app's own 404. */
  readonly miss: ServedHandler;
}

interface Group {
  readonly route: DiscoveredRoute;
  neutral?: ServedHandler;
  readonly versions: Map<string, ServedHandler>;
}

/** Appends `name` to `Vary` unless it is already listed. */
const appendVary = (response: Response, name: string): Response => {
  const listed = (response.headers.get('vary') ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase());
  if (!listed.includes(name.toLowerCase()) && !listed.includes('*')) {
    response.headers.append('vary', name);
  }
  return response;
};

/**
 * One table entry for every version of a path and method. Bun has already
 * matched the path and the method, so this is not path routing: it reads one
 * header and picks from a `Map` built at boot, the way `AuthHandler` hands a
 * matched request to better-auth. Synchronous when the chosen handler is.
 *
 * An exact version wins, then a `VERSION_NEUTRAL` handler on the same path. A
 * request naming no version gets `defaultVersion`. Anything else falls through
 * to the app's 404, as Nest's `next()` does.
 */
const select = (
  group: Group,
  { versioning, miss }: VersionSelection,
  header: string,
): ServedHandler => {
  const { versions, neutral } = group;
  const unknown = neutral ?? miss;
  const fallback =
    versioning.defaults
      .map((version) => versions.get(version))
      .find((handler) => handler !== undefined) ?? unknown;

  return withResponseStamp(
    (response) => appendVary(response, header),
    (req, server) => {
      const requested = versioning.requested(req);
      const handler =
        requested === undefined
          ? fallback
          : (versions.get(requested) ?? unknown);
      return handler(req, server);
    },
  );
};

/**
 * Puts each built handler in the table. Under header and media-type
 * versioning the versions of one path and method become one entry.
 */
export const mountHandlers = (
  entries: readonly (readonly [DiscoveredRoute, ServedHandler])[],
  routes: BunRoutes,
  selection?: VersionSelection,
): void => {
  const header = selection?.versioning.header;
  if (selection === undefined || header === undefined) {
    for (const [route, handler] of entries) {
      (routes[route.path] ??= {})[route.method] = handler;
    }
    return;
  }

  const groups = new Map<string, Group>();
  for (const [route, handler] of entries) {
    const key = `${route.method} ${route.path}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = { route, versions: new Map() };
      groups.set(key, group);
    }
    if (route.version === undefined) group.neutral = handler;
    else group.versions.set(route.version, handler);
  }
  for (const group of groups.values()) {
    const { path, method } = group.route;
    (routes[path] ??= {})[method] =
      group.versions.size === 0
        ? group.neutral!
        : select(group, selection, header);
  }
};

/**
 * A preflight must admit the version header, or a browser never sends it. An
 * echoed `Access-Control-Request-Headers` already does; a fixed list gains it.
 */
export const corsForVersions = (
  cors: CorsOptions,
  versioning: RouteVersioning | undefined,
): CorsOptions => {
  const header = versioning?.type === 'header' ? versioning.header : undefined;
  if (header === undefined || cors.allowedHeaders === undefined) return cors;
  return { ...cors, allowedHeaders: [...cors.allowedHeaders, header] };
};
