import {
  observe,
  type SocketContext,
  type SocketFrame,
  type SocketMiddleware,
  type SocketNext,
} from './middleware.js';

/**
 * A {@link SocketMiddleware} that watches a frame and changes nothing about it.
 *
 * A gateway handler may return a value or a promise, so a middleware wanting the
 * outcome has to handle a throw and a rejection and rethrow both; getting it
 * wrong silently swallows a failure. Extend this and implement {@link settled}
 * instead - the result reaches the caller untouched either way.
 *
 * ```ts
 * export class SocketErrorReporter extends SocketObserver {
 *   override readonly reportsErrors = true;
 *
 *   constructor(private readonly logger: Logger) {
 *     super();
 *   }
 *
 *   protected override settled(error: unknown, _value: unknown, frame: SocketFrame, ctx: SocketContext): void {
 *     if (error !== undefined) this.logger.error('socket handler failed', { event: ctx.event, err: error });
 *   }
 * }
 * ```
 *
 * One that answers a frame, refuses one or replaces the value is not this:
 * implement `SocketMiddleware` and call `next()` yourself.
 */
export abstract class SocketObserver implements SocketMiddleware {
  /**
   * Override to `true` when {@link settled} reports a failure somewhere. See
   * {@link SocketMiddleware.reportsErrors} - a middleware that ignores a throw
   * and claims otherwise turns error reporting off for the whole server.
   */
  readonly reportsErrors: boolean = false;

  handle(frame: SocketFrame, ctx: SocketContext, next: SocketNext): unknown {
    return observe(next, (error, value) => {
      this.settled(error, value, frame, ctx);
    });
  }

  /**
   * How the handler went, once per frame. `error` is `undefined` on success and
   * `value` is `undefined` on a failure.
   */
  protected abstract settled(
    error: unknown,
    value: unknown,
    frame: SocketFrame,
    ctx: SocketContext,
  ): void;
}
