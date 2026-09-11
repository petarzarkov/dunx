import { AppError } from '@dunx/core';
import { CacheStore } from './store.js';

interface Entry {
  readonly value: unknown;
  readonly expiresAt: number;
}

export interface MemoryCacheInit {
  /** Entries held before the least recently used one is evicted. @default 10000 */
  readonly max?: number;
}

/**
 * L1: one `Map`, bounded, least-recently-used eviction. 100k entries measured
 * 16.1 MB, so `max` is what decides the footprint.
 *
 * Insertion order is the recency order - a read deletes and re-inserts, so the
 * first key the iterator yields is the coldest. Eviction walks from there and
 * stops at the cap, which charges one delete to the write that overflowed instead
 * of a full-Map pass.
 *
 * The value is stored by reference: a reader mutating what it got back mutates
 * what the next reader gets. `RedisCacheStore` round-trips through JSON and does
 * not, which is the one behaviour the two tiers do not share.
 */
export class MemoryCacheStore extends CacheStore {
  readonly #entries = new Map<string, Entry>();
  readonly #max: number;

  constructor(init: MemoryCacheInit = {}) {
    super();
    const max = init.max ?? 10_000;
    // `Math.max(1, NaN)` is `NaN`, and `size > NaN` is never true, so a
    // non-finite bound silently turns eviction off and the Map grows forever.
    if (!Number.isFinite(max)) {
      throw new AppError(
        `Cache max must be a finite number of entries, got ${String(max)}.`,
      );
    }
    this.#max = Math.max(1, max);
  }

  /** Live and expired entries alike, until one is touched. */
  get size(): number {
    return this.#entries.size;
  }

  get<V = unknown>(key: string): Promise<V | undefined> {
    const entry = this.#entries.get(key);
    if (entry === undefined) return Promise.resolve(undefined);
    this.#entries.delete(key);
    if (entry.expiresAt <= Date.now()) return Promise.resolve(undefined);
    this.#entries.set(key, entry);
    return Promise.resolve(entry.value as V);
  }

  set<V>(key: string, value: V, ttl: number): Promise<void> {
    this.#entries.delete(key);
    this.#entries.set(key, { value, expiresAt: Date.now() + ttl });
    if (this.#entries.size > this.#max) {
      for (const coldest of this.#entries.keys()) {
        this.#entries.delete(coldest);
        if (this.#entries.size <= this.#max) break;
      }
    }
    return Promise.resolve();
  }

  del(key: string): Promise<boolean> {
    return Promise.resolve(this.#entries.delete(key));
  }
}
