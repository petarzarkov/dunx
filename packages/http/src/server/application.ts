import type { BunRequest, Server } from 'bun';
import {
  AppError,
  Logger,
  type App,
  type AppOptions,
  type Ctor,
  type InjectionToken,
  type ShutdownSignal,
} from '@dunx/core';
import { joinPath, type DiscoveredRoute } from '../route/discover.js';
import type { WebSocketRuntime } from '../ws/adapter.js';
import { PubSub } from '../ws/pubsub.js';
import type { PubSubRelay, RelayOptions, RelayPhase } from '../ws/relay.js';
import type { SocketData, SocketOptions } from '../ws/socket.js';
import { attachAddressSource, ClientAddress } from './client-address.js';
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
  /** Resolved from the container, so middleware can inject(). */
  readonly middleware?: readonly Ctor<Middleware>[];
  /**
   * Replaces the default mapper.
   *
   * A bare `ErrorMapper` function, or an `ErrorFilter` **class** - which is the one
   * to prefer, because a class is resolved from the container and can therefore
   * inject the `Logger` or the config a real filter needs. A mapper cannot; dunx's
   * own default has to be curried over its logger for exactly that reason.
   *
   * A filter with dependencies needs them bindable, the same rule `middleware`
   * entries follow; one with none self-binds and needs no `providers` entry.
   */
  readonly onError?: ErrorHandler;
  /**
   * One structured entry per request, on by default. `false` removes it; an
   * options object tunes what it records. See {@link RequestLoggingMiddleware}.
   *
   * It is the **outermost** middleware, ahead of anything `middleware` declares,
   * so a request rejected by a guard is still logged with the status it got.
   */
  readonly requestLogging?: boolean | RequestLoggingOptions;
  /**
   * Bun's `websocket` options, plus where a throwing handler goes. Server-wide, so
   * they live here next to `middleware` rather than on a module: gateways
   * themselves are declared in `@Module({ providers })`.
   */
  readonly websocket?: SocketOptions;
  /**
   * Multi-node websocket fan-out. Absent - the default - means `PubSub` publishes
   * to this process only, which is exactly Bun's native pub/sub and costs nothing.
   *
   * `new RedisRelay({ url })` is the batteries-included one. Anything with a
   * `publish` and a `subscribe` fits, including `@dunx/infra`'s `RedisConnection`,
   * which has to come out of the container and so goes through
   * `app.get(PubSub).relayThrough(...)` instead of this option.
   */
  readonly relay?: PubSubRelay;
  /** The broker channel the relay carries frames on. @default 'dunx:ws' */
  readonly relayChannel?: string;
  /**
   * How hard to retry a subscribe that failed. Same shape as
   * `RelayOptions.resubscribe`: bounded, doubling, and on an unref'd timer, so a
   * broker that never comes back cannot hold the process open.
   *
   * Here rather than only on `relayThrough` because reaching for that to set one
   * option means giving up `relay` above entirely - the two conflict, and the
   * second to run throws `PubSub already relays`.
   */
  readonly relayResubscribe?: RelayOptions['resubscribe'];
  /**
   * What an unmatched path looks like to global middleware.
   *
   * `'guarded'`, the default, gives the miss no route metadata, so a global guard
   * refuses it and an anonymous caller gets that guard's status rather than a 404.
   * That is deliberate: a 404 on a miss while every real path answers 401 tells a
   * prober which paths exist.
   *
   * `'public'` reports the miss as `@Public()`, so a guard honouring that flag
   * passes it through to the conventional 404. The request is still logged and
   * still gets a request id either way, which is the whole reason the fallback
   * runs the middleware at all.
   *
   * A guard can discriminate under either setting: `UNMATCHED` is set on the miss
   * and no real route ever sets it.
   *
   * @default 'guarded'
   */
  readonly notFound?: 'guarded' | 'public';
}

/**
 * Everything below `listen()` configures the route table, which is built exactly
 * once - when the server binds. Calling any of them afterwards throws rather than
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
  /** The same `inject(ClientAddress)` singleton - honours `'trust proxy'`. */
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
  readonly #relay: PubSubRelay | undefined;
  readonly #relayChannel: string | undefined;
  readonly #relayResubscribe: RelayOptions['resubscribe'];
  readonly #notFound: 'guarded' | 'public';
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
    this.#middleware = [
      ...(options.requestLogging === false ? [] : [RequestLoggingMiddleware]),
      ...(options.middleware ?? []),
    ];
    // The bound Logger, resolved only when the app did not bring its own handler:
    // a 500's stack belongs in the same stream as everything else.
    //
    // A filter class is resolved from the container here rather than per request, so
    // a missing binding is a boot error like any other and the request path stays a
    // method call. Its `catch` is looked up per call, which is what lets a filter be
    // rebound in a test.
    this.#onError =
      options.onError === undefined
        ? errorMapper(app.get(Logger))
        : toErrorMapper(options.onError, (token) => app.get(token));
    this.#port = options.port ?? 3000;
    this.#websocket = websocket;
    this.#relay = options.relay;
    this.#relayChannel = options.relayChannel;
    this.#relayResubscribe = options.relayResubscribe;
    this.#notFound = options.notFound ?? 'guarded';
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
   * same table, so Bun's router - not a hand-written `fetch` fallback - is what
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

    // Bun's own 404 never reaches the middleware chain, so an unmatched path is
    // invisible to request logging. This runs only after Bun has matched nothing,
    // so Bun is still the router - it just puts the global middleware in front of
    // the 404 and returns it in the framework's error shape.
    const fetch = buildFallback(
      middleware,
      this.#onError,
      this.#cors,
      this.#notFound,
    );

    // Two literals, one call: a route that may answer `undefined` because it
    // upgraded is only a valid route table when `websocket` is there to receive it,
    // and Bun's own types say so.
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
    const pubsub = this.#app.get(PubSub);
    pubsub.attach(this.#server);
    // After attach, so a frame that arrives during the subscribe already has a
    // server to fan out on. Awaited so a two-node deployment is subscribed by the
    // time listen() resolves; an unreachable broker fails fast and degrades.
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
    return this.#server.url.href;
  }

  // Not delegated to the core app: the server has to stop before providers tear
  // down, so the signal handler must land here. With a gateway the stop is forced -
  // a graceful stop waits for open connections and a WebSocket does not close on
  // its own, so it would hang. Those clients see a 1006 close.
  async shutdown(): Promise<void> {
    this.#shuttingDown ??= (async () => {
      await this.#server?.stop(this.#websocket !== undefined);
      this.#server = undefined;
      // Before the container: a relay this app owns holds two Redis sockets, and
      // `maxRetries: 0` means nothing else will ever close them.
      await this.#app.get(PubSub).close();
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

  // #started rather than #server, which shutdown() clears - a hook called after
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
