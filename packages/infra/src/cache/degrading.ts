import { ConsoleLogger, type Logger } from '@dunx/core';
import { isConnectionError } from '../redis/errors.js';
import { CacheStore } from './store.js';

export interface DegradingCacheInit {
  /** Where the one line per outage goes. Defaults to core's `ConsoleLogger`. */
  readonly logger?: Logger;
  /**
   * Which failures may be swallowed, `isConnectionError` by default. Narrow: a
   * serialisation failure is the app's bug and has to keep throwing, or the
   * cache quietly stops working and nothing says so.
   */
  readonly degradable?: (error: unknown) => boolean;
  /** The key {@link DegradingCacheStore.probe} reads. Its value is never used. */
  readonly probeKey?: string;
}

/**
 * A cache tier that answers misses instead of throwing while its backend is
 * unreachable. A cached value can be computed again, so an unreachable Redis can
 * cost latency alone; without this every route behind the cache 500s.
 *
 * Opt in through `CacheModule.forRoot(init, { degrade: true })`, or by hand to
 * wrap one tier of a `TieredCacheStore`, which keeps L1 authoritative:
 *
 * ```ts
 * new TieredCacheStore(
 *   new MemoryCacheStore(),
 *   new DegradingCacheStore(new RedisCacheStore(redis), { logger }),
 * );
 * ```
 *
 * `Cache.wrap` needs no change: a `get` of `undefined` is already a miss.
 */
export class DegradingCacheStore extends CacheStore {
  readonly #logger: Logger;
  readonly #degradable: (error: unknown) => boolean;
  readonly #probeKey: string;
  #down = false;

  constructor(
    readonly inner: CacheStore,
    init: DegradingCacheInit = {},
  ) {
    super();
    this.#logger = init.logger ?? new ConsoleLogger();
    this.#degradable = init.degradable ?? isConnectionError;
    this.#probeKey = init.probeKey ?? '__dunx_cache_probe__';
  }

  /**
   * Whether the last operation failed the way this swallows. Optimistic until
   * something has used the store, so ask {@link probe} when it has to mean
   * something.
   */
  get degraded(): boolean {
    return this.#down;
  }

  /** One real read down the same path. A miss is a reachable backend. */
  async probe(): Promise<boolean> {
    try {
      await this.inner.get(this.#probeKey);
      this.#recovered();
      return true;
    } catch (error) {
      if (!this.#degradable(error)) throw error;
      this.#degrade(error);
      return false;
    }
  }

  async get<V = unknown>(key: string): Promise<V | undefined> {
    try {
      const value = await this.inner.get<V>(key);
      this.#recovered();
      return value;
    } catch (error) {
      if (!this.#degradable(error)) throw error;
      this.#degrade(error);
      return undefined;
    }
  }

  /** Dropped rather than queued: a deferred write would report a value the
   * cache never stored. */
  async set<V>(key: string, value: V, ttl: number): Promise<void> {
    try {
      await this.inner.set(key, value, ttl);
      this.#recovered();
    } catch (error) {
      if (!this.#degradable(error)) throw error;
      this.#degrade(error);
    }
  }

  /** `false`, the same answer as a key that was not there. */
  async del(key: string): Promise<boolean> {
    try {
      const dropped = await this.inner.del(key);
      this.#recovered();
      return dropped;
    } catch (error) {
      if (!this.#degradable(error)) throw error;
      this.#degrade(error);
      return false;
    }
  }

  /** Once per outage. An unreachable cache is touched by every cached route and
   * is otherwise the loudest thing in the log. */
  #degrade(error: unknown): void {
    if (this.#down) return;
    this.#down = true;
    this.#logger.warn(
      'The cache is unreachable, so reads are answering as misses and writes ' +
        'are being dropped. Routes behind it are slower, not failing.',
      { reason: error instanceof Error ? error.message : String(error) },
    );
  }

  /** Cleared on any success, so the next outage says so too. */
  #recovered(): void {
    if (!this.#down) return;
    this.#down = false;
    this.#logger.info('The cache is answering again.');
  }
}
