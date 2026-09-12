import { Logger, Module } from '@dunx/core';
import {
  CacheMetrics,
  CacheModule as CacheLayer,
  MemoryCacheStore,
  RedisCacheStore,
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

/**
 * Hoisted rather than written inline, because the cache layer below names this
 * same object in its own `imports`. A dynamic module is its own scope keyed on
 * the reference, so calling `forRootAsync` twice would open two connections.
 *
 * No url, so Bun resolves $VALKEY_URL, $REDIS_URL, then localhost, lazily.
 * `maxRetries: 0` because on Bun 1.3.14 a failed connect with retries keeps a
 * timer alive past `close()`.
 */
const appRedis = RedisModule.forRootAsync(
  {
    useFactory: (config: AppConfigService) => {
      // `exactOptionalPropertyTypes` will not let `string | undefined` reach
      // a `url?: string`, even where `undefined` is ruled out.
      const { url } = config.get('redis');
      return {
        ...(url === undefined ? {} : { url }),
        connectionTimeout: 500,
        maxRetries: 0,
      };
    },
    inject: [AppConfigService] as const,
  },
  // No subclass: the default connection. Settings come last, as on `DbModule`.
  undefined,
  // Times every command, readable as `RedisMetrics`. Off by default.
  { metrics: true },
);

@Module({
  imports: [
    appRedis,
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
     * Two tiers when the broker answers, one when it does not. The probe is at
     * boot: `RedisCacheStore` writes on every miss, so an unreachable L2 would
     * turn each of them into a 500 rather than a slow read.
     */
    CacheLayer.forRootAsync(
      {
        imports: [appRedis],
        useFactory: async (redis: RedisConnection, logger: Logger) => {
          const l1 = new MemoryCacheStore({ max: 500 });
          const shared = {
            ttl: 30_000,
            // One prefix per deployment, not per process: a shared L2 that no
            // replica or restart can read is not shared. The example's own suites
            // set DUNX_CACHE_PREFIX so concurrent runs do not collide on one
            // valkey; an app that sets nothing gets a stable prefix.
            prefix: `${process.env['DUNX_CACHE_PREFIX'] ?? 'app'}:cache`,
          };
          try {
            await redis.ping();
            return {
              ...shared,
              store: new TieredCacheStore(l1, new RedisCacheStore(redis), {
                promoteTtl: 5_000,
              }),
            };
          } catch (error) {
            logger.warn(
              `cache running on memory alone: ${(error as Error).message}`,
            );
            return { ...shared, store: l1 };
          }
        },
        inject: [RedisConnection, Logger] as const,
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
    CacheMetrics,
    RedisConnection,
    RedisMetrics,
    SessionsRedis,
    Sessions,
    CatalogDemo,
  ],
})
export class CacheModule {}
