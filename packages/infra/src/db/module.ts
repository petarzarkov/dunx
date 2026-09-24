import {
  Logger,
  provide,
  token,
  Tracer,
  type AbstractCtor,
  type AsyncModuleConfig,
  type Ctor,
  type Deps,
  type DynamicModule,
  type InjectionToken,
  type ModuleRef,
  type Registration,
  type Token,
} from '@dunx/core';
import { DbConnection, DbOptions } from './connection.js';
import { DataSources, type DataSourcesInit } from './data-sources.js';
import { instrumented } from './instrument.js';
import { QueryMetrics } from './metrics.js';
import { dbConnection, dbHandle, dbMetrics, dbOptions } from './tokens.js';

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
 * The four tokens one data source is reachable by. A default registration fills
 * them with `DbOptions`, `DbConnection`, drizzle's class and `QueryMetrics`; a
 * named one with the per-name tokens.
 */
interface Wiring<TDb> {
  readonly options: InjectionToken<DbOptions<TDb>>;
  readonly connection: InjectionToken<DbConnection<TDb>>;
  readonly handle: InjectionToken<TDb>;
  readonly metrics: InjectionToken<QueryMetrics> | undefined;
}

/**
 * One data source's wiring, whatever it is bound under. The handle depends on the
 * connection, which fixes the shutdown order: the connection is constructed first
 * and so closes last.
 */
const connectionModule = <TDb>(
  tokens: Wiring<TDb>,
  options: Registration,
  imports: readonly ModuleRef[],
): DynamicModule => ({
  module: DbModule,
  imports,
  exports: [
    tokens.options,
    tokens.connection,
    tokens.handle,
    ...(tokens.metrics === undefined ? [] : [tokens.metrics]),
  ],
  providers: [
    options,
    ...(tokens.metrics === undefined
      ? []
      : [provide(tokens.metrics, { useValue: new QueryMetrics() })]),
    // Branch on the call, not the argument: a union of provider shapes matches
    // neither `provide` overload.
    tokens.metrics === undefined
      ? provide(tokens.connection, {
          useFactory: (resolved: DbOptions<TDb>, tracer: Tracer) =>
            instrumented(resolved.open(), undefined, tracer),
          inject: [tokens.options, Tracer] as const,
        })
      : provide(tokens.connection, {
          useFactory: (
            resolved: DbOptions<TDb>,
            tracer: Tracer,
            metrics: QueryMetrics,
          ) => instrumented(resolved.open(), metrics, tracer),
          inject: [tokens.options, Tracer, tokens.metrics] as const,
        }),
    provide(tokens.handle, {
      useFactory: (opened: DbConnection<TDb>) => opened.db,
      inject: [tokens.connection] as const,
    }),
  ],
});

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
  const configured = options instanceof DbOptions;

  return connectionModule<TDb>(
    {
      options: optionsToken,
      connection: dbConnection<TDb>(name),
      handle: dbHandle<TDb>(name),
      metrics: metricsOn ? dbMetrics(name) : undefined,
    },
    configured
      ? provide(optionsToken, { useValue: options })
      : provide(optionsToken, options),
    configured ? [] : (options.imports ?? []),
  );
};

/** What `forDataSources` binds beyond the pool itself. */
export interface DataSourcesSettings {
  /**
   * Count and time every query across every data source the pool opens, through
   * one shared {@link QueryMetrics}. One histogram set per tenant would grow
   * without a bound; the pool's does not.
   */
  readonly metrics?: boolean;
  /**
   * What `dbMetrics(name)` resolves the pool's metrics under. Defaults to the
   * class name, which two pools can share: `class Tenants extends DataSources`
   * in two feature modules would then export one metrics token twice and the
   * importing scope would report a duplicate.
   */
  readonly name?: string;
  /** Modules the `create` factory's own dependencies come from. */
  readonly imports?: readonly ModuleRef[];
}

/**
 * The init's token, keyed by the class rather than its name: two subclasses may
 * share a name, and nothing exports this for a consumer to look up.
 */
const initTokens = new WeakMap<Ctor<DataSources<never>>, Token<unknown>>();

const dataSourcesInit = <TDb>(
  as: Ctor<DataSources<TDb>>,
): Token<DataSourcesInit<TDb>> => {
  const key = as as Ctor<DataSources<never>>;
  const existing = initTokens.get(key);
  if (existing !== undefined) return existing as Token<DataSourcesInit<TDb>>;
  const created = token<DataSourcesInit<TDb>>(`DataSourcesInit(${as.name})`);
  initTokens.set(key, created as Token<unknown>);
  return created;
};

const poolModule = <TDb>(
  target: Ctor<DataSources<TDb>>,
  init: Registration,
  initToken: Token<DataSourcesInit<TDb>>,
  settings: DataSourcesSettings,
): DynamicModule => {
  const metricsToken =
    settings.metrics === true
      ? dbMetrics(settings.name ?? target.name)
      : undefined;
  const construct = (
    resolved: DataSourcesInit<TDb>,
    logger: Logger,
    tracer: Tracer,
    metrics?: QueryMetrics,
  ): DataSources<TDb> =>
    new (target as new (
      init: DataSourcesInit<TDb>,
      logger?: Logger,
      metrics?: QueryMetrics,
      tracer?: Tracer,
    ) => DataSources<TDb>)(resolved, logger, metrics, tracer);

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
            useFactory: (
              resolved: DataSourcesInit<TDb>,
              logger: Logger,
              tracer: Tracer,
            ) => construct(resolved, logger, tracer),
            inject: [initToken, Logger, Tracer] as const,
          })
        : provide(target, {
            useFactory: (
              resolved: DataSourcesInit<TDb>,
              logger: Logger,
              tracer: Tracer,
              metrics: QueryMetrics,
            ) => construct(resolved, logger, tracer, metrics),
            inject: [initToken, Logger, Tracer, metricsToken] as const,
          }),
    ],
  };
};

/**
 * Binds three tokens: `DbOptions`, `DbConnection`, and drizzle's own database
 * class, which is what a repository injects. There is no wrapper. Every factory
 * settles before the first constructor runs, so there is no lazy connect.
 *
 * `{ metrics: true }` binds a fourth, {@link QueryMetrics}. `{ name }` moves all
 * of them onto per-name tokens, and {@link DbModule.forDataSources} registers
 * data sources whose keys are only known at runtime.
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
    // factory stay typed without a cast.
    const connection: AbstractCtor<DbConnection<TDb>> = DbConnection;

    return connectionModule<TDb>(
      {
        options: DbOptions,
        connection,
        handle: options.token,
        metrics: metricsOn ? QueryMetrics : undefined,
      },
      provide(DbOptions, { useValue: options }),
      [],
    );
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

    return connectionModule<TDb>(
      {
        options: configured,
        connection,
        handle: token,
        metrics: metricsOn ? QueryMetrics : undefined,
      },
      provide(configured, provider),
      provider.imports ?? [],
    );
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
