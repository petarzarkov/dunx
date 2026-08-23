import {
  Logger,
  Module,
  provide,
  type Deps,
  type DynamicModule,
  type FactoryProvider,
  type Registration,
} from '@dunx/core';
import { ScheduleOptions, type ScheduleOptionsInit } from './options.js';
import { ScheduleRegistry } from './registry.js';
import { ScheduleRunner, SCHEDULE_RUNNER_DEPS } from './runner.js';

const providers = (optionsProvider: Registration) => [
  optionsProvider,
  provide(ScheduleRegistry, {
    useFactory: (opts: ScheduleOptions, logger: Logger) =>
      new ScheduleRegistry(opts, logger),
    inject: [ScheduleOptions, Logger] as const,
  }),
  // Bound so the container constructs it, which is what gets `onInit` and
  // `onShutdown` called. Nothing injects it.
  provide(ScheduleRunner, {
    useFactory: (...deps: readonly unknown[]) =>
      new ScheduleRunner(
        ...(deps as ConstructorParameters<typeof ScheduleRunner>),
      ),
    inject: SCHEDULE_RUNNER_DEPS,
  }),
];

/**
 * Arms every `@Cron`, `@Interval` and `@OnceOnBoot` in the graph at boot.
 *
 * In-process and single-node: two replicas both run every schedule, since nothing
 * here coordinates. A schedule that must fire once per fleet is a job, through
 * bullmq's `upsertJobScheduler`.
 *
 * A `forRoot` pair rather than a decorated class because a scope is keyed on the
 * module reference, so two importers calling a zero-argument one would build two
 * registries and two copies of every schedule.
 */
@Module({})
export class ScheduleModule {
  static forRoot(init: ScheduleOptionsInit = {}): DynamicModule {
    return {
      module: ScheduleModule,
      exports: [ScheduleOptions, ScheduleRegistry],
      providers: providers(
        provide(ScheduleOptions, { useValue: new ScheduleOptions(init) }),
      ),
    };
  }

  /**
   * The same, with the options built from the container.
   *
   * ```ts
   * ScheduleModule.forRootAsync({
   *   useFactory: (config: AppConfigService) => ({ tz: config.get('tz') }),
   *   inject: [AppConfigService],
   * });
   * ```
   *
   */
  static forRootAsync(
    load: () => ScheduleOptionsInit | Promise<ScheduleOptionsInit>,
  ): DynamicModule;
  static forRootAsync<const D extends Deps>(
    config: FactoryProvider<ScheduleOptionsInit, D>,
  ): DynamicModule;
  static forRootAsync(
    source:
      | (() => ScheduleOptionsInit | Promise<ScheduleOptionsInit>)
      | FactoryProvider<ScheduleOptionsInit, Deps>,
  ): DynamicModule {
    const load = typeof source === 'function' ? source : source.useFactory;
    const inject = typeof source === 'function' ? [] : (source.inject ?? []);

    return {
      module: ScheduleModule,
      exports: [ScheduleOptions, ScheduleRegistry],
      providers: providers(
        provide(ScheduleOptions, {
          useFactory: async (
            ...deps: readonly unknown[]
          ): Promise<ScheduleOptions> =>
            new ScheduleOptions(await load(...deps)),
          inject,
        }),
      ),
    };
  }
}
