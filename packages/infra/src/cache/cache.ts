import { CacheOptions } from './options.js';

/**
 * The injected service. `get`, `set` and `del` are the store behind the
 * configured prefix; `wrap` is read-through with one load per key in flight.
 */
export class Cache {
  readonly #inflight = new Map<string, Promise<unknown>>();

  constructor(private readonly options: CacheOptions) {}

  get<V = unknown>(key: string): Promise<V | undefined> {
    return this.options.store.get<V>(this.options.keyFor(key));
  }

  /** `ttl` in milliseconds, defaulting to the module's. */
  set<V>(key: string, value: V, ttl?: number): Promise<void> {
    return this.options.store.set(
      this.options.keyFor(key),
      value,
      ttl ?? this.options.ttl,
    );
  }

  del(key: string): Promise<boolean> {
    return this.options.store.del(this.options.keyFor(key));
  }

  /**
   * The cached value, or `load()` stored and returned.
   *
   * Concurrent calls for one key share a single `load()`: the second caller
   * receives the first one's promise. Per process, so N replicas can still run N
   * loads. A `load()` returning `undefined` is not stored, and runs again next
   * call.
   */
  async wrap<V>(
    key: string,
    load: () => V | Promise<V>,
    ttl?: number,
  ): Promise<V> {
    const stored = this.options.keyFor(key);
    const running = this.#inflight.get(stored);
    if (running !== undefined) return (await running) as V;

    const started = this.#read(stored, load, ttl ?? this.options.ttl);
    this.#inflight.set(stored, started);
    try {
      return await started;
    } finally {
      // In `finally`: a rejection left in the map would be handed to every later
      // caller for the life of the process.
      this.#inflight.delete(stored);
    }
  }

  async #read<V>(
    stored: string,
    load: () => V | Promise<V>,
    ttl: number,
  ): Promise<V> {
    const hit = await this.options.store.get<V>(stored);
    if (hit !== undefined) return hit;
    const value = await load();
    if (value !== undefined) await this.options.store.set(stored, value, ttl);
    return value;
  }
}
