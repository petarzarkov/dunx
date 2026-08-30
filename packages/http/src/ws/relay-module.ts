import {
  provide,
  type AsyncModuleConfig,
  type Deps,
  type DynamicModule,
  type FactoryProvider,
  type OnShutdown,
  type Registration,
} from '@dunx/core';
import { PostgresRelay, type PostgresRelayOptions } from './postgres-relay.js';
import { RedisRelay, type RedisRelayOptions } from './redis-relay.js';
import { WsRelay } from './relay.js';

/**
 * The Redis relay's connection settings, as a class so a factory can bind them.
 *
 * `RedisRelayOptions` stays the interface a caller writes; this is what the
 * container holds, which is the same split `HttpClientOptions` and
 * `HttpClientOptionsInit` use.
 */
export class RelayConnectionOptions {
  readonly url: string | undefined;
  readonly maxRetries: number | undefined;
  readonly connectionTimeout: number | undefined;
  readonly tls: boolean | Bun.TLSOptions | undefined;

  constructor(init: RedisRelayOptions = {}) {
    this.url = init.url;
    this.maxRetries = init.maxRetries;
    this.connectionTimeout = init.connectionTimeout;
    this.tls = init.tls;
  }

  /** Only the keys actually set, so each `RedisRelay` default still applies. */
  toInit(): RedisRelayOptions {
    return {
      ...(this.url !== undefined && { url: this.url }),
      ...(this.maxRetries !== undefined && { maxRetries: this.maxRetries }),
      ...(this.connectionTimeout !== undefined && {
        connectionTimeout: this.connectionTimeout,
      }),
      ...(this.tls !== undefined && { tls: this.tls }),
    };
  }
}

/** The same, for the Postgres relay. */
export class PostgresRelayConnectionOptions {
  readonly url: string | undefined;
  readonly max: number | undefined;

  constructor(init: PostgresRelayOptions = {}) {
    this.url = init.url;
    this.max = init.max;
  }

  toInit(): PostgresRelayOptions {
    return {
      ...(this.url !== undefined && { url: this.url }),
      ...(this.max !== undefined && { max: this.max }),
    };
  }
}

/**
 * Closes the relay's own sockets at shutdown.
 *
 * `PubSub.close()` calls `relay.close()` only for a relay it was handed, and an
 * app that never opened a socket never reaches it. A relay built by the container
 * is the container's to close.
 */
class RelayLifecycle implements OnShutdown {
  constructor(private readonly relay: WsRelay) {}

  async onShutdown(): Promise<void> {
    await this.relay.close();
  }
}

const redisBindings = (
  options: FactoryProvider<RelayConnectionOptions, Deps>,
): readonly Registration[] => [
  provide(RelayConnectionOptions, options),
  provide(RedisRelay, {
    useFactory: (settings: RelayConnectionOptions) =>
      new RedisRelay(settings.toInit()),
    inject: [RelayConnectionOptions] as const,
  }),
  provide(WsRelay, {
    useFactory: (relay: RedisRelay) => relay,
    inject: [RedisRelay] as const,
  }),
  provide(RelayLifecycle, {
    useFactory: (relay: WsRelay) => new RelayLifecycle(relay),
    inject: [WsRelay] as const,
  }),
];

const postgresBindings = (
  options: FactoryProvider<PostgresRelayConnectionOptions, Deps>,
): readonly Registration[] => [
  provide(PostgresRelayConnectionOptions, options),
  provide(PostgresRelay, {
    useFactory: (settings: PostgresRelayConnectionOptions) =>
      new PostgresRelay(settings.toInit()),
    inject: [PostgresRelayConnectionOptions] as const,
  }),
  provide(WsRelay, {
    useFactory: (relay: PostgresRelay) => relay,
    inject: [PostgresRelay] as const,
  }),
  provide(RelayLifecycle, {
    useFactory: (relay: WsRelay) => new RelayLifecycle(relay),
    inject: [WsRelay] as const,
  }),
];

/**
 * Binds the websocket relay, so `relay` is a provider rather than an instance
 * `main.ts` constructs and threads into `HttpFactory.create`.
 *
 * Name {@link WsRelay} at the injection site and the backend is a wiring choice:
 *
 * ```ts
 * export class AppHttpOptions extends HttpOptionsProvider {
 *   constructor(private readonly bus: WsRelay) {
 *     super();
 *   }
 *
 *   override get relay(): PubSubRelay {
 *     return this.bus;
 *   }
 * }
 * ```
 *
 * The backend is chosen by which method you call, not by a field in the options.
 * A relay of your own needs no module: extend `WsRelay`, bind it, and return it
 * from that same getter.
 */
export class WsRelayModule {
  /** Redis or Valkey, over `Bun.RedisClient`. */
  static forRoot(init: RedisRelayOptions = {}): DynamicModule {
    return {
      module: WsRelayModule,
      exports: [WsRelay, RedisRelay, RelayConnectionOptions],
      providers: redisBindings({
        useFactory: () => new RelayConnectionOptions(init),
        inject: [] as const,
      }),
    };
  }

  /**
   * The same bindings with the settings behind a factory, so the url can come off
   * `ConfigService`. `imports` reaches that factory; importing the module
   * alongside does not, since a dynamic module is its own scope.
   */
  static forRootAsync<const D extends Deps>(
    config: AsyncModuleConfig<RedisRelayOptions, D>,
  ): DynamicModule {
    const useFactory = async (
      ...deps: readonly unknown[]
    ): Promise<RelayConnectionOptions> =>
      new RelayConnectionOptions(await config.useFactory(...(deps as never)));

    return {
      module: WsRelayModule,
      ...(config.imports === undefined ? {} : { imports: config.imports }),
      exports: [WsRelay, RedisRelay, RelayConnectionOptions],
      providers: redisBindings({
        useFactory,
        inject: config.inject ?? ([] as const),
      } as FactoryProvider<RelayConnectionOptions, Deps>),
    };
  }

  /**
   * Postgres, over `Bun.SQL`'s `LISTEN`/`NOTIFY`, for an app that already has a
   * database and would rather not run a broker. A frame over about 7.9 KB is
   * refused; see {@link PostgresRelay}.
   */
  static forPostgres(init: PostgresRelayOptions = {}): DynamicModule {
    return {
      module: WsRelayModule,
      exports: [WsRelay, PostgresRelay, PostgresRelayConnectionOptions],
      providers: postgresBindings({
        useFactory: () => new PostgresRelayConnectionOptions(init),
        inject: [] as const,
      }),
    };
  }

  /** `forPostgres` with the settings behind a factory. */
  static forPostgresAsync<const D extends Deps>(
    config: AsyncModuleConfig<PostgresRelayOptions, D>,
  ): DynamicModule {
    const useFactory = async (
      ...deps: readonly unknown[]
    ): Promise<PostgresRelayConnectionOptions> =>
      new PostgresRelayConnectionOptions(
        await config.useFactory(...(deps as never)),
      );

    return {
      module: WsRelayModule,
      ...(config.imports === undefined ? {} : { imports: config.imports }),
      exports: [WsRelay, PostgresRelay, PostgresRelayConnectionOptions],
      providers: postgresBindings({
        useFactory,
        inject: config.inject ?? ([] as const),
      } as FactoryProvider<PostgresRelayConnectionOptions, Deps>),
    };
  }
}
