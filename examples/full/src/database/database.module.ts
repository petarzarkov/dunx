import { Module } from '@dunx/core';
import {
  DbConnection,
  DbModule,
  SyncDatabase,
  SyncSqliteOptions,
} from '@dunx/infra/db';
import { AppConfigService } from '../config.js';
import { LedgerController } from './ledger.controller.js';
import { Ledger } from './ledger.service.js';
import * as schema from './schema.js';

@Module({
  imports: [
    // The token comes first, unlike `forRoot`: which class a repository injects
    // is only known once the factory has produced the options.
    //
    // `SyncSqliteOptions` runs SQLite in synchronous mode, so the token is
    // `SyncDatabase` and `transactionSync` is reachable. `SqliteOptions` is the
    // default and what an app wants if it might move to Postgres.
    DbModule.forRootAsync(SyncDatabase, {
      useFactory: (config: AppConfigService) =>
        new SyncSqliteOptions({
          // Required: the type argument every constructor below sees.
          schema,
          // A dotted path, checked against AppConfig the same way a top-level
          // key is. `config.get('database').file` still reads the same value.
          filename: config.get('database.file'),
          pragmas: ['foreign_keys = ON'],
        }),
      inject: [AppConfigService],
    }),
  ],
  controllers: [LedgerController],
  providers: [Ledger],
  /**
   * Re-exported so importers can inject it. `DbModule` exports to this module
   * only; naming it again passes it on.
   */
  exports: [SyncDatabase, DbConnection, Ledger],
})
export class DatabaseModule {}
