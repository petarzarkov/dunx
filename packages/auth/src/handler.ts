import { inject, type Ctor } from '@dunx/core';
import {
  ApiHidden,
  Controller,
  Delete,
  Get,
  Patch,
  Post,
  Public,
  Put,
  type Input,
  type RouteSchemas,
} from '@dunx/http';
import type { BunRequest } from 'bun';
import { Auth } from './auth.js';
import { AuthError } from './errors.js';
import { DEFAULT_BASE_PATH } from './options.js';

/**
 * better-auth's handler is a plain `(request: Request) => Promise<Response>`, so
 * mounting it is five one-line routes. Every endpoint it and its plugins declare
 * lives under one wildcard, which `Bun.serve` matches natively, so Bun is still
 * the router. All five verbs, because a plugin may declare any of them.
 *
 * The `Response` is returned untouched, keeping `Set-Cookie` and redirects intact.
 * `@Public()` at class scope, or a global `SessionGuard` would demand a session
 * from the sign-in endpoint. `inject(Auth)` in a field rather than a constructor
 * parameter, so mounting works without the transform preload.
 */
@Public()
export class AuthHandler {
  readonly #auth = inject(Auth);
  #verified = false;

  @Get('/*') get({ req }: Input<RouteSchemas>): Promise<Response> {
    return this.#dispatch(req);
  }

  @Post('/*') post({ req }: Input<RouteSchemas>): Promise<Response> {
    return this.#dispatch(req);
  }

  @Put('/*') put({ req }: Input<RouteSchemas>): Promise<Response> {
    return this.#dispatch(req);
  }

  @Patch('/*') patch({ req }: Input<RouteSchemas>): Promise<Response> {
    return this.#dispatch(req);
  }

  @Delete('/*') delete({ req }: Input<RouteSchemas>): Promise<Response> {
    return this.#dispatch(req);
  }

  /**
   * better-auth resolves an endpoint by comparing the whole pathname to its own
   * `basePath`, so a handler mounted somewhere else answers 404 to everything with no
   * hint as to why. The final path is only knowable once `listen()` has applied the
   * global prefix, which is after this module was configured - so it is checked on
   * the **first** request and never again.
   */
  #dispatch(req: BunRequest): Promise<Response> {
    if (!this.#verified) {
      this.#verified = true;
      const basePath = this.#auth.options.basePath ?? DEFAULT_BASE_PATH;
      const { pathname } = new URL(req.url);
      if (!pathname.startsWith(`${basePath}/`)) {
        throw new AuthError(
          `${pathname} reached the auth handler, but better-auth is configured with ` +
            `basePath ${basePath} and would answer 404 to everything under it. A ` +
            'global prefix is the usual cause: mount the handler at the path without ' +
            'the prefix and give better-auth the full one - see AuthOptions.mountAt.',
        );
      }
    }
    return this.#auth.handler(req);
  }
}

/**
 * The controller `AuthModule` registers, prefixed with `AuthOptions.mountAt`.
 *
 * A subclass rather than `@Controller(...)` on {@link AuthHandler}: the prefix is
 * only known once the module is configured, and mutating the shared class would
 * make two configurations fight over one. The subclass inherits the routes and
 * `@Public()` off the prototype chain while owning the prefix.
 *
 * `@ApiHidden()` because `*` is not an OpenAPI path template;
 * `betterAuthDocument` describes the auth surface properly.
 */
export const mountHandler = (mountAt: string): Ctor<AuthHandler> =>
  ApiHidden()(
    Controller(mountAt)(class MountedAuthHandler extends AuthHandler {}),
  );
