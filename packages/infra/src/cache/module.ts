import {
  provide,
  type AsyncModuleConfig,
  type Deps,
  type DynamicModule,
} from '@dunx/core';
import { Cache } from './cache.js';
import { CacheMetrics } from './metrics.js';
import { CacheOptions, type CacheOptionsInit } from './options.js';
import { CacheStore } from './store.js';

export interface CacheModuleSettings {
  /**
   * Count and time every store operation, readable through {@link CacheMetrics}.
   * Off by default: on, each `get`, `set` and `del` pays two `Bun.nanoseconds()`
   * reads and a histogram record, and the store is wrapped once at boot.
   */
  readonly metrics?: boolean;
}

/**
 * Both factories bind these two the same way. `CacheStore` is bound rather than
 * left to self-bind, so `get(CacheStore)` hands back the configured tier instead
 * of constructing the abstract contract.
 */
const bindings = [
  provide(CacheStore, {
    useFactory: (options: CacheOptions) => options.store,
    inject: [CacheOptions],
  }),
  provide(Cache, {
    useFactory: (options: CacheOptions) => new Cache(options),
    inject: [CacheOptions],
  }),
];

export class CacheModule {
  /**
   * Binds `CacheOptions`, `CacheStore` and `Cache`.
   *
   * ```ts
   * @Module({ imports: [CacheModule.forRoot({ ttl: 30_000, prefix: 'app' })] })
   * export class AppModule {}
   * ```
   *
   * `{ metrics: true }` binds a fourth, {@link CacheMetrics}, and wraps the store
   * in a `MeteredCacheStore` that reports into it.
   */
  static forRoot(
    init: CacheOptionsInit = {},
    settings: CacheModuleSettings = {},
  ): DynamicModule {
    const metrics = settings.metrics === true ? new CacheMetrics() : undefined;
    return {
      module: CacheModule,
      exports: [
        CacheOptions,
        CacheStore,
        Cache,
        ...(metrics === undefined ? [] : [CacheMetrics]),
      ],
      providers: [
        provide(CacheOptions, { useValue: new CacheOptions(init, metrics) }),
        ...(metrics === undefined
          ? []
          : [provide(CacheMetrics, { useValue: metrics })]),
        ...bindings,
      ],
    };
  }

  /**
   * The same three bindings, with the options behind a factory that may inject:
   *
   * ```ts
   * CacheModule.forRootAsync({
   *   imports: [RedisModule.forRoot()],
   *   useFactory: (redis: RedisConnection) => ({
   *     store: new RedisCacheStore(redis),
   *   }),
   *   inject: [RedisConnection],
   * });
   * ```
   *
   * `imports` is the module the factory's dependencies come from: this dynamic
   * module is its own scope, so importing it alongside does not reach here.
   */
  static forRootAsync<const D extends Deps>(
    config: AsyncModuleConfig<CacheOptionsInit, D>,
    settings: CacheModuleSettings = {},
  ): DynamicModule {
    const metrics = settings.metrics === true ? new CacheMetrics() : undefined;
    return {
      module: CacheModule,
      ...(config.imports === undefined ? {} : { imports: config.imports }),
      exports: [
        CacheOptions,
        CacheStore,
        Cache,
        ...(metrics === undefined ? [] : [CacheMetrics]),
      ],
      providers: [
        provide(CacheOptions, {
          useFactory: async (...deps) =>
            new CacheOptions(await config.useFactory(...deps), metrics),
          inject: config.inject ?? ([] as unknown as D),
        }),
        ...(metrics === undefined
          ? []
          : [provide(CacheMetrics, { useValue: metrics })]),
        ...bindings,
      ],
    };
  }
}
