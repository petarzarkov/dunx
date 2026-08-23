import {
  Logger,
  Module,
  provide,
  type Deps,
  type DynamicModule,
  type FactoryProvider,
  type Registration,
} from '@dunx/core';
import { ClientAddress } from '../server/client-address.js';
import { ThrottleGuard } from './guard.js';
import { ThrottleOptions, type ThrottleOptionsInit } from './options.js';
import { MemoryThrottleStore, ThrottleStore } from './store.js';

const EXPORTS = [ThrottleOptions, ThrottleStore, ThrottleGuard];

/**
 * Bound with its dependencies declared rather than left to `@dunx/transform`, the
 * same choice `RedisModule` makes for `Redis`: this package's own test run has no
 * preload, and a framework provider that only resolves in a transformed app is a
 * provider that cannot be tested here.
 */
const guard = (): Registration =>
  provide(ThrottleGuard, {
    useFactory: (
      options: ThrottleOptions,
      store: ThrottleStore,
      address: ClientAddress,
      logger: Logger,
    ) => new ThrottleGuard(options, store, address, logger),
    inject: [ThrottleOptions, ThrottleStore, ClientAddress, Logger] as const,
  });

/**
 * The store the options named, or the in-process one. Bound as a factory so the
 * default is built at boot rather than at import, and so an app that never
 * registers the module never allocates a Map.
 */
const store = (): Registration =>
  provide(ThrottleStore, {
    useFactory: (options: ThrottleOptions) =>
      options.store ?? new MemoryThrottleStore(),
    inject: [ThrottleOptions] as const,
  });

/**
 * The decorator, the guard, the counter and its options.
 *
 * `global: true`: the guard is listed in `HttpOptions.middleware`, the app's own
 * list, so a non-global module would make every consumer import this one to reach
 * a guard it never names.
 *
 * ```ts
 * ThrottleModule.forRootAsync({
 *   useFactory: (config: AppConfig, redis: RedisConnection) => ({
 *     ...config.throttle,
 *     prefix: config.app.name,
 *     store: new RedisThrottleStore(redis),
 *     subject: (req) => caller.optional()?.id ?? address.of(req),
 *   }),
 *   inject: [AppConfig, RedisConnection] as const,
 * });
 *
 * HttpFactory.create(AppModule, { middleware: [SessionGuard, ThrottleGuard] });
 * ```
 *
 * Position in the chain is the app's: ahead of a session guard, the limit counts
 * every caller as an address.
 */
@Module({})
export class ThrottleModule {
  static forRoot(init: ThrottleOptionsInit): DynamicModule {
    return {
      module: ThrottleModule,
      global: true,
      exports: EXPORTS,
      providers: [
        provide(ThrottleOptions, { useValue: new ThrottleOptions(init) }),
        store(),
        guard(),
      ],
    };
  }

  /** `forRoot` with the limit read off the container - a config value, usually. */
  static forRootAsync<const D extends Deps>(
    config: FactoryProvider<ThrottleOptionsInit, D> & {
      readonly imports?: DynamicModule['imports'];
    },
  ): DynamicModule {
    return {
      module: ThrottleModule,
      global: true,
      ...(config.imports && { imports: config.imports }),
      exports: EXPORTS,
      providers: [
        provide(ThrottleOptions, {
          useFactory: async (...deps: readonly unknown[]) =>
            new ThrottleOptions(
              await (
                config.useFactory as (
                  ...args: readonly unknown[]
                ) => ThrottleOptionsInit | Promise<ThrottleOptionsInit>
              )(...deps),
            ),
          inject: config.inject ?? [],
        }),
        store(),
        guard(),
      ],
    };
  }
}
