import {
  ContextStore,
  Logger as ArkvLogger,
  type LoggerConfig,
} from '@arkv/logger';
import { Logger, provide, token, type DynamicModule } from '@dunx/core';

/**
 * The config `@arkv/logger` accepts, bound as a token so a factory can read it.
 * dunx does not restate it — a parallel config type is the duplication the
 * "reuse `@arkv`" rule in CLAUDE.md exists to prevent.
 */
export const LoggerSettings = token<LoggerConfig>('LoggerConfig');

/** Options, or a function returning them — possibly async. */
export type LoggerConfigSource =
  | LoggerConfig
  | (() => LoggerConfig | Promise<LoggerConfig>);

export class LoggerModule {
  /**
   * Binds `Logger` (the `@dunx/core` contract) to `@arkv/logger`'s implementation.
   *
   * No adapter class sits between them: `@arkv/logger`'s `Logger` already declares
   * `logLevel` and all six levels with the same overloads, so it satisfies the
   * contract structurally. dunx supplies the contract and the wiring, nothing else.
   *
   * There is no `forRootAsync` — eager resolution settles an async factory before
   * any constructor runs, so a function config is simply a `useFactory`. See
   * docs/ARCHITECTURE.md, "Configured modules, and why there is no forRootAsync".
   */
  static forRoot(config: LoggerConfigSource = {}): DynamicModule {
    return {
      module: LoggerModule,
      providers: [
        typeof config === 'function'
          ? provide(LoggerSettings, { useFactory: config })
          : provide(LoggerSettings, { useValue: config }),
        ContextStore,
        provide(Logger, {
          useFactory: (settings: LoggerConfig, context: ContextStore) =>
            new ArkvLogger(settings, context),
          inject: [LoggerSettings, ContextStore] as const,
        }),
      ],
    };
  }
}
