import type { Auth as Instance, BetterAuthOptions } from 'better-auth';
import { AuthError } from './errors.js';

/**
 * The injection token for the better-auth instance, and the whole of dunx's
 * contract with the library.
 *
 * `betterAuth()` returns a plain object, so there is no class to use as a token.
 * This is the same trick `Logger` and `RequestContext` use in `@dunx/core`: an
 * abstract class whose members are **aliases of better-auth's own** — not
 * restatements — which a real instance satisfies structurally. That is what makes
 * `constructor(private readonly auth: Auth)` work, since `@dunx/transform` records
 * the bare type name and the container resolves it.
 *
 * The type argument is the `DbModule` trick from `@dunx/infra/db`: the token is the
 * erased class, so `Auth<typeof authOptions>` at an injection site keeps the
 * plugin-widened `api` while still resolving the one binding. Written bare, `Auth`
 * carries better-auth's core endpoints only — a plugin's endpoints are on the
 * annotation, not on the token.
 */
export abstract class Auth<O extends BetterAuthOptions = BetterAuthOptions> {
  /**
   * `abstract` stops TypeScript constructing this, but the container works on
   * runtime values and every class self-binds — so `get(Auth)` with nothing bound
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
  /** Every endpoint as a callable — `api.getSession`, `api.signUpEmail`, ... */
  abstract readonly api: Instance<O>['api'];
  /** The options `betterAuth()` was called with, dunx's defaults already applied. */
  abstract readonly options: Instance<O>['options'];
  abstract readonly $ERROR_CODES: Instance<O>['$ERROR_CODES'];
  abstract readonly $context: Instance<O>['$context'];
  abstract readonly $Infer: Instance<O>['$Infer'];
}

/**
 * `{ session, user }` for an authenticated caller — better-auth's own inferred
 * session type, so a plugin's extra user fields (the `admin` plugin's `role` and
 * `banned`, say) are typed without dunx naming a single one of them.
 */
export type Principal<O extends BetterAuthOptions = BetterAuthOptions> =
  Instance<O>['$Infer']['Session'];
