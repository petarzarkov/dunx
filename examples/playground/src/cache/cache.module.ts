import { Module } from '@dunx/core';
import { RedisModule } from '@dunx/infra/redis';
import { AppConfigService } from '../config.js';
import { CacheController } from './cache.controller.js';
import { Sessions } from './sessions.service.js';

@Module({
  imports: [
    // Without a url Bun's own chain decides it — $VALKEY_URL, then $REDIS_URL,
    // then valkey://localhost:6379. Connections are lazy, so nothing is dialled
    // here and an unavailable cache cannot stop the process from booting.
    // `eager: true` would opt into finding out at startup, which is the opposite
    // of the point: the cache routes report themselves degraded instead.
    //
    // `maxRetries: 0` is not just impatience: measured on Bun 1.3.14, a client
    // that failed to connect with `maxRetries > 0` keeps a retry timer alive even
    // after `close()`, and the process never exits. With 0 it exits cleanly.
    RedisModule.forRootAsync({
      useFactory: (config: AppConfigService) => {
        // Destructured first: `exactOptionalPropertyTypes` will not let a
        // `string | undefined` reach a `url?: string`, even inside the branch
        // that has already ruled `undefined` out.
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
})
export class CacheModule {}
