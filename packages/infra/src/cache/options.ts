import { AppError } from '@dunx/core';
import { MemoryCacheStore } from './memory.js';
import { MeteredCacheStore, type CacheMetrics } from './metrics.js';
import type { CacheStore } from './store.js';

export interface CacheOptionsInit {
  /** Lifetime in milliseconds for a write that names none. @default 60000 */
  readonly ttl?: number;
  /** Prepended to every key with a `:`, so two apps can share one Redis. */
  readonly prefix?: string;
  /** @default new MemoryCacheStore() */
  readonly store?: CacheStore;
}

/**
 * A class, not an interface, so it is a runtime value `@dunx/transform` can record
 * as a constructor parameter type.
 */
export class CacheOptions {
  readonly ttl: number;
  readonly prefix: string | undefined;
  readonly store: CacheStore;

  /**
   * `metrics` wraps whatever store this resolves to, the default one included, so
   * `store` is the metered one everywhere it is read from. `CacheModule` passes
   * it when `metrics: true`; nothing else needs to.
   */
  constructor(init: CacheOptionsInit = {}, metrics?: CacheMetrics) {
    const ttl = init.ttl ?? 60_000;
    if (!Number.isFinite(ttl) || ttl <= 0) {
      throw new AppError(
        `Cache ttl must be a positive number of milliseconds, got ${String(ttl)}.`,
      );
    }
    this.ttl = ttl;
    this.prefix = init.prefix;
    const store = init.store ?? new MemoryCacheStore();
    this.store =
      metrics === undefined ? store : new MeteredCacheStore(store, metrics);
  }

  /** The key as the store sees it. */
  keyFor(key: string): string {
    return this.prefix === undefined ? key : `${this.prefix}:${key}`;
  }
}
