import type { BunRequest, Server } from 'bun';

/**
 * Every server this process has bound and not yet stopped. A `BunRequest` carries
 * no handle back to the one that received it, and `server.timeout()` for a foreign
 * request is a silent no-op rather than a throw - both probed on Bun 1.4.2 - so the
 * set is walked and the owner is whichever call lands. An app binds one or two, and
 * this runs once per long-lived response rather than once per request.
 */
const servers = new Set<Server<unknown>>();

/** Registers a bound server; the returned function forgets it again. */
export const trackServer = (server: Server<unknown>): (() => void) => {
  servers.add(server);
  return () => {
    servers.delete(server);
  };
};

/**
 * `Bun.serve` severs a connection idle for `idleTimeout` seconds, 10 by default,
 * and a response already streaming is no exception: an event stream with nothing
 * to say for ten seconds is dropped mid-flight, and the next `enqueue` throws
 * `Invalid state: Controller is already closed`.
 *
 * A response meant to idle says so through this. `@Sse` calls it for every stream
 * it answers with; a handler returning its own long-lived `Response` calls
 * `RequestTimeout.clear(req)` for itself.
 */
export class RequestTimeout {
  /**
   * Exempts `req` from the idle timeout for the rest of its life. A peer that
   * vanished is then detected by the next write failing, which for `@Sse` is the
   * heartbeat.
   */
  static clear(req: BunRequest): void {
    RequestTimeout.set(req, 0);
  }

  /** Seconds, counted from now, with `0` for no timeout at all. */
  static set(req: BunRequest, seconds: number): void {
    for (const server of servers) server.timeout(req, seconds);
  }
}
