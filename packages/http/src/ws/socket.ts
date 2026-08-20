import type { ServerWebSocket, WebSocketHandler } from 'bun';

/**
 * What every socket carries. `path` is the gateway it upgraded on; `context` is
 * whatever that gateway's `@OnUpgrade` returned, so per-connection state is
 * declared where the connection is accepted.
 */
export interface SocketData<T = unknown> {
  readonly path: string;
  readonly context: T;
  /**
   * This connection, for as long as it lasts. Minted at the upgrade, because Bun's
   * socket carries no identity of its own and a log line for a frame is only
   * joinable to the connect and the disconnect around it if something does.
   */
  readonly id: string;
}

/**
 * Bun's native socket, unwrapped. `send`, `subscribe`, `unsubscribe`,
 * `isSubscribed`, `publish`, `cork` and `close` are its own methods - nothing here
 * reimplements them.
 */
export type Socket<T = unknown> = ServerWebSocket<SocketData<T>>;

/** Named for the socket, so it reads apart from the HTTP `ErrorMapper`. */
export type SocketErrorHandler = (error: unknown, socket: Socket) => void;

/**
 * The websocket half of `HttpOptions`. Everything but `onError` is `Pick`ed from
 * Bun's own handler type rather than restated, so the names and the accepted values
 * cannot drift from the runtime. `idleTimeout` is in seconds and Bun rejects
 * anything above 960 at `Bun.serve` time.
 */
export type SocketOptions = Readonly<
  Pick<
    WebSocketHandler<SocketData>,
    | 'backpressureLimit'
    | 'closeOnBackpressureLimit'
    | 'idleTimeout'
    | 'maxPayloadLength'
    | 'perMessageDeflate'
    | 'publishToSelf'
    | 'sendPings'
  >
> & {
  /**
   * Where a throwing or rejecting handler goes. @default console.error
   *
   * The default is **not** installed when `socketMiddleware` is non-empty: a
   * middleware wraps the handler, so it already saw the failure and a second
   * report on the console would be a duplicate.
   */
  readonly onError?: SocketErrorHandler;
};
