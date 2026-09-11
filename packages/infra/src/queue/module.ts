import {
  AppRef,
  Logger,
  provide,
  ROOT_MODULE,
  type Deps,
  type DynamicModule,
  type AsyncModuleConfig,
  type ModuleRef,
  type Registration,
} from '@dunx/core';
import { QueueConnection } from './connection.js';
import { JobEvents } from './events.js';
import { QueueMetrics } from './metrics.js';
import { QueueOptions, type QueueOptionsInit } from './options.js';
import { JobPublisher } from './publisher.js';
import { QueueRunner } from './runner.js';

/**
 * `QueueConnection` is bound as a factory over `QueueOptions`, and `JobPublisher`
 * as one over the connection, which is what fixes the teardown order. dunx tears
 * down in reverse construction order, so the connection - constructed first,
 * because the publisher needs it - closes its sockets last, after every queue has
 * closed.
 */
/**
 * The public surface: `JobPublisher` is what an app publishes through,
 * `JobEvents` is how it learns a job finished, `QueueOptions` reports the
 * redacted broker url, and `QueueConnection` is what a `WorkerFactory` in the
 * same process needs.
 */
const surface = [QueueOptions, QueueConnection, JobPublisher, JobEvents];

export interface QueueModuleSettings {
  /**
   * Count and time enqueues and handlers, readable through {@link QueueMetrics}.
   * Off by default.
   *
   * A handler reaches it only where the dispatcher is built by this container -
   * `consume: true` in this process. `isolation` defaults to `'process'`, so a
   * `@JobHandler({ background: true })` runs in a forked child with a container of
   * its own, and so does a `WorkerFactory` worker process. The publish side is
   * always this container's.
   */
  readonly metrics?: boolean;
}

/** The surface plus `QueueMetrics`, which is bound only when it is asked for. */
const exportsFor = (metrics: QueueMetrics | undefined) =>
  metrics === undefined ? surface : [...surface, QueueMetrics];

/**
 * Always bound, and idle unless `consume` is set - checked in `onInit`, since
 * `forRootAsync` builds its options from a factory and the flag is not knowable
 * when providers are declared.
 *
 * `QueueConnection` is injected though the runner never touches it: that is what
 * orders the runner after it in construction and before it in teardown.
 */
const runner = (metrics: QueueMetrics | undefined): Registration =>
  provide(QueueRunner, {
    useFactory: (
      ref: AppRef,
      root: ModuleRef,
      options: QueueOptions,
      logger: Logger,
      _connection: QueueConnection,
    ) => new QueueRunner(ref, root, options, logger, metrics),
    inject: [
      AppRef,
      ROOT_MODULE,
      QueueOptions,
      Logger,
      QueueConnection,
    ] as const,
  });

const bindings = (
  metrics: QueueMetrics | undefined,
): readonly Registration[] => [
  ...(metrics === undefined
    ? []
    : [provide(QueueMetrics, { useValue: metrics })]),
  provide(QueueConnection, {
    useFactory: (options: QueueOptions, logger: Logger) =>
      new QueueConnection(options, logger),
    inject: [QueueOptions, Logger] as const,
  }),
  provide(JobPublisher, {
    useFactory: (
      connection: QueueConnection,
      options: QueueOptions,
      logger: Logger,
    ) => new JobPublisher(connection, options, logger, metrics),
    inject: [QueueConnection, QueueOptions, Logger] as const,
  }),
  // After the connection, so reverse-order teardown closes the event streams
  // before the sockets they borrowed. It opens none until something waits.
  provide(JobEvents, {
    useFactory: (
      connection: QueueConnection,
      options: QueueOptions,
      logger: Logger,
    ) => new JobEvents(connection, options, logger),
    inject: [QueueConnection, QueueOptions, Logger] as const,
  }),
];

/**
 * Binds `QueueOptions`, `QueueConnection`, `JobPublisher` and `JobEvents` - the
 * publish side, which is all a web process needs.
 *
 * A worker process imports the same module and adds `WorkerFactory.create`, which
 * is what discovers the handlers and opens the bullmq `Worker`s. Importing this
 * alone opens no worker and consumes nothing.
 */
export class QueueModule {
  static forRoot(
    init: QueueOptionsInit = {},
    settings: QueueModuleSettings = {},
  ): DynamicModule {
    const metrics = settings.metrics === true ? new QueueMetrics() : undefined;
    return {
      module: QueueModule,
      exports: exportsFor(metrics),
      providers: [
        provide(QueueOptions, { useValue: new QueueOptions(init) }),
        ...bindings(metrics),
        runner(metrics),
      ],
    };
  }

  /**
   * `forRoot` with the options behind a factory, which may inject:
   *
   * ```ts
   * QueueModule.forRootAsync({
   *   useFactory: (config: AppConfigService) => ({ url: config.get('redis').url }),
   *   inject: [AppConfigService],
   * });
   * ```
   */
  static forRootAsync(
    load: () => QueueOptionsInit | Promise<QueueOptionsInit>,
    settings?: QueueModuleSettings,
  ): DynamicModule;
  static forRootAsync<const D extends Deps>(
    config: AsyncModuleConfig<QueueOptionsInit, D>,
    settings?: QueueModuleSettings,
  ): DynamicModule;
  static forRootAsync(
    source:
      | (() => QueueOptionsInit | Promise<QueueOptionsInit>)
      | AsyncModuleConfig<QueueOptionsInit, Deps>,
    settings: QueueModuleSettings = {},
  ): DynamicModule {
    const load = typeof source === 'function' ? source : source.useFactory;
    const inject = typeof source === 'function' ? [] : (source.inject ?? []);
    const metrics = settings.metrics === true ? new QueueMetrics() : undefined;

    return {
      module: QueueModule,
      ...(typeof source === 'function' || source.imports === undefined
        ? {}
        : { imports: source.imports }),
      exports: exportsFor(metrics),
      providers: [
        provide(QueueOptions, {
          useFactory: async (...deps: readonly unknown[]) =>
            new QueueOptions(await load(...deps)),
          inject,
        }),
        ...bindings(metrics),
        runner(metrics),
      ],
    };
  }
}
