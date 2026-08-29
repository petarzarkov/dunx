import type { Ctor } from '@dunx/core';
import type { HttpOptions } from './application.js';
import type { SocketLoggingOptions } from '../ws/logging.js';
import type { SocketMiddleware } from '../ws/middleware.js';
import type { PubSubRelay, RelayOptions } from '../ws/relay.js';
import type { SocketOptions } from '../ws/socket.js';
import type { CorsOptions } from './cors.js';
import type { ErrorHandler } from './errors.js';
import type { Middleware } from './middleware.js';
import type { RequestLoggingOptions } from './request-logging.js';

/**
 * How an app configures its HTTP server, as a provider rather than an argument.
 *
 * A subclass is resolved from the container, so it can inject `ConfigService` and
 * answer from validated config - which an argument to `HttpFactory.create` cannot,
 * the container not existing when that argument is built.
 *
 * ```ts
 * export class AppHttpOptions extends HttpOptionsProvider {
 *   constructor(private readonly config: AppConfigService) {
 *     super();
 *   }
 *
 *   override trustProxy = true;
 *
 *   override get prefix(): string {
 *     return this.config.get('app').prefix;
 *   }
 * }
 *
 * @Module({ providers: [provide(HttpOptionsProvider, { useClass: AppHttpOptions })] })
 * export class HttpConfigModule {}
 * ```
 *
 * Every member has a default, so a subclass overrides only what differs, and
 * anything passed to `create()` still wins field by field.
 *
 * **Fields must be overridden by fields and getters by getters** (`TS2611`,
 * `TS2610`). Fields here are the members that are usually literal - a middleware
 * list, a boolean; getters are the ones that usually derive. To override a field
 * from config, declare `override trustProxy: boolean` and assign in the
 * constructor; to override a getter with a constant, return the literal.
 *
 * See docs/architecture/http.md, "HTTP options as a provider".
 */
/*
 * `class-literal-property-style` wants the three getters that return a literal to
 * be fields. They are getters because of what a subclass has to do: TypeScript
 * rejects a getter overriding a field (TS2611), and these are the members that
 * nearly always derive from config in a real app. A field here would force every
 * override to compute in the constructor instead.
 */
// oxlint-disable typescript/class-literal-property-style
export abstract class HttpOptionsProvider {
  /**
   * Global middleware, in order, outermost first. Module-scoped middleware is
   * declared by that module instead and does not belong here.
   */
  readonly middleware: readonly Ctor<Middleware>[] = [];

  /** The socket half of {@link middleware}. */
  readonly socketMiddleware: readonly Ctor<SocketMiddleware>[] = [];

  /**
   * What an unmatched path looks like to global middleware. `'guarded'` gives the
   * miss no route metadata, so a global guard refuses it and a prober cannot tell a
   * 404 from a 401; `'public'` reports it as `@Public()` for a conventional 404.
   */
  readonly notFound: 'guarded' | 'public' = 'public';

  /** One entry at `listen()` naming every route and gateway served. */
  readonly bootLogging: boolean = true;

  /**
   * Whether `x-forwarded-for` is believed. Off by default: believing it behind
   * nothing lets any caller choose its own address.
   */
  readonly trustProxy: boolean = false;

  /**
   * Install `SIGTERM`/`SIGINT` handlers that shut the app down. Off by default,
   * because installing a signal handler changes how the process terminates and
   * that is the app's decision to make.
   */
  readonly shutdownHooks: boolean = false;

  /** The broker channel a relay carries frames on. */
  readonly relayChannel: string = 'dunx:ws';

  /** Prefixes every discovered route. Empty means none. */
  get prefix(): string {
    return '';
  }

  /** `undefined` lets `listen(port)` decide, which is what a test harness needs. */
  get port(): number | undefined {
    return undefined;
  }

  /** `undefined` mounts no preflight at all. */
  get cors(): CorsOptions | undefined {
    return undefined;
  }

  /** `false` removes the middleware from the chain; an object tunes it. */
  get requestLogging(): boolean | RequestLoggingOptions {
    return true;
  }

  get socketLogging(): boolean | SocketLoggingOptions {
    return true;
  }

  /**
   * Replaces the default mapper. Prefer an `ErrorFilter` class over a bare
   * function: a class is resolved from the container and can inject.
   */
  get onError(): ErrorHandler | undefined {
    return undefined;
  }

  get websocket(): SocketOptions | undefined {
    return undefined;
  }

  /** Multi-node websocket fan-out. Absent publishes to this process only. */
  get relay(): PubSubRelay | undefined {
    return undefined;
  }

  get relayResubscribe(): RelayOptions['resubscribe'] {
    return undefined;
  }
}

/**
 * The base itself, bound when no module bound a subclass. Concrete because the
 * container has to construct something, and every member already has a default.
 */
export class DefaultHttpOptions extends HttpOptionsProvider {}

/**
 * One options object out of the two places they can come from.
 *
 * **The argument wins, field by field, and the provider fills the rest.** That
 * ordering is not a preference: `HttpFactory.create(root, options)` already means
 * something, and if the provider won, adding one to an existing app would silently
 * change what its argument does. A field the argument does not mention is the
 * provider's to answer, which is how an app moves configuration into the container
 * one field at a time rather than all at once.
 *
 * Each getter is read exactly once, here, which is when the argument was read
 * before. A getter that depends on something settling later should be read at the
 * point it is used instead.
 */
export function resolveHttpOptions(
  settings: HttpOptionsProvider,
  given: HttpOptions,
): HttpOptions {
  const merged: Record<string, unknown> = {
    middleware: settings.middleware,
    socketMiddleware: settings.socketMiddleware,
    notFound: settings.notFound,
    bootLogging: settings.bootLogging,
    trustProxy: settings.trustProxy,
    shutdownHooks: settings.shutdownHooks,
    relayChannel: settings.relayChannel,
    prefix: settings.prefix,
    port: settings.port,
    cors: settings.cors,
    requestLogging: settings.requestLogging,
    socketLogging: settings.socketLogging,
    onError: settings.onError,
    websocket: settings.websocket,
    relay: settings.relay,
    relayResubscribe: settings.relayResubscribe,
  };
  // `exactOptionalPropertyTypes` separates an absent key from one set to
  // `undefined`, and only the first should defer to the provider: passing
  // `{ onError: undefined }` explicitly is a caller saying "no filter".
  for (const key of Object.keys(given) as (keyof HttpOptions)[]) {
    merged[key] = given[key];
  }
  return merged as HttpOptions;
}
