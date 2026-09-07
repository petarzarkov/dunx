import { Module } from '@dunx/core';
import { DashboardModule } from '@dunx/dashboard';
import { RequestMetrics } from '@dunx/http';
import { QueryMetrics } from '@dunx/infra/db';
import { JobPublisher } from '@dunx/infra/queue';
import { RedisConnection } from '@dunx/infra/redis';
import { AppConfigService } from '../config.js';
import { CacheModule } from '../cache/cache.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { AppIndicators } from '../health/indicators.js';
import { IndicatorsModule } from '../health/health.module.js';
import { JobsModule } from '../jobs/jobs.module.js';
import { DashboardDemo } from './dashboard.demo.js';

/**
 * The operations page at `/api/_dunx`. `forRootAsync` because everything shown
 * comes out of the container: `JobPublisher` satisfies `QueueSource` and
 * `RedisConnection` satisfies `RedisProbe`, with no adapter between them.
 *
 * `authorize` only when `DASHBOARD_TOKEN` is set, which it is not by default: the
 * page stays explorable with `bun start` and the package's boot warning is part
 * of the demonstration. Set the variable and a caller without the header gets
 * **404, not 403** - the mount does not admit it exists. It takes the raw
 * `Request` and runs before any guard, so it must be self-sufficient.
 */
@Module({
  imports: [
    DashboardModule.forRootAsync({
      // The dynamic module is its own scope, so what the factory injects is
      // imported here rather than on OpsModule.
      imports: [JobsModule, CacheModule, IndicatorsModule, DatabaseModule],
      useFactory: (
        queues: JobPublisher,
        redis: RedisConnection,
        config: AppConfigService,
        indicators: AppIndicators,
        stats: RequestMetrics,
        dbStats: QueryMetrics,
      ) => ({
        // Spelled out: the global prefix covers discovered routes, and this is
        // a middleware.
        path: '/api/_dunx',
        title: config.get('appName'),
        queues,
        // Nothing connects until the board is opened, so this still exits 0
        // against an absent Redis.
        queueNames: ['thumbnails'],
        redis,
        // The same checks `/api/health/ready` runs, declared once.
        probes: indicators.dashboardProbes,
        // `metrics: true` on HttpFactory.create and on DbModule is what puts
        // anything in these; without it the panel says so rather than lying.
        stats,
        dbStats,
        config,
        // Keys only, except two that are safe to read. Everything else stays
        // redacted, including the database url and every secret.
        reveal: (key: string) => key === 'appName' || key === 'port',
        // False on the public demo: the board is worth showing, mutating it is not.
        commands: config.get('dashboard').commands,
        openApiPath: '/api/docs',
        // Spread rather than `authorize: undefined`: `exactOptionalPropertyTypes`
        // separates an absent option from one explicitly undefined, and the
        // package's boot warning reads the difference.
        ...(config.get('dashboard.token') === undefined
          ? {}
          : {
              authorize: (req: Bun.BunRequest) =>
                req.headers.get('x-dashboard-token') ===
                config.get('dashboard.token'),
            }),
      }),
      inject: [
        JobPublisher,
        RedisConnection,
        AppConfigService,
        AppIndicators,
        RequestMetrics,
        QueryMetrics,
      ] as const,
    }),
  ],
  providers: [DashboardDemo],
  exports: [DashboardDemo],
})
export class OpsModule {}
