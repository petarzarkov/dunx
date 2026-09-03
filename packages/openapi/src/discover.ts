import {
  collectModules,
  inertInstance,
  readControllers,
  type ModuleRef,
} from '@dunx/core';
import { HIDDEN } from '@dunx/http';
import { discoverRoutes, type DiscoveredRoute } from '@dunx/http/internal';

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
      for (const route of discoverRoutes(inertInstance(controller))) {
        if (route.meta?.get(HIDDEN.id) === true) continue;
        routes.push(route);
      }
    }
  }

  return routes;
};
