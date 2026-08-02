import { collectModules, readControllers, type ModuleRef } from '@dunx/core';
import { discoverRoutes, HIDDEN, type DiscoveredRoute } from '@dunx/http';

interface Prototyped {
  readonly prototype: object;
}

/**
 * Every route a module graph declares, read without constructing a thing.
 *
 * `discoverRoutes` walks an instance's prototype chain looking for marked methods,
 * and `Object.create(Controller.prototype)` is that chain with nothing behind it:
 * `instance.constructor` still resolves to the class, every method is still
 * reachable, and no constructor - or dependency of one - has to exist. Generation
 * reads metadata; it never calls a handler.
 */
export const describeRoutes = (root: ModuleRef): readonly DiscoveredRoute[] => {
  const routes: DiscoveredRoute[] = [];

  for (const module of collectModules(root)) {
    for (const controller of readControllers(module)) {
      const { prototype } = controller as unknown as Prototyped;
      for (const route of discoverRoutes(Object.create(prototype) as object)) {
        if (route.meta?.get(HIDDEN.id) === true) continue;
        routes.push(route);
      }
    }
  }

  return routes;
};
