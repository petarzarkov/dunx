import type { ServerWebSocket } from 'bun';

/**
 * What every socket carries. `path` is the gateway it upgraded on; `context` is
 * whatever that gateway's `@OnUpgrade` returned, so per-connection state is
 * declared where the connection is accepted.
 */
export interface SocketData<T = unknown> {
  readonly path: string;
  readonly context: T;
}

/**
 * Bun's native socket, unwrapped. `send`, `subscribe`, `unsubscribe`,
 * `isSubscribed`, `publish`, `cork` and `close` are its own methods — nothing here
 * reimplements them.
 */
export type Socket<T = unknown> = ServerWebSocket<SocketData<T>>;

export type ErrorHandler = (error: unknown, socket: Socket) => void;
