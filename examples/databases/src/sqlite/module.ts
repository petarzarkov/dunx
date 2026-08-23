import type { DynamicModule } from '@dunx/core';
import {
  DbModule,
  SqliteOptions,
  SyncDatabase,
  SyncSqliteOptions,
} from '@dunx/infra/db';
import { DatabasesConfigService } from '../config.js';
import * as schema from './schema.js';
import { SyncWidgets } from './widgets-sync.service.js';
import { Widgets } from './widgets.service.js';

/**
 * `bun:sqlite` through `drizzle-orm/bun-sqlite`. Sync and async are separate
 * factories because the mode decides which class the handle is bound under, and
 * a runtime flag would leave `DbModule.forRoot` a union to infer from. Import
 * one or the other: both bind `DbConnection`.
 */
export class SqliteModule {
  /** Asynchronous mode, binding drizzle's `BunSQLiteDatabase`. */
  static asynchronous(filename: string): DynamicModule {
    return {
      module: SqliteModule,
      imports: [
        DbModule.forRoot(
          new SqliteOptions({
            // Required: this is the type argument every constructor sees.
            schema,
            filename,
            pragmas: ['foreign_keys = ON'],
          }),
        ),
      ],
      providers: [Widgets],
    };
  }

  /**
   * Synchronous mode, binding `SyncDatabase` and reaching `transactionSync`.
   * `forRootAsync` takes the token first: the factory has not run yet, so the
   * options cannot supply it. No Postgres counterpart - a socket is not sync.
   */
  static synchronous(): DynamicModule {
    return {
      module: SqliteModule,
      imports: [
        DbModule.forRootAsync(SyncDatabase, {
          useFactory: (config: DatabasesConfigService) =>
            new SyncSqliteOptions({
              schema,
              filename: config.get('sqliteFile'),
              pragmas: ['foreign_keys = ON'],
            }),
          inject: [DatabasesConfigService],
        }),
      ],
      providers: [SyncWidgets],
    };
  }
}
