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
 * mounting it is five one-line routes and nothing else. Every endpoint the library
 * and its plugins declare lives under one wildcard - dunx does not restate, wrap or
 * re-dispatch a single one of them.
 *
 * `Bun.serve` matches `<basePath>/*` natively (verified on Bun 1.3.14), so Bun is
 * still the router. All five verbs are mounted because a plugin may declare any of
 * them; better-auth's own endpoints are `GET` and `POST`.
 *
 * The `Response` is returned untouched - `buildRoutes` passes one straight through,
 * which is what keeps better-auth's `Set-Cookie` headers and redirects intact.
 *
 * `@Public()` at class scope, so all five inherit it - `mergeMeta` reads the class's
 * record under the handler's. Without it a globally installed `SessionGuard` would
 * demand a session from the sign-in endpoint, and no session could ever be created.
 *
 * `inject(Auth)` in a field rather than a constructor parameter, because a bare
 * class in `controllers` is bound as a class provider and would then need
 * `@dunx/transform`'s transform to have run. This way mounting works in an app that
 * never added the preload.
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
 * A subclass rather than `@Controller(...)` on {@link AuthHandler} itself: the prefix
 * is only known once the module is configured, and mutating the shared class from a
 * factory would make two configurations fight over one prefix. The subclass declares
 * nothing of its own and inherits everything - `discoverRoutes` walks the prototype
 * chain for the routes, and `metaOf` and `prefixOf` are plain lookups, so `@Public()`
 * comes down from the base while the prefix stays own to the subclass.
 *
 * `@ApiHidden()` because the mount is a wildcard. The route is real and has to be
 * served, but `*` is not an OpenAPI path template, so documenting it produced an
 * invalid entry tagged with this class's internal name - alongside the paths
 * `betterAuthDocument` describes properly, which is where the auth surface should
 * be read from.
 */
export const mountHandler = (mountAt: string): Ctor<AuthHandler> =>
  ApiHidden()(
    Controller(mountAt)(class MountedAuthHandler extends AuthHandler {}),
  );
