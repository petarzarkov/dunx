import type { BunRequest, Server } from 'bun';
import {
  AppError,
  type App,
  type Ctor,
  type InjectionToken,
  type ShutdownSignal,
} from '@dunx/core';
import { joinPath, type DiscoveredRoute } from '../route/discover.js';
import type { WebSocketRuntime } from '../ws/adapter.js';
import { PubSub } from '../ws/pubsub.js';
import type { SocketData, SocketOptions } from '../ws/socket.js';
import { attachAddressSource, ClientAddress } from './client-address.js';
import type { CorsOptions } from './cors.js';
import { defaultErrorMapper, type ErrorMapper } from './errors.js';
import type { Middleware } from './middleware.js';
import {
  assertNoGatewayCollisions,
  buildRoutes,
  withUpgradeRoutes,
} from './routes.js';
import { defaultSettings, type AppSettings } from './settings.js';

export interface HttpOptions {
  readonly port?: number;
  /** Resolved from the container, so middleware can inject(). */
  readonly middleware?: readonly Ctor<Middleware>[];
  readonly onError?: ErrorMapper;
  /**
   * Bun's `websocket` options, plus where a throwing handler goes. Server-wide, so
   * they live here next to `middleware` rather than on a module: gateways
   * themselves are declared in `@Module({ providers })`.
   */
  readonly websocket?: SocketOptions;
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
  /** Every gateway path this app upgrades on, exactly as mounted. */
  readonly gatewayPaths: readonly string[];
  listen(port?: number): Promise<string>;
}

export class HttpApplication implements HttpApp {
  readonly closed: Promise<void>;
  readonly gatewayPaths: readonly string[];
  readonly #app: App;
  readonly #discovered: readonly DiscoveredRoute[];
  readonly #middleware: Ctor<Middleware>[];
  readonly #settings: AppSettings = defaultSettings();
  readonly #onError: ErrorMapper;
  readonly #port: number;
  readonly #websocket: WebSocketRuntime | undefined;
  #globalPrefix = '';
  #cors: CorsOptions | undefined;
  #started = false;
  #server: Server<SocketData> | undefined;
  #resolveClosed: (() => void) | undefined;
  #shuttingDown: Promise<void> | undefined;
  #hooked = false;

  constructor(
    app: App,
    discovered: readonly DiscoveredRoute[],
    options: HttpOptions,
    websocket?: WebSocketRuntime,
  ) {
    this.#app = app;
    this.#discovered = discovered;
    this.#middleware = [...(options.middleware ?? [])];
    this.#onError = options.onError ?? defaultErrorMapper;
    this.#port = options.port ?? 3000;
    this.#websocket = websocket;
    this.gatewayPaths = websocket?.paths ?? [];
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

  /**
   * The one `Bun.serve` call. A gateway's upgrade is a native `GET` route in the
   * same table, so Bun's router — not a hand-written `fetch` fallback — is what
   * matches an upgrade, and no `fetch` handler is needed at all.
   */
  async listen(port = this.#port): Promise<string> {
    this.#assertNotStarted('listen()');
    this.#started = true;

    const middleware = this.#middleware.map((entry) => this.#app.get(entry));
    const prefixed = this.#prefixed();
    // A `@UseGuards` class comes from the container too, so a guard injects exactly
    // like global middleware does.
    const routes = buildRoutes(
      prefixed,
      middleware,
      this.#onError,
      this.#cors,
      (guard) => this.#app.get(guard),
    );

    const ws = this.#websocket;
    if (ws) assertNoGatewayCollisions(prefixed, ws.paths);

    // Two literals, one call: a route that may answer `undefined` because it
    // upgraded is only a valid route table when `websocket` is there to receive it,
    // and Bun's own types say so.
    const options: Bun.Serve.Options<SocketData> = ws
      ? {
          port,
          routes: withUpgradeRoutes(routes, ws.routes),
          websocket: ws.websocket,
        }
      : { port, routes };
    this.#server = Bun.serve(options);

    attachAddressSource(this.#app.get(ClientAddress), {
      server: this.#server,
      trustProxy: this.#settings['trust proxy'],
    });
    this.#app.get(PubSub).attach(this.#server);
    return this.#server.url.href;
  }

  // Not delegated to the core app: the server has to stop before providers tear
  // down, so the signal handler must land here. With a gateway the stop is forced —
  // a graceful stop waits for open connections and a WebSocket does not close on
  // its own, so it would hang. Those clients see a 1006 close.
  async shutdown(): Promise<void> {
    this.#shuttingDown ??= (async () => {
      await this.#server?.stop(this.#websocket !== undefined);
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
