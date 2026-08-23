import { AsyncLocalStorage } from 'node:async_hooks';
import { RequestContext } from '@dunx/core';
import { HttpError, HttpStatusCode } from '@dunx/http';
import type { BetterAuthOptions } from 'better-auth';
import type { Principal } from './auth.js';

/**
 * How the authenticated caller reaches a handler, and anything the handler calls.
 *
 * `AsyncLocalStorage`, the only mechanism that gets a value from middleware to a
 * service three constructor hops away without passing it. Request-scoped DI was
 * measured and rejected; hanging the principal off `req` reaches a route handler
 * but nothing it calls.
 *
 * A second store rather than a key in `RequestContext`: that one is the log
 * record, so a session object there would be noise on every line and a redaction
 * hazard. `userId` does go there, so lines correlate without the principal.
 */
export class AuthContext {
  readonly #storage = new AsyncLocalStorage<Principal>();

  constructor(private readonly context: RequestContext) {}

  /**
   * The caller, or `undefined` on an anonymous request. The type argument is the
   * options object `AuthModule` was configured with, and is how a plugin's extra
   * user fields become visible:
   *
   * ```ts
   * const principal = this.auth.current<typeof authOptions>();
   * ```
   */
  current<O extends BetterAuthOptions = BetterAuthOptions>():
    | Principal<O>
    | undefined {
    return this.#storage.getStore() as Principal<O> | undefined;
  }

  /** The caller, or a 401. For a handler behind `SessionGuard` that is not `@Public()`. */
  require<O extends BetterAuthOptions = BetterAuthOptions>(): Principal<O> {
    const principal = this.current<O>();
    if (!principal) {
      throw new HttpError(HttpStatusCode.UNAUTHORIZED, 'UNAUTHENTICATED');
    }
    return principal;
  }

  /**
   * Runs `callback` with `principal` as the caller. `SessionGuard` is what calls
   * this; a job or a socket handler that resolved a session itself can too.
   *
   * `userId` is written to `RequestContext` as well, which is what puts it on every
   * log line the callback produces.
   */
  run<T>(principal: Principal, callback: () => T): T {
    this.context.updateContext({ userId: principal.user.id });
    return this.#storage.run(principal, callback);
  }
}
