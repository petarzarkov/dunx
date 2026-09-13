import { Logger, Module } from '@dunx/core';
import { DegradingCacheStore, RedisCacheStore } from '@dunx/infra/cache';
import { RedisConnection } from '@dunx/infra/redis';
import { appRedis } from './app-redis.js';

/**
 * The shared tier, wrapped so an unreachable valkey costs a miss instead of a
 * 500. A class so the health check can reach it and call `probe()`. The L2 and
 * not the tier: `TieredCacheStore.set` awaits L2 first, so wrapping from
 * outside loses the L1 promotion.
 */
export class CacheL2 {
  readonly store: DegradingCacheStore;

  constructor(redis: RedisConnection, logger: Logger) {
    this.store = new DegradingCacheStore(new RedisCacheStore(redis), {
      logger,
    });
  }
}

@Module({
  imports: [appRedis],
  providers: [CacheL2],
  exports: [CacheL2],
})
export class CacheL2Module {}
