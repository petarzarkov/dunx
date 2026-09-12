import { Durations, type HistogramSnapshot } from '@dunx/core';
import { CacheStore } from './store.js';

export const CacheOperation = Object.freeze({
  GET: 'get',
  SET: 'set',
  DEL: 'del',
} as const);
export type CacheOperation =
  (typeof CacheOperation)[keyof typeof CacheOperation];

/** What one operation did, which is what separates a hit rate from a count. */
export const CacheOutcome = Object.freeze({
  /** A `get` that answered with a value. */
  HIT: 'hit',
  /** A `get` that answered `undefined`, whether absent or expired. */
  MISS: 'miss',
  /** A `set` or a `del` that returned. Neither a hit nor a miss. */
  OK: 'ok',
  /** Any of the three, having rejected or thrown. */
  ERROR: 'error',
} as const);
export type CacheOutcome = (typeof CacheOutcome)[keyof typeof CacheOutcome];

export interface CacheOperationStats {
  readonly operation: CacheOperation;
  readonly count: number;
  /** Operations whose promise rejected, or which threw synchronously. */
  readonly errors: number;
  /** Nanoseconds. */
  readonly duration: HistogramSnapshot;
}

export interface CacheStatsReport {
  readonly operations: readonly CacheOperationStats[];
  readonly hits: number;
  readonly misses: number;
  /**
   * `hits / (hits + misses)`, and `0` before the first read. A `get` that threw
   * is in neither term: a broker that is down would otherwise read as a cache
   * that is missing.
   */
  readonly hitRate: number;
  /** Every operation, reads and writes together. */
  readonly total: number;
  readonly errors: number;
  readonly since: string;
}

interface Series {
  count: number;
  errors: number;
  readonly duration: Durations;
}

const series = (): Series => ({
  count: 0,
  errors: 0,
  duration: new Durations(),
});

/** Fixed, so a poll two minutes later lists the same rows in the same order. */
const ORDER: readonly CacheOperation[] = [
  CacheOperation.GET,
  CacheOperation.SET,
  CacheOperation.DEL,
];

/**
 * How the cache is behaving: hits against misses, and how long each operation
 * takes.
 *
 * Recorded at the `CacheStore` seam rather than on `Cache`, so a store injected
 * directly is counted too, and so `wrap`'s coalesced callers record the one read
 * that reached the store instead of one per caller.
 *
 * **The key is never kept.** `QueryMetrics` keeps a redacted statement shape for
 * its slowest query; the analogue here is a cache key, which is caller data with
 * no `redact()` that could be written for it. The same reasoning `RedisMetrics`
 * gives.
 *
 * Three operations and no caller-chosen label, so there is nothing to cap: the
 * series count is three.
 *
 * Bound only when `metrics: true`.
 */
export class CacheMetrics {
  readonly #series = new Map<CacheOperation, Series>();
  #hits = 0;
  #misses = 0;
  #total = 0;
  #errors = 0;
  #since = new Date();

  observe(
    operation: CacheOperation,
    durationNs: number,
    outcome: CacheOutcome = CacheOutcome.OK,
  ): void {
    let stats = this.#series.get(operation);
    if (stats === undefined) {
      stats = series();
      this.#series.set(operation, stats);
    }
    this.#total += 1;
    stats.count += 1;
    if (outcome === CacheOutcome.ERROR) {
      this.#errors += 1;
      stats.errors += 1;
    } else if (outcome === CacheOutcome.HIT) {
      this.#hits += 1;
    } else if (outcome === CacheOutcome.MISS) {
      this.#misses += 1;
    }
    stats.duration.record(durationNs);
  }

  snapshot(): CacheStatsReport {
    const operations: CacheOperationStats[] = [];
    for (const operation of ORDER) {
      const stats = this.#series.get(operation);
      if (stats === undefined) continue;
      operations.push({
        operation,
        count: stats.count,
        errors: stats.errors,
        duration: stats.duration.snapshot(),
      });
    }
    const reads = this.#hits + this.#misses;
    return {
      operations,
      hits: this.#hits,
      misses: this.#misses,
      hitRate: reads === 0 ? 0 : this.#hits / reads,
      total: this.#total,
      errors: this.#errors,
      since: this.#since.toISOString(),
    };
  }

  reset(): void {
    this.#series.clear();
    this.#hits = 0;
    this.#misses = 0;
    this.#total = 0;
    this.#errors = 0;
    this.#since = new Date();
  }
}

/**
 * A `CacheStore` that times the one it wraps and reports into a
 * {@link CacheMetrics}.
 *
 * `CacheModule.forRoot(init, { metrics: true })` puts one around the configured
 * store, so nothing has to be assembled by hand for the common case.
 *
 * Wrapping a `TieredCacheStore` counts the logical operation: an L2 hit promoted
 * into L1 is one `get` and one hit, and the L1 write behind it is not a `set`.
 * Wrap a tier to see that split, with a `CacheMetrics` of its own.
 *
 * **`metrics: true` changes what `CacheStore` resolves to**, since this is what
 * sits in front of the configured store. An `instanceof TieredCacheStore` on
 * `CacheOptions.store` stops matching the moment metrics go on, which is why
 * {@link MeteredCacheStore.inner} is public: reach through it for an identity or
 * an `instanceof` check.
 */
export class MeteredCacheStore extends CacheStore {
  constructor(
    /** The store being timed, so a caller can reach what it configured. */
    readonly inner: CacheStore,
    private readonly metrics: CacheMetrics,
  ) {
    super();
  }

  async get<V = unknown>(key: string): Promise<V | undefined> {
    const started = Bun.nanoseconds();
    try {
      const value = await this.inner.get<V>(key);
      this.metrics.observe(
        CacheOperation.GET,
        Bun.nanoseconds() - started,
        value === undefined ? CacheOutcome.MISS : CacheOutcome.HIT,
      );
      return value;
    } catch (error) {
      this.metrics.observe(
        CacheOperation.GET,
        Bun.nanoseconds() - started,
        CacheOutcome.ERROR,
      );
      throw error;
    }
  }

  async set<V>(key: string, value: V, ttl: number): Promise<void> {
    const started = Bun.nanoseconds();
    try {
      await this.inner.set(key, value, ttl);
      this.metrics.observe(CacheOperation.SET, Bun.nanoseconds() - started);
    } catch (error) {
      this.metrics.observe(
        CacheOperation.SET,
        Bun.nanoseconds() - started,
        CacheOutcome.ERROR,
      );
      throw error;
    }
  }

  async del(key: string): Promise<boolean> {
    const started = Bun.nanoseconds();
    try {
      const removed = await this.inner.del(key);
      this.metrics.observe(CacheOperation.DEL, Bun.nanoseconds() - started);
      return removed;
    } catch (error) {
      this.metrics.observe(
        CacheOperation.DEL,
        Bun.nanoseconds() - started,
        CacheOutcome.ERROR,
      );
      throw error;
    }
  }
}
