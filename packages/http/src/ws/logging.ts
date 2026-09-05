import { Logger, LogLevel, RequestContext } from '@dunx/core';
import { HandlerKind } from './marker.js';
import {
  observe,
  type SocketContext,
  type SocketFrame,
  type SocketMiddleware,
  type SocketNext,
} from './middleware.js';

export interface SocketLoggingOptions {
  /**
   * The level every message frame is logged at. Default **`'debug'`**.
   *
   * `'debug'`, not `'info'`, because a socket is not a request: a gateway can take
   * a frame per player per tick, and one `info` line each would bury everything
   * else the process writes. The default `ConsoleLogger` threshold is `'info'`, so
   * this is off until an app lowers its level or names a louder one here.
   */
  readonly level?: LogLevel;
  /** What a throwing or rejecting handler is logged at. @default 'error' */
  readonly errorLevel?: LogLevel;
  /**
   * Per-event level, keyed by the `@OnMessage(event)` name. `false` skips the
   * event entirely, and skipping is complete: no entry, no timing, no scope.
   *
   * ```ts
   * socketLogging: { events: { placeBet: 'info', cursorMove: false } }
   * ```
   */
  readonly events?: Readonly<Record<string, LogLevel | false>>;
  /**
   * Open, close, drain, ping and pong. Defaults to `level`; `false` drops them.
   *
   * Separate from `level` because the two answer different questions - how much
   * traffic a socket carries, against how many sockets there are - and an app that
   * silences the first usually still wants the second.
   */
  readonly lifecycle?: LogLevel | false;
  /**
   * Log the frame's payload. Default **`false`**.
   *
   * A payload is caller-supplied and arrives without validation, so it is both the
   * field most likely to carry a credential and the one most likely to be large.
   */
  readonly payload?: boolean;
  /** Payloads past this many characters are logged as a size. @default 512 */
  readonly maxPayloadLength?: number;
  /**
   * Wrap each dispatch in an `AsyncRequestContext` scope. Default **`true`**.
   *
   * The scope is what makes a line a service logs four frames down carry
   * `connectionId` and `event` without being handed the socket.
   */
  readonly correlate?: boolean;
}

const LIFECYCLE_LABEL: Readonly<Record<string, string>> = {
  [HandlerKind.OPEN]: 'connect',
  [HandlerKind.CLOSE]: 'disconnect',
};

const elapsedMs = (started: number): number =>
  Math.round((Bun.nanoseconds() - started) / 1e6);

/**
 * One structured entry per dispatched frame, carrying the frame and its outcome.
 *
 * The socket counterpart of `RequestLoggingMiddleware`, and the same single-entry
 * shape: the middleware wraps the handler, so the frame and what it answered are
 * one line rather than an inbound line to correlate with an outbound one.
 *
 * It also replaces what a gateway would otherwise hand-write. A throwing handler
 * reaches the `Logger` here with the gateway, the path and the event on it -
 * `SocketOptions.onError`'s default is a bare `console.error` off the logging
 * pipeline entirely, and installing this takes that fallback out of the way.
 */
export class SocketLoggingMiddleware implements SocketMiddleware {
  /** A throwing handler reaches the `Logger` here, at `errorLevel`. */
  readonly reportsErrors = true;
  readonly #level: LogLevel;
  readonly #errorLevel: LogLevel;
  readonly #events: Readonly<Record<string, LogLevel | false>>;
  readonly #lifecycle: LogLevel | false;
  readonly #payload: boolean;
  readonly #limit: number;
  readonly #correlate: boolean;

  constructor(
    private readonly logger: Logger,
    private readonly context: RequestContext,
    options: SocketLoggingOptions = {},
  ) {
    this.#level = options.level ?? LogLevel.DEBUG;
    this.#errorLevel = options.errorLevel ?? LogLevel.ERROR;
    this.#events = options.events ?? {};
    this.#lifecycle = options.lifecycle ?? this.#level;
    this.#payload = options.payload ?? false;
    this.#limit = options.maxPayloadLength ?? 512;
    this.#correlate = options.correlate ?? true;
  }

  /** `false` means this frame is not logged at all. */
  #levelFor(ctx: SocketContext): LogLevel | false {
    if (ctx.kind !== HandlerKind.MESSAGE) return this.#lifecycle;
    if (ctx.event === undefined) return this.#level;
    return this.#events[ctx.event] ?? this.#level;
  }

  handle(frame: SocketFrame, ctx: SocketContext, next: SocketNext): unknown {
    const level = this.#levelFor(ctx);
    if (level === false) return next();

    const label = ctx.event ?? LIFECYCLE_LABEL[ctx.kind] ?? ctx.kind;
    const connectionId = frame.socket.data.id;
    const started = Bun.nanoseconds();
    const write = (error: unknown, value: unknown): void => {
      const entry = {
        gateway: ctx.gateway,
        path: ctx.path,
        event: label,
        connectionId,
        elapsedMs: elapsedMs(started),
        ...(this.#payload ? { payload: this.#brief(frame.data) } : {}),
        ...(error === undefined
          ? { replied: value !== undefined }
          : { err: error }),
      };
      const line = `${ctx.path} ${label}`;
      this.#emit(error === undefined ? level : this.#errorLevel, line, entry);
    };

    if (!this.#correlate) return observe(next, write);
    return this.context.runWithContext(
      { connectionId, event: label, flow: 'ws', context: ctx.gateway },
      () => observe(next, write),
    );
  }

  /**
   * A `switch` rather than `this.logger[level](...)`. The indexed call needs a
   * `bind` to keep its receiver, which would be one closure allocated per frame -
   * and a gateway taking a frame per tick is exactly where that shows up.
   */
  #emit(level: LogLevel, line: string, entry: Record<string, unknown>): void {
    switch (level) {
      case LogLevel.VERBOSE:
        this.logger.verbose(line, entry);
        return;
      case LogLevel.DEBUG:
        this.logger.debug(line, entry);
        return;
      case LogLevel.INFO:
        this.logger.info(line, entry);
        return;
      case LogLevel.WARN:
        this.logger.warn(line, entry);
        return;
      case LogLevel.ERROR:
        this.logger.error(line, entry);
        return;
      default:
        this.logger.fatal(line, entry);
    }
  }

  /**
   * A payload as one loggable value: an object as itself, anything longer than the
   * limit as its size. Serialising to measure it is the cost `payload: false`
   * avoids.
   */
  #brief(data: unknown): unknown {
    if (data === undefined || this.#limit === 0) return undefined;
    if (typeof data === 'string') {
      return data.length > this.#limit ? `[${data.length} chars]` : data;
    }
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      return `[${data.byteLength} bytes]`;
    }
    // What `binaryType: 'blob'` delivers. Without this branch it would fall
    // through to `JSON.stringify`, which makes `{}` of a Blob of any size.
    if (data instanceof Blob) return `[${data.size} bytes]`;
    const text = JSON.stringify(data) ?? '';
    return text.length > this.#limit ? `[${text.length} chars]` : data;
  }
}
