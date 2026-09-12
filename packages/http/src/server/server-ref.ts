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
   * `Bun.serve` closes a connection idle for `idleTimeout`, 10 seconds by
   * default, and a paused response stream counts as idle once the request body
   * has been read. Measured on Bun 1.4.2: a handler that reads the body and then
   * waits 12.5 seconds before its second chunk has the socket cut and the
   * enqueue throws `Controller is already closed`; the same handler on a GET with
   * no body survives, and an 11 second pause survives either way.
   *
   * So a streaming RPC, where the gap between messages is the protocol rather
   * than a stall, clears its own deadline. The app-wide `idleTimeout` is left
   * alone, since it is protecting every other route.
   */
  keepAlive(req: Request): void {
    this.#server?.timeout(req, 0);
  }
}
