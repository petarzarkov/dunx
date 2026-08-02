import {
  Logger,
  provide,
  type Deps,
  type DynamicModule,
  type FactoryProvider,
  type Registration,
} from '@dunx/core';
import { QueueConnection } from './connection.js';
import { QueueOptions, type QueueOptionsInit } from './options.js';
import { JobPublisher } from './publisher.js';

/**
 * `QueueConnection` is bound as a factory over `QueueOptions`, and `JobPublisher`
 * as one over the connection, which is what fixes the teardown order. dunx tears
 * down in reverse construction order, so the connection - constructed first,
 * because the publisher needs it - closes its sockets last, after every queue has
 * closed.
 */
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
      providers: [
        provide(QueueOptions, { useValue: new QueueOptions(init) }),
        ...bindings,
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
    config: FactoryProvider<QueueOptionsInit, D>,
  ): DynamicModule;
  static forRootAsync(
    source:
      | (() => QueueOptionsInit | Promise<QueueOptionsInit>)
      | FactoryProvider<QueueOptionsInit, Deps>,
  ): DynamicModule {
    const load = typeof source === 'function' ? source : source.useFactory;
    const inject = typeof source === 'function' ? [] : (source.inject ?? []);

    return {
      module: QueueModule,
      providers: [
        provide(QueueOptions, {
          useFactory: async (...deps: readonly unknown[]) =>
            new QueueOptions(await load(...deps)),
          inject,
        }),
        ...bindings,
      ],
    };
  }
}
