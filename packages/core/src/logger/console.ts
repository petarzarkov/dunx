import type { ContextStore } from './context.js';
import { formatColoredJson } from './format.js';
import { Logger, type LogMessage } from './logger.js';
import type { LoggerOptions } from './options.js';
import { findNestedError, sanitizeLogEntry } from './sanitize.js';
import { isPlainObject, safeStringify, serializeError } from './serialize.js';
import {
  isErrorLevel,
  LOG_LEVELS,
  LogLevel,
  type AsyncContext,
  type LogEntry,
} from './types.js';

interface Prepared {
  readonly message: string;
  readonly extra?: LogEntry;
  readonly error?: Error;
  /** Only set when the caller passed something that is not a valid message. */
  readonly invalid?: LogEntry;
}

const prepareMessage = (message: unknown, maxDepth: number): Prepared => {
  if (typeof message === 'string') return { message };
  if (message instanceof Error) {
    return { message: message.message, error: message };
  }

  if (isPlainObject(message)) {
    const found = findNestedError(message, maxDepth);
    return found
      ? { message: found.message, error: found, extra: message }
      : { message: 'Object logged', extra: message };
  }

  // A number, a boolean, null — legal at runtime, so it is logged rather than
  // dropped, but the call site is recorded so the bad call can be found.
  const stack = new Error().stack?.split('\n').slice(2, 7).join('\n');
  return {
    message:
      message === null || message === undefined
        ? `[${String(message)}]`
        : `[OBJECT]: ${safeStringify(message)}`,
    invalid: {
      invalidMessageWarning: 'Logger called with non-string message parameter',
      invalidMessageCallstack: stack,
      originalMessageType: typeof message,
      originalMessage: safeStringify(message),
    },
  };
};

/**
 * Which property of an extra object holds the error. An `Error` instance wins
 * over a string wherever it is, and a string only counts at `warn` and above —
 * `{ error: 'not found' }` at debug level is data, not a failure.
 */
const errorKeyOf = (
  param: Record<string, unknown>,
  level: LogLevel,
): 'err' | 'error' | undefined => {
  if (param['err'] instanceof Error) return 'err';
  if (param['error'] instanceof Error) return 'error';
  if (!isErrorLevel(level)) return undefined;
  if (typeof param['err'] === 'string') return 'err';
  if (typeof param['error'] === 'string') return 'error';
  return undefined;
};

const extractErrorAndExtra = (
  params: readonly unknown[],
  level: LogLevel,
  maxDepth: number,
): { error: Error | null; extra: LogEntry } => {
  let error: Error | null = null;
  const extra: LogEntry = {};

  for (const param of params) {
    if (param instanceof Error) {
      error = param;
      continue;
    }

    if (typeof param === 'string') {
      if (isErrorLevel(level)) error = new Error(param);
      else extra['context'] = param;
      continue;
    }

    if (!isPlainObject(param)) continue;

    const key = errorKeyOf(param, level);
    if (key === undefined) {
      error = findNestedError(param, maxDepth) ?? error;
      Object.assign(extra, param);
      continue;
    }

    const value = param[key];
    error = value instanceof Error ? value : new Error(String(value));
    Object.assign(extra, param);
    delete extra[key];
  }

  return { error, extra };
};

/**
 * Writes one JSON entry per call to `console.log`, coloured when
 * `LoggerOptions.colors` says so.
 *
 * One line per entry is deliberate: a stack's newlines are collapsed to commas by
 * `serializeError`, so a shipper that splits on newlines gets one record per log
 * call rather than a dozen fragments of one.
 *
 * Nothing is buffered, so there is no `onShutdown` to flush — `console.log` hands
 * the bytes to the runtime on every call.
 */
export class ConsoleLogger extends Logger {
  readonly #options: LoggerOptions;
  readonly #context: ContextStore;

  constructor(options: LoggerOptions, context: ContextStore) {
    super();
    this.#options = options;
    this.#context = context;
  }

  get logLevel(): LogLevel {
    return this.#options.level;
  }

  verbose(message: LogMessage, ...optionalParams: unknown[]): void {
    this.#write(LogLevel.VERBOSE, message, optionalParams);
  }

  debug(message: LogMessage, ...optionalParams: unknown[]): void {
    this.#write(LogLevel.DEBUG, message, optionalParams);
  }

  log(message: LogMessage, ...optionalParams: unknown[]): void {
    this.#write(LogLevel.LOG, message, optionalParams);
  }

  warn(message: LogMessage, ...optionalParams: unknown[]): void {
    this.#write(LogLevel.WARN, message, optionalParams);
  }

  error(message: LogMessage, ...optionalParams: unknown[]): void {
    this.#write(LogLevel.ERROR, message, optionalParams);
  }

  fatal(message: LogMessage, ...optionalParams: unknown[]): void {
    this.#write(LogLevel.FATAL, message, optionalParams);
  }

  #write(
    level: LogLevel,
    message: LogMessage,
    optionalParams: readonly unknown[],
  ): void {
    // One read of the async store per call, shared by the filter and the entry.
    const context = this.#context.getContext();
    if (!this.#shouldLog(level, context)) return;

    const prepared = prepareMessage(message, this.#options.maxDepth);
    const extracted = extractErrorAndExtra(
      optionalParams,
      level,
      this.#options.maxDepth,
    );
    const error = prepared.error ?? extracted.error;

    const entry: LogEntry = {
      level,
      timestamp: new Date().toISOString(),
      pid: process.pid,
      message: prepared.message,
      ...(this.#options.appId === undefined
        ? {}
        : { appId: this.#options.appId }),
      ...context,
      ...prepared.extra,
      ...extracted.extra,
      ...prepared.invalid,
    };
    if (error) entry.error = serializeError(error);

    const sanitized = sanitizeLogEntry(entry, this.#options);
    console.log(
      this.#options.colors
        ? formatColoredJson(sanitized, level)
        : safeStringify(sanitized),
    );
  }

  #shouldLog(level: LogLevel, context: AsyncContext): boolean {
    if (LOG_LEVELS.indexOf(level) < LOG_LEVELS.indexOf(this.#options.level)) {
      return false;
    }
    const { event } = context;
    return event === undefined || !this.#options.filterEvents.includes(event);
  }
}
