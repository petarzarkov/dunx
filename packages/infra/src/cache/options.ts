import { AppError } from '@dunx/core';
import { MemoryCacheStore } from './memory.js';
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

  constructor(init: CacheOptionsInit = {}) {
    const ttl = init.ttl ?? 60_000;
    if (!Number.isFinite(ttl) || ttl <= 0) {
      throw new AppError(
        `Cache ttl must be a positive number of milliseconds, got ${String(ttl)}.`,
      );
    }
    this.ttl = ttl;
    this.prefix = init.prefix;
    this.store = init.store ?? new MemoryCacheStore();
  }

  /** The key as the store sees it. */
  keyFor(key: string): string {
    return this.prefix === undefined ? key : `${this.prefix}:${key}`;
  }
}
