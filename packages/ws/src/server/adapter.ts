import { AppError, type App } from '@dunx/core';
import type { Server, WebSocketHandler } from 'bun';
import {
  discoverGateway,
  normalizePath,
  type DiscoveredGateway,
  type Invoke,
} from '../gateway/discover.js';
import { decode, encode } from './envelope.js';
import { WsSettings, type WsOptions } from './options.js';
import { PubSub } from './pubsub.js';
import { buildGateways, someHandler, type GatewayRuntime } from './runtime.js';
import type { ErrorHandler, Socket, SocketData } from './socket.js';

// The gateway a socket belongs to travels with the socket, so dispatch is a
// property read rather than a path lookup. Symbol-keyed, so it stays out of
// anything that enumerates `socket.data`.
const RUNTIME: unique symbol = Symbol.for('dunx.ws.runtime');

interface Routed extends SocketData<unknown> {
  readonly [RUNTIME]: GatewayRuntime;
}

/**
 * Everything `Bun.serve` needs, built once at boot. `@dunx/http` can spread
 * `websocket` into its own serve options and call `upgrade` from its `fetch`
 * fallback; nothing here calls `Bun.serve` itself.
 */
export interface WsAdapter {
  readonly websocket: WebSocketHandler<SocketData>;
  readonly paths: readonly string[];
  /** Whether any gateway serves this request's pathname. */
  handles(req: Request): boolean;
  /**
   * `undefined` means the socket was upgraded and the caller must return
   * `undefined` from `fetch`. A `Response` means it was not: `404` for a path no
   * gateway serves, `426` when the request was not an upgrade, or whatever
   * `@OnUpgrade` returned to refuse it.
   */
  upgrade(
    req: Request,
    server: Server<SocketData>,
  ): Response | undefined | Promise<Response | undefined>;
  attach(server: Server<SocketData>): void;
}

const defaultOnError: ErrorHandler = (error, socket) => {
  console.error(`[dunx/ws] ${socket.data.path} handler failed:`, error);
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
  onError: ErrorHandler,
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

export const buildAdapter = (
  discovered: readonly DiscoveredGateway[],
  options: WsOptions = {},
  pubsub: PubSub = new PubSub(),
): WsAdapter => {
  const byPath = buildGateways(discovered);
  const gateways = [...byPath.values()];
  const onError = options.onError ?? defaultOnError;
  // The rest is exactly the set of keys Bun's WebSocketHandler accepts.
  const {
    gateways: _gateways,
    port: _port,
    onError: _onError,
    ...socketOptions
  } = options;

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
    pubsub.attach(server);
    const data: Routed = { path: gateway.path, context, [RUNTIME]: gateway };
    return server.upgrade(req, { data })
      ? undefined
      : new Response('Expected a WebSocket upgrade', { status: 426 });
  };

  const lookup = (req: Request): GatewayRuntime | undefined =>
    byPath.get(normalizePath(new URL(req.url).pathname));

  return {
    websocket,
    paths: [...byPath.keys()],

    handles(req) {
      return lookup(req) !== undefined;
    },

    upgrade(req, server) {
      const gateway = lookup(req);
      if (!gateway) {
        return new Response('Not Found', { status: 404 });
      }
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
    },

    attach(server) {
      pubsub.attach(server);
    },
  };
};

/**
 * The integration point. Boot the container however you like, then hand the app
 * here: gateways are resolved from it, so they inject like any other class.
 */
export const createWsAdapter = (app: App): WsAdapter => {
  let options: WsOptions;
  try {
    options = app.get(WsSettings);
  } catch (error) {
    throw new AppError(
      'No WebSocket options are bound. Import ' +
        'WsModule.forRoot({ gateways: [...] }) from your root module.',
      { cause: error },
    );
  }

  const discovered: DiscoveredGateway[] = (options.gateways ?? []).map(
    (gateway) => discoverGateway(app.get(gateway) as object),
  );

  return buildAdapter(discovered, options, app.get(PubSub));
};
