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
 * `bun:sqlite` through `drizzle-orm/bun-sqlite`.
 *
 * Two module factories, because the mode is the one thing that cannot be a runtime
 * flag: it decides which class the drizzle handle is bound under, and that is what
 * `DbModule.forRoot` infers the injection token from. A flag would leave that
 * inference with a union to guess at.
 *
 * Only one of the two may be imported at a time — the container is flat and throws
 * on a duplicate token, and both bind `DbConnection`.
 */
export class SqliteModule {
  /**
   * Asynchronous mode — the default, and what to pick if the app might move to
   * Postgres later, since every call is already awaited. The handle bound is
   * drizzle's `BunSQLiteDatabase`.
   *
   * `forRoot` takes the options object directly, because the token is knowable
   * from it before anything runs.
   */
  static asynchronous(filename: string): DynamicModule {
    return {
      module: SqliteModule,
      imports: [
        DbModule.forRoot(
          new SqliteOptions({
            // Required, and the reason it is: this is the type argument that
            // reaches `BunSQLiteDatabase<typeof schema>` in every constructor.
            schema,
            filename,
            // The only place a pragma can run before the first query.
            pragmas: ['foreign_keys = ON'],
          }),
        ),
      ],
      providers: [Widgets],
    };
  }

  /**
   * Synchronous mode. The handle is `SyncDatabase` and `transactionSync` becomes
   * reachable. Wired with `forRootAsync` so both styles appear once: the filename
   * comes off the validated config, which is the one thing a zero-argument
   * `forRoot` cannot reach.
   *
   * `forRootAsync` takes the token as its first argument, unlike `forRoot` — which
   * class the handle is bound under only becomes known once the factory has
   * produced the options, too late to register a provider under it.
   *
   * There is deliberately no Postgres counterpart. `Bun.SQL` talks to a server over
   * a socket, and nothing makes a socket synchronous.
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
