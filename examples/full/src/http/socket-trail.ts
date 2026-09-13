import { Logger } from '@dunx/core';
import {
  SocketObserver,
  type SocketContext,
  type SocketFrame,
  type SocketOutcome,
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
 * `RequestTrailMiddleware`'s socket half, extending {@link SocketObserver}
 * because it only wants the outcome. `reportsErrors` is claimed because this one
 * reports: false with no `websocket.onError` beside it turns dunx's own fallback
 * off for the whole server.
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
    outcome: SocketOutcome,
    frame: SocketFrame,
    ctx: SocketContext,
  ): void {
    // A lifecycle hook has no event name; `kind` is what it has instead.
    const what = `${ctx.gateway}${ctx.path} ${ctx.event ?? ctx.kind}`;
    if (!outcome.ok) {
      this.logger.warn('socket handler failed', {
        handler: what,
        connectionId: frame.socket.data.id,
        err: outcome.error,
      });
      this.trail.record(`${what} -> threw`);
      return;
    }
    this.trail.record(
      `${what} -> ${outcome.value === undefined ? 'no reply' : 'reply'}`,
    );
  }
}
