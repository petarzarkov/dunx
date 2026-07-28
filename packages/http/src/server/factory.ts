import {
  collectModules,
  AppError,
  AppFactory,
  readControllers,
  type ModuleRef,
} from '@dunx/core';
import { discoverRoutes, type DiscoveredRoute } from '../route/discover.js';
import {
  HttpApplication,
  type HttpApp,
  type HttpOptions,
} from './application.js';
import { assertNoCollisions } from './routes.js';

export type { HttpApp, HttpOptions } from './application.js';

export class HttpFactory {
  /**
   * Boots the container, discovers every controller's routes and rejects a
   * collision. The `Bun.serve` route table itself is built by `listen()`, so
   * `setGlobalPrefix`, `use`, `set` and `enableCors` can still affect it.
   */
  static async create(
    root: ModuleRef,
    options: HttpOptions = {},
  ): Promise<HttpApp> {
    const app = await AppFactory.create(root);

    const discovered: DiscoveredRoute[] = [];
    for (const module of collectModules(root)) {
      for (const controller of readControllers(module)) {
        const routes = discoverRoutes(app.get(controller) as object);
        if (routes.length === 0) {
          throw new AppError(
            `${controller.name} is registered as a controller but declares no routes. ` +
              'Add a @Get/@Post/... method, or move it to providers.',
          );
        }
        discovered.push(...routes);
      }
    }
    // Eagerly, so a wiring error still surfaces from create() rather than waiting
    // for listen(). A uniform global prefix cannot introduce a new one.
    assertNoCollisions(discovered);

    return new HttpApplication(app, discovered, options);
  }
}
