import type { Ctor } from '@dunx/core';
import type { Middleware } from '../server/middleware.js';
import {
  prefixOf,
  resolvePath,
  routeMetaOf,
  type HttpMethod,
} from './marker.js';
import { guardsOf, mergeMeta, metaOf, type MetaRecord } from './metadata.js';
import type { RouteInput, RouteSchemas } from './schema.js';

export interface DiscoveredRoute {
  readonly method: HttpMethod;
  readonly path: string;
  readonly controller: string;
  readonly handlerName: string;
  readonly handler: (input: RouteInput) => unknown;
  /** Schemas and status from the decorator, carried through to `buildRoutes`. */
  readonly options?: RouteSchemas | undefined;
  /** The class's metadata merged under the handler's, which wins. Resolved here, once. */
  readonly meta?: MetaRecord | undefined;
  /**
   * The class's own record, unmerged. `meta` above is the resolved view, where a
   * handler's value **replaces** the class's - which is what `@Roles` and
   * `@Public` want and what a value composed of independent fields does not:
   * `@ApiDoc`'s class-level `tags` have to survive a method-level `summary`, and
   * a per-field merge cannot be recovered from an already-collapsed record.
   */
  readonly classMeta?: MetaRecord | undefined;
  /** Class-level `@UseGuards` first, then method-level. `buildRoutes` resolves them. */
  readonly guards?: readonly Ctor<Middleware>[] | undefined;
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
  const classGuards = guardsOf(klass);
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
      // The marked function, not the instance member: a decorator wrote onto this
      // object, and it is the only place its metadata can have come from.
      const marked = descriptor.value as object;
      routes.push({
        method: meta.method,
        path: joinPath(prefix, resolvePath(meta.path)),
        controller: klass.name,
        handlerName: name,
        handler: members[name]!.bind(instance),
        options: meta.options,
        meta: mergeMeta(klass, marked),
        classMeta: metaOf(klass),
        guards: [...classGuards, ...guardsOf(marked)],
      });
    }
  }

  return routes;
};
