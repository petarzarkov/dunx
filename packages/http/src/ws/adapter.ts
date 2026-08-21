import type { BunRequest, Server, WebSocketHandler } from 'bun';
import type { DiscoveredGateway, Invoke } from './discover.js';
import { decode, encode } from './envelope.js';
import { HandlerKind } from './marker.js';
import {
  composeSocket,
  type SocketContext,
  type SocketFrame,
  type SocketMiddleware,
} from './middleware.js';
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
// The chain for a frame no named handler claimed, built per gateway at boot. Only
// present when there is middleware to run.
const UNCLAIMED: unique symbol = Symbol.for('dunx.ws.unclaimed');

interface Routed extends SocketData<unknown> {
  readonly [RUNTIME]: GatewayRuntime;
  readonly [UNCLAIMED]?: UnclaimedDispatch;
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
  /**
   * What `listen()` reports at boot: which gateway serves each path and which named
   * messages it claims. Nest logs one line per subscription; this is the same
   * information in one structured field, which is the shape the queue worker's
   * "Consuming N job(s)" entry already set.
   */
  readonly gateways: readonly GatewaySummary[];
  /**
   * What `HttpFactory.create` logs at boot, the way the container logs its own
   * scope warnings. Empty for a server that reports socket errors, or says it does.
   */
  readonly warnings: readonly string[];
}

export interface GatewaySummary {
  readonly name: string;
  readonly path: string;
  /** `@OnMessage('name')` events. A raw catch-all has no name to report. */
  readonly events: readonly string[];
}

const defaultOnError: SocketErrorHandler = (error, socket) => {
  console.error(`[dunx/http] ${socket.data.path} handler failed:`, error);
};

/** The failure already went through the chain, which is where it was recorded. */
const reportedByMiddleware: SocketErrorHandler = () => undefined;

/**
 * Dropping the fallback is right for middleware that reports, and it is the
 * middleware's word that says so. Without it the wiring reads the same either way,
 * and an observer that ignores a throw takes a wrong report down to no report:
 * that is how it was found, in an app that had added socket logging and then had
 * to add a reporter after noticing failures had gone quiet.
 */
const unreported = (middleware: readonly SocketMiddleware[]): string =>
  'Socket middleware is installed and none of it sets reportsErrors, so a ' +
  'throwing gateway handler is reported nowhere: the console fallback is off ' +
  'whenever middleware wraps the handler. Set reportsErrors on the one that ' +
  'records a failure, or pass websocket.onError. Installed: ' +
  `${middleware.map((entry) => entry.constructor.name).join(', ')}.`;

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

/**
 * Where the socket and the payload sit in a handler's own arguments, which differ
 * by kind: `open`, `close` and `drain` take the socket first, while a message, a
 * ping and a pong take their data first. Resolved once per slot at boot, so no
 * frame is built by branching on the kind.
 */
const framing = (
  kind: HandlerKind,
): ((args: readonly unknown[]) => SocketFrame) => {
  if (kind === HandlerKind.CLOSE) {
    return (args) => ({
      socket: args[0] as Socket,
      data: { code: args[1], reason: args[2] },
    });
  }
  if (kind === HandlerKind.OPEN || kind === HandlerKind.DRAIN) {
    return (args) => ({ socket: args[0] as Socket, data: undefined });
  }
  return (args) => ({ socket: args[1] as Socket, data: args[0] });
};

const NOTHING: Invoke = () => undefined;

/**
 * One slot's handler with the middleware chain folded in front of it.
 *
 * `invoke` may be absent: `open` and `close` are wrapped even for a gateway that
 * declares neither, so a connection and its end are never invisible to an
 * observer. The inner call is then a no-op and the chain still runs.
 */
const through = (
  gateway: GatewayRuntime,
  middleware: readonly SocketMiddleware[],
  kind: HandlerKind,
  event: string | undefined,
  invoke: Invoke | undefined,
): Invoke => {
  const ctx: SocketContext = {
    gateway: gateway.name,
    path: gateway.path,
    kind,
    event,
  };
  const dispatch = composeSocket(middleware, ctx);
  const frameOf = framing(kind);
  const run = invoke ?? NOTHING;
  return (...args) => dispatch(frameOf(args), () => run(...args));
};

const withMiddleware = (
  gateway: GatewayRuntime,
  middleware: readonly SocketMiddleware[],
): GatewayRuntime => {
  const wrap = (
    kind: HandlerKind,
    event: string | undefined,
    invoke: Invoke | undefined,
  ) => through(gateway, middleware, kind, event, invoke);
  const optional = (kind: HandlerKind, invoke: Invoke | undefined) =>
    invoke === undefined ? undefined : wrap(kind, undefined, invoke);

  return {
    ...gateway,
    open: wrap(HandlerKind.OPEN, undefined, gateway.open),
    close: wrap(HandlerKind.CLOSE, undefined, gateway.close),
    // Left alone when the gateway declares none. Bun answers a ping with a pong
    // itself, and installing a handler to observe one would take that away.
    drain: optional(HandlerKind.DRAIN, gateway.drain),
    ping: optional(HandlerKind.PING, gateway.ping),
    pong: optional(HandlerKind.PONG, gateway.pong),
    raw: optional(HandlerKind.MESSAGE, gateway.raw),
    events: new Map(
      [...gateway.events].map(([event, invoke]) => [
        event,
        wrap(HandlerKind.MESSAGE, event, invoke),
      ]),
    ),
  };
};

/**
 * The chain for a frame nothing claimed - an event no `@OnMessage` declares, on a
 * gateway with no raw catch-all. The socket analogue of the HTTP not-found
 * fallback: without it an unknown event is silently dropped, which is the one thing
 * a client debugging its own wire format cannot see.
 *
 * The context is built per frame because the event name is the frame's, and that
 * allocation is on this path only.
 */
type UnclaimedDispatch = (
  frame: SocketFrame,
  event: string | undefined,
) => unknown;

const unclaimedDispatch =
  (
    gateway: GatewayRuntime,
    middleware: readonly SocketMiddleware[],
  ): UnclaimedDispatch =>
  (frame, event) =>
    composeSocket(middleware, {
      gateway: gateway.name,
      path: gateway.path,
      kind: HandlerKind.MESSAGE,
      event,
    })(frame, () => undefined);

export const buildWebSocket = (
  discovered: readonly DiscoveredGateway[],
  options: SocketOptions = {},
  middleware: readonly SocketMiddleware[] = [],
): WebSocketRuntime => {
  const byPath = buildGateways(discovered);
  const wrapped =
    middleware.length === 0
      ? byPath
      : new Map(
          [...byPath].map(([path, gateway]) => [
            path,
            withMiddleware(gateway, middleware),
          ]),
        );
  const gateways = [...wrapped.values()];
  // A middleware wraps the handler, so it has already seen a failure by the time
  // one escapes - and the console fallback would be a second report of it.
  const onError =
    options.onError ??
    (middleware.length === 0 ? defaultOnError : reportedByMiddleware);
  const reports =
    options.onError !== undefined ||
    middleware.some((entry) => entry.reportsErrors === true);
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
      let event: string | undefined;
      if (gateway.events.size > 0) {
        const envelope = decode(message);
        const handler = envelope && gateway.events.get(envelope.event);
        if (envelope && handler) {
          run(handler, [envelope.data, ws], ws, (value) => {
            if (value !== undefined) ws.send(encode(envelope.event, value));
          });
          return;
        }
        event = envelope?.event;
      }
      if (gateway.raw) {
        run(gateway.raw, [message, ws], ws, (value) => replyRaw(ws, value));
        return;
      }
      const unclaimed = (ws.data as Routed)[UNCLAIMED];
      if (!unclaimed) return;
      try {
        settle(
          unclaimed({ socket: ws, data: message }, event),
          ws,
          onError,
          undefined,
        );
      } catch (error) {
        onError(error, ws);
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

  const unclaimed = new Map<GatewayRuntime, UnclaimedDispatch>(
    middleware.length === 0
      ? []
      : gateways.map((gateway) => [
          gateway,
          unclaimedDispatch(gateway, middleware),
        ]),
  );

  const accept = (
    req: Request,
    server: Server<SocketData>,
    gateway: GatewayRuntime,
    context: unknown,
  ): Response | undefined => {
    const fallback = unclaimed.get(gateway);
    const data: Routed = {
      path: gateway.path,
      context,
      id: crypto.randomUUID(),
      [RUNTIME]: gateway,
      ...(fallback === undefined ? {} : { [UNCLAIMED]: fallback }),
    };
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
    warnings: middleware.length > 0 && !reports ? [unreported(middleware)] : [],
    gateways: gateways.map((gateway) => ({
      name: gateway.name,
      path: gateway.path,
      events: [...gateway.events.keys()],
    })),
  };
};
