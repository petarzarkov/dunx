import type { BetterAuthOptions } from 'better-auth';

type SecondaryStorage = NonNullable<BetterAuthOptions['secondaryStorage']>;

/**
 * The six commands this needs, restated rather than imported from
 * `@dunx/infra/redis` - same reasoning as {@link DrizzleSource}. A `RedisConnection`
 * satisfies it structurally (its parameters are wider, which is the assignable
 * direction), and a test double is six methods instead of the whole surface.
 */
export interface RedisStore {
  get(key: string): Promise<string | null>;
  getdel(key: string): Promise<string | null>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<boolean>;
  set(
    key: string,
    value: string,
    options?: { readonly ex?: number },
  ): Promise<string | null>;
  del(key: string): Promise<number>;
}

/**
 * better-auth's `secondaryStorage` over `Bun.RedisClient`, so sessions and
 * rate-limit counters cost no database round trip.
 *
 * All five methods, not the three that are mandatory: `getAndDelete` and
 * `increment` are optional because most clients cannot do them atomically, and
 * `Bun.RedisClient` can through `GETDEL` and `INCR`. Without them better-auth
 * falls back to a read-then-delete race and a non-atomic counter.
 *
 * `increment`'s TTL applies on creation only, so the window is fixed from the
 * first hit. An unreachable Redis is not softened: a swallowed `null` would read
 * as "no session" and sign every user out.
 */
export const redisStorage = (connection: RedisStore): SecondaryStorage => ({
  get: (key) => connection.get(key),
  getAndDelete: (key) => connection.getdel(key),
  increment: async (key, ttl) => {
    const value = await connection.incr(key);
    if (value === 1) await connection.expire(key, ttl);
    return value;
  },
  set: (key, value, ttl) =>
    connection.set(key, value, ttl === undefined ? {} : { ex: ttl }),
  delete: async (key) => {
    await connection.del(key);
  },
});
