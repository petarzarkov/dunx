import type { OnShutdown } from '../di/lifecycle.js';
import { Logger } from './logger.js';
import type { RequestContext } from './context.js';
import { runFilters, type LogFilter } from './filter.js';
import {
  isErrorLevel,
  type LogEntry,
  type LogLevel,
  LOG_LEVELS,
  type SerializedError,
} from './types.js';

const serialize = (error: Error): SerializedError => ({
  name: error.name,
  message: error.message,
  ...(error.stack === undefined ? {} : { stack: error.stack }),
});

/**
 * `new Date().toISOString()` measured ~170 ns, and at any rate worth logging the
 * millisecond has not moved since the last entry. One `Date.now()` replaces it.
 */
let stampAt = 0;
let stamp = '';
const timestamp = (): string => {
  const now = Date.now();
  if (now !== stampAt) {
    stampAt = now;
    stamp = new Date(now).toISOString();
  }
  return stamp;
};

/**
 * A `write(2)` per entry cost 1.84 us, the largest single component of request
 * logging; concatenating and writing once per event-loop turn costs 0.27 us.
 *
 * The trade is that a buffered line is lost if the process dies without unwinding.
 * Three things bound it: `warn` and above are never buffered and flush what is
 * queued behind them, the window is one event-loop turn rather than a timer, and
 * `flush()` is public and called from `onShutdown()` and `process.on('exit')`.
 *
 * `new ConsoleLogger(context, level, false)` opts out.
 */
class StdoutBatch {
  #pending = '';
  #scheduled = false;
  #hooked = false;

  /** An arrow, since the timer and the `exit` hook call it detached. */
  readonly flush = (): void => {
    this.#scheduled = false;
    if (this.#pending === '') return;
    const batch = this.#pending;
    this.#pending = '';
    console.log(batch);
  };

  emit(line: string, toError: boolean): void {
    if (toError) {
      this.flush();
      console.error(line);
      return;
    }
    this.#pending = this.#pending === '' ? line : `${this.#pending}\n${line}`;
    if (this.#scheduled) return;
    this.#scheduled = true;
    setTimeout(this.flush, 0).unref();
    if (this.#hooked) return;
    this.#hooked = true;
    process.on('exit', this.flush);
  }
}

/**
 * Shared by every instance because they all write to the same descriptor:
 * separate buffers would interleave two loggers' lines.
 */
const stdout = new StdoutBatch();

/**
 * The default binding for {@link Logger}, so `Logger` is injectable in an app
 * that has imported no logging module at all - which is what lets `@dunx/http`
 * turn request logging on by default without booting into "No provider".
 *
 * Deliberately small: one JSON line per entry on stdout, stderr from `warn` up
 * so a shipper can separate them. It does **not** sanitize, mask, rotate or
 * colour. `@dunx/infra/logger` replaces it with `@arkv/logger`, which does all
 * of that, and the swap is one import - see `packages/infra/README.md`.
 *
 * `filters` is the one entry hook it does carry, because it is the only one that
 * has nowhere else to live here: a redaction, a dropped field or a rewritten
 * message is application policy, not a property of the sink.
 */
export class ConsoleLogger extends Logger implements OnShutdown {
  readonly #minimum: number;
  readonly #buffered: boolean;

  constructor(
    private readonly context?: RequestContext,
    readonly logLevel: LogLevel = 'info',
    buffered = true,
    private readonly filters: readonly LogFilter[] = [],
  ) {
    super();
    this.#minimum = LOG_LEVELS.indexOf(logLevel);
    this.#buffered = buffered;
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

  /** Writes everything buffered at `info` and below. Idempotent. */
  flush(): void {
    stdout.flush();
  }

  #filterFailureReported = false;

  /**
   * `console.error` rather than an entry: this is a report about the logger, not a
   * log line, and routing it back through the filters that just failed would be a
   * loop.
   */
  #reportFilterFailure(error: unknown): void {
    if (this.#filterFailureReported) return;
    this.#filterFailureReported = true;
    console.error(
      `[dunx] a log filter threw, so its entry was dropped: ${String(error)}`,
    );
  }

  onShutdown(): void {
    stdout.flush();
  }

  #write(level: LogLevel, message: unknown, rest: readonly unknown[]): void {
    if (LOG_LEVELS.indexOf(level) < this.#minimum) return;

    // After the level check, so a filter only ever sees an entry that would have
    // been written; before serialization, so a dropped entry costs no
    // `JSON.stringify` and a rewritten one is what the line carries.
    let entry: LogEntry | undefined;
    try {
      entry = runFilters(
        this.#entry(level, message, rest),
        level,
        this.filters,
      );
    } catch (error) {
      // A filter that throws drops the entry rather than writing it unfiltered,
      // because the filters this hook exists for are redactions and the unfiltered
      // entry is the leak. Reported once: a broken filter on a request path would
      // otherwise write a line per request. `@dunx/infra/logger` contains the same
      // throw in `@arkv/logger`'s transport machinery, so both agree on the
      // outcome - entry dropped, caller not failed.
      this.#reportFilterFailure(error);
      return;
    }
    if (entry === undefined) return;

    // JSON.stringify, not a formatter: a cycle here would be the logger's fault,
    // and the replacement that handles cycles is one import away.
    const line = JSON.stringify(entry);
    if (!this.#buffered) {
      stdout.flush();
      if (isErrorLevel(level)) console.error(line);
      else console.log(line);
      return;
    }
    stdout.emit(line, isErrorLevel(level));
  }

  /**
   * `logger.info('GET /json 200', fields)` is the shape every framework call has,
   * and the general path below costs it two array allocations, a third object and
   * an `Object.assign` to reach the same entry. Taken directly instead.
   */
  #entry(
    level: LogLevel,
    message: unknown,
    rest: readonly unknown[],
  ): LogEntry {
    const only = rest[0];
    if (
      typeof message === 'string' &&
      rest.length <= 1 &&
      (only === undefined ||
        (typeof only === 'object' && only !== null && !(only instanceof Error)))
    ) {
      return {
        level,
        timestamp: timestamp(),
        pid: process.pid,
        message,
        ...this.context?.getContext(),
        ...(only as Record<string, unknown> | undefined),
      };
    }

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

    return {
      level,
      timestamp: timestamp(),
      pid: process.pid,
      message: text,
      ...this.context?.getContext(),
      ...extra,
      ...(error === undefined ? {} : { error: serialize(error) }),
    };
  }
}
