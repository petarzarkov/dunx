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
 * Its own module because `HealthModule.forRootAsync` registers in its own scope,
 * so a factory injecting `AppIndicators` must name where it comes from - and
 * pointing that back at `ProbesModule` would be a cycle.
 */
@Module({
  imports: [DatabaseModule, CacheModule, WorkspaceModule],
  providers: [
    provide(AppIndicators, {
      // `Workspace.create()` is idempotent, so this is the directory
      // `FilesModule` already made.
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
 * Mounts `/api/health/live` and `/api/health/ready`, both `@Public()` and hidden
 * from the document. No indicator for the in-process packages: a check that
 * cannot fail tells an operator nothing.
 */
@Module({
  imports: [
    IndicatorsModule,
    HealthModule.forRootAsync({
      imports: [IndicatorsModule],
      useFactory: (indicators: AppIndicators) => ({
        readiness: indicators.readiness,
        liveness: indicators.liveness,
        // A real deployment tunes these so a load balancer sees readiness fail
        // before the socket closes.
        drainDelayMs: 250,
      }),
      inject: [AppIndicators] as const,
    }),
  ],
  providers: [HealthDemo],
  exports: [AppIndicators, HealthDemo],
})
export class ProbesModule {}
