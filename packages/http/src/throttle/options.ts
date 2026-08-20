import { AppError } from '@dunx/core';
import type { BunRequest } from 'bun';
import type { RouteContext } from '../server/context.js';
import type { ThrottleLimit } from './decorators.js';
import type { ThrottleStore } from './store.js';

export interface ThrottleOptionsInit extends ThrottleLimit {
  /**
   * Namespaces every key this app writes. **Required, and an empty one throws.**
   *
   * There is no default on purpose. A scaffolded app that inherits the template's
   * prefix and ships with it puts two applications in one Redis on one throttle
   * namespace, each spending the other's budget - which is exactly what happened,
   * and a friendly fallback is what let it.
   */
  readonly prefix: string;
  /**
   * Who is being limited. Defaults to the client address, or `'anonymous'` when
   * even that is unknown.
   *
   * This is an option rather than an injected caller because the identity a limit
   * counts by belongs to the app: an authenticated request is limited by user id
   * and an anonymous one by address, and only the guard ahead of this one knows
   * which. It is also what keeps `@dunx/http` from depending on `@dunx/auth`.
   *
   * ```ts
   * subject: (req) => currentUser.optional()?.id ?? address.of(req)
   * ```
   */
  readonly subject?: (req: BunRequest, ctx: RouteContext) => string | undefined;
  /**
   * Send `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`, plus
   * `Retry-After` on a 429. @default true
   */
  readonly headers?: boolean;
  /**
   * The counter. Defaults to {@link MemoryThrottleStore}, which is per process -
   * so two replicas each allow the full budget until this names a shared one.
   */
  readonly store?: ThrottleStore;
}

/**
 * A class, not an interface, so it is a runtime value and can be a constructor
 * parameter type the transform records - the same reason `StaticOptions` is one.
 */
export class ThrottleOptions {
  readonly limit: number;
  readonly windowSeconds: number;
  readonly prefix: string;
  readonly headers: boolean;
  readonly subject:
    | ((req: BunRequest, ctx: RouteContext) => string | undefined)
    | undefined;
  readonly store: ThrottleStore | undefined;

  constructor(init: ThrottleOptionsInit) {
    if (init.prefix.trim() === '') {
      throw new AppError(
        'ThrottleModule needs a prefix naming this application, and it has no ' +
          'default: two apps sharing one Redis with one throttle namespace each ' +
          "spend the other's budget. Pass something like { prefix: 'orders-api' }.",
      );
    }
    if (!Number.isInteger(init.limit) || init.limit < 1) {
      throw new AppError(
        `ThrottleModule needs a limit of at least 1; got ${init.limit}.`,
      );
    }
    if (!Number.isInteger(init.windowSeconds) || init.windowSeconds < 1) {
      throw new AppError(
        'ThrottleModule needs a windowSeconds of at least 1; got ' +
          `${init.windowSeconds}.`,
      );
    }
    this.limit = init.limit;
    this.windowSeconds = init.windowSeconds;
    this.prefix = init.prefix;
    this.headers = init.headers ?? true;
    this.subject = init.subject;
    this.store = init.store;
  }
}
