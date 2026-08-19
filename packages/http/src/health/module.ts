import {
  Module,
  provide,
  type Deps,
  type DynamicModule,
  type FactoryProvider,
  type ProviderEntry,
} from '@dunx/core';
import { HealthController } from './controller.js';
import { Readiness, ReadinessOptions } from './readiness.js';
import {
  HealthOptions,
  HealthRegistry,
  type HealthOptionsInit,
} from './registry.js';

const wiring = (
  options: readonly ProviderEntry[],
): readonly ProviderEntry[] => [
  ...options,
  provide(ReadinessOptions, {
    useFactory: (opts: HealthOptions) =>
      new ReadinessOptions({ drainDelayMs: opts.drainDelayMs }),
    inject: [HealthOptions] as const,
  }),
  provide(Readiness, {
    useFactory: (opts: ReadinessOptions) => new Readiness(opts),
    inject: [ReadinessOptions] as const,
  }),
  provide(HealthRegistry, {
    useFactory: (opts: HealthOptions, readiness: Readiness) =>
      new HealthRegistry(opts, readiness),
    inject: [HealthOptions, Readiness] as const,
  }),
];

const surface = [HealthOptions, HealthRegistry, Readiness];

/**
 * Liveness and readiness, and the drain that makes readiness worth having.
 *
 * `Readiness` implements `OnBeforeShutdown`, so readiness starts failing **before** the
 * server stops accepting. Without that phase the flip was unexpressible: every
 * `onShutdown` hook runs after `server.stop()` has resolved, so a probe answering
 * from there answers on a closed port and the load balancer is still routing when
 * the socket goes away.
 *
 * `routes: false` binds everything and mounts nothing, for an app that would rather
 * answer on its own paths or from a sidecar.
 */
@Module({})
export class HealthModule {
  static forRoot(init: HealthOptionsInit = {}): DynamicModule {
    const options = new HealthOptions(init);
    return {
      module: HealthModule,
      ...(options.routes ? { controllers: [HealthController] } : {}),
      exports: surface,
      providers: wiring([provide(HealthOptions, { useValue: options })]),
    };
  }

  /**
   * The same, with the indicators built from the container, which is the usual case:
   * a database indicator needs the connection.
   *
   * ```ts
   * HealthModule.forRootAsync({
   *   useFactory: (db: DbConnection, redis: RedisConnection) => ({
   *     readiness: [new DatabaseIndicator(db), new RedisIndicator(redis)],
   *     drainDelayMs: 15_000,
   *   }),
   *   inject: [DbConnection, RedisConnection],
   * });
   * ```
   *
   * `routes` is read from the init here too, but the controller is mounted from the
   * static shape rather than from the awaited options: a route table is folded into
   * one closure per route when the server binds, so it cannot wait on a factory.
   * Pass `routes: false` and mount your own if that matters.
   */
  static forRootAsync<const D extends Deps>(
    config: FactoryProvider<HealthOptionsInit, D> & {
      readonly imports?: DynamicModule['imports'];
      readonly routes?: boolean;
    },
  ): DynamicModule {
    return {
      module: HealthModule,
      ...(config.imports ? { imports: config.imports } : {}),
      ...((config.routes ?? true) ? { controllers: [HealthController] } : {}),
      exports: surface,
      providers: wiring([
        provide(HealthOptions, {
          // Same cast `StaticModule.forRootAsync` makes: `Resolved<D>` is what
          // types the caller's factory, and the container hands its providers
          // through as `unknown[]`.
          useFactory: async (...deps: readonly unknown[]) =>
            new HealthOptions(
              await (
                config.useFactory as (
                  ...args: readonly unknown[]
                ) => HealthOptionsInit | Promise<HealthOptionsInit>
              )(...deps),
            ),
          inject: config.inject ?? [],
        }),
      ]),
    };
  }
}
