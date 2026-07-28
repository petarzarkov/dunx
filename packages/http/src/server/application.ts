import type { BunRequest, Server } from 'bun';
import {
  AppError,
  type App,
  type Ctor,
  type InjectionToken,
  type ShutdownSignal,
} from '@dunx/core';
import { joinPath, type DiscoveredRoute } from '../route/discover.js';
import { attachAddressSource, ClientAddress } from './client-address.js';
import type { CorsOptions } from './cors.js';
import { defaultErrorMapper, type ErrorMapper } from './errors.js';
import type { Middleware } from './middleware.js';
import { buildRoutes } from './routes.js';
import { defaultSettings, type AppSettings } from './settings.js';

export interface HttpOptions {
  readonly port?: number;
  /** Resolved from the container, so middleware can inject(). */
  readonly middleware?: readonly Ctor<Middleware>[];
  readonly onError?: ErrorMapper;
}

/**
 * Everything below `listen()` configures the route table, which is built exactly
 * once — when the server binds. Calling any of them afterwards throws rather than
 * being quietly dropped.
 */
export interface HttpApp extends App {
  /** Prefixes every discovered route. Last call wins. */
  setGlobalPrefix(prefix: string): this;
  /** Appends middleware, after anything `HttpOptions.middleware` declared. */
  use(...middleware: readonly Ctor<Middleware>[]): this;
  set<K extends keyof AppSettings>(key: K, value: AppSettings[K]): this;
  setting<K extends keyof AppSettings>(key: K): AppSettings[K];
  /** Mounts an `OPTIONS` preflight per path. Last call wins. */
  enableCors(options?: CorsOptions): this;
  /** The same `inject(ClientAddress)` singleton — honours `'trust proxy'`. */
  clientIp(req: BunRequest): string | undefined;
  listen(port?: number): Promise<string>;
}

export class HttpApplication implements HttpApp {
  readonly closed: Promise<void>;
  readonly #app: App;
  readonly #discovered: readonly DiscoveredRoute[];
  readonly #middleware: Ctor<Middleware>[];
  readonly #settings: AppSettings = defaultSettings();
  readonly #onError: ErrorMapper;
  readonly #port: number;
  #globalPrefix = '';
  #cors: CorsOptions | undefined;
  #started = false;
  #server: Server<unknown> | undefined;
  #resolveClosed: (() => void) | undefined;
  #shuttingDown: Promise<void> | undefined;
  #hooked = false;

  constructor(
    app: App,
    discovered: readonly DiscoveredRoute[],
    options: HttpOptions,
  ) {
    this.#app = app;
    this.#discovered = discovered;
    this.#middleware = [...(options.middleware ?? [])];
    this.#onError = options.onError ?? defaultErrorMapper;
    this.#port = options.port ?? 3000;
    this.closed = new Promise<void>((resolve) => {
      this.#resolveClosed = resolve;
    });
  }

  get<T>(token: InjectionToken<T>): T {
    return this.#app.get(token);
  }

  setGlobalPrefix(prefix: string): this {
    this.#assertNotStarted('setGlobalPrefix()');
    this.#globalPrefix = prefix;
    return this;
  }

  use(...middleware: readonly Ctor<Middleware>[]): this {
    this.#assertNotStarted('use()');
    this.#middleware.push(...middleware);
    return this;
  }

  set<K extends keyof AppSettings>(key: K, value: AppSettings[K]): this {
    this.#assertNotStarted('set()');
    this.#settings[key] = value;
    return this;
  }

  setting<K extends keyof AppSettings>(key: K): AppSettings[K] {
    return this.#settings[key];
  }

  enableCors(options: CorsOptions = {}): this {
    this.#assertNotStarted('enableCors()');
    this.#cors = options;
    return this;
  }

  clientIp(req: BunRequest): string | undefined {
    return this.#app.get(ClientAddress).of(req);
  }

  async listen(port = this.#port): Promise<string> {
    this.#assertNotStarted('listen()');
    this.#started = true;

    const middleware = this.#middleware.map((entry) => this.#app.get(entry));
    const routes = buildRoutes(
      this.#prefixed(),
      middleware,
      this.#onError,
      this.#cors,
    );

    this.#server = Bun.serve({ port, routes });
    attachAddressSource(this.#app.get(ClientAddress), {
      server: this.#server,
      trustProxy: this.#settings['trust proxy'],
    });
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

  // Collision detection re-runs inside buildRoutes on these final paths.
  #prefixed(): readonly DiscoveredRoute[] {
    if (this.#globalPrefix === '') return this.#discovered;
    return this.#discovered.map((route) => ({
      ...route,
      path: joinPath(this.#globalPrefix, route.path),
    }));
  }

  // #started rather than #server, which shutdown() clears — a hook called after
  // the server stopped is just as ineffective as one called while it ran.
  #assertNotStarted(hook: string): void {
    if (!this.#started) return;
    throw new AppError(
      `${hook} must be called before listen(). The route table and the middleware ` +
        'chain are folded into one closure per route when the server binds, so ' +
        'this call could not take effect.',
    );
  }
}
