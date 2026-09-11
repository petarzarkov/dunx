import { CacheStore } from './store.js';

/**
 * The three commands the L2 store needs, restated structurally rather than
 * imported. `RedisConnection` satisfies it, and so does a bare `Bun.RedisClient`,
 * without either being named here - the same split `ThrottleStore` and
 * `ThrottleRedis` take in `@dunx/http`.
 */
export interface CacheRedis {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    options?: { readonly px?: number },
  ): Promise<string | null>;
  del(key: string): Promise<number>;
}

/**
 * L2: `SET key value PX ttl`, `GET`, `DEL`, over a connection the app already
 * owns. It opens none of its own and closes none, so it cannot hold the event loop
 * open past shutdown.
 *
 * Values travel as JSON, so what comes back is a copy and anything
 * `JSON.stringify` drops - a `Date`, a `Map`, a function - comes back changed or
 * missing.
 */
export class RedisCacheStore extends CacheStore {
  constructor(private readonly redis: CacheRedis) {
    super();
  }

  async get<V = unknown>(key: string): Promise<V | undefined> {
    const raw = await this.redis.get(key);
    return raw === null ? undefined : (JSON.parse(raw) as V);
  }

  async set<V>(key: string, value: V, ttl: number): Promise<void> {
    const raw = JSON.stringify(value);
    // `JSON.stringify(undefined)` is `undefined`, and a stored `undefined` reads
    // back as a miss anyway, so it removes the key instead of writing "undefined".
    if (raw === undefined) {
      await this.redis.del(key);
      return;
    }
    await this.redis.set(key, raw, { px: Math.max(1, Math.round(ttl)) });
  }

  async del(key: string): Promise<boolean> {
    return (await this.redis.del(key)) > 0;
  }
}
