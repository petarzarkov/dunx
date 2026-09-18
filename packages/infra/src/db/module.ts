import {
  Logger,
  provide,
  type AbstractCtor,
  type Ctor,
  type Deps,
  type DynamicModule,
  type AsyncModuleConfig,
  type ModuleRef,
  type Registration,
  type Token,
} from '@dunx/core';
import { DbConnection, DbOptions } from './connection.js';
import { DataSources, type DataSourcesInit } from './data-sources.js';
import { instrumented, QueryMetrics } from './metrics.js';
import {
  dbConnection,
  dbHandle,
  dbMetrics,
  dbOptions,
  namedToken,
} from './tokens.js';

/** The init's own token, one per pool class, so two pools do not collide. */
const dataSourcesInit = <TDb>(
  as: Ctor<DataSources<TDb>>,
): Token<DataSourcesInit<TDb>> => namedToken(`DataSourcesInit(${as.name})`);

export interface DbModuleSettings {
  /**
   * Count and time every query, readable through {@link QueryMetrics}. Off by
   * default: on, the driver dunx constructs is wrapped, which costs two
   * `Bun.nanoseconds()` reads and a closure per query.
   */
  readonly metrics?: boolean;
  /**
   * Register under `dbOptions(name)`, `dbConnection(name)` and `dbHandle(name)`
   * instead of under `DbOptions`, `DbConnection` and drizzle's own class, so
   * several data sources coexist alongside one default.
   */
  readonly name?: string;
}

/**
 * A named registration binds its own four tokens, so two of them collide on
 * none of `DbOptions`, `DbConnection`, drizzle's class or `QueryMetrics` - a
 * scope reports a duplicate when it binds one of those twice.
 */
const namedModule = <TDb>(
  name: string,
  options: DbOptions<TDb> | AsyncModuleConfig<DbOptions<TDb>, Deps>,
  metricsOn: boolean,
): DynamicModule => {
  const optionsToken = dbOptions<TDb>(name);
  const connectionToken = dbConnection<TDb>(name);
  const handleToken = dbHandle<TDb>(name);
  const metricsToken = metricsOn ? dbMetrics(name) : undefined;
  const configured = options instanceof DbOptions;
  const imports = configured ? [] : (options.imports ?? []);

  return {
    module: DbModule,
    imports,
    exports: [
      optionsToken,
      connectionToken,
      handleToken,
      ...(metricsToken === undefined ? [] : [metricsToken]),
    ],
    providers: [
      // Branch on the call, not the argument: a union of provider shapes matches
      // neither `provide` overload.
      configured
        ? provide(optionsToken, { useValue: options })
        : provide(optionsToken, options),
      ...(metricsToken === undefined
        ? []
        : [provide(metricsToken, { useValue: new QueryMetrics() })]),
      metricsToken === undefined
        ? provide(connectionToken, {
            useFactory: (resolved: DbOptions<TDb>) => resolved.open(),
            inject: [optionsToken] as const,
          })
        : provide(connectionToken, {
            useFactory: (resolved: DbOptions<TDb>, metrics: QueryMetrics) =>
              instrumented(resolved.open(), metrics),
            inject: [optionsToken, metricsToken] as const,
          }),
      provide(handleToken, {
        useFactory: (opened: DbConnection<TDb>) => opened.db,
        inject: [connectionToken] as const,
      }),
    ],
  };
};

/**
 * What `forDataSources` binds beyond the pool itself.
 */
export interface DataSourcesSettings {
  /**
   * Count and time every query across every data source the pool opens, through
   * one shared {@link QueryMetrics} bound under `dbMetrics(<class name>)`. One
   * histogram set per tenant would grow without a bound; the pool's does not.
   */
  readonly metrics?: boolean;
  /** Modules the `create` factory's own dependencies come from. */
  readonly imports?: readonly ModuleRef[];
}

const poolModule = <TDb>(
  target: Ctor<DataSources<TDb>>,
  init: Registration,
  initToken: Token<DataSourcesInit<TDb>>,
  settings: DataSourcesSettings,
): DynamicModule => {
  const metricsToken =
    settings.metrics === true ? dbMetrics(target.name) : undefined;
  const construct = (
    resolved: DataSourcesInit<TDb>,
    logger: Logger,
    metrics?: QueryMetrics,
  ): DataSources<TDb> =>
    new (target as new (
      init: DataSourcesInit<TDb>,
      logger?: Logger,
      metrics?: QueryMetrics,
    ) => DataSources<TDb>)(resolved, logger, metrics);

  return {
    module: DbModule,
    imports: settings.imports ?? [],
    exports: [target, ...(metricsToken === undefined ? [] : [metricsToken])],
    providers: [
      init,
      ...(metricsToken === undefined
        ? []
        : [provide(metricsToken, { useValue: new QueryMetrics() })]),
      metricsToken === undefined
        ? provide(target, {
            useFactory: (resolved: DataSourcesInit<TDb>, logger: Logger) =>
              construct(resolved, logger),
            inject: [initToken, Logger] as const,
          })
        : provide(target, {
            useFactory: (
              resolved: DataSourcesInit<TDb>,
              logger: Logger,
              metrics: QueryMetrics,
            ) => construct(resolved, logger, metrics),
            inject: [initToken, Logger, metricsToken] as const,
          }),
    ],
  };
};

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
 *
 * `{ name }` moves all of them onto per-name tokens, and
 * {@link DbModule.forDataSources} registers data sources whose keys are only
 * known at runtime.
 */
export class DbModule {
  static forRoot<TDb>(
    options: DbOptions<TDb>,
    settings: DbModuleSettings = {},
  ): DynamicModule {
    const metricsOn = settings.metrics === true;
    if (settings.name !== undefined) {
      return namedModule(settings.name, options, metricsOn);
    }
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
        ...(metricsOn ? [QueryMetrics] : []),
      ],
      providers: [
        provide(DbOptions, { useValue: options }),
        ...(metricsOn
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
   *
   * With `settings.name` set, `token` fixes what `dbHandle(name)` resolves to
   * rather than being the binding itself.
   */
  static forRootAsync<TDb, const D extends Deps>(
    token: AbstractCtor<TDb>,
    provider: AsyncModuleConfig<DbOptions<TDb>, D>,
    settings: DbModuleSettings = {},
  ): DynamicModule {
    const metricsOn = settings.metrics === true;
    if (settings.name !== undefined) {
      return namedModule<TDb>(
        settings.name,
        provider as AsyncModuleConfig<DbOptions<TDb>, Deps>,
        metricsOn,
      );
    }
    const connection: AbstractCtor<DbConnection<TDb>> = DbConnection;
    const configured: AbstractCtor<DbOptions<TDb>> = DbOptions;

    return {
      module: DbModule,
      ...(provider.imports === undefined ? {} : { imports: provider.imports }),
      exports: [
        configured,
        connection,
        token,
        ...(metricsOn ? [QueryMetrics] : []),
      ],
      providers: [
        provide(configured, provider),
        ...(metricsOn
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

  /**
   * Binds a {@link DataSources} pool, for data sources whose keys are only known
   * at runtime - a database per tenant. `as` is a subclass, which is what carries
   * the drizzle handle type through to the injection site:
   *
   * ```ts
   * export class Tenants extends DataSources<BunSQLDatabase<typeof schema>> {}
   *
   * DbModule.forDataSources(
   *   { create: (id) => new SqlOptions({ schema, url: urlFor(id) }), max: 32 },
   *   Tenants,
   * );
   * ```
   *
   * The pool is bound before anything that injects it, so core's reverse
   * construction order closes every live data source after its consumers drain.
   */
  static forDataSources<TDb>(
    init: DataSourcesInit<TDb>,
    as: Ctor<DataSources<TDb>>,
    settings: DataSourcesSettings = {},
  ): DynamicModule {
    const initToken = dataSourcesInit<TDb>(as);
    return poolModule(
      as,
      provide(initToken, { useValue: init }),
      initToken,
      settings,
    );
  }

  /**
   * `forDataSources` with the init behind a factory that may await and inject, so
   * `create` can read configuration:
   *
   * ```ts
   * DbModule.forDataSourcesAsync(
   *   {
   *     useFactory: (config: AppConfigService) => ({
   *       create: (id: string) =>
   *         new SqlOptions({ schema, url: `${config.get('tenants').base}/${id}` }),
   *     }),
   *     inject: [AppConfigService],
   *   },
   *   Tenants,
   * );
   * ```
   */
  static forDataSourcesAsync<TDb, const D extends Deps>(
    provider: AsyncModuleConfig<DataSourcesInit<TDb>, D>,
    as: Ctor<DataSources<TDb>>,
    settings: DataSourcesSettings = {},
  ): DynamicModule {
    const initToken = dataSourcesInit<TDb>(as);
    return poolModule(as, provide(initToken, provider), initToken, {
      ...settings,
      imports: settings.imports ?? provider.imports ?? [],
    });
  }
}
