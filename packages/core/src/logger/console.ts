import { Logger } from './logger.js';
import type { RequestContext } from './context.js';
import { isErrorLevel, type LogLevel, LOG_LEVELS } from './types.js';

const serialize = (error: Error): Record<string, unknown> => ({
  name: error.name,
  message: error.message,
  ...(error.stack === undefined ? {} : { stack: error.stack }),
});

/**
 * The default binding for {@link Logger}, so `Logger` is injectable in an app
 * that has imported no logging module at all — which is what lets `@dunx/http`
 * turn request logging on by default without booting into "No provider".
 *
 * Deliberately small: one JSON line per entry on stdout, stderr from `warn` up
 * so a shipper can separate them. It does **not** sanitize, mask, rotate or
 * colour. `@dunx/infra/logger` replaces it with `@arkv/logger`, which does all
 * of that, and the swap is one import — see `packages/infra/README.md`.
 */
export class ConsoleLogger extends Logger {
  readonly #minimum: number;

  constructor(
    private readonly context?: RequestContext,
    readonly logLevel: LogLevel = 'info',
  ) {
    super();
    this.#minimum = LOG_LEVELS.indexOf(logLevel);
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

  /** @deprecated Use {@link ConsoleLogger.info}. */
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

    const extra: Record<string, unknown> = {};
    let error: Error | undefined;

    for (const value of [message, ...rest]) {
      if (value instanceof Error) error ??= value;
      else if (typeof value === 'object' && value !== null) {
        Object.assign(extra, value);
      }
    }

    const text =
      typeof message === 'string'
        ? message
        : message instanceof Error
          ? message.message
          : 'Object logged';

    const entry = {
      level,
      timestamp: new Date().toISOString(),
      pid: process.pid,
      message: text,
      ...this.context?.getContext(),
      ...extra,
      ...(error === undefined ? {} : { error: serialize(error) }),
    };

    // JSON.stringify, not a formatter: a cycle here would be the logger's fault,
    // and the replacement that handles cycles is one import away.
    const line = JSON.stringify(entry);
    if (isErrorLevel(level)) console.error(line);
    else console.log(line);
  }
}
