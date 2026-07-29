import { prefixOf, routeMetaOf, type HttpMethod } from './marker.js';
import type { RouteInput, RouteSchemas } from './schema.js';

export interface DiscoveredRoute {
  readonly method: HttpMethod;
  readonly path: string;
  readonly controller: string;
  readonly handlerName: string;
  readonly handler: (input: RouteInput) => unknown;
  /** Schemas and status from the decorator, carried through to `buildRoutes`. */
  readonly options?: RouteSchemas | undefined;
}

export const joinPath = (prefix: string, path: string): string => {
  const joined = `/${prefix}/${path}`.replace(/\/{2,}/g, '/');
  return joined.length > 1 ? joined.replace(/\/$/, '') : '/';
};

/**
 * Walks the prototype chain of a constructed controller and collects every marked
 * method. Most-derived wins on a repeated name; an undecorated override does not
 * shadow its decorated base, and dispatch still lands on the override because the
 * handler is bound off the instance.
 */
export const discoverRoutes = (
  instance: object,
): readonly DiscoveredRoute[] => {
  const klass = instance.constructor;
  const prefix = prefixOf(klass);
  const members = instance as Record<string, (input: RouteInput) => unknown>;
  const routes: DiscoveredRoute[] = [];
  const seen = new Set<string>();

  for (
    let proto = Object.getPrototypeOf(instance) as object | null;
    proto !== null && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto) as object | null
  ) {
    for (const [name, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(proto),
    )) {
      if (name === 'constructor' || seen.has(name)) continue;

      const meta = routeMetaOf(descriptor.value);
      if (!meta) continue;

      seen.add(name);
      routes.push({
        method: meta.method,
        path: joinPath(prefix, meta.path),
        controller: klass.name,
        handlerName: name,
        handler: members[name]!.bind(instance),
        options: meta.options,
      });
    }
  }

  return routes;
};
