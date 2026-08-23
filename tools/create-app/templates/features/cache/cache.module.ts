import { Module } from '@dunx/core';
import { RedisConnection, RedisModule } from '@dunx/infra/redis';
import { AppConfigService } from '../config.js';
import { CacheController } from './cache.controller.js';
import { Sessions } from './sessions.service.js';

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
  ],
  controllers: [CacheController],
  providers: [Sessions],
  // Re-exported so the chat gateway fans out through the same connection.
  exports: [RedisConnection, Sessions],
})
export class CacheModule {}
