import { Module } from '@dunx/core';
import { DbModule, SqliteOptions } from '@dunx/infra/db';
import { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
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
    // The first argument is the token, unlike `forRoot`. drizzle's own database
    // class is what a repository injects, and which class that is only becomes
    // known once the factory has produced the options — too late to register a
    // provider under it.
    DbModule.forRootAsync(BunSQLiteDatabase, {
      useFactory: (config: AppConfigService) =>
        new SqliteOptions({
          // Required, and the reason it is: this is the type argument that reaches
          // `BunSQLiteDatabase<typeof schema>` in every constructor below.
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
})
export class DatabaseModule {}
