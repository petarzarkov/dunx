import { AppError } from '@dunx/core';
import type { BunRequest } from 'bun';
import { metaKey, type MetaKey } from '../route/metadata.js';
import type { RouteContext } from '../server/context.js';
import type { IdempotencyStore } from './store.js';

/** What `@Idempotent()` takes, overriding the module's defaults for its routes. */
export interface IdempotentRoute {
  /** Refuse a request without an `Idempotency-Key` with a 400. @default false */
  readonly required?: boolean;
  /** How long a completed response is replayed. */
  readonly ttlSeconds?: number;
}

/**
 * Read off a `RouteContext` like `THROTTLE`, and what tells `IdempotencyGuard`
 * that a route opted in.
 */
export const IDEMPOTENT: MetaKey<IdempotentRoute> = metaKey('idempotent');

export interface IdempotencyOptionsInit {
  /**
   * Namespaces every key this app writes. **Required, and an empty one throws**,
   * for the reason `ThrottleOptions.prefix` gives: two apps on one Redis sharing a
   * namespace replay each other's responses.
   */
  readonly prefix: string;
  /**
   * Whose key it is. The stored key is `prefix`, this, and the client's key, so
   * two callers sending the same key never see each other's response.
   *
   * **Required.** `@dunx/http` cannot see a session, so an authenticated app names
   * its principal: `subject: () => auth.current()?.user.id`. Returning `undefined`
   * puts the caller in one key space shared by every such caller, and
   * `subject: () => undefined` is how an app with no auth says it accepts that.
   */
  readonly subject: (req: BunRequest, ctx: RouteContext) => string | undefined;
  /** How long a completed response is replayed. @default 86400 (24 hours) */
  readonly ttlSeconds?: number;
  /**
   * How long an in-flight claim holds its key. A retry inside it is a 409; past
   * it, a request that crashed without releasing no longer blocks the key.
   * Longer than the slowest handler, or a slow first request runs twice.
   * @default 60
   */
  readonly leaseSeconds?: number;
  /**
   * The largest response body stored. A larger one is returned but not kept, and
   * its key is released. @default 1048576 (1 MiB)
   */
  readonly maxBodyBytes?: number;
  /** Defaults to {@link MemoryIdempotencyStore}, which is per process. */
  readonly store?: IdempotencyStore;
}

/** Shared with `@Idempotent()`, which names itself as `owner`. */
export const positive = (
  name: string,
  value: number,
  owner = 'IdempotencyModule',
): number => {
  if (!Number.isInteger(value) || value < 1) {
    throw new AppError(`${owner} needs a ${name} of at least 1; got ${value}.`);
  }
  return value;
};

/** A class so it is a runtime value a constructor parameter can name. */
export class IdempotencyOptions {
  readonly prefix: string;
  readonly subject: (req: BunRequest, ctx: RouteContext) => string | undefined;
  readonly ttlSeconds: number;
  readonly leaseSeconds: number;
  readonly maxBodyBytes: number;
  readonly store: IdempotencyStore | undefined;

  constructor(init: IdempotencyOptionsInit) {
    if (typeof init.prefix !== 'string' || init.prefix.trim() === '') {
      throw new AppError(
        'IdempotencyModule needs a prefix naming this application, and it has ' +
          'no default: two apps sharing one Redis with one namespace replay each ' +
          "other's responses. Pass something like { prefix: 'orders-api' }.",
      );
    }
    if (typeof init.subject !== 'function') {
      throw new AppError(
        'IdempotencyModule needs a subject naming whose key it is, and it has no ' +
          'default. Pass subject: () => auth.current()?.user.id, or ' +
          'subject: () => undefined to share one key space between every caller.',
      );
    }
    this.prefix = init.prefix;
    this.subject = init.subject;
    this.ttlSeconds = positive('ttlSeconds', init.ttlSeconds ?? 86_400);
    this.leaseSeconds = positive('leaseSeconds', init.leaseSeconds ?? 60);
    this.maxBodyBytes = positive('maxBodyBytes', init.maxBodyBytes ?? 1 << 20);
    this.store = init.store;
  }
}
