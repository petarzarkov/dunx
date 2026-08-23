import { Logger, Module } from '@dunx/core';
import {
  ClientAddress,
  MemoryThrottleStore,
  RedisThrottleStore,
  ThrottleModule,
} from '@dunx/http';
import { RedisConnection } from '@dunx/infra/redis';
import { CacheModule } from '../cache/cache.module.js';
import { Sessions } from '../cache/sessions.service.js';
import { AppConfigService } from '../config.js';
import { LimitsController } from './limits.controller.js';
import { ThrottleDemo } from './throttle.demo.js';

/**
 * A fixed-window rate limit over the whole app, picking its counter at boot by
 * asking whether the cache answers. A real deployment names one outright.
 *
 * The probe matters because the guard fails open: with `RedisThrottleStore` and
 * no Redis nothing is counted. The prefix carries the pid, so two runs against one
 * Redis cannot spend each other's budget.
 */
@Module({
  imports: [
    CacheModule,
    ThrottleModule.forRootAsync({
      imports: [CacheModule],
      useFactory: async (
        config: AppConfigService,
        redis: RedisConnection,
        address: ClientAddress,
        sessions: Sessions,
        logger: Logger,
      ) => {
        const cache = await sessions.status();
        logger.info(
          cache.reachable
            ? `rate limit counting in redis at ${cache.url}, shared by every replica`
            : `rate limit counting in memory: ${cache.url} is unreachable, so the ` +
                'budget is per process',
        );
        return {
          ...config.get('throttle'),
          prefix: `${config.get('appName')}:${process.pid}`,
          store: cache.reachable
            ? new RedisThrottleStore(redis)
            : new MemoryThrottleStore(),
          /**
           * Who is counted: an API key when presented, else the address. Only a
           * guard ahead of this one knows, so it is an option rather than
           * something the package reads for itself.
           */
          subject: (req: Bun.BunRequest) =>
            req.headers.get('x-api-key') ?? address.of(req),
        };
      },
      inject: [
        AppConfigService,
        RedisConnection,
        ClientAddress,
        Sessions,
        Logger,
      ] as const,
    }),
  ],
  controllers: [LimitsController],
  providers: [ThrottleDemo],
  exports: [ThrottleDemo],
})
export class LimitsModule {}
