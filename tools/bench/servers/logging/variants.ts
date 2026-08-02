import { Logger, LOG_LEVELS, RequestContext, type LogLevel } from '@dunx/core';

/**
 * The default request-logging path, sliced one step at a time. Every variant runs
 * the same app on the same route and differs from the one before it by exactly one
 * piece of work, so a row minus the row above it is that piece's cost.
 *
 * `off` through `respheader` use `StepMiddleware` in `dunx.ts`, which is
 * `RequestLoggingMiddleware` with everything past a given step removed. `entry`
 * onwards use the real middleware and vary only the bound `Logger`.
 *
 * The loggers below must stay a faithful copy of `ConsoleLogger` minus the step
 * they are named for. When that file changes, these change with it - otherwise the
 * table decomposes an implementation that is no longer the one shipping.
 */
export const loggingVariants = Object.freeze([
  'off',
  'passthru',
  'path',
  'headers',
  'requestid',
  'als',
  'respheader',
  'entry',
  'timestamp',
  'serialize',
  'unbatched',
  'default',
] as const);
export type LoggingVariant = (typeof loggingVariants)[number];

export const isLoggingVariant = (value: string): value is LoggingVariant =>
  (loggingVariants as readonly string[]).includes(value);

export const stepOf = (variant: LoggingVariant): number =>
  loggingVariants.indexOf(variant);

/** Kept in module scope so the optimiser cannot drop the work being measured. */
export const sink: { line: string; stamp: string; count: number } = {
  line: '',
  stamp: '',
  count: 0,
};

/**
 * Counts the entry and does nothing else - isolates everything before the logger.
 * It counts rather than returning, so the call cannot be inlined away.
 */
export class DiscardLogger extends Logger {
  readonly logLevel: LogLevel = 'info';

  verbose(): void {
    sink.count += 1;
  }
  debug(): void {
    sink.count += 1;
  }
  info(): void {
    sink.count += 1;
  }
  log(): void {
    sink.count += 1;
  }
  warn(): void {
    sink.count += 1;
  }
  error(): void {
    sink.count += 1;
  }
  fatal(): void {
    sink.count += 1;
  }
}

/**
 * Only the timestamp `ConsoleLogger` stamps on every entry, cached by millisecond
 * exactly as it caches it, then stops.
 */
let stampAt = 0;
let stampValue = '';
export class TimestampLogger extends DiscardLogger {
  override info(): void {
    const now = Date.now();
    if (now !== stampAt) {
      stampAt = now;
      stampValue = new Date(now).toISOString();
    }
    sink.stamp = stampValue;
  }
}

/**
 * `ConsoleLogger` with the write removed and nothing else changed, so the
 * difference between this row and `unbatched` is the write and only the write.
 */
export class SerializeOnlyLogger extends Logger {
  readonly #minimum: number;
  readonly logLevel: LogLevel = 'info';

  constructor(private readonly context?: RequestContext) {
    super();
    this.#minimum = LOG_LEVELS.indexOf('info');
  }

  verbose(message: unknown, ...rest: unknown[]): void {
    this.#write('verbose', message, rest);
  }
  debug(message: unknown, ...rest: unknown[]): void {
    this.#write('debug', message, rest);
  }
  info(message: unknown, ...rest: unknown[]): void {
    this.#write('info', message, rest);
  }
  log(message: unknown, ...rest: unknown[]): void {
    this.#write('info', message, rest);
  }
  warn(message: unknown, ...rest: unknown[]): void {
    this.#write('warn', message, rest);
  }
  error(message: unknown, ...rest: unknown[]): void {
    this.#write('error', message, rest);
  }
  fatal(message: unknown, ...rest: unknown[]): void {
    this.#write('fatal', message, rest);
  }

  #write(level: LogLevel, message: unknown, rest: readonly unknown[]): void {
    if (LOG_LEVELS.indexOf(level) < this.#minimum) return;

    const now = Date.now();
    if (now !== stampAt) {
      stampAt = now;
      stampValue = new Date(now).toISOString();
    }
    const only = rest[0];
    sink.line = JSON.stringify({
      level,
      timestamp: stampValue,
      pid: process.pid,
      message,
      ...this.context?.getContext(),
      ...(only as Record<string, unknown> | undefined),
    });
  }
}
