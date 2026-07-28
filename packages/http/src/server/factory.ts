import type { Server } from 'bun';
import {
  collectModules,
  AppError,
  AppFactory,
  readControllers,
  type App,
  type Ctor,
  type InjectionToken,
  type ModuleClass,
  type ShutdownSignal,
} from '@dunx/core';
import { discoverRoutes, type DiscoveredRoute } from '../route/discover.js';
import { defaultErrorMapper, type ErrorMapper } from './errors.js';
import type { Middleware } from './middleware.js';
import { buildRoutes, type BunRoutes } from './routes.js';

export interface HttpOptions {
  readonly port?: number;
  /** Resolved from the container, so middleware can inject(). */
  readonly middleware?: readonly Ctor<Middleware>[];
  readonly onError?: ErrorMapper;
}

export interface HttpApp extends App {
  listen(port?: number): Promise<string>;
}

class HttpApplication implements HttpApp {
  readonly closed: Promise<void>;
  readonly #app: App;
  readonly #routes: BunRoutes;
  readonly #port: number;
  #server: Server<unknown> | undefined;
  #resolveClosed: (() => void) | undefined;
  #shuttingDown: Promise<void> | undefined;
  #hooked = false;

  constructor(app: App, routes: BunRoutes, port: number) {
    this.#app = app;
    this.#routes = routes;
    this.#port = port;
    this.closed = new Promise<void>((resolve) => {
      this.#resolveClosed = resolve;
    });
  }

  get<T>(token: InjectionToken<T>): T {
    return this.#app.get(token);
  }

  async listen(port = this.#port): Promise<string> {
    this.#server = Bun.serve({ port, routes: this.#routes });
    return this.#server.url.href;
  }

  // Not delegated to the core app: the server has to stop before providers tear
  // down, so the signal handler must land here.
  async shutdown(): Promise<void> {
    this.#shuttingDown ??= (async () => {
      await this.#server?.stop();
      this.#server = undefined;
      await this.#app.shutdown();
      this.#resolveClosed?.();
    })();
    return this.#shuttingDown;
  }

  enableShutdownHooks(
    signals: readonly ShutdownSignal[] = ['SIGTERM', 'SIGINT'],
  ): this {
    if (this.#hooked) return this;
    this.#hooked = true;
    for (const signal of signals) {
      process.once(signal, () => void this.shutdown());
    }
    return this;
  }
}

export class HttpFactory {
  /**
   * Boots the container, discovers every controller's routes, detects collisions,
   * and emits the object handed to `Bun.serve`. Nothing is read per request.
   */
  static async create(
    root: ModuleClass,
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

    const middleware = (options.middleware ?? []).map((entry) =>
      app.get(entry),
    );
    const routes = buildRoutes(
      discovered,
      middleware,
      options.onError ?? defaultErrorMapper,
    );

    return new HttpApplication(app, routes, options.port ?? 3000);
  }
}
