import { Redis } from '@dunx/infra/redis';

/**
 * A second Redis connection, separate from the general-purpose one, reachable as
 * a constructor parameter: `redisConnection('sessions')` returns a `Token`, which
 * can only be reached with `inject()` in a field. `cache.module.ts` binds it with
 * `RedisModule.forRootAsync(config, SessionsRedis)`.
 *
 * `cache.module.ts` binds it to database 1, which is what separates it.
 */
export class SessionsRedis extends Redis {}
