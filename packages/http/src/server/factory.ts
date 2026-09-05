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
import { HttpApplication, type HttpApp } from './application.js';
import type { HttpOptions } from './options.js';
import {
  DefaultHttpOptions,
  HttpOptionsProvider,
  resolveHttpOptions,
} from './options-provider.js';
import type { Middleware } from './middleware.js';
import { RequestLoggingMiddleware } from './request-logging.js';
import { assertNoCollisions } from './routes.js';

export type { HttpApp } from './application.js';
export type { HttpOptions } from './options.js';

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

/**
 * The caller's logging options if it gave any, else the provider's, and `{}` for
 * either `false` - which switches the middleware off in the chain rather than
 * changing how it behaves once it is there.
 */
const pick = <T extends object>(
  given: boolean | T | undefined,
  fallback: boolean | T,
): T | Record<string, never> => {
  const chosen = given ?? fallback;
  return typeof chosen === 'object' ? chosen : {};
};

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
        settings: HttpOptionsProvider,
        metrics: RequestMetrics,
      ) =>
        new RequestLoggingMiddleware(
          logger,
          context,
          // The same precedence the merge below uses, applied here because this
          // provider is constructed during resolution and the merged object does
          // not exist until after it.
          pick(options.requestLogging, settings.requestLogging),
          // Handed in only when asked for, so the observe call is a branch the
          // default configuration never takes. Same precedence again.
          (options.metrics ?? settings.metrics) ? metrics : undefined,
        ),
      inject: [
        Logger,
        RequestContext,
        HttpOptionsProvider,
        RequestMetrics,
      ] as const,
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
      useFactory: (
        logger: Logger,
        context: RequestContext,
        settings: HttpOptionsProvider,
      ) =>
        new SocketLoggingMiddleware(
          logger,
          context,
          pick(options.socketLogging, settings.socketLogging),
        ),
      inject: [Logger, RequestContext, HttpOptionsProvider] as const,
    });

    // `RequestMetrics` is bound here rather than left to self-bind for the
    // reason `ClientAddress` is: `listen()` hands one instance the live server,
    // and a second scope resolving its own would read `pendingRequests` off no
    // server at all.
    const services = [PubSub, ClientAddress, RequestMetrics];
    /**
     * Every middleware is bound unconditionally, which is what unties the
     * ordering knot the options provider was blocked on: `requestLogging: false`
     * used to decide whether the provider was bound at all, and that decision had
     * to be made before the container existed. Whether one is in the chain is now
     * `HttpApplication`'s to read off the resolved options. Binding one that is
     * never used costs a constructor call at boot.
     */
    const providers = [...services, logging, metricsMiddleware, socketLogging];
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
    const app = await AppFactory.create(scope, {
      ...(options.overrides ? { overrides: options.overrides } : {}),
      /**
       * Promoted rather than bound in this scope, which is what core does with
       * `Logger`. Binding it here would put it in `HttpModule`'s own map and
       * export it to the root, so an app declaring its own subclass would be
       * warned for shadowing a token it is meant to shadow - and the http scope
       * would keep resolving its own default anyway.
       */
      promote: [provide(HttpOptionsProvider, { useClass: DefaultHttpOptions })],
    });
    // Resolved after the container, which is the whole point: a subclass can inject
    // `ConfigService` and answer from validated config. Anything the caller passed
    // to `create` still wins, field by field.
    const resolved = resolveHttpOptions(
      app.get(HttpOptionsProvider, root),
      options,
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
            resolved.websocket,
            HttpFactory.#socketMiddleware(app, root, resolved),
          )
        : undefined;

    // Boot warnings go out here for the same reason the container's own do: they
    // are about the wiring, and the app that wired it is about to start serving.
    for (const warning of websocket?.warnings ?? []) {
      app.get(Logger).warn(warning);
    }
    // A second port needs something to serve on it. Silently binding nothing
    // would leave an operator's firewall rule pointing at a closed port.
    if (
      resolved.gatewayPort !== undefined &&
      resolved.gatewayPort !== 0 &&
      websocket === undefined
    ) {
      app
        .get(Logger)
        .warn(
          `gatewayPort is set and no gateway is declared, so no second server ` +
            `binds and gatewayUrl stays undefined. Declare a @Gateway in a ` +
            `module's providers, or drop gatewayPort.`,
        );
    }
    /**
     * A websocket upgrade is an HTTP/1.1 request, so a server refusing HTTP/1.x
     * refuses every gateway on it. Bun answers 505 and the connection never
     * opens, and the upgrade never reaches dunx, so nothing is logged per
     * request either: the app looks healthy and its gateways are unreachable.
     *
     * An error rather than a warning because the configuration cannot be right.
     * `gatewayPort` moves the upgrades to a second `Bun.serve` that keeps
     * HTTP/1.1, which is the one shape that makes the pair work.
     */
    if (
      resolved.http1 === false &&
      websocket !== undefined &&
      resolved.gatewayPort === undefined
    ) {
      // Best effort: a provider whose `onShutdown` rejects must not replace the
      // configuration error with a teardown one.
      await app.shutdown().catch(() => undefined);
      throw new AppError(
        `http1: false refuses HTTP/1.x with a 505, and a websocket upgrade is an ` +
          `HTTP/1.1 request - so nothing could ever connect to ` +
          `${websocket.paths.join(', ')}. Set gatewayPort to serve the gateways ` +
          'from a second port that keeps HTTP/1.1, or drop http1: false.',
      );
    }

    // `root` is the app's own module, so global middleware and the error filter
    // resolve as the app sees them rather than as this wrapper does.
    return new HttpApplication(app, discovered, resolved, root, websocket);
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
