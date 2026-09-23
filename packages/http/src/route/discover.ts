import {
  AppError,
  markedMethods,
  type Ctor,
  type MarkedMethod,
  type ModuleRef,
} from '@dunx/core';
import type { Middleware } from '../server/middleware.js';
import {
  filterOf,
  prefixOf,
  resolvePath,
  routeMetaOf,
  type HttpMethod,
  type RouteMeta,
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
  /**
   * The module that declared this route's controller, and the middleware that module
   * declared - applied to these routes and to nothing else.
   *
   * Filled by `HttpFactory`, which is the only place that knows the module graph.
   * `module` is carried alongside so each entry resolves from **that module's scope**,
   * which is the whole point: module middleware can inject providers the module keeps
   * private.
   */
  readonly module?: ModuleRef | undefined;
  readonly moduleMiddleware?: readonly Ctor<Middleware>[] | undefined;
}

export const joinPath = (prefix: string, path: string): string => {
  const joined = `/${prefix}/${path}`.replace(/\/{2,}/g, '/');
  return joined.length > 1 ? joined.replace(/\/$/, '') : '/';
};

const applyFilter = (
  klass: { readonly name: string },
  marked: readonly MarkedMethod<RouteMeta>[],
): readonly MarkedMethod<RouteMeta>[] => {
  const filter = filterOf(klass);
  if (filter === undefined) return marked;

  const names = new Set(marked.map(({ name }) => name));
  // Checked at runtime too: an untyped caller's misspelt key would otherwise
  // leave the route it meant to hide being served.
  for (const [list, listed] of Object.entries(filter)) {
    if (list !== 'include' && list !== 'exclude') {
      throw new AppError(
        `${klass.name} passes ${list} to @Controller, which takes include and exclude.`,
      );
    }
    for (const name of (listed ?? []) as readonly string[]) {
      if (!names.has(name)) {
        throw new AppError(
          `${klass.name} lists ${name} in @Controller ${list}, but it is not a ` +
            'route handler. Name a method decorated with @Get/@Post/...',
        );
      }
    }
  }

  const { include, exclude } = filter;
  return marked.filter(
    ({ name }) =>
      (include === undefined || include.includes(name)) &&
      !exclude?.includes(name),
  );
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

  return applyFilter(
    klass,
    markedMethods(
      Object.getPrototypeOf(instance) as object | null,
      routeMetaOf,
    ),
    // `marked` is the function the decorator wrote onto, not the instance member:
    // it is the only place the rest of this route's metadata can have come from.
  ).map(({ name, meta, value: marked }) => ({
    method: meta.method,
    path: joinPath(prefix, resolvePath(meta.path)),
    controller: klass.name,
    handlerName: name,
    handler: members[name]!.bind(instance),
    options: meta.options,
    meta: mergeMeta(klass, marked),
    classMeta: metaOf(klass),
    guards: [...classGuards, ...guardsOf(marked)],
  }));
};
