import {
  collectModules,
  AppError,
  AppFactory,
  readControllers,
  type DynamicModule,
  type ModuleRef,
} from '@dunx/core';
import { discoverRoutes, type DiscoveredRoute } from '../route/discover.js';
import { buildWebSocket } from '../ws/adapter.js';
import { discoverGateways } from '../ws/discover.js';
import { PubSub } from '../ws/pubsub.js';
import {
  HttpApplication,
  type HttpApp,
  type HttpOptions,
} from './application.js';
import { assertNoCollisions } from './routes.js';

export type { HttpApp, HttpOptions } from './application.js';

// Bound around the user's root so `PubSub` is injectable without importing
// anything. Its name is what a duplicate binding of PubSub would be reported
// against, which is why it is a named class and not an object literal.
class HttpModule {}

export class HttpFactory {
  /**
   * Boots the container, discovers every controller's routes and every gateway's
   * handlers, and rejects a collision in either. The `Bun.serve` route table itself
   * is built by `listen()`, so `setGlobalPrefix`, `use`, `set` and `enableCors` can
   * still affect it.
   */
  static async create(
    root: ModuleRef,
    options: HttpOptions = {},
  ): Promise<HttpApp> {
    const scope: DynamicModule = {
      module: HttpModule,
      imports: [root],
      providers: [PubSub],
    };
    const app = await AppFactory.create(scope);
    const modules = collectModules(scope);

    const discovered: DiscoveredRoute[] = [];
    for (const module of modules) {
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

    const gateways = discoverGateways(modules, (token) => app.get(token));
    // Handler collisions and two gateways on one path are boot errors too, and the
    // websocket object is built once here rather than per connection.
    const websocket =
      gateways.length > 0
        ? buildWebSocket(gateways, options.websocket)
        : undefined;

    return new HttpApplication(app, discovered, options, websocket);
  }
}
