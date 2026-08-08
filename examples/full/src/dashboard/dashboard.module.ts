import { Module } from '@dunx/core';
import { DashboardModule } from '@dunx/dashboard';
import { JobPublisher } from '@dunx/infra/queue';
import { RedisConnection } from '@dunx/infra/redis';
import { AppConfigService } from '../config.js';
import { CacheModule } from '../cache/cache.module.js';
import { JobsModule } from '../jobs/jobs.module.js';
import { DashboardDemo } from './dashboard.demo.js';

/**
 * The operations page, at `/api/_dunx`.
 *
 * `forRootAsync` rather than `forRoot`, because everything worth showing comes out
 * of the container: `JobPublisher` satisfies `QueueSource` as written, and
 * `RedisConnection` satisfies `RedisProbe`. No adapter between them - `@dunx/dashboard`
 * depends on `@dunx/infra` not at all and restates both shapes structurally.
 *
 * **There is deliberately no `authorize`**, so `bun start` opens the page with no
 * header to set and the example is actually explorable. That is precisely what the
 * package warns about at boot, and the warning is part of what this demonstrates:
 * the page is routes plus config plus the provider graph on one screen, so a real
 * service states an `authorize` either way rather than leaving it to a default.
 *
 * When you do write one, it gets the raw `Request` and runs **before** any guard,
 * so it has to be self-sufficient - asking better-auth directly rather than reading
 * an `AuthContext` a later middleware would have written.
 */
@Module({
  imports: [
    DashboardModule.forRootAsync({
      // The dynamic module is its own scope, so the modules exporting what the
      // factory injects go here rather than on OpsModule below.
      imports: [JobsModule, CacheModule],
      useFactory: (
        queues: JobPublisher,
        redis: RedisConnection,
        config: AppConfigService,
      ) => ({
        // Spelled out, because `app.setGlobalPrefix('api')` prefixes discovered
        // routes and the dashboard is a middleware rather than one of those.
        path: '/api/_dunx',
        title: config.get('appName'),
        queues,
        // The thumbnail queue is drained by `bun run worker`, a separate process.
        // Naming it here is free: nothing opens a connection until somebody
        // actually opens the board, which is what lets this example still exit 0
        // against an absent Redis.
        queueNames: ['thumbnails'],
        redis,
        config,
        // Keys only, except the two that are safe to read and genuinely useful
        // when someone asks "which environment is this". Everything else -
        // including the database url and every auth secret - stays redacted.
        reveal: (key: string) => key === 'appName' || key === 'port',
        openApiPath: '/api/docs',
      }),
      inject: [JobPublisher, RedisConnection, AppConfigService] as const,
    }),
  ],
  providers: [DashboardDemo],
  exports: [DashboardDemo],
})
export class OpsModule {}
