import { AppError } from '@dunx/core';

/**
 * What a cache tier does: read a value, write one with a lifetime, drop one.
 *
 * An `abstract class` rather than an interface, since an interface has no runtime
 * value for `@dunx/transform` to record and is a boot error at an injection site.
 *
 * Separate from `@dunx/http`'s `ThrottleStore`, which is a counter -
 * `hit(key, windowSeconds)` and `ttl(key)`, no value channel and no recency. The
 * one literal overlap is `MemoryThrottleStore`'s expiry sweep, which walks the
 * whole Map and clears it at the cap: 59.9 ms of stall at 100k keys, measured, and
 * already flagged for replacement. `@dunx/infra` must not depend on the web layer,
 * so a shared contract could only live in zero-dependency `@dunx/core`.
 */
export abstract class CacheStore {
  constructor() {
    if (new.target === CacheStore) {
      throw new AppError(
        'CacheStore is a contract, not an implementation. Bind one with ' +
          'CacheModule.forRoot({ store: new RedisCacheStore(redis) }), or leave ' +
          'it out for the in-process MemoryCacheStore.',
      );
    }
  }

  /** `undefined` is a miss, so a stored `undefined` cannot be told from one. */
  abstract get<V = unknown>(key: string): Promise<V | undefined>;

  /** `ttl` is milliseconds. */
  abstract set<V>(key: string, value: V, ttl: number): Promise<void>;

  /** Whether a live entry was removed. */
  abstract del(key: string): Promise<boolean>;
}
