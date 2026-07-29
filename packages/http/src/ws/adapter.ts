import type { BunRequest, Server, WebSocketHandler } from 'bun';
import type { DiscoveredGateway, Invoke } from './discover.js';
import { decode, encode } from './envelope.js';
import { buildGateways, someHandler, type GatewayRuntime } from './runtime.js';
import type {
  Socket,
  SocketData,
  SocketErrorHandler,
  SocketOptions,
} from './socket.js';

// The gateway a socket belongs to travels with the socket, so dispatch is a
// property read rather than a path lookup. Symbol-keyed, so it stays out of
// anything that enumerates `socket.data`.
const RUNTIME: unique symbol = Symbol.for('dunx.ws.runtime');

interface Routed extends SocketData<unknown> {
  readonly [RUNTIME]: GatewayRuntime;
}

/**
 * A gateway's entry in the server's route table. Returning `undefined` is how Bun
 * is told the socket was upgraded; a `Response` is `426` for a request that was not
 * an upgrade, or whatever `@OnUpgrade` refused with.
 */
export type UpgradeHandler = (
  req: BunRequest,
  server: Server<SocketData>,
) => Response | undefined | Promise<Response | undefined>;

/**
 * Everything the one `Bun.serve` call needs from the websocket side, built once at
 * boot: the handler object, and one native route per gateway path. Nothing here
 * calls `Bun.serve` itself.
 */
export interface WebSocketRuntime {
  readonly websocket: WebSocketHandler<SocketData>;
  /** Merged into the HTTP route table by `listen()`, keyed by gateway path. */
  readonly routes: ReadonlyMap<string, UpgradeHandler>;
  readonly paths: readonly string[];
}

const defaultOnError: SocketErrorHandler = (error, socket) => {
  console.error(`[dunx/http] ${socket.data.path} handler failed:`, error);
};

const runtimeOf = (socket: Socket): GatewayRuntime =>
  (socket.data as Routed)[RUNTIME];

const isBinary = (value: unknown): value is Bun.BufferSource =>
  value instanceof ArrayBuffer || ArrayBuffer.isView(value);

const replyRaw = (socket: Socket, value: unknown): void => {
  if (value === undefined) return;
  socket.send(
    typeof value === 'string' || isBinary(value)
      ? value
      : JSON.stringify(value),
  );
};

/**
 * A handler may be sync or async. `then` is what turns a returned value into a
 * frame, and it runs inside the same error path either way.
 */
const settle = (
  result: unknown,
  socket: Socket,
  onError: SocketErrorHandler,
  then: ((value: unknown) => void) | undefined,
): void => {
  if (result instanceof Promise) {
    void result.then(
      (value: unknown) => {
        if (!then) return;
        try {
          then(value);
        } catch (error) {
          onError(error, socket);
        }
      },
      (error: unknown) => onError(error, socket),
    );
    return;
  }
  if (then) then(result);
};

export const buildWebSocket = (
  discovered: readonly DiscoveredGateway[],
  options: SocketOptions = {},
): WebSocketRuntime => {
  const byPath = buildGateways(discovered);
  const gateways = [...byPath.values()];
  const onError = options.onError ?? defaultOnError;
  // The rest is exactly the set of keys Bun's WebSocketHandler accepts.
  const { onError: _onError, ...socketOptions } = options;

  const run = (
    invoke: Invoke,
    args: readonly unknown[],
    ws: Socket,
    then: ((value: unknown) => void) | undefined,
  ): void => {
    try {
      settle(invoke(...args), ws, onError, then);
    } catch (error) {
      onError(error, ws);
    }
  };

  const websocket: WebSocketHandler<SocketData> = {
    ...socketOptions,

    message(ws, message) {
      const gateway = runtimeOf(ws);
      if (gateway.events.size > 0) {
        const envelope = decode(message);
        const handler = envelope && gateway.events.get(envelope.event);
        if (envelope && handler) {
          run(handler, [envelope.data, ws], ws, (value) => {
            if (value !== undefined) ws.send(encode(envelope.event, value));
          });
          return;
        }
      }
      if (gateway.raw) {
        run(gateway.raw, [message, ws], ws, (value) => replyRaw(ws, value));
      }
    },

    ...(someHandler(gateways, (g) => g.open) && {
      open(ws: Socket) {
        const { open } = runtimeOf(ws);
        if (open) run(open, [ws], ws, undefined);
      },
    }),

    ...(someHandler(gateways, (g) => g.close) && {
      close(ws: Socket, code: number, reason: string) {
        const { close } = runtimeOf(ws);
        if (close) run(close, [ws, code, reason], ws, undefined);
      },
    }),

    ...(someHandler(gateways, (g) => g.drain) && {
      drain(ws: Socket) {
        const { drain } = runtimeOf(ws);
        if (drain) run(drain, [ws], ws, undefined);
      },
    }),

    // Only installed when a gateway asks for them: Bun answers a ping with a pong
    // on its own, and overriding the handler with a no-op would take that away.
    ...(someHandler(gateways, (g) => g.ping) && {
      ping(ws: Socket, data: Buffer) {
        const { ping } = runtimeOf(ws);
        if (ping) run(ping, [data, ws], ws, undefined);
      },
    }),

    ...(someHandler(gateways, (g) => g.pong) && {
      pong(ws: Socket, data: Buffer) {
        const { pong } = runtimeOf(ws);
        if (pong) run(pong, [data, ws], ws, undefined);
      },
    }),
  };

  const accept = (
    req: Request,
    server: Server<SocketData>,
    gateway: GatewayRuntime,
    context: unknown,
  ): Response | undefined => {
    const data: Routed = { path: gateway.path, context, [RUNTIME]: gateway };
    return server.upgrade(req, { data })
      ? undefined
      : new Response('Expected a WebSocket upgrade', { status: 426 });
  };

  // One closure per gateway, built here rather than per request. `@OnUpgrade` is
  // handed the BunRequest, so a path pattern's `req.params` is readable.
  const upgradeHandler =
    (gateway: GatewayRuntime): UpgradeHandler =>
    (req, server) => {
      if (!gateway.upgrade) return accept(req, server, gateway, undefined);

      const result = gateway.upgrade(req);
      if (result instanceof Promise) {
        return result.then((value: unknown) =>
          value instanceof Response
            ? value
            : accept(req, server, gateway, value),
        );
      }
      return result instanceof Response
        ? result
        : accept(req, server, gateway, result);
    };

  return {
    websocket,
    routes: new Map(
      gateways.map((gateway) => [gateway.path, upgradeHandler(gateway)]),
    ),
    paths: [...byPath.keys()],
  };
};
