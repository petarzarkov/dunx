import {
  type CaptureGlobalErrorsOptions,
  captureGlobalErrors,
  ContextStore,
  Logger as ArkvLogger,
  type LoggerConfig,
} from '@arkv/logger';
import {
  type Deps,
  type DynamicModule,
  type FactoryProvider,
  Logger,
  type OnInit,
  type OnShutdown,
  provide,
  type Registration,
  RequestContext,
  token,
} from '@dunx/core';

/**
 * The config `@arkv/logger` accepts, bound as a token so a factory can read it.
 * dunx does not restate it - a parallel config type is the duplication the
 * "reuse `@arkv`" rule in CLAUDE.md exists to prevent.
 */
export const LoggerSettings = token<LoggerConfig>('LoggerConfig');

/**
 * The same instance `Logger` resolves to, typed as the implementation.
 *
 * Core's contract covers the six levels and nothing else, on purpose. The
 * implementation carries three things beyond it - `child(bindings)`,
 * `flush()` and `close()` - and this token is how an app reaches them without
 * a cast or an adapter class widening the contract for everyone.
 */
export const BackingLogger = token<ArkvLogger>('BackingLogger');

/** Options, or a function returning them - possibly async. */
export type LoggerConfigSource =
  | LoggerConfig
  | (() => LoggerConfig | Promise<LoggerConfig>);

export interface LoggerModuleOptions {
  /**
   * Install `uncaughtException` and `unhandledRejection` handlers that log
   * through this logger and flush before the process goes away. `true` takes
   * the defaults: fatal for an uncaught exception, then `process.exit(1)`.
   */
  captureGlobalErrors?: boolean | CaptureGlobalErrorsOptions;
}

/**
 * Owns the two things core's `Logger` contract deliberately does not carry: the
 * process-level error handlers, and flushing a buffered `FileTransport` before
 * the process ends. A separate provider rather than a wrapper, so nothing sits
 * between the contract and the implementation.
 */
class LoggerLifecycle implements OnInit, OnShutdown {
  #release: (() => void) | undefined;

  constructor(
    private readonly logger: ArkvLogger,
    private readonly capture: LoggerModuleOptions['captureGlobalErrors'],
  ) {}

  onInit(): void {
    if (!this.capture) return;
    this.#release = captureGlobalErrors(
      this.logger,
      this.capture === true ? {} : this.capture,
    );
  }

  /**
   * Runs late: `App.shutdown` walks instances in reverse resolution order, and
   * the logger resolves before anything that depends on it, so those services
   * can still log while they close.
   */
  onShutdown(): void {
    this.#release?.();
    this.logger.close();
  }
}

/** Everything except the settings binding, which is what the two entrypoints differ on. */
const bindings = (options: LoggerModuleOptions): readonly Registration[] => [
  // Core's contract, bound to the very store this logger reads. Without it
  // @dunx/http's request logging would write a requestId into core's default
  // store and @arkv/logger would read its own, so no entry would carry one.
  // `ContextStore` satisfies `RequestContext` structurally - no adapter.
  provide(RequestContext, {
    useFactory: (store: ContextStore) => store,
    inject: [ContextStore] as const,
  }),
  provide(BackingLogger, {
    useFactory: (settings: LoggerConfig, context: ContextStore) =>
      new ArkvLogger(settings, context),
    inject: [LoggerSettings, ContextStore] as const,
  }),
  provide(Logger, {
    useFactory: (logger: ArkvLogger) => logger,
    inject: [BackingLogger] as const,
  }),
  provide(LoggerLifecycle, {
    useFactory: (logger: ArkvLogger) =>
      new LoggerLifecycle(logger, options.captureGlobalErrors),
    inject: [BackingLogger] as const,
  }),
];

export class LoggerModule {
  /**
   * Binds `Logger` (the `@dunx/core` contract) to `@arkv/logger`'s implementation.
   *
   * No adapter class sits between them: `@arkv/logger`'s `Logger` already declares
   * `logLevel` and all six levels with the same overloads, so it satisfies the
   * contract structurally. dunx supplies the contract and the wiring, nothing else.
   */
  static forRoot(
    config: LoggerConfigSource = {},
    options: LoggerModuleOptions = {},
  ): DynamicModule {
    return {
      module: LoggerModule,
      providers: [
        typeof config === 'function'
          ? provide(LoggerSettings, { useFactory: config })
          : provide(LoggerSettings, { useValue: config }),
        ContextStore,
        ...bindings(options),
      ],
    };
  }

  /**
   * The same bindings, with the config produced by a factory that may inject -
   * which is the only thing `forRoot` cannot express, since the function it takes
   * receives no arguments. Reading the level off `ConfigService` is the case:
   *
   * ```ts
   * LoggerModule.forRootAsync({
   *   useFactory: (config: ConfigService<AppConfig>) => ({
   *     level: config.get('log').level,
   *   }),
   *   inject: [ConfigService],
   * });
   * ```
   *
   * Named for the `FilesModule`/`DbModule` precedent, not because asynchrony is
   * the point: eager resolution settles an async factory either way.
   */
  static forRootAsync<const D extends Deps>(
    config: FactoryProvider<LoggerConfig, D>,
    options: LoggerModuleOptions = {},
  ): DynamicModule {
    return {
      module: LoggerModule,
      providers: [
        provide(LoggerSettings, config),
        ContextStore,
        ...bindings(options),
      ],
    };
  }
}
