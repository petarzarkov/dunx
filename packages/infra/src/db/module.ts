import {
  provide,
  type AbstractCtor,
  type Deps,
  type DynamicModule,
  type AsyncModuleConfig,
} from '@dunx/core';
import { DbConnection, DbOptions } from './connection.js';
import { QueryMetrics } from './metrics.js';

/**
 * Binds three tokens: `DbOptions` (the resolved configuration), `DbConnection`
 * (the lifecycle and raw driver handle), and drizzle's own database class, which
 * is what a repository injects. There is no wrapper.
 *
 * The handle is bound through a factory depending on `DbConnection`, which fixes
 * the shutdown order: the connection is constructed first and so closes last.
 * Every factory settles before the first constructor runs, so there is no lazy
 * connect and no `await db.ready()`.
 *
 * `{ metrics: true }` binds a fourth, {@link QueryMetrics}, and times every query
 * through it. Off by default, so an app that reads no numbers wraps no driver.
 */
export class DbModule {
  static forRoot<TDb>(
    options: DbOptions<TDb>,
    settings: DbModuleSettings = {},
  ): DynamicModule {
    // Instantiated to this configuration's handle type. The runtime value is the
    // same abstract class either way; the type argument is what lets the drizzle
    // factory below stay typed without a cast.
    const connection: AbstractCtor<DbConnection<TDb>> = DbConnection;

    return {
      module: DbModule,
      // The drizzle handle is what repositories inject, `DbConnection` is what a
      // health check or a migration runner needs, and `DbOptions` is how an app
      // reports which backend it is on. All three are public; nothing here is not.
      exports: [
        DbOptions,
        connection,
        options.token,
        ...(settings.metrics === true ? [QueryMetrics] : []),
      ],
      providers: [
        provide(DbOptions, { useValue: options }),
        ...(settings.metrics === true
          ? [
              provide(QueryMetrics, { useValue: new QueryMetrics() }),
              provide(connection, {
                useFactory: (metrics: QueryMetrics) =>
                  instrumented(options.open(), metrics),
                inject: [QueryMetrics] as const,
              }),
            ]
          : [provide(connection, { useFactory: () => options.open() })]),
        provide(options.token, {
          useFactory: (opened) => opened.db,
          inject: [connection],
        }),
      ],
    };
  }

  /**
   * The same `forRoot` with the options behind a factory that may await and
   * inject. `token` has to be passed, unlike in `forRoot`: which drizzle class is
   * the injection token is only known once the factory has produced the options.
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
    provider: AsyncModuleConfig<DbOptions<TDb>, D>,
    settings: DbModuleSettings = {},
  ): DynamicModule {
    const connection: AbstractCtor<DbConnection<TDb>> = DbConnection;
    const configured: AbstractCtor<DbOptions<TDb>> = DbOptions;

    return {
      module: DbModule,
      ...(provider.imports === undefined ? {} : { imports: provider.imports }),
      exports: [
        configured,
        connection,
        token,
        ...(settings.metrics === true ? [QueryMetrics] : []),
      ],
      providers: [
        provide(configured, provider),
        ...(settings.metrics === true
          ? [
              provide(QueryMetrics, { useValue: new QueryMetrics() }),
              provide(connection, {
                useFactory: (options: DbOptions<TDb>, metrics: QueryMetrics) =>
                  instrumented(options.open(), metrics),
                inject: [configured, QueryMetrics] as const,
              }),
            ]
          : [
              provide(connection, {
                useFactory: (options) => options.open(),
                inject: [configured],
              }),
            ]),
        provide(token, {
          useFactory: (opened) => opened.db,
          inject: [connection],
        }),
      ],
    };
  }
}

export interface DbModuleSettings {
  /**
   * Count and time every query, readable through {@link QueryMetrics}. Off by
   * default: on, the driver dunx constructs is wrapped, which costs two
   * `Bun.nanoseconds()` reads and a closure per query.
   */
  readonly metrics?: boolean;
}

/**
 * Instruments after `open()` rather than before `drizzle()`. `instrument` mutates
 * the client in place and drizzle looks `prepare`/`unsafe` up on it per query, so
 * a handle built earlier still goes through the timer - which keeps this out of
 * both connection constructors and both option classes.
 */
const instrumented = async <TDb>(
  opening: Promise<DbConnection<TDb>>,
  metrics: QueryMetrics,
): Promise<DbConnection<TDb>> => {
  const opened = await opening;
  // A `Bun.SQL` client is a **function** - it is callable as a tagged template -
  // so an `=== 'object'` guard skipped the whole Postgres backend.
  const raw: unknown = opened.raw;
  if ((typeof raw === 'object' && raw !== null) || typeof raw === 'function') {
    metrics.instrument(raw as object);
  }
  return opened;
};
