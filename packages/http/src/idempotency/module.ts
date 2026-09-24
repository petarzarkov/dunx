import {
  Logger,
  Module,
  provide,
  type AsyncModuleConfig,
  type Deps,
  type DynamicModule,
  type Registration,
} from '@dunx/core';
import { BoundIdempotencyGuard, IdempotencyGuard } from './guard.js';
import { IdempotencyOptions, type IdempotencyOptionsInit } from './options.js';
import { IdempotencyStore, MemoryIdempotencyStore } from './store.js';

const EXPORTS = [IdempotencyOptions, IdempotencyStore, IdempotencyGuard];

/** Dependencies declared, for the reason `ThrottleModule` gives. */
const providers = (options: Registration): Registration[] => [
  options,
  provide(IdempotencyStore, {
    useFactory: (resolved: IdempotencyOptions) =>
      resolved.store ?? new MemoryIdempotencyStore(),
    inject: [IdempotencyOptions] as const,
  }),
  provide(IdempotencyGuard, {
    useFactory: (
      resolved: IdempotencyOptions,
      store: IdempotencyStore,
      logger: Logger,
    ) => new BoundIdempotencyGuard(resolved, store, logger),
    inject: [IdempotencyOptions, IdempotencyStore, Logger] as const,
  }),
];

/**
 * The guard `@Idempotent()` names, its store and its options.
 *
 * `global: true`, because the guard is resolved from whichever module declares
 * the controller, and that module should not have to import this one to reach a
 * guard it never names.
 *
 * ```ts
 * IdempotencyModule.forRootAsync({
 *   useFactory: (redis: RedisConnection, auth: AuthContext) => ({
 *     prefix: 'orders-api',
 *     store: new RedisIdempotencyStore(redis),
 *     subject: () => auth.current()?.user.id,
 *   }),
 *   inject: [RedisConnection, AuthContext] as const,
 * });
 * ```
 */
@Module({})
export class IdempotencyModule {
  static forRoot(init: IdempotencyOptionsInit): DynamicModule {
    return {
      module: IdempotencyModule,
      global: true,
      exports: EXPORTS,
      providers: providers(
        provide(IdempotencyOptions, {
          useValue: new IdempotencyOptions(init),
        }),
      ),
    };
  }

  static forRootAsync<const D extends Deps>(
    config: AsyncModuleConfig<IdempotencyOptionsInit, D>,
  ): DynamicModule {
    return {
      module: IdempotencyModule,
      global: true,
      ...(config.imports && { imports: config.imports }),
      exports: EXPORTS,
      providers: providers(
        provide(IdempotencyOptions, {
          useFactory: async (...deps: readonly unknown[]) =>
            new IdempotencyOptions(
              await (
                config.useFactory as (
                  ...args: readonly unknown[]
                ) => IdempotencyOptionsInit | Promise<IdempotencyOptionsInit>
              )(...deps),
            ),
          inject: config.inject ?? [],
        }),
      ),
    };
  }
}
