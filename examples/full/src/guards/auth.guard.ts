import { Logger } from '@dunx/core';
import type { BunRequest } from 'bun';
import {
  HttpError,
  HttpStatusCode,
  PUBLIC,
  ROLES,
  type Middleware,
  type Next,
  type RouteContext,
} from '@dunx/http';

/** `Authorization: Bearer <role>` - enough to demonstrate, short of a real token. */
const roleOf = (req: BunRequest): string | undefined =>
  req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');

/**
 * Global middleware, so it sees every route. `ctx.get(PUBLIC)` is the only thing
 * that can tell an opted-out route apart from one that needs credentials - which
 * is what makes `@Public()` do something rather than decorate.
 */
export class AuthGuard implements Middleware {
  constructor(private readonly logger: Logger) {}

  handle(req: BunRequest, ctx: RouteContext, next: Next): Promise<Response> {
    if (ctx.get(PUBLIC)) {
      this.logger.info(
        `AuthGuard: ${ctx.method} ${ctx.path} is @Public() - skipping`,
      );
      return next();
    }
    const role = roleOf(req);
    if (role === undefined) {
      throw new HttpError(HttpStatusCode.UNAUTHORIZED, 'No credentials');
    }
    this.logger.info(
      `AuthGuard: ${ctx.controller}.${ctx.handler} authenticated as "${role}"`,
    );
    return next();
  }
}

/**
 * A guard is middleware that throws. Applied with `@UseGuards(RolesGuard)` at
 * method scope, it reads whichever `@Roles` won - the method's, else the class's.
 */
export class RolesGuard implements Middleware {
  constructor(private readonly logger: Logger) {}

  handle(req: BunRequest, ctx: RouteContext, next: Next): Promise<Response> {
    const required = ctx.get(ROLES);
    if (!required) return next();

    const role = roleOf(req);
    this.logger.info(
      `RolesGuard: ${ctx.handler} requires [${required.join(', ')}], caller is "${role ?? '-'}"`,
    );
    if (role === undefined || !required.includes(role)) {
      throw new HttpError(
        HttpStatusCode.FORBIDDEN,
        `Requires one of: ${required.join(', ')}`,
      );
    }
    return next();
  }
}
