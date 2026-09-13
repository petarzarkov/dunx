import { Logger } from '@dunx/core';
import {
  SocketObserver,
  type SocketContext,
  type SocketFrame,
} from '@dunx/http';

/** The last few frames, so a route can show what the observer saw. */
const KEEP = 200;

export class SocketTrail {
  readonly entries: string[] = [];

  record(entry: string): void {
    this.entries.push(entry);
    if (this.entries.length > KEEP) {
      this.entries.splice(0, this.entries.length - KEEP);
    }
  }
}

/**
 * `RequestTrailMiddleware`'s socket half. It extends {@link SocketObserver}
 * rather than implementing `SocketMiddleware` because it only wants the outcome,
 * and the base class is where the throw and the rejection are handled.
 *
 * `reportsErrors` is claimed because this one reports. Leaving it false with no
 * `websocket.onError` beside it turns dunx's own fallback off for the server.
 */
export class SocketTrailObserver extends SocketObserver {
  override readonly reportsErrors = true;

  constructor(
    private readonly trail: SocketTrail,
    private readonly logger: Logger,
  ) {
    super();
  }

  protected override settled(
    error: unknown,
    value: unknown,
    frame: SocketFrame,
    ctx: SocketContext,
  ): void {
    // A lifecycle hook has no event name; `kind` is what it has instead.
    const what = `${ctx.gateway}${ctx.path} ${ctx.event ?? ctx.kind}`;
    if (error !== undefined) {
      this.logger.warn('socket handler failed', {
        handler: what,
        connectionId: frame.socket.data.id,
        err: error,
      });
      this.trail.record(`${what} -> threw`);
      return;
    }
    this.trail.record(
      `${what} -> ${value === undefined ? 'no reply' : 'reply'}`,
    );
  }
}
