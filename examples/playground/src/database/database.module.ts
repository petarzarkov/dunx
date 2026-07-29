import { Module } from '@dunx/core';
import { DbModule, SqliteOptions } from '@dunx/infra/db';
import { Config } from '../config.js';
import { Ledger } from './ledger.service.js';

@Module({
  imports: [
    // `forRootAsync` is not a second mechanism: dunx settles every async factory
    // before the first constructor runs, so `Database` is open and its pragmas
    // applied by the time a repository is built.
    DbModule.forRootAsync({
      useFactory: (config: Config) =>
        new SqliteOptions({
          filename: config.databaseFile,
          // The only place a pragma can run before the first query.
          pragmas: ['foreign_keys = ON'],
        }),
      inject: [Config],
    }),
  ],
  providers: [Ledger],
})
export class DatabaseModule {}
