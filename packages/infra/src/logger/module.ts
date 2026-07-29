import { provide, type DynamicModule } from '@dunx/core';
import { ConsoleLogger } from './console.js';
import { ContextStore } from './context.js';
import { Logger } from './logger.js';
import { LoggerOptions, resolveLoggerOptions } from './options.js';
import type { LoggerConfig } from './types.js';

/** Config, or a loader for it. A loader may be async. */
export type LoggerConfigSource =
  | LoggerConfig
  | (() => LoggerConfig | Promise<LoggerConfig>);

export class LoggerModule {
  /**
   * Binds {@link Logger}, {@link LoggerOptions} and {@link ContextStore}.
   *
   * ```ts
   * @Module({ imports: [LoggerModule.forRoot({ name: 'api', level: LogLevel.LOG })] })
   * export class AppModule {}
   * ```
   *
   * There is no `forRootAsync`. dunx resolves eagerly and awaits factories before
   * any constructor runs, so an asynchronously configured module is just one whose
   * config comes from a factory — pass a function and it is awaited:
   *
   * ```ts
   * LoggerModule.forRoot(async () => ({ level: await settings.logLevel() }));
   * ```
   *
   * `Logger` is bound through an explicit factory rather than
   * `useClass: ConsoleLogger` so that `@dunx/infra/logger` works with or without
   * the `@dunx/compiler` preload — the plugin skips `node_modules`, so it never
   * sees this package's published `dist`.
   */
  static forRoot(config: LoggerConfigSource = {}): DynamicModule {
    return {
      module: LoggerModule,
      providers: [
        ContextStore,
        provide(LoggerOptions, {
          useFactory: async () =>
            resolveLoggerOptions(
              typeof config === 'function' ? await config() : config,
            ),
        }),
        provide(Logger, {
          useFactory: (options: LoggerOptions, context: ContextStore) =>
            new ConsoleLogger(options, context),
          inject: [LoggerOptions, ContextStore] as const,
        }),
      ],
    };
  }
}
