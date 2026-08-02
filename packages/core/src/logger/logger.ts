import type { LogLevel } from './types.js';

/**
 * The injectable contract.
 *
 * An `abstract class` rather than an interface on purpose: `@dunx/transform` records
 * constructor parameter *types*, and an interface has no runtime value to record,
 * so an interface here would be a boot error at the injection site. See CLAUDE.md,
 * "Dependency injection".
 *
 * ```ts
 * class Users {
 *   constructor(private readonly logger: Logger) {}
 * }
 * ```
 *
 * Every level takes the same three shapes:
 *
 * - `logger.info('message', extra, err)` - a message plus any number of extras.
 *   An `Error` among them becomes the entry's `error`; at `warn` and above so does
 *   a bare string or an `{ err }` / `{ error }` property.
 * - `logger.info({ orderId, total })` - the object's fields are merged into the
 *   entry. An `Error` nested anywhere inside it is found and its message becomes
 *   the entry's message.
 * - `logger.info(err)` - the error's message becomes the entry's message.
 */
export abstract class Logger {
  /** The configured threshold. Entries below it are dropped. */
  abstract readonly logLevel: LogLevel;

  abstract verbose(message: string, ...optionalParams: unknown[]): void;
  abstract verbose(message: Record<string, unknown>): void;
  abstract verbose(message: Error): void;

  abstract debug(message: string, ...optionalParams: unknown[]): void;
  abstract debug(message: Record<string, unknown>): void;
  abstract debug(message: Error): void;

  abstract info(message: string, ...optionalParams: unknown[]): void;
  abstract info(message: Record<string, unknown>): void;
  abstract info(message: Error): void;

  /**
   * @deprecated Use {@link Logger.info}. Only a method name - the emitted `level`
   * is `'info'` either way. Kept because the backing `@arkv/logger` keeps it for
   * a third-party `LoggerService` interface, and dropping it here would reject
   * that class.
   */
  abstract log(message: string, ...optionalParams: unknown[]): void;
  /** @deprecated Use {@link Logger.info}. */
  abstract log(message: Record<string, unknown>): void;
  /** @deprecated Use {@link Logger.info}. */
  abstract log(message: Error): void;

  abstract warn(message: string, ...optionalParams: unknown[]): void;
  abstract warn(message: Record<string, unknown>): void;
  abstract warn(message: Error): void;

  abstract error(message: string, ...optionalParams: unknown[]): void;
  abstract error(message: Record<string, unknown>): void;
  abstract error(message: Error): void;

  abstract fatal(message: string, ...optionalParams: unknown[]): void;
  abstract fatal(message: Record<string, unknown>): void;
  abstract fatal(message: Error): void;
}

/** What every level accepts. */
export type LogMessage = string | Record<string, unknown> | Error;
