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
 * better-auth's `secondaryStorage` over `Bun.RedisClient`, so sessions, verification
 * values and rate-limit counters live in Redis instead of costing a database round
 * trip on every request.
 *
 * All five methods are implemented, not the three that are mandatory.
 * `getAndDelete` and `increment` are optional in better-auth's interface because most
 * clients cannot do them atomically - `Bun.RedisClient` can, through `GETDEL` and
 * `INCR`, both already on `@dunx/infra/redis`'s contract. Without them better-auth
 * falls back to read-then-delete for single-use credentials, which is a race, and to
 * a non-atomic rate-limit counter.
 *
 * `increment`'s TTL applies on creation only, which is what makes the counter expire
 * a fixed window after the first hit rather than sliding forever: `INCR` returning
 * `1` is the signal that this call created the key.
 *
 * Redis being unreachable is deliberately **not** softened here. Bun's client
 * connects lazily and queues, so a command against a down server rejects and
 * better-auth's own error path is what should see it - a swallowed `null` from `get`
 * would read as "no session" and sign every user out.
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
