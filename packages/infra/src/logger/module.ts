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
  type AsyncModuleConfig,
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
 * implementation carries more than that - `child(bindings)`, `setLevel(level)`,
 * `stats()`, `flush()`/`close()` and their awaited counterparts - and this token
 * is how an app reaches them without a cast or an adapter class widening the
 * contract for everyone.
 *
 * `setLevel` is the one worth knowing about: it moves this logger and every child
 * it made, so a `SIGUSR2` handler resolving this token can turn a running process
 * to debug without a restart.
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
   *
   * **`closeAsync`, and the await is the point.** A `FileTransport` writes
   * synchronously and either form drains it, but a transport whose sink is a
   * network cannot answer synchronously at all: `close()` on one discards
   * whatever it was holding, so every deploy lost the last batch of logs before
   * the pod went away. `@dunx/core` declares `onShutdown(): void | Promise<void>`
   * and `App.shutdown` awaits it, so this costs nothing to arrange.
   */
  async onShutdown(): Promise<void> {
    this.#release?.();
    await this.logger.closeAsync();
  }
}

/** Everything except the settings binding, which is what the two entrypoints differ on. */
/**
 * **`global: true`**, and this is the module that most needs it: `Logger` and
 * `RequestContext` are what core guarantees resolvable everywhere, so binding them
 * behind an import boundary would mean every feature module importing a logging
 * module to get a logger. `@dunx/http` middleware injects `Logger` too and has no
 * module of its own to import from.
 *
 * `BackingLogger` is exported as well, so `child()`, `flush()` and `close()` are
 * reachable without widening the contract. `LoggerSettings` and `LoggerLifecycle`
 * stay private - they are how this module was configured and how it shuts down.
 */
const surface = [Logger, RequestContext, BackingLogger];

const bindings = (options: LoggerModuleOptions): readonly Registration[] => [
  // Core's contract, bound to the very store this logger reads. Without it
  // @dunx/http's request logging would write a traceId into core's default
  // store and @arkv/logger would read its own, so no entry would carry one.
  // `ContextStore` satisfies `RequestContext` structurally - no adapter.
  provide(RequestContext, {
    useFactory: (store: ContextStore) => store,
    inject: [ContextStore] as const,
  }),
  provide(BackingLogger, {
    // `isDevelopment` is upstream's colour switch and nothing else, and upstream
    // defaults it from `NODE_ENV` with no terminal check anywhere on the path - so
    // a container with `NODE_ENV` unset writes ANSI escapes into its JSON and the
    // logs stop parsing. `Bun.enableANSIColors` is the question actually being
    // asked, and it already folds in TTY, `NO_COLOR` and `FORCE_COLOR`. The
    // consumer still wins, and this is the Bun-specific half of the fix: the
    // portable one belongs upstream (internal/notes/roadmap/arkv-integrations.md).
    useFactory: (settings: LoggerConfig, context: ContextStore) =>
      new ArkvLogger(
        {
          ...settings,
          isDevelopment: settings.isDevelopment ?? Bun.enableANSIColors,
        },
        context,
      ),
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
      global: true,
      exports: surface,
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
    config: AsyncModuleConfig<LoggerConfig, D>,
    options: LoggerModuleOptions = {},
  ): DynamicModule {
    return {
      module: LoggerModule,
      global: true,
      ...(config.imports === undefined ? {} : { imports: config.imports }),
      exports: surface,
      providers: [
        provide(LoggerSettings, config),
        ContextStore,
        ...bindings(options),
      ],
    };
  }
}
