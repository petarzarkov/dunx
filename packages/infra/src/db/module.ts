import {
  provide,
  type AbstractCtor,
  type Deps,
  type DynamicModule,
  type FactoryProvider,
} from '@dunx/core';
import { DbConnection, DbOptions } from './connection.js';

/**
 * Binds three tokens:
 *
 * - `DbOptions` — the resolved configuration, so anything can read the dialect.
 * - `DbConnection` — the lifecycle and the raw driver handle.
 * - drizzle's own database class — `BunSQLiteDatabase` or `BunSQLDatabase` — which
 *   is what a repository injects. There is no wrapper: drizzle is the interface.
 *
 * The drizzle handle is bound through a factory that depends on `DbConnection`,
 * which is what fixes the shutdown order. dunx tears down in reverse construction
 * order, so the connection — constructed first, because everything else needs it —
 * closes last, after every repository has drained.
 *
 * Every factory settles before the first constructor runs, so the connection is
 * open and handshaked before any repository is built. No lazy connect, no
 * `await db.ready()`.
 */
export class DbModule {
  static forRoot<TDb>(options: DbOptions<TDb>): DynamicModule {
    // Instantiated to this configuration's handle type. The runtime value is the
    // same abstract class either way; the type argument is what lets the drizzle
    // factory below stay typed without a cast.
    const connection: AbstractCtor<DbConnection<TDb>> = DbConnection;

    return {
      module: DbModule,
      providers: [
        provide(DbOptions, { useValue: options }),
        provide(connection, { useFactory: () => options.open() }),
        provide(options.token, {
          useFactory: (opened) => opened.db,
          inject: [connection],
        }),
      ],
    };
  }

  /**
   * The same `forRoot`, with the options produced by a factory that may await and
   * may inject — for when the URL comes from a secret store or a `Config`.
   *
   * `token` has to be passed, unlike in `forRoot`. drizzle's database class is the
   * injection token, and which class that is only becomes known once the factory
   * has produced the options — too late to register a provider under it:
   *
   * ```ts
   * DbModule.forRootAsync(BunSQLiteDatabase, {
   *   useFactory: (config: Config) =>
   *     new SqliteOptions({ schema, filename: config.databaseFile }),
   *   inject: [Config],
   * });
   * ```
   */
  static forRootAsync<TDb, const D extends Deps>(
    token: AbstractCtor<TDb>,
    provider: FactoryProvider<DbOptions<TDb>, D>,
  ): DynamicModule {
    const connection: AbstractCtor<DbConnection<TDb>> = DbConnection;
    const configured: AbstractCtor<DbOptions<TDb>> = DbOptions;

    return {
      module: DbModule,
      providers: [
        provide(configured, provider),
        provide(connection, {
          useFactory: (options) => options.open(),
          inject: [configured],
        }),
        provide(token, {
          useFactory: (opened) => opened.db,
          inject: [connection],
        }),
      ],
    };
  }
}
