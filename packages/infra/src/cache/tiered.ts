import { AppError } from '@dunx/core';
import { CacheStore } from './store.js';

export interface TieredCacheInit {
  /**
   * How long a value read out of L2 stays in L1, in milliseconds. L2 reports no
   * remaining lifetime, so a promoted entry gets this rather than what is left of
   * the original.
   *
   * @default 30000
   */
  readonly promoteTtl?: number;
}

/**
 * L1 in front of L2. A hit in L1 answers without touching L2; a hit in L2 is
 * copied into L1 for `promoteTtl`. A write goes to both, a delete to both.
 *
 * Both are local. A `del` on one node leaves every other node's L1 holding the old
 * value until it expires, so `promoteTtl` is the staleness window across a fleet.
 * Cross-process invalidation over pub/sub is not here: a subscribing
 * `Bun.RedisClient` holds the event loop open after `close()`, which would turn
 * every cache into a process that does not exit.
 */
export class TieredCacheStore extends CacheStore {
  readonly #promoteTtl: number;
  /** How many L2 reads are in flight per key, and which were invalidated. */
  readonly #promoting = new Map<string, number>();
  readonly #superseded = new Set<string>();

  constructor(
    private readonly l1: CacheStore,
    private readonly l2: CacheStore,
    init: TieredCacheInit = {},
  ) {
    super();
    const promoteTtl = init.promoteTtl ?? 30_000;
    // `Math.max(1, NaN)` is `NaN`, which reaches L1 as `expiresAt: NaN`. Nothing
    // compares greater than that, so the promoted entry never expires and keeps
    // answering after the L2 one is gone.
    if (!Number.isFinite(promoteTtl) || promoteTtl <= 0) {
      throw new AppError(
        'Cache promoteTtl must be a positive number of milliseconds, got ' +
          `${String(promoteTtl)}.`,
      );
    }
    this.#promoteTtl = promoteTtl;
  }

  async get<V = unknown>(key: string): Promise<V | undefined> {
    const near = await this.l1.get<V>(key);
    if (near !== undefined) return near;

    this.#promoting.set(key, (this.#promoting.get(key) ?? 0) + 1);
    try {
      const far = await this.l2.get<V>(key);
      if (far === undefined) return undefined;
      // A `del` or `set` landing while the L2 read was in flight has already
      // run. Promoting now would put the old value back into L1 and answer
      // from it until `promoteTtl` expired, so the write is dropped instead.
      if (this.#superseded.has(key)) return undefined;
      await this.l1.set(key, far, this.#promoteTtl);
      return far;
    } finally {
      // Counted, not a flag: the first of several concurrent reads to finish
      // would otherwise clear the mark and let the ones behind it write the
      // value a `del` had already removed.
      const left = (this.#promoting.get(key) ?? 1) - 1;
      if (left > 0) this.#promoting.set(key, left);
      else {
        this.#promoting.delete(key);
        this.#superseded.delete(key);
      }
    }
  }

  /** Bounded by the reads in flight, so it holds nothing between `get` calls. */
  #supersede(key: string): void {
    if (this.#promoting.has(key)) this.#superseded.add(key);
  }

  async set<V>(key: string, value: V, ttl: number): Promise<void> {
    this.#supersede(key);
    await this.l2.set(key, value, ttl);
    await this.l1.set(key, value, Math.min(ttl, this.#promoteTtl));
  }

  async del(key: string): Promise<boolean> {
    this.#supersede(key);
    const [near, far] = await Promise.all([this.l1.del(key), this.l2.del(key)]);
    return near || far;
  }
}
