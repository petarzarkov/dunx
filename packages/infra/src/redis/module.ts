import {
  namedToken,
  provide,
  token,
  Tracer,
  type Ctor,
  type Deps,
  type ModuleRef,
  type DynamicModule,
  type AsyncModuleConfig,
  type FactoryProvider,
  type Token,
} from '@dunx/core';
import { Redis } from './client.js';
import { RedisConnection } from './connection.js';
import { RedisMetrics } from './metrics.js';
import { RedisOptions, type RedisOptionsInit } from './options.js';

/**
 * The token a named connection is bound to. `namedToken` memoises it, so the
 * module and the consumer hold the same one for a given name.
 *
 * A `Token` is not a constructor type, so reach it with `inject()`:
 *
 * ```ts
 * class Sessions {
 *   readonly redis = inject(redisConnection('sessions'));
 * }
 * ```
 */
export const redisConnection = (name: string): Token<RedisConnection> =>
  namedToken(`RedisConnection(${name})`);

/**
 * `useFactory` rather than `useClass: Redis`. Either would work - declaring
 * `inject` here just makes the binding explicit and independent of the transform.
 *
 * A consumer's runtime plugin does skip `node_modules`, but that does not matter:
 * `scripts/build-package.ts` runs the same plugin over every package build, so
 * `dist/index.js` already carries the `Symbol.for('dunx.deps')` record for `Redis`.
 * A published package is transformed once, at its own build, not at the consumer's.
 */
/**
 * How a connection is addressed: a name, which binds a `Token`, or a subclass of
 * `Redis`, which binds the class itself.
 *
 * A subclass is both a token and a parameter type, so `constructor(private readonly
 * sessions: SessionsRedis)` resolves - which a `Token` can never do. Same treatment
 * `HttpModule` in `@dunx/http/client` gives a named outbound client.
 */
export type ConnectionTarget = string | Ctor<RedisConnection>;

export interface RedisModuleSettings {
  /**
   * Count and time every command, readable through {@link RedisMetrics}. Off by
   * default: on, each command pays two `Bun.nanoseconds()` reads and a histogram
   * record, and holds one histogram per verb seen, up to the cap.
   */
  readonly metrics?: boolean;
}

/**
 * The token a named connection's {@link RedisMetrics} is bound to. The default
 * connection binds the class itself;
 * a named one cannot, or two registrations would bind `RedisMetrics` twice and the
 * importer would silently see one of them.
 *
 * ```ts
 * class Sessions {
 *   readonly stats = inject(redisMetrics('SessionsRedis'));
 * }
 * ```
 */
export const redisMetrics = (name: string): Token<RedisMetrics> =>
  namedToken(`RedisMetrics(${name})`);

/** What `Redis` and any subclass of it is constructed with. */
type RedisCtor = new (
  options: RedisOptions,
  metrics?: RedisMetrics,
  tracer?: Tracer,
) => RedisConnection;

const connectionFrom = (
  // `typeof RedisConnection` is in the union separately: the contract is abstract,
  // so it is a valid token but not a `Ctor`, which is only ever the thing built.
  target:
    | Token<RedisConnection>
    | Ctor<RedisConnection>
    | typeof RedisConnection,
  optionsToken: Token<RedisOptions> | typeof RedisOptions,
  // The concrete class to construct. A subclass binds itself, so the instance has
  // to be one: `new Redis()` under a `SessionsRedis` token would fail every
  // `instanceof` and defeat the point of the subclass.
  ctor: Ctor<RedisConnection> = Redis,
  // Branch on the call, not the argument: a union of provider shapes matches
  // neither `provide` overload.
  metricsToken?: Token<RedisMetrics> | typeof RedisMetrics,
) =>
  metricsToken === undefined
    ? provide(target, {
        useFactory: (options: RedisOptions, tracer: Tracer) =>
          new (ctor as RedisCtor)(options, undefined, tracer),
        inject: [optionsToken, Tracer] as const,
      })
    : provide(target, {
        useFactory: (
          options: RedisOptions,
          tracer: Tracer,
          metrics: RedisMetrics,
        ) => new (ctor as RedisCtor)(options, metrics, tracer),
        inject: [optionsToken, Tracer, metricsToken] as const,
      });

/**
 * A named connection binds its own options token, so two of them do not collide
 * on `RedisOptions` - a scope reports a duplicate when it binds that class
 * twice.
 */
const namedModule = (
  target: ConnectionTarget,
  options: RedisOptions | FactoryProvider<RedisOptions, Deps>,
  imports: readonly ModuleRef[] = [],
  settings: RedisModuleSettings = {},
): DynamicModule => {
  const label = typeof target === 'string' ? target : target.name;
  const connection =
    typeof target === 'string' ? redisConnection(target) : target;
  const ctor = typeof target === 'string' ? Redis : target;
  const optionsToken = token<RedisOptions>(`RedisOptions(${label})`);
  // Branch on the call, not the argument: a union of provider shapes matches
  // neither `provide` overload.
  const optionsProvider =
    options instanceof RedisOptions
      ? provide(optionsToken, { useValue: options })
      : provide(optionsToken, options);
  const metricsToken =
    settings.metrics === true ? redisMetrics(label) : undefined;

  return {
    module: RedisModule,
    imports,
    exports: [
      optionsToken,
      connection,
      ...(metricsToken === undefined ? [] : [metricsToken]),
    ],
    providers: [
      optionsProvider,
      ...(metricsToken === undefined
        ? []
        : [provide(metricsToken, { useValue: new RedisMetrics() })]),
      connectionFrom(connection, optionsToken, ctor, metricsToken),
    ],
  };
};

export class RedisModule {
  /**
   * Binds `RedisConnection` and `RedisOptions` for the default connection, or
   * `redisConnection(init.name)` alone when `name` is set - a named registration
   * deliberately does not also claim `RedisConnection`, so several can coexist
   * alongside one default.
   */
  static forRoot(
    init: RedisOptionsInit = {},
    as?: Ctor<RedisConnection>,
    settings: RedisModuleSettings = {},
  ): DynamicModule {
    const options = new RedisOptions(init);
    const target = as ?? options.name;
    if (target !== undefined) return namedModule(target, options, [], settings);

    const metricsOn = settings.metrics === true;
    return {
      module: RedisModule,
      exports: [
        RedisOptions,
        RedisConnection,
        ...(metricsOn ? [RedisMetrics] : []),
      ],
      providers: [
        provide(RedisOptions, { useValue: options }),
        ...(metricsOn
          ? [provide(RedisMetrics, { useValue: new RedisMetrics() })]
          : []),
        connectionFrom(
          RedisConnection,
          RedisOptions,
          Redis,
          metricsOn ? RedisMetrics : undefined,
        ),
      ],
    };
  }

  /**
   * `forRoot` with the options behind a factory, which may inject:
   *
   * ```ts
   * RedisModule.forRootAsync({
   *   useFactory: (config: ConfigService<AppConfig>) => ({
   *     url: config.get('redis').url,
   *   }),
   *   inject: [ConfigService],
   * });
   * ```
   *
   * `name` is a parameter rather than a field of the init: the token has to exist
   * before the factory runs.
   */
  static forRootAsync(
    load: () => RedisOptionsInit | Promise<RedisOptionsInit>,
    as?: ConnectionTarget,
    settings?: RedisModuleSettings,
  ): DynamicModule;
  static forRootAsync<const D extends Deps>(
    config: AsyncModuleConfig<RedisOptionsInit, D>,
    as?: ConnectionTarget,
    settings?: RedisModuleSettings,
  ): DynamicModule;
  static forRootAsync(
    source:
      | (() => RedisOptionsInit | Promise<RedisOptionsInit>)
      | AsyncModuleConfig<RedisOptionsInit, Deps>,
    as?: ConnectionTarget,
    settings: RedisModuleSettings = {},
  ): DynamicModule {
    const load = typeof source === 'function' ? source : source.useFactory;
    const inject = typeof source === 'function' ? [] : (source.inject ?? []);
    // The container is scoped: this dynamic module is its own scope, so a factory
    // injecting a provider needs the module that exports it in *these* imports.
    // Importing it into whatever module calls forRootAsync does not reach here.
    const imports = typeof source === 'function' ? [] : (source.imports ?? []);
    const useFactory = async (
      ...deps: readonly unknown[]
    ): Promise<RedisOptions> => new RedisOptions(await load(...deps));

    if (as !== undefined) {
      return namedModule(as, { useFactory, inject }, imports, settings);
    }

    const metricsOn = settings.metrics === true;
    return {
      module: RedisModule,
      imports,
      exports: [
        RedisOptions,
        RedisConnection,
        ...(metricsOn ? [RedisMetrics] : []),
      ],
      providers: [
        provide(RedisOptions, { useFactory, inject }),
        ...(metricsOn
          ? [provide(RedisMetrics, { useValue: new RedisMetrics() })]
          : []),
        connectionFrom(
          RedisConnection,
          RedisOptions,
          Redis,
          metricsOn ? RedisMetrics : undefined,
        ),
      ],
    };
  }
}
