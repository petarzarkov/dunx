import type { Auth as Instance, BetterAuthOptions } from 'better-auth';
import { AuthError } from './errors.js';

/**
 * The injection token for the better-auth instance, and the whole of dunx's
 * contract with the library. `betterAuth()` returns a plain object, so there is no
 * class to use: this is an abstract class whose members alias better-auth's own,
 * which a real instance satisfies structurally.
 *
 * The type argument is `DbModule`'s trick - the token is the erased class, so
 * `Auth<typeof authOptions>` keeps the plugin-widened `api` while resolving the
 * one binding. Written bare it carries better-auth's core endpoints only.
 */
export abstract class Auth<O extends BetterAuthOptions = BetterAuthOptions> {
  /**
   * `abstract` stops TypeScript constructing this, but the container works on
   * runtime values and every class self-binds - so `get(Auth)` with nothing bound
   * would hand back a bare instance whose every member is `undefined`, and the
   * first symptom would be `auth.handler is not a function` deep in a request.
   */
  constructor() {
    if (new.target === Auth) {
      throw new AuthError(
        'Auth is a contract, not an implementation. Bind one with ' +
          'AuthModule.forRoot({ ... }) or AuthModule.forRootAsync({ useFactory }).',
      );
    }
  }

  /** better-auth's framework-agnostic handler. `AuthHandler` mounts it. */
  abstract readonly handler: Instance<O>['handler'];
  /** Every endpoint as a callable - `api.getSession`, `api.signUpEmail`, ... */
  abstract readonly api: Instance<O>['api'];
  /** The options `betterAuth()` was called with, dunx's defaults already applied. */
  abstract readonly options: Instance<O>['options'];
  abstract readonly $ERROR_CODES: Instance<O>['$ERROR_CODES'];
  abstract readonly $context: Instance<O>['$context'];
  abstract readonly $Infer: Instance<O>['$Infer'];
}

/**
 * `{ session, user }` for an authenticated caller - better-auth's own inferred
 * session type, so a plugin's extra user fields (the `admin` plugin's `role` and
 * `banned`, say) are typed without dunx naming a single one of them.
 */
export type Principal<O extends BetterAuthOptions = BetterAuthOptions> =
  Instance<O>['$Infer']['Session'];
