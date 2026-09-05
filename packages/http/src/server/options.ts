import type {
  AppOptions,
  Ctor,
  ShutdownHookOptions,
  ShutdownSignal,
} from '@dunx/core';
import type { SocketLoggingOptions } from '../ws/logging.js';
import type { SocketMiddleware } from '../ws/middleware.js';
import type { PubSubRelay, RelayOptions } from '../ws/relay.js';
import type { SocketOptions } from '../ws/socket.js';
import type { CorsOptions } from './cors.js';
import type { ErrorHandler } from './errors.js';
import type { Middleware } from './middleware.js';
import type { RequestLoggingOptions } from './request-logging.js';

/**
 * Every setting `HttpFactory.create` takes. Here rather than in
 * `application.ts` so that file is the class it is named for.
 *
 * Each field has a twin on {@link HttpOptionsProvider}, which is the same
 * settings answered from the container instead. The argument wins field by
 * field; see `resolveHttpOptions`.
 */
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
  /**
   * Serve HTTP/2 on the same port, through the same routes and the same
   * `fetch` fallback. Without TLS that is h2c: a client opening with the HTTP/2
   * preface gets HTTP/2 and everyone else gets HTTP/1.1, which is what a proxy
   * in front of the app speaks. Bun marks the option experimental.
   *
   * Gateways are unaffected and keep working, because a websocket upgrade is an
   * HTTP/1.1 request and Bun serves both protocols on the one socket. There is
   * no websocket over HTTP/2.
   *
   * @default false
   */
  readonly http2?: boolean;
  /**
   * Serve HTTP/1.1. `false` alongside `http2` refuses HTTP/1.x with a 505, which
   * **disables every gateway**: a websocket upgrade is an HTTP/1.1 request, so
   * nothing can connect to one. Only for a port that is HTTP/2 or nothing.
   *
   * @default true
   */
  readonly http1?: boolean;
  /**
   * A port of its own for the gateways. The routes keep {@link port} and the
   * upgrades move here, on a second `Bun.serve` that takes no protocol
   * overrides, so it speaks HTTP/1.1 whatever the main port is set to.
   *
   * This is what makes `http2` with `http1: false` usable at all: a websocket
   * upgrade is an HTTP/1.1 request, so one port can serve HTTP/2-only routes or
   * gateways and never both. Setting `http1: false` with a gateway declared and
   * no `gatewayPort` is a boot error.
   *
   * Both ports come out of one container, which is why this is an option rather
   * than a second `HttpFactory.create`: a second app would build a second
   * container, and the gateways would inject different singletons than the
   * controllers.
   */
  readonly gatewayPort?: number;
}
