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
    // `forRootAsync` is not a second mechanism: dunx settles every async factory
    // before the first constructor runs, so the connection is open and its pragmas
    // applied by the time a repository is built.
    //
    // The first argument is the token, unlike `forRoot`. The database class is
    // what a repository injects, and which class that is only becomes known once
    // the factory has produced the options - too late to register a provider
    // under it.
    //
    // `SyncSqliteOptions` rather than `SqliteOptions`, so this app runs SQLite in
    // **synchronous mode**: the token becomes `SyncDatabase`, and `transactionSync`
    // becomes reachable. `SqliteOptions` is the default and still what an app
    // wants if it might move to Postgres later - sync mode is SQLite for good.
    DbModule.forRootAsync(SyncDatabase, {
      useFactory: (config: AppConfigService) =>
        new SyncSqliteOptions({
          // Required, and the reason it is: this is the type argument that reaches
          // `SyncDatabase<typeof schema>` in every constructor below.
          schema,
          filename: config.get('database').file,
          // The only place a pragma can run before the first query.
          pragmas: ['foreign_keys = ON'],
        }),
      inject: [AppConfigService],
    }),
  ],
  controllers: [LedgerController],
  providers: [Ledger],
  /**
   * The drizzle handle, re-exported so every feature module that imports this one can
   * inject it. `DbModule` exports it to *this* module; naming it again is what passes
   * it on, and it is why a repository declares `imports: [DatabaseModule]` rather than
   * reaching into `@dunx/infra/db` itself.
   */
  exports: [SyncDatabase, DbConnection, Ledger],
})
export class DatabaseModule {}
