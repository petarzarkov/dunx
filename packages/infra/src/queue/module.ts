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
 * `QueueOptions` reports the redacted broker url, and `QueueConnection` is what a
 * `WorkerFactory` in the same process needs.
 */
const surface = [QueueOptions, QueueConnection, JobPublisher];

/**
 * Always bound, and it does nothing unless `consume` is set - the check is inside
 * `onInit` rather than here because `forRootAsync` builds its options from a
 * factory, so the flag is not knowable when the providers are declared. An idle
 * runner costs one object.
 *
 * Bound **after** the publisher, so reverse-order teardown stops the workers before
 * the connection they run on closes.
 *
 * `QueueConnection` is in the inject list even though the runner never touches it
 * directly: it is what puts the runner after it in construction order, and
 * therefore before it in teardown. An ordering expressed as a dependency is one the
 * container enforces rather than one a comment asks for.
 */
const runner = (): Registration =>
  provide(QueueRunner, {
    useFactory: (
      ref: AppRef,
      root: ModuleRef,
      options: QueueOptions,
      logger: Logger,
      _connection: QueueConnection,
    ) => new QueueRunner(ref, root, options, logger),
    inject: [
      AppRef,
      ROOT_MODULE,
      QueueOptions,
      Logger,
      QueueConnection,
    ] as const,
  });

const bindings: readonly Registration[] = [
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
    ) => new JobPublisher(connection, options, logger),
    inject: [QueueConnection, QueueOptions, Logger] as const,
  }),
];

/**
 * Binds `QueueOptions`, `QueueConnection` and `JobPublisher` - the publish side,
 * which is all a web process needs.
 *
 * A worker process imports the same module and adds `WorkerFactory.create`, which
 * is what discovers the handlers and opens the bullmq `Worker`s. Importing this
 * alone opens no worker and consumes nothing.
 */
export class QueueModule {
  static forRoot(init: QueueOptionsInit = {}): DynamicModule {
    return {
      module: QueueModule,
      exports: surface,
      providers: [
        provide(QueueOptions, { useValue: new QueueOptions(init) }),
        ...bindings,
        runner(),
      ],
    };
  }

  /**
   * `forRoot` with the options behind a factory. There is no separate async
   * machinery: the container resolves eagerly and awaits factories before any
   * constructor runs, so awaited config is already settled by then.
   *
   * The factory may also **inject**, which a bare loader cannot - reading the url
   * off `ConfigService`, say:
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
  ): DynamicModule;
  static forRootAsync<const D extends Deps>(
    config: AsyncModuleConfig<QueueOptionsInit, D>,
  ): DynamicModule;
  static forRootAsync(
    source:
      | (() => QueueOptionsInit | Promise<QueueOptionsInit>)
      | AsyncModuleConfig<QueueOptionsInit, Deps>,
  ): DynamicModule {
    const load = typeof source === 'function' ? source : source.useFactory;
    const inject = typeof source === 'function' ? [] : (source.inject ?? []);

    return {
      module: QueueModule,
      ...(typeof source === 'function' || source.imports === undefined
        ? {}
        : { imports: source.imports }),
      exports: surface,
      providers: [
        provide(QueueOptions, {
          useFactory: async (...deps: readonly unknown[]) =>
            new QueueOptions(await load(...deps)),
          inject,
        }),
        ...bindings,
        runner(),
      ],
    };
  }
}
