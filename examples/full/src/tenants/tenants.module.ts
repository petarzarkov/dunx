import { Module } from '@dunx/core';
import { DbModule, SyncDatabase, SyncSqliteOptions } from '@dunx/infra/db';
import { AppConfigService } from '../config.js';
import * as schema from './schema.js';
import { reportingDb, TenantSources } from './sources.js';
import { TenantsController } from './tenants.controller.js';
import { Tenants } from './tenants.service.js';

@Module({
  imports: [
    // A second static data source beside `DatabaseModule`'s. Named, so it binds
    // `dbHandle('reporting')` rather than claiming `SyncDatabase` twice.
    DbModule.forRootAsync(
      SyncDatabase<typeof schema>,
      {
        useFactory: (config: AppConfigService) =>
          new SyncSqliteOptions({
            schema,
            filename: config.get('tenants.reportingFile'),
          }),
        inject: [AppConfigService],
      },
      { name: 'reporting', metrics: true },
    ),
    // One database per tenant, opened on first use. `max` bounds how many live
    // at once and `idleMs` closes the ones nobody has asked for.
    DbModule.forDataSourcesAsync(
      {
        useFactory: (config: AppConfigService) => {
          const tenants = config.get('tenants');
          return {
            create: (key: string) =>
              new SyncSqliteOptions({
                schema,
                filename: tenants.file.replace('{tenant}', key),
              }),
            max: tenants.max,
            idleMs: tenants.idleMs,
          };
        },
        inject: [AppConfigService],
      },
      TenantSources,
      { metrics: true },
    ),
  ],
  controllers: [TenantsController],
  providers: [Tenants],
  exports: [Tenants, TenantSources, reportingDb],
})
export class TenantsModule {}
