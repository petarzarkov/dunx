import {
  HttpError,
  HttpStatusCode,
  PUBLIC,
  ROLES,
  type Middleware,
  type Next,
  type RouteContext,
} from '@dunx/http';
import type { BunRequest } from 'bun';
import { Auth, type Principal } from './auth.js';
import { AuthContext } from './context.js';

interface Roled {
  readonly role?: unknown;
}

/**
 * What roles a user holds. better-auth's `admin` plugin stores them in a single
 * `role` column, comma-separated for more than one; a custom plugin may use an
 * array. Both read the same here, and a user with none reads as `[]` rather than
 * throwing - an app may well not use roles at all.
 */
export const rolesOf = (user: object): readonly string[] => {
  const role = (user as Roled).role;

  if (typeof role === 'string') {
    return role
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  if (Array.isArray(role)) {
    return role.filter((entry): entry is string => typeof entry === 'string');
  }
  return [];
};

/**
 * Authenticates every request it sees through better-auth's own session lookup, and
 * composes with the metadata `@dunx/http` already carries:
 *
 * - `@Public()` - skipped outright. No session lookup, no rejection, no role check.
 *   That is what makes it safe to install globally: better-auth's own endpoints are
 *   `@Public()`, and a sign-in route that needed a session could never be reached.
 *   A public route that wants to *adapt* to an optional caller injects `Auth` and
 *   calls `auth.api.getSession({ headers: req.headers })` itself - one line, and it
 *   does not put a lookup on every public request in the app.
 * - `@Roles('admin')` - a 403 unless the caller holds one of them.
 *
 * Install it globally with `HttpFactory.create(root, { middleware: [SessionGuard] })`
 * and opt routes out with `@Public()`, or scope it with `@UseGuards(SessionGuard)`
 * and leave the rest of the app open. `AuthModule` registers it either way.
 */
export class SessionGuard implements Middleware {
  constructor(
    private readonly auth: Auth,
    private readonly context: AuthContext,
  ) {}

  async handle(
    req: BunRequest,
    ctx: RouteContext,
    next: Next,
  ): Promise<Response> {
    if (ctx.get(PUBLIC)) return next();

    const principal: Principal | null = await this.auth.api.getSession({
      headers: req.headers,
    });
    if (!principal) {
      throw new HttpError(HttpStatusCode.UNAUTHORIZED, 'UNAUTHENTICATED');
    }

    const required = ctx.get(ROLES);
    if (required !== undefined && required.length > 0) {
      const held = rolesOf(principal.user);
      if (!required.some((role) => held.includes(role))) {
        throw new HttpError(
          HttpStatusCode.FORBIDDEN,
          `Requires one of: ${required.join(', ')}`,
        );
      }
    }

    return this.context.run(principal, next);
  }
}
