import { Module, provide } from '@dunx/core';
import { HealthModule } from '@dunx/http';
import { DbConnection } from '@dunx/infra/db';
import { RedisConnection } from '@dunx/infra/redis';
import { CacheModule } from '../cache/cache.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { Ledger } from '../database/ledger.service.js';
import { WorkspaceModule } from '../storage/storage.module.js';
import { Workspace } from '../storage/workspace.js';
import { HealthDemo } from './health.demo.js';
import { AppIndicators } from './indicators.js';

/**
 * The indicators, in a module of their own for the reason `WorkspaceModule` is:
 * `HealthModule.forRootAsync` registers its provider in its own scope, so a factory
 * injecting `AppIndicators` has to name the module it comes from - and pointing that
 * back at `ProbesModule` would be a cycle.
 *
 * A health check is still the feature that imports the most, so this list is an
 * accurate statement of what it touches.
 */
@Module({
  imports: [DatabaseModule, CacheModule, WorkspaceModule],
  providers: [
    provide(AppIndicators, {
      // Async because the upload root is: `Workspace.create()` is idempotent, so
      // this is the directory `FilesModule` already made rather than a second one.
      useFactory: async (
        db: DbConnection,
        redis: RedisConnection,
        ledger: Ledger,
        workspace: Workspace,
      ) =>
        new AppIndicators({
          db,
          redis,
          ledger,
          uploadRoot: await workspace.create(),
        }),
      inject: [DbConnection, RedisConnection, Ledger, Workspace] as const,
    }),
  ],
  exports: [AppIndicators],
})
export class IndicatorsModule {}

/**
 * `HealthModule` from `@dunx/http`, which mounts `/api/health/live` and
 * `/api/health/ready`. Both are `@Public()` and hidden from the OpenAPI document:
 * a probe carries no credentials and is not an API a consumer calls.
 *
 * There is no indicator for `@dunx/infra/files` or `@dunx/infra/images`. Both are
 * in-process, so "it booted" is already answered by the port answering at all, and
 * a check that cannot fail tells an operator nothing.
 */
@Module({
  imports: [
    IndicatorsModule,
    HealthModule.forRootAsync({
      imports: [IndicatorsModule],
      useFactory: (indicators: AppIndicators) => ({
        readiness: indicators.readiness,
        liveness: indicators.liveness,
        // A real deployment sets a few probe intervals here, so a load balancer
        // sees readiness fail before the socket closes. Short enough that
        // `bun run tour` and the suites are not waiting on it.
        drainDelayMs: 250,
      }),
      inject: [AppIndicators] as const,
    }),
  ],
  providers: [HealthDemo],
  exports: [AppIndicators, HealthDemo],
})
export class ProbesModule {}
