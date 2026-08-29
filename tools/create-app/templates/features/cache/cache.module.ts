import { Module } from '@dunx/core';
import {
  defaultRedisUrl,
  RedisConnection,
  RedisModule,
} from '@dunx/infra/redis';
import { AppConfigService } from '../config.js';
import { CacheController } from './cache.controller.js';
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
    // No url, so Bun resolves $VALKEY_URL, $REDIS_URL, then localhost.
    // Connections are lazy, so an unavailable cache cannot stop boot.
    //
    // `maxRetries: 0` because on Bun 1.3.14 a client that failed to connect with
    // `maxRetries > 0` keeps a retry timer alive after `close()` and never exits.
    RedisModule.forRootAsync({
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
    }),
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
  ],
  controllers: [CacheController],
  providers: [Sessions],
  // Re-exported so the chat gateway fans out through the same connection.
  exports: [RedisConnection, SessionsRedis, Sessions],
})
export class CacheModule {}
