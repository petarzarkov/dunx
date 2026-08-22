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
 * A fixed-window rate limit over the whole app.
 *
 * **Which counter is decided at boot, by asking whether the cache answers.** A real
 * deployment names one outright: `RedisThrottleStore` for more than one replica,
 * because the in-process default lets each of them allow the full budget. This
 * example has to work with nothing installed, so it probes and says which it got.
 *
 * That probe is `Sessions.status()`, which `CacheModule` already exports rather than
 * a second ping written here.
 *
 * Falling back matters more than it looks. The guard fails **open**, so with
 * `RedisThrottleStore` and no Redis nothing is counted at all: no 429, no
 * `ratelimit-*` headers, every request through. That is the right call for a
 * production limiter, and it would make this example demonstrate nothing on a
 * machine without Redis.
 *
 * `RedisThrottleStore` takes its client structurally, so `RedisConnection` satisfies
 * it with no adapter.
 *
 * The prefix carries the pid, the same trick `Sessions` uses: two runs against one
 * Redis would otherwise spend each other's budget, and a leftover window would make
 * a suite fail on the previous run's counters.
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
           * Who is being counted. An API key when one is presented, else the
           * address - which is the shape a real app wants, where an authenticated
           * caller is limited by identity and an anonymous one by where it came
           * from. Only a guard ahead of this one knows which, which is why this is
           * an option rather than something the package reads for itself.
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
