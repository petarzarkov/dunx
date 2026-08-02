import type { DiscoveredRoute } from '../route/discover.js';
import type { HttpMethod } from '../route/marker.js';
import type { MetaKey, MetaRecord } from '../route/metadata.js';

/**
 * Which route the middleware is running for, and what that route's decorators
 * declared. `get` resolves the handler's metadata first and the controller class's
 * second - the usual override direction for handler-over-class metadata.
 */
export interface RouteContext {
  readonly controller: string;
  readonly handler: string;
  readonly method: HttpMethod;
  readonly path: string;
  get<T>(key: MetaKey<T>): T | undefined;
}

const EMPTY: MetaRecord = new Map();

/**
 * One frozen context per route, built when the table is built and closed over by
 * the chain. The merge already happened at discovery, so `get` is a Map lookup -
 * not a prototype walk, and nothing is read per request.
 */
export const buildContext = (route: DiscoveredRoute): RouteContext => {
  const record = route.meta ?? EMPTY;
  return Object.freeze({
    controller: route.controller,
    handler: route.handlerName,
    method: route.method,
    path: route.path,
    get: <T>(key: MetaKey<T>): T | undefined =>
      record.get(key.id) as T | undefined,
  });
};
