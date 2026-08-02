/**
 * Frozen object plus an indexed-access union, not an `enum` - see CLAUDE.md and
 * `@dunx/http`'s `HttpStatusCode`. One exported name serves as both the value
 * (`LogLevel.DEBUG`) and the type (`level: LogLevel`), and it erases cleanly
 * instead of emitting a runtime object with reverse mappings.
 */
export const LogLevel = Object.freeze({
  VERBOSE: 'verbose',
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
  FATAL: 'fatal',
} as const);
export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];

/**
 * Ascending severity. Position in this array is what `level` filtering compares,
 * and the backing logger compares against its **own** copy - so these names must
 * stay identical to `@arkv/logger`'s. A name it does not know indexes to `-1`,
 * which sits below every real level, so drift disables filtering rather than
 * raising. `@dunx/infra`'s logger tests assert the two arrays are equal.
 */
export const LOG_LEVELS = Object.freeze([
  LogLevel.VERBOSE,
  LogLevel.DEBUG,
  LogLevel.INFO,
  LogLevel.WARN,
  LogLevel.ERROR,
  LogLevel.FATAL,
] as const);

/** Levels at which a bare string or `{ error: string }` is promoted to an `Error`. */
const ERROR_LEVELS: readonly LogLevel[] = [
  LogLevel.WARN,
  LogLevel.ERROR,
  LogLevel.FATAL,
];

export const isErrorLevel = (level: LogLevel): boolean =>
  ERROR_LEVELS.includes(level);

/** A serialized `Error`, as the backing logger writes it. */
export interface SerializedError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
}

/** One structured entry. Extra fields are whatever the caller merged in. */
export type LogEntry = Record<string, unknown> & {
  error?: Error | SerializedError;
};
