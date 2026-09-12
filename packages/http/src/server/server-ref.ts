/**
 * The one thing a middleware needs off the bound server, restated structurally so
 * this carries no `Server<SocketData>` type argument: `Bun.Server` satisfies it
 * whatever its socket data is.
 */
export interface RequestDeadlines {
  timeout(req: Request, seconds: number): void;
}

/**
 * The bound server, for the middleware that needs a per-request call on it.
 *
 * Bound by `HttpFactory`'s global wrapper next to `ClientAddress` and attached by
 * `listen()`, so there is one instance and it is the one holding the live server.
 * Unattached before `listen()`, and `keepAlive` is a no-op until then.
 */
export class ServerRef {
  #server: RequestDeadlines | undefined;

  attach(server: RequestDeadlines): void {
    this.#server = server;
  }

  /**
   * Takes one in-flight request out of the idle timeout.
   *
   * `Bun.serve` severs a response that has been idle past `idleTimeout`: the
   * enqueue throws `Controller is already closed` and the client reads
   * `ECONNRESET`. The check runs on a 4 second timer, so the sever lands at
   * `ceil(idleTimeout / 4) * 4` seconds - 12.0s on the default 10, and 8.0s for
   * any setting from 5 to 8. Reading the request body makes no difference, and
   * `idleTimeout: 0` disables it. Measured on Bun 1.4.2, table in
   * docs/bun-apis.md.
   *
   * A streaming RPC clears its own deadline because a gap between messages is
   * the protocol rather than a stall. Everything else, a slow unary handler
   * included, stays under the app-wide `idleTimeout` that protects every route.
   */
  keepAlive(req: Request): void {
    this.#server?.timeout(req, 0);
  }
}
