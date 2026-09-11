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

  constructor(
    private readonly l1: CacheStore,
    private readonly l2: CacheStore,
    init: TieredCacheInit = {},
  ) {
    super();
    this.#promoteTtl = Math.max(1, init.promoteTtl ?? 30_000);
  }

  async get<V = unknown>(key: string): Promise<V | undefined> {
    const near = await this.l1.get<V>(key);
    if (near !== undefined) return near;
    const far = await this.l2.get<V>(key);
    if (far === undefined) return undefined;
    await this.l1.set(key, far, this.#promoteTtl);
    return far;
  }

  async set<V>(key: string, value: V, ttl: number): Promise<void> {
    await this.l2.set(key, value, ttl);
    await this.l1.set(key, value, Math.min(ttl, this.#promoteTtl));
  }

  async del(key: string): Promise<boolean> {
    const [near, far] = await Promise.all([this.l1.del(key), this.l2.del(key)]);
    return near || far;
  }
}
