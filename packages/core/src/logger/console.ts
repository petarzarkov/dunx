import type { OnShutdown } from '../di/lifecycle.js';
import { Logger } from './logger.js';
import type { RequestContext } from './context.js';
import { isErrorLevel, type LogLevel, LOG_LEVELS } from './types.js';

const serialize = (error: Error): Record<string, unknown> => ({
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
 * Pending `info`-and-below output, shared by every instance because they all write
 * to the same descriptor — separate buffers would interleave two loggers' lines.
 */
let pending = '';
let scheduled = false;
let hooked = false;

const flushPending = (): void => {
  scheduled = false;
  if (pending === '') return;
  const batch = pending;
  pending = '';
  console.log(batch);
};

/**
 * One `console.log` per request is one `write(2)` per request, and measured on
 * `bun run logging` it cost **1.84 µs** — the largest single component of request
 * logging, more than the `JSON.stringify` that produced the line. Concatenating
 * into one string and writing it once per event-loop turn costs **0.27 µs**.
 *
 * **The trade:** a line that is still in this buffer is lost if the process dies
 * without unwinding — a `SIGKILL`, an OOM kill, a segfault — which is exactly when
 * the log matters most. Three things bound it:
 *
 * - **`warn`, `error` and `fatal` are never buffered.** They go out immediately and
 *   flush everything queued ahead of them, so the entries you go looking for after
 *   a crash are the ones that were never held back.
 * - The window is **one event-loop turn**, not a timer interval.
 * - `flush()` is public, `onShutdown()` calls it, and so does `process.on('exit')`.
 *
 * `new ConsoleLogger(context, level, false)` opts out and writes every entry as it
 * happens.
 */
const emit = (line: string, toError: boolean): void => {
  if (toError) {
    flushPending();
    console.error(line);
    return;
  }
  pending = pending === '' ? line : `${pending}\n${line}`;
  if (scheduled) return;
  scheduled = true;
  setTimeout(flushPending, 0).unref();
  if (hooked) return;
  hooked = true;
  process.on('exit', flushPending);
};

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
export class ConsoleLogger extends Logger implements OnShutdown {
  readonly #minimum: number;
  readonly #buffered: boolean;

  constructor(
    private readonly context?: RequestContext,
    readonly logLevel: LogLevel = 'info',
    buffered = true,
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
    flushPending();
  }

  onShutdown(): void {
    flushPending();
  }

  #write(level: LogLevel, message: unknown, rest: readonly unknown[]): void {
    if (LOG_LEVELS.indexOf(level) < this.#minimum) return;

    // JSON.stringify, not a formatter: a cycle here would be the logger's fault,
    // and the replacement that handles cycles is one import away.
    const line = JSON.stringify(this.#entry(level, message, rest));
    if (!this.#buffered) {
      flushPending();
      if (isErrorLevel(level)) console.error(line);
      else console.log(line);
      return;
    }
    emit(line, isErrorLevel(level));
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
  ): Record<string, unknown> {
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
