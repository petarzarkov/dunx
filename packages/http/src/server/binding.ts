import type { Server } from 'bun';
import type { SocketData } from '../ws/socket.js';
import type { WebSocketRuntime } from '../ws/adapter.js';
import type { RouteHandler } from './middleware.js';
import { withUpgradeRoutes, type BunRoutes } from './routes.js';

/** What `listen()` computes and hands the binding, once the table is final. */
export interface BindingPlan {
  readonly port: number;
  readonly routes: BunRoutes;
  readonly fetch: RouteHandler;
  readonly websocket: WebSocketRuntime | undefined;
}

/** The protocol settings, fixed at construction. `undefined` leaves Bun's own
 * default in place rather than restating it. */
export interface BindingProtocols {
  readonly http2?: boolean | undefined;
  readonly http1?: boolean | undefined;
  /**
   * A port of its own for the gateways. When set, the upgrade routes are not
   * merged into the main table and a second `Bun.serve` takes them.
   */
  readonly gatewayPort?: number | undefined;
}

/**
 * The two per-server counters a metrics reader wants, summed across however
 * many servers are bound. `Server` satisfies it on its own, which is what an
 * unsplit app hands over.
 */
export interface ServerGauges {
  readonly pendingRequests: number;
  readonly pendingWebSockets: number;
}

export interface Bound {
  readonly main: Server<SocketData>;
  /** The server that owns the sockets, which is what `PubSub` publishes on. */
  readonly sockets: Server<SocketData>;
  readonly gauges: ServerGauges;
}

/**
 * The one or two `Bun.serve` instances an app binds.
 *
 * One is the normal shape: a gateway's upgrade is a native `GET` route in the
 * same table, so Bun's router matches it and nothing else is needed.
 *
 * Two exist for `gatewayPort`. A websocket upgrade is an HTTP/1.1 request, so a
 * server with `http1: false` can serve HTTP/2 routes or gateways and never both;
 * splitting the ports is what lets one app do both. The gateway server takes no
 * protocol overrides, because refusing HTTP/1.x there is the thing being avoided.
 *
 * Both servers come from one container, which is the reason this is a second
 * `Bun.serve` rather than a second `HttpFactory.create`: a second app would build
 * a second container, and the gateways would inject different singletons than the
 * controllers.
 */
export class ServerBinding {
  readonly #protocols: BindingProtocols;
  #main: Server<SocketData> | undefined;
  #gateways: Server<SocketData> | undefined;

  constructor(protocols: BindingProtocols) {
    this.#protocols = protocols;
  }

  bind(plan: BindingPlan): Bound {
    const { websocket: ws } = plan;
    const { http2, http1, gatewayPort } = this.#protocols;
    const split = ws !== undefined && gatewayPort !== undefined;

    // One call: a route that may answer `undefined` because it upgraded is only
    // a valid table when `websocket` is there, and Bun's types say so.
    const table =
      ws && !split
        ? {
            routes: withUpgradeRoutes(plan.routes, ws.routes),
            websocket: ws.websocket,
          }
        : { routes: plan.routes };
    this.#main = Bun.serve({
      port: plan.port,
      fetch: plan.fetch,
      ...(http2 !== undefined && { http2 }),
      ...(http1 !== undefined && { http1 }),
      ...table,
    });

    if (split) {
      try {
        this.#gateways = Bun.serve({
          port: gatewayPort,
          // The same fallback as the routes port, so a miss here is logged,
          // gets its CORS headers and honours `notFound` the same way. The only
          // difference between the two servers is what is in the table.
          fetch: plan.fetch,
          routes: withUpgradeRoutes({}, ws.routes),
          websocket: ws.websocket,
        });
      } catch (error) {
        // Otherwise the routes port stays bound behind a rejected `listen()`,
        // and the instance can never listen again.
        void this.#main.stop(true);
        this.#main = undefined;
        throw error;
      }
    }

    const main = this.#main;
    const gateways = this.#gateways;
    return {
      main,
      sockets: gateways ?? main,
      gauges: {
        get pendingRequests() {
          return main.pendingRequests + (gateways?.pendingRequests ?? 0);
        },
        get pendingWebSockets() {
          return main.pendingWebSockets + (gateways?.pendingWebSockets ?? 0);
        },
      },
    };
  }

  get gatewayUrl(): string | undefined {
    return this.#gateways?.url.href;
  }

  /**
   * `force` is for the server that owns the sockets: a graceful stop waits for
   * open connections, and a WebSocket never closes itself, so those clients see
   * a 1006. Under a split the routes server holds none and stops gracefully, so
   * an in-flight request there finishes rather than being cut off.
   */
  async stop(force: boolean): Promise<void> {
    const main = this.#main;
    const gateways = this.#gateways;
    this.#main = undefined;
    this.#gateways = undefined;
    await Promise.all([
      main?.stop(gateways === undefined && force),
      gateways?.stop(force),
    ]);
  }
}
