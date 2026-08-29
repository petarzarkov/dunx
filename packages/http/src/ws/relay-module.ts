import {
  provide,
  type AsyncModuleConfig,
  type Deps,
  type DynamicModule,
  type FactoryProvider,
  type OnShutdown,
  type Registration,
} from '@dunx/core';
import { RedisRelay, type RedisRelayOptions } from './redis-relay.js';

/**
 * The relay's connection settings, as a class so a factory can bind them.
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

/**
 * Closes the relay's own sockets at shutdown.
 *
 * `PubSub.close()` calls `relay.close()` only for a relay it was handed, and an
 * app that never opened a socket never reaches it. A relay built by the container
 * is the container's to close.
 */
class RelayLifecycle implements OnShutdown {
  constructor(private readonly relay: RedisRelay) {}

  async onShutdown(): Promise<void> {
    await this.relay.close();
  }
}

const bindings = (
  options: FactoryProvider<RelayConnectionOptions, Deps>,
): readonly Registration[] => [
  provide(RelayConnectionOptions, options),
  provide(RedisRelay, {
    useFactory: (settings: RelayConnectionOptions) =>
      new RedisRelay(settings.toInit()),
    inject: [RelayConnectionOptions] as const,
  }),
  provide(RelayLifecycle, {
    useFactory: (relay: RedisRelay) => new RelayLifecycle(relay),
    inject: [RedisRelay] as const,
  }),
];

/**
 * Binds the websocket relay, so `relay` is a provider rather than an instance
 * `main.ts` constructs and threads into `HttpFactory.create`.
 *
 * `RedisRelay` is a class, so an options provider takes it as a parameter:
 *
 * ```ts
 * export class AppHttpOptions extends HttpOptionsProvider {
 *   constructor(private readonly bus: RedisRelay) {
 *     super();
 *   }
 *
 *   override get relay(): PubSubRelay {
 *     return this.bus;
 *   }
 * }
 * ```
 *
 * A relay of your own needs no module: bind the class and return it from that
 * same getter. This one exists because `RedisRelay` is the one dunx ships and its
 * url comes from config like everything else.
 */
export class WsRelayModule {
  static forRoot(init: RedisRelayOptions = {}): DynamicModule {
    return {
      module: WsRelayModule,
      exports: [RedisRelay, RelayConnectionOptions],
      providers: bindings({
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
      exports: [RedisRelay, RelayConnectionOptions],
      providers: bindings({
        useFactory,
        inject: config.inject ?? ([] as const),
      } as FactoryProvider<RelayConnectionOptions, Deps>),
    };
  }
}
