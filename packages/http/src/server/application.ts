import type { BunRequest, Server } from 'bun';
import {
  AppError,
  Logger,
  runtimeInfo,
  ShutdownHooks,
  teardownError,
  teardownFailures as toFailures,
  type App,
  type AppOptions,
  type Ctor,
  type InjectionToken,
  type ModuleRef,
  type ShutdownHookOptions,
  type ShutdownSignal,
} from '@dunx/core';
import { joinPath, type DiscoveredRoute } from '../route/discover.js';
import type { WebSocketRuntime } from '../ws/adapter.js';
import { PubSub } from '../ws/pubsub.js';
import type { SocketLoggingOptions } from '../ws/logging.js';
import type { SocketMiddleware } from '../ws/middleware.js';
import type { PubSubRelay, RelayOptions, RelayPhase } from '../ws/relay.js';
import type { SocketData, SocketOptions } from '../ws/socket.js';
import { attachAddressSource, ClientAddress } from './client-address.js';
import {
  MetricsMiddleware,
  RequestMetrics,
  usesMetricsMiddleware,
} from './metrics.js';
import type { CorsOptions } from './cors.js';
import {
  errorMapper,
  toErrorMapper,
  type ErrorHandler,
  type ErrorMapper,
} from './errors.js';
import type { Middleware } from './middleware.js';
import {
  RequestLoggingMiddleware,
  type RequestLoggingOptions,
} from './request-logging.js';
import {
  assertNoGatewayCollisions,
  buildFallback,
  buildRoutes,
  withUpgradeRoutes,
} from './routes.js';
import { defaultSettings, type AppSettings } from './settings.js';

export interface HttpOptions extends AppOptions {
  readonly port?: number;
  /**
   * Prefixes every discovered route, the same thing {@link HttpApp.setGlobalPrefix}
   * does. Both exist: the method is what NestJS offers and what a script reaches
   * for, the field is what an `HttpOptionsProvider` can answer from validated
   * config. A later `setGlobalPrefix` call still wins, because it happens after.
   *
   * Explicitly `| undefined`, unlike the rest: a suite running one fixture both
   * prefixed and unprefixed passes a variable here, and under
   * `exactOptionalPropertyTypes` that would otherwise need a conditional spread.
   * "No prefix" and "absent" mean the same thing. `@dunx/testing` relies on it.
   */
  readonly prefix?: string | undefined;
  /** Mounts an `OPTIONS` preflight per path, as {@link HttpApp.enableCors} does. */
  readonly cors?: CorsOptions;
  /** `app.set('trust proxy', ...)` as a field. */
  readonly trustProxy?: boolean;
  /**
   * Calls `enableShutdownHooks` at construction. `true` takes the default signals;
   * an object names them and tunes the force-exit.
   */
  readonly shutdownHooks?:
    | boolean
    | {
        readonly signals?: readonly ShutdownSignal[];
        readonly options?: ShutdownHookOptions;
      };
  /** Resolved from the container, so middleware can inject(). */
  readonly middleware?: readonly Ctor<Middleware>[];
  /**
   * Replaces the default mapper. Prefer an `ErrorFilter` class over a bare
   * `ErrorMapper`: a class is resolved from the container and can inject.
   */
  readonly onError?: ErrorHandler;
  /**
   * One structured entry per request, on by default and outermost, so a request
   * a guard rejected is still logged with the status it got.
   * See {@link RequestLoggingMiddleware}.
   */
  readonly requestLogging?: boolean | RequestLoggingOptions;
  /**
   * Count requests and time them per route, readable through
   * {@link RequestMetrics}. Off by default; `+35.2 ns` per request when
   * `requestLogging` is on, because the entry it already builds shares the
   * timing. With `requestLogging: false` a `MetricsMiddleware` pays for its own
   * `.then` instead, at +175.9 ns.
   */
  readonly metrics?: boolean;
  /**
   * One entry at `listen()` naming every route and gateway served. On by default,
   * and switched separately from `requestLogging`: one is per process, the other
   * per request. `@dunx/testing` defaults it off.
   */
  readonly bootLogging?: boolean;
  /** Bun's `websocket` options, plus where a throwing handler goes. Server-wide;
   * gateways themselves are declared in `@Module({ providers })`. */
  readonly websocket?: SocketOptions;
  /**
   * The socket half of `middleware`. Each entry wraps every dispatched gateway
   * handler; `socketLogging`'s runs outermost, ahead of anything here.
   */
  readonly socketMiddleware?: readonly Ctor<SocketMiddleware>[];
  /**
   * One structured entry per socket frame, on by default at `debug` - a gateway
   * can take a frame per connection per tick, so it writes nothing until an app
   * lowers its level. See {@link SocketLoggingMiddleware}.
   */
  readonly socketLogging?: boolean | SocketLoggingOptions;
  /**
   * Multi-node websocket fan-out. Absent means `PubSub` publishes to this process
   * only. Anything with `publish` and `subscribe` fits; one that has to come out
   * of the container goes through `app.get(PubSub).relayThrough(...)` instead.
   */
  readonly relay?: PubSubRelay;
  /** The broker channel the relay carries frames on. @default 'dunx:ws' */
  readonly relayChannel?: string;
  /**
   * How hard to retry a failed subscribe. Bounded, doubling, on an unref'd timer,
   * so a broker that never returns cannot hold the process open.
   */
  readonly relayResubscribe?: RelayOptions['resubscribe'];
  /**
   * What an unmatched path looks like to global middleware. `'guarded'` gives the
   * miss no route metadata, so a global guard refuses it and a prober cannot tell
   * a 404 from a 401. `'public'` reports it as `@Public()` for a conventional 404.
   * Either way `UNMATCHED` is set, which no real route sets.
   *
   * @default 'guarded'
   */
  readonly notFound?: 'guarded' | 'public';
}

/**
 * Everything below `listen()` configures the route table, built once when the
 * server binds. Calling any of them afterwards throws.
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
  /** The same `inject(ClientAddress)` singleton - honours `'trust proxy'`. */
  clientIp(req: BunRequest): string | undefined;
  /** Every gateway path this app upgrades on, exactly as mounted. */
  readonly gatewayPaths: readonly string[];
  listen(port?: number): Promise<string>;
}

export class HttpApplication implements HttpApp {
  /** Forwarded from the container so an app can log scope warnings at boot. */
  readonly warnings: readonly string[];
  /**
   * The app's own root module, not this package's wrapper. Resolving from the
   * wrapper would limit a guard to what the app happened to export.
   */
  readonly #root: ModuleRef;
  readonly closed: Promise<void>;
  readonly gatewayPaths: readonly string[];
  readonly #app: App;
  readonly #discovered: readonly DiscoveredRoute[];
  readonly #middleware: Ctor<Middleware>[];
  readonly #settings: AppSettings = defaultSettings();
  readonly #onError: ErrorMapper;
  readonly #port: number;
  readonly #websocket: WebSocketRuntime | undefined;
  readonly #relay: PubSubRelay | undefined;
  readonly #relayChannel: string | undefined;
  readonly #relayResubscribe: RelayOptions['resubscribe'];
  readonly #notFound: 'guarded' | 'public';
  readonly #bootLogging: boolean;
  #globalPrefix = '';
  #cors: CorsOptions | undefined;
  #started = false;
  #server: Server<SocketData> | undefined;
  #resolveClosed: (() => void) | undefined;
  #shuttingDown: Promise<void> | undefined;
  readonly #hooks = new ShutdownHooks();

  constructor(
    app: App,
    discovered: readonly DiscoveredRoute[],
    options: HttpOptions,
    root: ModuleRef,
    websocket?: WebSocketRuntime,
  ) {
    this.#app = app;
    this.#root = root;
    this.warnings = app.warnings;
    this.#discovered = discovered;
    this.#middleware = [
      ...(options.requestLogging === false ? [] : [RequestLoggingMiddleware]),
      // Only when nothing else is timing the request. Request logging observes
      // from the `.then` it already allocates, so both would double-count.
      ...(usesMetricsMiddleware(options) ? [MetricsMiddleware] : []),
      ...(options.middleware ?? []),
    ];
    // A filter class is resolved here rather than per request, so a missing
    // binding is a boot error. Its `catch` is looked up per call, so a test can
    // rebind it.
    this.#onError =
      options.onError === undefined
        ? errorMapper(app.get(Logger))
        : toErrorMapper(options.onError, (token) => app.get(token, root));
    this.#port = options.port ?? 3000;
    this.#websocket = websocket;
    this.#relay = options.relay;
    this.#relayChannel = options.relayChannel;
    this.#relayResubscribe = options.relayResubscribe;
    this.#notFound = options.notFound ?? 'public';
    this.#bootLogging = options.bootLogging ?? true;
    this.gatewayPaths = websocket?.paths ?? [];
    this.closed = new Promise<void>((resolve) => {
      this.#resolveClosed = resolve;
    });

    /**
     * The declarative half of the four settings that also have methods. Applied
     * here, at construction, so a later `setGlobalPrefix` or `enableCors` call
     * still wins - which is what keeps both spellings working and makes the
     * method the more specific of the two, as an imperative call should be.
     */
    if (options.prefix !== undefined && options.prefix !== '') {
      this.setGlobalPrefix(options.prefix);
    }
    if (options.cors !== undefined) {
      this.enableCors(options.cors);
    }
    if (options.trustProxy !== undefined) {
      this.set('trust proxy', options.trustProxy);
    }
    const hooks = options.shutdownHooks;
    if (hooks !== undefined && hooks !== false) {
      if (hooks === true) {
        this.enableShutdownHooks();
      } else {
        this.enableShutdownHooks(hooks.signals, hooks.options);
      }
    }
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

  /** The one `Bun.serve` call. A gateway's upgrade is a native `GET` route in the
   * same table, so Bun's router matches it and no `fetch` handler is needed. */
  async listen(port = this.#port): Promise<string> {
    this.#assertNotStarted('listen()');
    this.#started = true;

    /**
     * Global middleware resolves permissively rather than from a named scope: the
     * right instance is the one its own feature module built. `app.get` finds the
     * single module that declares it and errors if two do.
     */
    const middleware = this.#middleware.map((entry) =>
      this.#app.get(entry, this.#root),
    );
    const prefixed = this.#prefixed();
    const routes = buildRoutes(
      prefixed,
      middleware,
      this.#onError,
      this.#cors,
      // A module's own middleware resolves from that module, carried by `from`.
      (guard, from) =>
        from === undefined ? this.#app.get(guard) : this.#app.get(guard, from),
    );

    const ws = this.#websocket;
    if (ws) assertNoGatewayCollisions(prefixed, ws.paths);

    // Bun's own 404 never reaches the middleware chain. This runs only after Bun
    // has matched nothing, so Bun is still the router.
    const fetch = buildFallback(
      middleware,
      this.#onError,
      this.#cors,
      this.#notFound,
    );

    // One call: a route that may answer `undefined` because it upgraded is only
    // a valid table when `websocket` is there, and Bun's types say so.
    const options: Bun.Serve.Options<SocketData> = ws
      ? {
          port,
          fetch,
          routes: withUpgradeRoutes(routes, ws.routes),
          websocket: ws.websocket,
        }
      : { port, fetch, routes };
    this.#server = Bun.serve(options);

    attachAddressSource(this.#app.get(ClientAddress), {
      server: this.#server,
      trustProxy: this.#settings['trust proxy'],
    });
    // `pendingRequests` and `pendingWebSockets` are readable only from the bound
    // server, so the singleton gets it the same way `ClientAddress` does.
    this.#app.get(RequestMetrics).attach(this.#server);
    const pubsub = this.#app.get(PubSub);
    pubsub.attach(this.#server);
    // After attach, so a frame arriving during the subscribe has a server to fan
    // out on. Awaited, so a two-node deployment is subscribed by listen().
    if (this.#relay) {
      const logger = this.#app.get(Logger);
      await pubsub.relayThrough(this.#relay, {
        ...(this.#relayChannel !== undefined && {
          channel: this.#relayChannel,
        }),
        ...(this.#relayResubscribe !== undefined && {
          resubscribe: this.#relayResubscribe,
        }),
        onError: (error: unknown, phase: RelayPhase) => {
          logger.warn(
            `the websocket relay could not ${phase}. Fan-out is local to this ` +
              'process until it recovers.',
            { error },
          );
        },
      });
    }
    this.#logServed(prefixed, ws);
    return this.#server.url.href;
  }

  /**
   * What the process serves, as one entry once the table is final. One structured
   * record rather than a line per route, which a collector reads as one fact.
   * Here rather than at `create()` because `setGlobalPrefix` runs in between.
   */
  #logServed(
    routes: readonly DiscoveredRoute[],
    ws: WebSocketRuntime | undefined,
  ): void {
    if (!this.#bootLogging) return;
    const gateways = ws?.gateways ?? [];
    const subject = [
      `${routes.length} route(s)`,
      ...(gateways.length === 0 ? [] : [`${gateways.length} gateway(s)`]),
    ].join(' and ');

    this.#app.get(Logger).info(`Serving ${subject}`, {
      // Under `bun test` `main` is the test file rather than the app entry.
      ...runtimeInfo(),
      routes: routes.map((route) => `${route.method} ${route.path}`),
      ...(gateways.length === 0
        ? {}
        : {
            gateways: gateways.map((gateway) => ({
              path: gateway.path,
              gateway: gateway.name,
              events: gateway.events,
            })),
          }),
    });
  }

  // The server has to stop before providers tear down, so the handler lands
  // here. With a gateway the stop is forced: a graceful one waits for open
  // connections and a WebSocket never closes itself. Those clients see a 1006.
  /** Public so an operator can start draining without committing to a shutdown,
   * which is what a readiness probe wants during a rolling deploy. */
  drain(): Promise<void> {
    return this.#app.drain();
  }

  /**
   * Four phases in order, none skipped because an earlier one failed. A throwing
   * drain hook used to abort before `server.stop()`, leaving the port open and
   * `closed` unresolved; failures are collected and thrown at the end.
   */
  async shutdown(): Promise<void> {
    this.#shuttingDown ??= (async () => {
      const failures: unknown[] = [];
      const step = async (run: () => Promise<unknown>): Promise<void> => {
        try {
          await run();
        } catch (error) {
          failures.push(...toFailures(error));
        }
      };

      // While the port is still open: a readiness probe has to fail before the
      // server stops. Memoized, so `App.shutdown()` below cannot drain twice.
      await step(() => this.#app.drain());
      await step(async () => this.#server?.stop(this.#websocket !== undefined));
      this.#server = undefined;
      // Before the container: a relay this app owns holds two Redis sockets.
      await step(() => this.#app.get(PubSub).close());
      try {
        await step(() => this.#app.shutdown());
      } finally {
        this.#resolveClosed?.();
      }
      if (failures.length > 0) throw teardownError(failures);
    })();
    return this.#shuttingDown;
  }

  enableShutdownHooks(
    signals: readonly ShutdownSignal[] = ['SIGTERM', 'SIGINT'],
    options: ShutdownHookOptions = {},
  ): this {
    this.#hooks.install(() => this.shutdown(), signals, options);
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

  // #started rather than #server, which shutdown() clears.
  #assertNotStarted(hook: string): void {
    if (!this.#started) return;
    throw new AppError(
      `${hook} must be called before listen(). The route table and the middleware ` +
        'chain are folded into one closure per route when the server binds, so ' +
        'this call could not take effect.',
    );
  }
}
