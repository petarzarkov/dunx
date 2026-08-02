import {
  provide,
  type AbstractCtor,
  type Deps,
  type DynamicModule,
  type FactoryProvider,
  type Registration,
  RequestContext,
} from '@dunx/core';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { Auth } from './auth.js';
import { AuthContext } from './context.js';
import { AuthError } from './errors.js';
import { SessionGuard } from './guard.js';
import { mountHandler } from './handler.js';
import {
  AuthOptions,
  DEFAULT_BASE_PATH,
  normalizeBasePath,
} from './options.js';

const build = (options: Registration, mountAt: string): DynamicModule => {
  // Instantiated to the token type rather than left as `typeof Auth`, which is what
  // lets the factory below hand back a plain better-auth instance with no cast.
  const auth: AbstractCtor<Auth> = Auth;

  return {
    module: AuthModule,
    controllers: [mountHandler(mountAt)],
    // Every binding declares its own `inject`, so nothing here needs
    // `@dunx/transform`'s transform to have run — the same reason
    // `RequestLoggingMiddleware` and `@dunx/infra/redis`'s `Redis` are bound this way.
    providers: [
      options,
      provide(auth, {
        useFactory: (resolved: AuthOptions) => betterAuth(resolved.options),
        inject: [AuthOptions] as const,
      }),
      provide(AuthContext, {
        useFactory: (context: RequestContext) => new AuthContext(context),
        inject: [RequestContext] as const,
      }),
      provide(SessionGuard, {
        useFactory: (instance: Auth, context: AuthContext) =>
          new SessionGuard(instance, context),
        inject: [auth, AuthContext] as const,
      }),
    ],
  };
};

/**
 * Binds three tokens and one controller:
 *
 * - `AuthOptions` — what `betterAuth()` was called with, and where it is mounted.
 * - `Auth` — the better-auth instance itself.
 * - `AuthContext` — the authenticated caller, per request.
 * - a prefixed `AuthHandler`, serving every better-auth endpoint under `basePath`.
 *
 * `SessionGuard` is registered as a provider rather than installed as global
 * middleware, because whether it guards the whole app or one controller is the app's
 * decision — pass it to `HttpFactory.create(root, { middleware: [SessionGuard] })`
 * or to `@UseGuards(SessionGuard)`.
 */
export class AuthModule {
  /**
   * ```ts
   * AuthModule.forRoot({
   *   secret: process.env.BETTER_AUTH_SECRET,
   *   baseURL: 'http://localhost:3000',
   *   database: drizzleDatabase(connection),
   *   emailAndPassword: { enabled: true },
   *   plugins: [admin(), bearer()],
   * });
   * ```
   *
   * `const O` is load-bearing: it keeps the literal `plugins` tuple, which is what
   * `betterAuth()` infers the plugin endpoints from — and therefore what
   * `Auth<typeof options>` resolves to at an injection site.
   *
   * `mountAt` only matters under a global prefix — see {@link AuthOptions.mountAt}.
   */
  static forRoot<const O extends BetterAuthOptions>(
    options: O,
    mountAt?: string,
  ): DynamicModule {
    const resolved = new AuthOptions(options, mountAt);
    return build(
      provide(AuthOptions, { useValue: resolved }),
      resolved.mountAt,
    );
  }

  /**
   * `forRoot` with the options behind a factory that may await and may inject —
   * which is the only way the secret, the base URL and the database can come from
   * `ConfigService` rather than from module scope:
   *
   * ```ts
   * AuthModule.forRootAsync({
   *   useFactory: (config: AppConfigService, connection: DbConnection) => ({
   *     secret: config.get('authSecret'),
   *     baseURL: config.get('appUrl'),
   *     database: drizzleDatabase(connection),
   *     emailAndPassword: { enabled: true },
   *   }),
   *   inject: [AppConfigService, DbConnection],
   * });
   * ```
   *
   * `mountAt` is a second, **synchronous** argument for the same reason
   * `DbModule.forRootAsync` takes its token positionally: the mount is a route in
   * Bun's table, and that table is built before any factory has run. It is only
   * needed under a global prefix — see {@link AuthOptions.mountAt}. Omitting it while
   * the factory returns a non-default `basePath` is a boot error, because that
   * combination could only ever have mounted the handler where better-auth is not
   * looking.
   */
  static forRootAsync<const D extends Deps>(
    provider: FactoryProvider<BetterAuthOptions, D>,
    mountAt?: string,
  ): DynamicModule;
  static forRootAsync(
    provider: FactoryProvider<BetterAuthOptions, Deps>,
    mountAt?: string,
  ): DynamicModule {
    const mounted = normalizeBasePath(mountAt ?? DEFAULT_BASE_PATH);

    return build(
      provide(AuthOptions, {
        useFactory: async (
          ...deps: readonly unknown[]
        ): Promise<AuthOptions> => {
          const resolved = new AuthOptions(
            await provider.useFactory(...deps),
            mounted,
          );
          if (mountAt === undefined && resolved.basePath !== mounted) {
            throw new AuthError(
              `The factory returned basePath ${resolved.basePath}, but the handler ` +
                `is mounted at ${mounted} — the table was built before the factory ` +
                'ran, so it could not follow. Pass the route path as ' +
                "forRootAsync's second argument.",
            );
          }
          return resolved;
        },
        inject: provider.inject ?? [],
      }),
      mounted,
    );
  }
}
