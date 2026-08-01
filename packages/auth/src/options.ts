import type { BetterAuthOptions } from 'better-auth';
import { AuthError } from './errors.js';
import { bunPassword } from './password.js';

/** better-auth's own default, and where `AuthHandler` mounts unless told otherwise. */
export const DEFAULT_BASE_PATH = '/api/auth';

/**
 * One leading slash, no trailing one — the shape `@dunx/http`'s route paths take,
 * so the mount and better-auth's own URL building agree character for character.
 *
 * The root is rejected: the mount is `<basePath>/*`, and at `/` that wildcard would
 * claim every path in the app.
 */
export const normalizeBasePath = (basePath: string): string => {
  const normalized = `/${basePath}`.replace(/\/{2,}/g, '/').replace(/\/$/, '');

  if (normalized.length < 2) {
    throw new AuthError(
      `"${basePath}" is not a usable basePath. The handler mounts at ` +
        '<basePath>/*, so at the root it would claim every route in the app. ' +
        `Use something like ${DEFAULT_BASE_PATH}.`,
    );
  }
  return normalized;
};

/**
 * Bun's native bcrypt in place of better-auth's pure-JavaScript scrypt, unless a
 * `password` of your own is already there. See {@link bunPassword} for the
 * migration caveat.
 */
const withBunPassword = <O extends BetterAuthOptions>(options: O): O => {
  const email = options.emailAndPassword;
  if (!email?.enabled || email.password) return options;

  // The one cast in the package: TypeScript cannot prove a spread of a generic with
  // one key replaced is still that generic, and widening the return to
  // `BetterAuthOptions` would lose the plugin types `betterAuth()` infers from it.
  return {
    ...options,
    emailAndPassword: { ...email, password: bunPassword },
  } as O;
};

/**
 * What `betterAuth()` gets called with, where the handler mounts, and the difference
 * between the two. Bound in the container so all of it is readable, and constructed
 * by `AuthModule` rather than by the app.
 */
export class AuthOptions<O extends BetterAuthOptions = BetterAuthOptions> {
  readonly options: O;

  /**
   * What better-auth matches an incoming pathname against, and builds its URLs from.
   * Normalized here and written back into `options`, so the two cannot drift.
   */
  readonly basePath: string;

  /**
   * The **route** path `AuthHandler` is mounted at, which is `basePath` unless the
   * app calls `setGlobalPrefix`. better-auth compares the whole pathname to
   * `basePath`, so with `setGlobalPrefix('api')` the two are different strings for
   * the same URL: mount at `/auth`, and tell better-auth `basePath: '/api/auth'`.
   */
  readonly mountAt: string;

  constructor(init: O, mountAt?: string) {
    this.basePath = normalizeBasePath(init.basePath ?? DEFAULT_BASE_PATH);
    this.mountAt =
      mountAt === undefined ? this.basePath : normalizeBasePath(mountAt);
    this.options = withBunPassword({ ...init, basePath: this.basePath });
  }
}
