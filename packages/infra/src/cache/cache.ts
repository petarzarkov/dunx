import { CacheOptions } from './options.js';

/**
 * The injected service. `get`, `set` and `del` are the store behind the
 * configured prefix; `wrap` is read-through with one load per key in flight.
 */
export class Cache {
  readonly #inflight = new Map<string, Promise<unknown>>();
  /** Keys written or dropped while a `wrap` was loading them. */
  readonly #superseded = new Set<string>();

  constructor(private readonly options: CacheOptions) {}

  get<V = unknown>(key: string): Promise<V | undefined> {
    return this.options.store.get<V>(this.options.keyFor(key));
  }

  /** `ttl` in milliseconds, defaulting to the module's. */
  set<V>(key: string, value: V, ttl?: number): Promise<void> {
    const stored = this.options.keyFor(key);
    this.#supersede(stored);
    return this.options.store.set(stored, value, ttl ?? this.options.ttl);
  }

  del(key: string): Promise<boolean> {
    const stored = this.options.keyFor(key);
    this.#supersede(stored);
    return this.options.store.del(stored);
  }

  /**
   * The cached value, or `load()` stored and returned.
   *
   * Concurrent calls for one key share a single `load()`: the second caller
   * receives the first one's promise. Per process, so N replicas can still run N
   * loads. A `load()` returning `undefined` is not stored, and runs again next
   * call.
   *
   * A `set` or `del` for the same key while `load()` is running wins: the loaded
   * value reaches the caller but is not stored, so a `del` cannot be undone by a
   * loader that started before it.
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
      this.#superseded.delete(stored);
    }
  }

  /** Bounded by the loads in flight, so it holds nothing between `wrap` calls. */
  #supersede(stored: string): void {
    if (this.#inflight.has(stored)) this.#superseded.add(stored);
  }

  async #read<V>(
    stored: string,
    load: () => V | Promise<V>,
    ttl: number,
  ): Promise<V> {
    const hit = await this.options.store.get<V>(stored);
    if (hit !== undefined) return hit;
    const value = await load();
    if (value !== undefined && !this.#superseded.has(stored)) {
      await this.options.store.set(stored, value, ttl);
    }
    return value;
  }
}
