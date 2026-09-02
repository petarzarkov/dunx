import {
  collectModules,
  AppError,
  AppFactory,
  Logger,
  provide,
  readControllers,
  RequestContext,
  type Ctor,
  type DynamicModule,
  type ModuleRef,
} from '@dunx/core';
import { discoverRoutes, type DiscoveredRoute } from '../route/discover.js';
import { ClientAddress } from './client-address.js';
import { MetricsMiddleware, RequestMetrics } from './metrics.js';
import { buildWebSocket } from '../ws/adapter.js';
import { discoverGateways } from '../ws/discover.js';
import { SocketLoggingMiddleware } from '../ws/logging.js';
import type { SocketMiddleware } from '../ws/middleware.js';
import { PubSub } from '../ws/pubsub.js';
import {
  HttpApplication,
  type HttpApp,
  type HttpOptions,
} from './application.js';
import type { Middleware } from './middleware.js';
import { RequestLoggingMiddleware } from './request-logging.js';
import { assertNoCollisions } from './routes.js';

export type { HttpApp, HttpOptions } from './application.js';

// Bound around the user's root so `PubSub` is injectable without importing
// anything. Its name is what a duplicate binding of PubSub would be reported
// against, which is why it is a named class and not an object literal.
//
// `global: true` is what makes that "without importing anything" true under module
// scoping. This module *imports* the root rather than being imported by it, and
// visibility only flows from an import's exports to its importer - so without global
// these bindings would be invisible to every module in the app, which is the opposite
// of the intent. They are framework services with no module for an app to import.
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
    // Bound here rather than left to self-binding, because its constructor takes
    // the options object as well as two injectables. `Logger` and
    // `RequestContext` always resolve: @dunx/core binds a default for each.
    const logging = provide(RequestLoggingMiddleware, {
      useFactory: (
        logger: Logger,
        context: RequestContext,
        metrics: RequestMetrics,
      ) =>
        new RequestLoggingMiddleware(
          logger,
          context,
          typeof options.requestLogging === 'object'
            ? options.requestLogging
            : {},
          // Handed in only when asked for, so the observe call is a branch the
          // default configuration never takes.
          options.metrics === true ? metrics : undefined,
        ),
      inject: [Logger, RequestContext, RequestMetrics] as const,
    });

    // `ClientAddress` belongs here for the same reason `PubSub` does: `listen()`
    // hands one instance the live server, and `app.clientIp(req)` is documented as
    // that instance. Left to self-binding it landed in whichever scope asked first,
    // so a second module injecting it was a boot error naming the first - and the
    // app's own `app.get(ClientAddress)` could then reach an instance no server was
    // ever attached to.
    // Bound explicitly for the reason the two logging middlewares are: a
    // framework class must resolve whether or not the app registered
    // `@dunx/transform`, and left to self-bind this one is a boot error naming a
    // preload the consumer may already have.
    const metricsMiddleware = provide(MetricsMiddleware, {
      useFactory: (metrics: RequestMetrics) => new MetricsMiddleware(metrics),
      inject: [RequestMetrics] as const,
    });

    // Bound for the same reason: its constructor takes an options object as well
    // as two injectables, so it cannot self-bind.
    const socketLogging = provide(SocketLoggingMiddleware, {
      useFactory: (logger: Logger, context: RequestContext) =>
        new SocketLoggingMiddleware(
          logger,
          context,
          typeof options.socketLogging === 'object'
            ? options.socketLogging
            : {},
        ),
      inject: [Logger, RequestContext] as const,
    });

    // `RequestMetrics` is bound here rather than left to self-bind for the
    // reason `ClientAddress` is: `listen()` hands one instance the live server,
    // and a second scope resolving its own would read `pendingRequests` off no
    // server at all.
    const services = [PubSub, ClientAddress, RequestMetrics];
    const providers = [
      ...services,
      ...(options.requestLogging === false ? [] : [logging]),
      ...(options.metrics === true && options.requestLogging === false
        ? [metricsMiddleware]
        : []),
      ...(options.socketLogging === false ? [] : [socketLogging]),
    ];
    const scope: DynamicModule = {
      module: HttpModule,
      global: true,
      imports: [root],
      providers,
      exports: providers.map((entry) =>
        typeof entry === 'function' ? entry : entry.token,
      ),
    };
    // Spread rather than passed through, because `exactOptionalPropertyTypes`
    // separates an absent `overrides` from one explicitly set to undefined.
    const app = await AppFactory.create(
      scope,
      options.overrides ? { overrides: options.overrides } : {},
    );
    const modules = collectModules(scope);

    const discovered: DiscoveredRoute[] = [];
    for (const module of modules) {
      // The module's own middleware, applied to the routes its controllers declare
      // and to nothing else. Carried on each route with the module it came from, so it
      // resolves from that module's scope rather than the app's root.
      const moduleMiddleware = module.options.middleware ?? [];
      for (const controller of readControllers(module)) {
        const routes = discoverRoutes(
          app.get(controller, module.ref) as object,
        );
        if (routes.length === 0) {
          throw new AppError(
            `${controller.name} is registered as a controller but declares no routes. ` +
              'Add a @Get/@Post/... method, or move it to providers.',
          );
        }
        discovered.push(
          ...routes.map((route) => ({
            ...route,
            module: module.ref,
            ...(moduleMiddleware.length === 0
              ? {}
              : {
                  moduleMiddleware:
                    moduleMiddleware as readonly Ctor<Middleware>[],
                }),
          })),
        );
      }
    }
    // Eagerly, so a wiring error still surfaces from create() rather than waiting
    // for listen(). A uniform global prefix cannot introduce a new one.
    assertNoCollisions(discovered);

    const gateways = discoverGateways(modules, (token) => app.get(token));
    // Handler collisions and two gateways on one path are boot errors too, and the
    // websocket object is built once here rather than per connection.
    //
    // The socket middleware chain is resolved here and not at `listen()`, because
    // `buildWebSocket` folds it into one closure per slot - the same trade the HTTP
    // route table makes, moved a phase earlier because the handler object is.
    const websocket =
      gateways.length > 0
        ? buildWebSocket(
            gateways,
            options.websocket,
            HttpFactory.#socketMiddleware(app, root, options),
          )
        : undefined;

    // Boot warnings go out here for the same reason the container's own do: they
    // are about the wiring, and the app that wired it is about to start serving.
    for (const warning of websocket?.warnings ?? []) {
      app.get(Logger).warn(warning);
    }

    // `root` is the app's own module, so global middleware and the error filter
    // resolve as the app sees them rather than as this wrapper does.
    return new HttpApplication(app, discovered, options, root, websocket);
  }

  /**
   * Logging outermost, then whatever the app declared - the order the HTTP chain
   * already uses, so a frame a guard refuses is still logged with the failure.
   *
   * Resolved permissively, like global HTTP middleware: the class is usually
   * declared by whichever feature module owns it, and pinning the lookup to the
   * root would make the app re-export every observer it lists.
   */
  static #socketMiddleware(
    app: { get<T>(token: Ctor<T>, from?: ModuleRef): T },
    root: ModuleRef,
    options: HttpOptions,
  ): readonly SocketMiddleware[] {
    const declared = options.socketMiddleware ?? [];
    const entries: readonly Ctor<SocketMiddleware>[] =
      options.socketLogging === false
        ? declared
        : [SocketLoggingMiddleware, ...declared];
    return entries.map((entry) => app.get(entry, root));
  }
}
