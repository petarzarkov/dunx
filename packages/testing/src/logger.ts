import { Logger, LogLevel, type LogMessage } from '@dunx/core';

export interface RecordedLog {
  readonly level: LogLevel;
  readonly message: LogMessage;
  readonly params: readonly unknown[];
}

/**
 * A {@link Logger} that keeps entries instead of writing them, so a suite can
 * assert on what was logged and stays quiet when it does not care.
 *
 * It is here because the contract is seven levels of three overloads each: every
 * suite that wants a silent logger would otherwise hand-write the same thirty
 * lines. Nothing is interpreted — no level filtering, no error promotion, no
 * merging of extras — because those are the backing logger's behaviour and
 * asserting against a reimplementation of them would prove nothing.
 *
 * ```ts
 * const logger = new RecordingLogger();
 * await createTestApp({
 *   modules: [UsersModule],
 *   overrides: [provide(Logger, { useValue: logger })],
 * });
 * expect(logger.at(LogLevel.WARN)).toHaveLength(0);
 * ```
 */
export class RecordingLogger extends Logger {
  /** Everything is recorded, so a suite can assert on a `verbose` call too. */
  readonly logLevel: LogLevel = LogLevel.VERBOSE;
  readonly entries: RecordedLog[] = [];

  verbose(message: LogMessage, ...params: unknown[]): void {
    this.#record(LogLevel.VERBOSE, message, params);
  }

  debug(message: LogMessage, ...params: unknown[]): void {
    this.#record(LogLevel.DEBUG, message, params);
  }

  info(message: LogMessage, ...params: unknown[]): void {
    this.#record(LogLevel.INFO, message, params);
  }

  /** @deprecated Use {@link RecordingLogger.info}. Recorded as `info` either way. */
  log(message: LogMessage, ...params: unknown[]): void {
    this.#record(LogLevel.INFO, message, params);
  }

  warn(message: LogMessage, ...params: unknown[]): void {
    this.#record(LogLevel.WARN, message, params);
  }

  error(message: LogMessage, ...params: unknown[]): void {
    this.#record(LogLevel.ERROR, message, params);
  }

  fatal(message: LogMessage, ...params: unknown[]): void {
    this.#record(LogLevel.FATAL, message, params);
  }

  at(level: LogLevel): readonly RecordedLog[] {
    return this.entries.filter((entry) => entry.level === level);
  }

  clear(): void {
    this.entries.length = 0;
  }

  #record(
    level: LogLevel,
    message: LogMessage,
    params: readonly unknown[],
  ): void {
    this.entries.push({ level, message, params });
  }
}
