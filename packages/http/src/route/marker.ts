// Symbol.for, so two copies of @dunx/http in a tree still agree on the key. The
// marker goes on the method function itself - nothing accumulates at class
// definition time, so there is no ordering dependence and no cross-file leak.
// See docs/architecture/http.md, "Route discovery".
import { HttpStatusCode } from '../server/status.js';
import type { RouteSchemas } from './schema.js';

const ROUTE = Symbol.for('dunx.route');
const CONTROLLER = Symbol.for('dunx.controller');

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * The success status a route answers with when `options.status` is absent.
 * `buildRoutes` and `@dunx/openapi`'s `statusOf` both read it, so the rule is
 * stated once rather than in each of them.
 */
export const defaultStatusFor = (method: HttpMethod): number =>
  method === 'POST' ? HttpStatusCode.CREATED : HttpStatusCode.OK;

/**
 * The type-level twin of {@link defaultStatusFor}, derived from the same constants
 * so the two cannot drift. `Returns` needs it to know which `response` entry a
 * handler is being held to.
 */
export type DefaultStatus<M extends HttpMethod> = M extends 'POST'
  ? typeof HttpStatusCode.CREATED
  : typeof HttpStatusCode.OK;

/**
 * A literal path, or a thunk read at **discovery** rather than at decoration.
 *
 * Discovery runs after every provider has settled, which is the whole point: a
 * path that came out of validated configuration is knowable by then even though
 * a decorator's arguments were evaluated long before the container existed.
 * `OpenApiModule.forRootAsync` is what needs it - it mounts its page and its
 * document where `ConfigService` says. The thunk is called once per discovery,
 * so it has to answer the same thing every time.
 */
export type RoutePath = string | (() => string);

export interface RouteMeta {
  readonly method: HttpMethod;
  readonly path: RoutePath;
  /** The decorator's second argument. `buildRoutes` resolves it once, at boot. */
  readonly options?: RouteSchemas | undefined;
}

export const resolvePath = (path: RoutePath): string =>
  typeof path === 'function' ? path() : path;

interface RouteMarked {
  readonly [ROUTE]?: RouteMeta;
}

interface ControllerMarked {
  readonly [CONTROLLER]?: string;
}

export const markRoute = (target: object, meta: RouteMeta): void => {
  Object.defineProperty(target, ROUTE, { value: meta, configurable: true });
};

export const routeMetaOf = (value: unknown): RouteMeta | undefined =>
  typeof value === 'function' ? (value as RouteMarked)[ROUTE] : undefined;

export const markController = (target: object, prefix: string): void => {
  Object.defineProperty(target, CONTROLLER, {
    value: prefix,
    configurable: true,
  });
};

// Plain lookup, not Object.hasOwn: a subclass inherits its base's prefix, so two
// subclasses of one decorated base collide loudly instead of silently mounting at
// the root.
export const prefixOf = (target: object): string =>
  (target as ControllerMarked)[CONTROLLER] ?? '';
