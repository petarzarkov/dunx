import { AsyncLocalStorage } from 'node:async_hooks';
import { RequestContext } from '@dunx/core';
import { HttpError, HttpStatusCode } from '@dunx/http';
import type { BetterAuthOptions } from 'better-auth';
import type { Principal } from './auth.js';

/**
 * How the authenticated caller reaches a handler - and anything the handler calls,
 * however deep.
 *
 * `AsyncLocalStorage`, for the same reason `@dunx/core`'s `RequestContext` is: it is
 * a Node built-in Bun implements natively, and it is the only mechanism that gets a
 * value from middleware to a service three constructor hops away without passing
 * it. The alternatives were both worse - request-scoped DI was measured and rejected
 * (docs/ARCHITECTURE.md), and hanging the principal off `req` reaches a route
 * handler but nothing a route handler calls.
 *
 * It is a **second** store rather than a key in `RequestContext`. That store is the
 * log record: every field in it is serialized into every line the request writes, so
 * a session object there would be noise on each entry and a redaction hazard in the
 * ones that matter. What does go there is `userId` - a well-known `RequestFields`
 * key - so the log lines are correlated without carrying the principal.
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
