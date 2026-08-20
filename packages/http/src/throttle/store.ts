import { AppError } from '@dunx/core';

/**
 * The counter behind the guard.
 *
 * An `abstract class` rather than an interface: `@dunx/transform` records
 * constructor parameter *types*, so an interface at an injection site is a boot
 * error. Same reason `RedisConnection` and `Logger` are classes.
 *
 * **A fixed window, not a sliding one.** `hit` increments and returns the count for
 * the window the key is already in; the window starts at the first hit and ends
 * when the key expires. A sliding window needs a sorted set per subject and a
 * range trim per request, which is a different cost for an accuracy a rate limit
 * does not need.
 */
export abstract class ThrottleStore {
  constructor() {
    if (new.target === ThrottleStore) {
      throw new AppError(
        'ThrottleStore is a contract, not an implementation. Bind one with ' +
          'ThrottleModule.forRoot({ store: new RedisThrottleStore(redis) }), or ' +
          'leave it out for the in-process MemoryThrottleStore.',
      );
    }
  }

  /**
   * The count for this key in the current window.
   *
   * **`undefined` means the store could not be reached**, and the guard reads that
   * as "allow". A rate limiter that turns an unreachable Redis into a 503 has
   * turned a degraded route into an outage.
   */
  abstract hit(key: string, windowSeconds: number): Promise<number | undefined>;

  /** Seconds left in this key's window, for `Retry-After`. */
  abstract ttl(key: string): Promise<number | undefined>;
}

/**
 * The commands the Redis store needs, restated structurally so this package keeps
 * its zero dependencies - the same trick `PubSubRelay` uses.
 *
 * `@dunx/infra`'s `RedisConnection` satisfies it, and so does a bare
 * `Bun.RedisClient`, without either being named here.
 */
export interface ThrottleRedis {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
  ttl(key: string): Promise<number>;
}

/**
 * The multi-process counter: one key per subject and handler.
 *
 * `INCR` then `EXPIRE`, and the `EXPIRE` **only on the call that returned 1**. That
 * is what makes the window start at the first hit rather than being pushed forward
 * by every subsequent one, and it is two round trips rather than a Lua script
 * because `Bun.RedisClient` pipelines on its own.
 */
export class RedisThrottleStore extends ThrottleStore {
  constructor(private readonly redis: ThrottleRedis) {
    super();
  }

  async hit(key: string, windowSeconds: number): Promise<number | undefined> {
    const used = await this.redis.incr(key);
    if (used === 1) await this.redis.expire(key, windowSeconds);
    return used;
  }

  async ttl(key: string): Promise<number | undefined> {
    // Redis answers -1 for a key with no expiry and -2 for one that is gone.
    // Neither is a duration, and reporting one as a `Retry-After` would be a
    // negative wait.
    const left = await this.redis.ttl(key);
    return left > 0 ? left : undefined;
  }
}

interface Window {
  count: number;
  expiresAt: number;
}

/**
 * The single-process counter, and the default - so an app with no Redis still
 * limits something rather than nothing.
 *
 * It is per process, which is the whole caveat: two replicas each allow the full
 * budget. `RedisThrottleStore` is the answer for more than one.
 *
 * The map is bounded. An expired entry is dropped when its key is next touched,
 * and once the map passes `maxKeys` every expired entry is swept - so a burst
 * across many subjects cannot grow it without limit. Reaching the cap with nothing
 * expired clears it, which resets a window early rather than holding memory a
 * server does not have.
 */
export class MemoryThrottleStore extends ThrottleStore {
  readonly #windows = new Map<string, Window>();
  readonly #maxKeys: number;

  constructor(maxKeys = 10_000) {
    super();
    this.#maxKeys = maxKeys;
  }

  hit(key: string, windowSeconds: number): Promise<number | undefined> {
    const now = Date.now();
    const existing = this.#windows.get(key);
    if (existing !== undefined && existing.expiresAt > now) {
      existing.count += 1;
      return Promise.resolve(existing.count);
    }
    if (this.#windows.size >= this.#maxKeys) this.#sweep(now);
    this.#windows.set(key, { count: 1, expiresAt: now + windowSeconds * 1000 });
    return Promise.resolve(1);
  }

  ttl(key: string): Promise<number | undefined> {
    const window = this.#windows.get(key);
    if (window === undefined) return Promise.resolve(undefined);
    const left = Math.ceil((window.expiresAt - Date.now()) / 1000);
    return Promise.resolve(left > 0 ? left : undefined);
  }

  #sweep(now: number): void {
    for (const [key, window] of this.#windows) {
      if (window.expiresAt <= now) this.#windows.delete(key);
    }
    if (this.#windows.size >= this.#maxKeys) this.#windows.clear();
  }
}
