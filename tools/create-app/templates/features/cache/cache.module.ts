import { Module } from '@dunx/core';
import {
  CacheMetrics,
  CacheModule as CacheLayer,
  MemoryCacheStore,
  TieredCacheStore,
} from '@dunx/infra/cache';
import {
  defaultRedisUrl,
  RedisConnection,
  RedisMetrics,
  RedisModule,
} from '@dunx/infra/redis';
import { AppConfigService } from '../config.js';
import { CacheController } from './cache.controller.js';
import { appRedis } from './app-redis.js';
import { CacheL2, CacheL2Module } from './cache-l2.js';
import { CatalogController } from './catalog.controller.js';
import { CatalogDemo } from './catalog.demo.js';
import { Catalog } from './catalog.service.js';
import { SessionsRedis } from './sessions.redis.js';
import { Sessions } from './sessions.service.js';

/** The configured server, database 1. A path already on the url is replaced. */
const sessionsUrl = (url: string | undefined): string => {
  const parsed = new URL(url ?? defaultRedisUrl());
  parsed.pathname = '/1';
  return parsed.href;
};

@Module({
  imports: [
    appRedis,
    // In this scope too: exporting `CacheL2` needs it visible from here.
    CacheL2Module,
    /**
     * A subclass rather than a name, so `SessionsRedis` is an ordinary
     * constructor parameter, and it does not claim `RedisConnection`. Database 1:
     * separate clients do not isolate what a `FLUSHDB` reaches, so a shared
     * database would mean flushing the cache signed every user out.
     */
    RedisModule.forRootAsync(
      {
        useFactory: (config: AppConfigService) => ({
          url: sessionsUrl(config.get('redis').url),
          connectionTimeout: 500,
          maxRetries: 0,
        }),
        inject: [AppConfigService] as const,
      },
      SessionsRedis,
    ),
    /**
     * Two tiers, always. `CacheL2` is the degrading half, so a cold read costs
     * the loader rather than a 500. It replaced a boot-time `redis.ping()` that
     * chose one tier or two and could not see a valkey lost after boot.
     */
    CacheLayer.forRootAsync(
      {
        imports: [CacheL2Module],
        useFactory: (l2: CacheL2) => ({
          ttl: 30_000,
          // One prefix per deployment, not per process: a shared L2 that no
          // replica or restart can read is not shared. The example's own suites
          // set DUNX_CACHE_PREFIX so concurrent runs do not collide on one
          // valkey; an app that sets nothing gets a stable prefix.
          prefix: `${process.env['DUNX_CACHE_PREFIX'] ?? 'app'}:cache`,
          store: new TieredCacheStore(
            new MemoryCacheStore({ max: 500 }),
            l2.store,
            { promoteTtl: 5_000 },
          ),
        }),
        inject: [CacheL2] as const,
      },
      // Wraps the configured store, so hits, misses and timings are readable as
      // `CacheMetrics`. Settings come last here too.
      { metrics: true },
    ),
  ],
  controllers: [CacheController, CatalogController],
  providers: [Sessions, Catalog, CatalogDemo],
  // Re-exported so the chat gateway fans out through the same connection.
  exports: [
    CacheL2,
    CacheMetrics,
    RedisConnection,
    RedisMetrics,
    SessionsRedis,
    Sessions,
    CatalogDemo,
  ],
})
export class CacheModule {}
