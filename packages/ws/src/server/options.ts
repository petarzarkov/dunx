import { token, type Ctor } from '@dunx/core';
import type { WebSocketHandler } from 'bun';
import type { ErrorHandler, SocketData } from './socket.js';

/**
 * Picked from Bun's own handler type rather than restated, so the names and the
 * accepted values cannot drift from the runtime. `idleTimeout` is in seconds and
 * Bun rejects anything above 960 at `Bun.serve` time.
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
>;

export interface WsOptions extends SocketOptions {
  /** Registered as providers, so a gateway gets constructor injection. */
  readonly gateways?: readonly Ctor<unknown>[];
  /** Only read by `WsFactory`'s own `Bun.serve`. @default 3000 */
  readonly port?: number;
  /** Where a throwing or rejecting handler goes. @default console.error */
  readonly onError?: ErrorHandler;
}

/** Bound by `WsModule.forRoot()`, so the resolved options are injectable too. */
export const WsSettings = token<WsOptions>('WsSettings');
