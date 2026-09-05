import type { Server } from 'bun';
import type { SocketData } from '../ws/socket.js';
import type { WebSocketRuntime } from '../ws/adapter.js';
import type { RouteHandler } from './middleware.js';
import { withUpgradeRoutes, type BunRoutes } from './routes.js';

/** What `listen()` hands the binding, once the route table is final. */
export interface BindingPlan {
  readonly port: number;
  readonly routes: BunRoutes;
  readonly fetch: RouteHandler;
  readonly websocket: WebSocketRuntime | undefined;
  /** `undefined` leaves Bun's default in place rather than restating it. */
  readonly http2: boolean | undefined;
  readonly http1: boolean | undefined;
  /**
   * A port of its own for the gateways. When set, the upgrade routes are not
   * merged into the main table and a second `Bun.serve` takes them.
   */
  readonly gatewayPort: number | undefined;
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
  #main: Server<SocketData> | undefined;
  #gateways: Server<SocketData> | undefined;

  bind(plan: BindingPlan): void {
    const { websocket: ws, gatewayPort } = plan;
    const protocols = {
      ...(plan.http2 === undefined ? {} : { http2: plan.http2 }),
      ...(plan.http1 === undefined ? {} : { http1: plan.http1 }),
    };
    const split = ws !== undefined && gatewayPort !== undefined;

    // One call: a route that may answer `undefined` because it upgraded is only
    // a valid table when `websocket` is there, and Bun's types say so.
    const options: Bun.Serve.Options<SocketData> =
      ws && !split
        ? {
            port: plan.port,
            fetch: plan.fetch,
            ...protocols,
            routes: withUpgradeRoutes(plan.routes, ws.routes),
            websocket: ws.websocket,
          }
        : {
            port: plan.port,
            fetch: plan.fetch,
            ...protocols,
            routes: plan.routes,
          };
    this.#main = Bun.serve(options);

    if (!split) return;
    this.#gateways = Bun.serve({
      port: gatewayPort,
      // Nothing but the upgrades. An HTTP request to this port is a 404, which
      // is what a port documented as the websocket one should answer.
      routes: withUpgradeRoutes({}, ws.routes),
      websocket: ws.websocket,
      fetch: () =>
        new Response('{"error":"NOT_FOUND","status":404}', {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
    });
  }

  get main(): Server<SocketData> | undefined {
    return this.#main;
  }

  /** The server that owns the sockets, which is what `PubSub` publishes on. */
  get sockets(): Server<SocketData> | undefined {
    return this.#gateways ?? this.#main;
  }

  get url(): string | undefined {
    return this.#main?.url.href;
  }

  get gatewayUrl(): string | undefined {
    return this.#gateways?.url.href;
  }

  /**
   * `force` when a gateway is served: a graceful stop waits for open connections
   * and a WebSocket never closes itself. Those clients see a 1006.
   */
  async stop(force: boolean): Promise<void> {
    const stopping = [
      this.#main?.stop(force),
      this.#gateways?.stop(force),
    ].filter((value) => value !== undefined);
    this.#main = undefined;
    this.#gateways = undefined;
    await Promise.all(stopping);
  }
}
