import {
  observe,
  type SocketContext,
  type SocketFrame,
  type SocketMiddleware,
  type SocketNext,
} from './middleware.js';

/**
 * How a handler went. A union rather than an `error` that is `undefined` on
 * success: a handler may `throw undefined`, and `error !== undefined` reads that
 * as a success.
 */
export type SocketOutcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: unknown };

/**
 * A {@link SocketMiddleware} that watches a frame and changes nothing about it.
 *
 * A gateway handler may return a value or a promise, so a middleware wanting the
 * outcome has to handle a throw and a rejection and rethrow both; getting it
 * wrong silently swallows a failure. Extend this and implement {@link settled}
 * instead - the result reaches the caller untouched, `settled` throwing
 * included.
 *
 * ```ts
 * export class Reporter extends SocketObserver {
 *   override readonly reportsErrors = true;
 *
 *   protected override settled(outcome: SocketOutcome, _f: SocketFrame, ctx: SocketContext): void {
 *     if (outcome.ok) return;
 *     this.logger.error('socket handler failed', { event: ctx.event, err: outcome.error });
 *   }
 * }
 * ```
 *
 * One that answers or refuses a frame is not this: implement `SocketMiddleware`.
 */
export abstract class SocketObserver implements SocketMiddleware {
  /**
   * Override to `true` when {@link settled} reports a failure somewhere. See
   * {@link SocketMiddleware.reportsErrors} - a middleware that ignores a throw
   * and claims otherwise turns error reporting off for the whole server.
   */
  readonly reportsErrors: boolean = false;

  handle(frame: SocketFrame, ctx: SocketContext, next: SocketNext): unknown {
    return observe(next, (error, value, ok) => {
      try {
        this.settled(ok ? { ok, value } : { ok, error }, frame, ctx);
      } catch (failure) {
        // An observer that threw would turn a handler's success into a failure,
        // or replace the error the caller is about to be given with its own.
        console.error(
          `[dunx/http] ${this.constructor.name}.settled threw, which cannot ` +
            'change the outcome it was watching:',
          failure,
        );
      }
    });
  }

  /** How the handler went, once per frame, on whichever channel it used. */
  protected abstract settled(
    outcome: SocketOutcome,
    frame: SocketFrame,
    ctx: SocketContext,
  ): void;
}
