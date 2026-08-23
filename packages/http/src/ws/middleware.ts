import type { HandlerKind } from './marker.js';
import type { Socket } from './socket.js';

/**
 * Which handler a frame is on its way to, resolved at boot.
 *
 * The websocket half of {@link RouteContext}: it names the gateway rather than the
 * controller, and the envelope event rather than the method and path. One object
 * per slot, built once, so a middleware costs no allocation per frame beyond the
 * frame itself.
 */
export interface SocketContext {
  /** The gateway class's name. */
  readonly gateway: string;
  /** The path it upgraded on, exactly as mounted. */
  readonly path: string;
  readonly kind: HandlerKind;
  /**
   * The `@OnMessage(event)` name. `undefined` for a lifecycle hook and for the raw
   * `@OnMessage()` catch-all, which claims every frame no named handler took.
   */
  readonly event: string | undefined;
}

/**
 * The frame itself: the socket it arrived on, and the argument the handler is
 * about to be given.
 *
 * `data` is the envelope's `data` for a named message, the whole frame for the raw
 * catch-all, `{ code, reason }` for a close, the buffer for a ping or a pong, and
 * `undefined` for an open or a drain.
 */
export interface SocketFrame {
  readonly socket: Socket;
  readonly data: unknown;
}

/**
 * Runs the rest of the chain and finally the gateway handler, returning whatever
 * it returned - which for a named message is the value dunx sends back.
 *
 * It is **not** `Promise<unknown>`, unlike the HTTP `Next`. A gateway handler may
 * be synchronous and the dispatcher does not allocate a promise to hide that, so a
 * middleware that needs the outcome handles both channels. {@link observe} is that
 * dance, written once.
 */
export type SocketNext = () => unknown;

/**
 * The socket side's single extension point, shaped like {@link Middleware}: one
 * method wrapping `next()`. It sees every dispatched handler, and open and close
 * arrive even for a gateway declaring neither.
 *
 * A throwing handler passes through here. Rethrow to leave the outcome to
 * `SocketOptions.onError`, or return a value to answer the frame.
 *
 * It cannot see a `socket.send` a handler makes itself, a `PubSub` broadcast, or
 * the upgrade, which is an HTTP request.
 */
export interface SocketMiddleware {
  /**
   * That a failure passing through here is reported somewhere. Default `false`.
   *
   * `SocketOptions.onError`'s `console.error` fallback is not installed while any
   * socket middleware exists, since a middleware would report the same failure
   * twice. Only the middleware knows whether it does, and one that ignores a throw
   * would silently turn error reporting off for the whole server.
   *
   * Unset with no `websocket.onError` beside it is what `create` warns about.
   */
  readonly reportsErrors?: boolean;
  handle(frame: SocketFrame, ctx: SocketContext, next: SocketNext): unknown;
}

/** One slot's folded chain. The handler's own arguments ride in `run`. */
export type SocketDispatch = (frame: SocketFrame, run: SocketNext) => unknown;

/**
 * Folded into one closure per slot at boot, the same shape `compose` gives an HTTP
 * route - so dispatch stays a property read and a call, with no array iteration
 * per frame.
 */
export const composeSocket = (
  middleware: readonly SocketMiddleware[],
  ctx: SocketContext,
): SocketDispatch =>
  middleware.reduceRight<SocketDispatch>(
    (next, current) => (frame, run) =>
      current.handle(frame, ctx, () => next(frame, run)),
    (_frame, run) => run(),
  );

/**
 * Calls `next()` and reports how it went, on whichever channel it went out on,
 * leaving the result untouched.
 *
 * `error` is `undefined` on success. A synchronous throw and a rejection both
 * reach `done` and are then rethrown, so a middleware that only observes cannot
 * accidentally swallow a failure.
 */
export const observe = (
  next: SocketNext,
  done: (error: unknown, value: unknown) => void,
): unknown => {
  let result: unknown;
  try {
    result = next();
  } catch (error) {
    done(error, undefined);
    throw error;
  }

  if (result instanceof Promise) {
    return result.then(
      (value: unknown) => {
        done(undefined, value);
        return value;
      },
      (error: unknown) => {
        done(error, undefined);
        throw error;
      },
    );
  }
  done(undefined, result);
  return result;
};
