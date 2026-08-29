import { Redis } from '@dunx/infra/redis';

/**
 * A second Redis connection, separate from the general-purpose one, reachable as
 * a constructor parameter: `redisConnection('sessions')` returns a `Token`, which
 * can only be reached with `inject()` in a field. `cache.module.ts` binds it with
 * `RedisModule.forRootAsync(config, SessionsRedis)`.
 *
 * Splitting the session store off the cache is the reason to want a second one:
 * a `FLUSHDB` on the cache must not sign every user out.
 */
export class SessionsRedis extends Redis {}
