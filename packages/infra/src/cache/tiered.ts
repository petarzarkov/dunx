import { AppError } from '@dunx/core';
import { CacheStore } from './store.js';

export interface CacheLayerOptions {
  /** Whether this tier participates in reads, writes and deletes. @default true */
  readonly enabled?: boolean;
  /** Lifetime for writes to this tier, in milliseconds. */
  readonly ttl?: number;
}

export type LocalCacheOptions = CacheLayerOptions;

export type RemoteCacheOptions = CacheLayerOptions;

export interface TieredCacheOptions {
  /**
   * How long a value read out of L2 stays in L1 when local.ttl is omitted,
   * in milliseconds. L2 reports no remaining lifetime, so a promoted entry
   * gets this rather than what is left of the original.
   *
   * @default 30000
   */
  readonly ttl?: number;
  /** Settings for the process-local L1 tier. */
  readonly local?: LocalCacheOptions;
  /** Settings for the shared L2 tier. */
  readonly remote?: RemoteCacheOptions;
}

/**
 * L1 in front of L2. A hit in L1 answers without touching L2; a hit in L2 is
 * copied into L1 for `local.ttl`, falling back to `ttl`. A write goes to both,
 * a delete to both, unless a tier is disabled.
 *
 * A `del` on one node leaves every other node's L1 holding the old value until
 * its local lifetime expires. Configure `local.ttl` to bound this window.
 * Cross-process invalidation over pub/sub is not here: a subscribing
 * `Bun.RedisClient` holds the event loop open after `close()`, which would turn
 * every cache into a process that does not exit.
 */
export class TieredCacheStore extends CacheStore {
  readonly #ttl: number;
  readonly #localEnabled: boolean;
  readonly #remoteEnabled: boolean;
  readonly #localTtl: number | undefined;
  readonly #remoteTtl: number | undefined;
  /** How many L2 reads are in flight per key, and which were invalidated. */
  readonly #promoting = new Map<string, number>();
  readonly #superseded = new Set<string>();

  constructor(
    private readonly l1: CacheStore,
    private readonly l2: CacheStore,
    options: TieredCacheOptions = {},
  ) {
    super();
    this.#ttl = this.getTtl('ttl', options.ttl ?? 30_000);
    this.#localEnabled = options.local?.enabled ?? true;
    this.#remoteEnabled = options.remote?.enabled ?? true;
    this.#localTtl = this.getTtl('local', options.local?.ttl);
    this.#remoteTtl = this.getTtl('remote', options.remote?.ttl);
  }

  getTtl(name: string, ttl: number): number;
  getTtl(name: string, ttl: undefined): undefined;
  getTtl(name: string, ttl: number | undefined): number | undefined;
  getTtl(name: string, ttl?: number): number | undefined {
    if (ttl === undefined) return undefined;
    if (!Number.isFinite(ttl) || ttl <= 0) {
      throw new AppError(
        `Cache ${name} must be a positive number of milliseconds, got ${ttl}.`,
      );
    }
    return ttl;
  }

  async get<V = unknown>(key: string): Promise<V | undefined> {
    if (this.#localEnabled) {
      const near = await this.l1.get<V>(key);
      if (near !== undefined) return near;
    }
    if (!this.#remoteEnabled) return undefined;

    this.#promoting.set(key, (this.#promoting.get(key) ?? 0) + 1);
    try {
      const far = await this.l2.get<V>(key);
      if (far === undefined) return undefined;
      // A `del` or `set` landing while the L2 read was in flight has already
      // run. Promoting now would put the old value back into L1 and answer
      // from it until the local ttl expired, so the write is dropped instead.
      if (this.#superseded.has(key)) return undefined;
      if (this.#localEnabled) {
        await this.l1.set(key, far, this.#localTtl ?? this.#ttl);
      }
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
    if (this.#remoteEnabled) {
      await this.l2.set(key, value, this.#remoteTtl ?? ttl);
    }
    if (this.#localEnabled) {
      await this.l1.set(key, value, this.#localTtl ?? ttl);
    }
  }

  async del(key: string): Promise<boolean> {
    this.#supersede(key);
    const [near, far] = await Promise.all([
      this.#localEnabled ? this.l1.del(key) : Promise.resolve(false),
      this.#remoteEnabled ? this.l2.del(key) : Promise.resolve(false),
    ]);
    return near || far;
  }
}
