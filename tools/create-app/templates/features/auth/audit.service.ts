import { AuthContext, rolesOf } from '@dunx/auth';
import { Logger } from '@dunx/core';

/**
 * A plain provider, two hops from the request, holding no reference to it. `require()`
 * reads the principal `SessionGuard` established for this request out of
 * `AsyncLocalStorage` - the reason `AuthContext` exists rather than the caller being
 * an extra parameter on every method between here and the route.
 */
export class Audit {
  constructor(
    private readonly auth: AuthContext,
    private readonly logger: Logger,
  ) {}

  whoami(): { email: string; roles: readonly string[]; sessionId: string } {
    const { user, session } = this.auth.require();
    // Every log line inside this request already carries `userId`: the guard wrote it
    // to `RequestContext` on the way in.
    this.logger.info('resolving profile');
    return { email: user.email, roles: rolesOf(user), sessionId: session.id };
  }

  report(): { caller: string; entries: readonly string[] } {
    const { user } = this.auth.require();
    return {
      caller: user.email,
      entries: ['signed in', 'read profile', 'read audit'],
    };
  }

  /** `undefined` on a `@Public()` route: the guard skipped, so nothing was resolved. */
  caller(): string | null {
    return this.auth.current()?.user.email ?? null;
  }
}
