import {
  AppRef,
  Logger,
  provide,
  RequestContext,
  ROOT_MODULE,
  type AsyncModuleConfig,
  type Deps,
  type DynamicModule,
  type ModuleRef,
  type Registration,
} from '@dunx/core';
import { AmqpConnection } from './connection.js';
import { AmqpOptions, type AmqpOptionsInit } from './options.js';
import { AmqpPublisher } from './publisher.js';
import { AmqpRunner } from './runner.js';

/** `AmqpPublisher` is what an app sends through, `AmqpOptions` reports the
 * redacted url, and `AmqpConnection` is what a channel of your own needs. */
const surface = [AmqpOptions, AmqpConnection, AmqpPublisher];

/**
 * Each binding depends on the one before it, and dunx tears down in reverse
 * construction order - so the connection closes its socket last, after every
 * consumer has drained and the publisher's channel has closed.
 */
const bindings = (): readonly Registration[] => [
  provide(AmqpConnection, {
    useFactory: (options: AmqpOptions, logger: Logger) =>
      new AmqpConnection(options, logger),
    inject: [AmqpOptions, Logger] as const,
  }),
  provide(AmqpPublisher, {
    useFactory: (
      connection: AmqpConnection,
      options: AmqpOptions,
      logger: Logger,
      context: RequestContext,
    ) => new AmqpPublisher(connection, options, logger, context),
    inject: [AmqpConnection, AmqpOptions, Logger, RequestContext] as const,
  }),
  /**
   * Always bound, idle unless `consume` is set - checked in `onInit`, since
   * `forRootAsync` builds its options from a factory. `AmqpPublisher` is injected
   * though the runner never touches it, so a handler that publishes still has a
   * channel while it drains.
   */
  provide(AmqpRunner, {
    useFactory: (
      ref: AppRef,
      root: ModuleRef,
      options: AmqpOptions,
      logger: Logger,
      connection: AmqpConnection,
      _publisher: AmqpPublisher,
    ) => new AmqpRunner(ref, root, options, logger, connection),
    inject: [
      AppRef,
      ROOT_MODULE,
      AmqpOptions,
      Logger,
      AmqpConnection,
      AmqpPublisher,
    ] as const,
  }),
];

/**
 * Binds the publish side, which is all a web process needs. `consume: true` adds
 * the consuming side to the same container, discovering the `@AmqpHandler`
 * methods and opening one consumer per queue. Importing this alone opens no
 * socket until the first publish.
 */
export class AmqpModule {
  static forRoot(init: AmqpOptionsInit = {}): DynamicModule {
    return {
      module: AmqpModule,
      exports: surface,
      providers: [
        provide(AmqpOptions, { useValue: new AmqpOptions(init) }),
        ...bindings(),
      ],
    };
  }

  /**
   * `forRoot` with the options behind a factory, which may inject:
   *
   * ```ts
   * AmqpModule.forRootAsync({
   *   useFactory: (config: AppConfigService) => ({ url: config.get('amqp').url }),
   *   inject: [AppConfigService],
   * });
   * ```
   */
  static forRootAsync(
    load: () => AmqpOptionsInit | Promise<AmqpOptionsInit>,
  ): DynamicModule;
  static forRootAsync<const D extends Deps>(
    config: AsyncModuleConfig<AmqpOptionsInit, D>,
  ): DynamicModule;
  static forRootAsync(
    source:
      | (() => AmqpOptionsInit | Promise<AmqpOptionsInit>)
      | AsyncModuleConfig<AmqpOptionsInit, Deps>,
  ): DynamicModule {
    const load = typeof source === 'function' ? source : source.useFactory;
    const inject = typeof source === 'function' ? [] : (source.inject ?? []);

    return {
      module: AmqpModule,
      ...(typeof source === 'function' || source.imports === undefined
        ? {}
        : { imports: source.imports }),
      exports: surface,
      providers: [
        provide(AmqpOptions, {
          useFactory: async (...deps: readonly unknown[]) =>
            new AmqpOptions(await load(...deps)),
          inject,
        }),
        ...bindings(),
      ],
    };
  }
}
