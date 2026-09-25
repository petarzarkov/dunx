import { Logger, Module } from '@dunx/core';
import {
  IdempotencyModule,
  MemoryIdempotencyStore,
  RedisIdempotencyStore,
} from '@dunx/http';
import { RedisConnection } from '@dunx/infra/redis';
import { CacheModule } from '../cache/cache.module.js';
import { Sessions } from '../cache/sessions.service.js';
import { AppConfigService } from '../config.js';

/**
 * `Idempotency-Key` for `POST /events/orders`. The store is picked at boot as
 * the rate limiter's is: this guard fails closed, so a Redis store with no Redis
 * would 503 every keyed transfer. No pid in the prefix, so a retry on another
 * replica finds the first one's record.
 */
@Module({
  imports: [
    CacheModule,
    IdempotencyModule.forRootAsync({
      imports: [CacheModule],
      useFactory: async (
        config: AppConfigService,
        redis: RedisConnection,
        sessions: Sessions,
        logger: Logger,
      ) => {
        const cache = await sessions.status();
        logger.info(
          cache.reachable
            ? `idempotency keys kept in redis at ${cache.url}`
            : `idempotency keys kept in memory: ${cache.url} is unreachable, ` +
                'so a retry on another replica runs again',
        );
        return {
          prefix: config.get('appName'),
          store: cache.reachable
            ? new RedisIdempotencyStore(redis)
            : new MemoryIdempotencyStore(),
          // `POST /events/orders` is not behind `SessionGuard`, so there is no
          // signed-in user to scope by: every caller shares one key space.
          subject: () => undefined,
        };
      },
      inject: [AppConfigService, RedisConnection, Sessions, Logger] as const,
    }),
  ],
})
export class IdempotencyKeysModule {}
