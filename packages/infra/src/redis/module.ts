import {
  provide,
  token,
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
import { RedisOptions, type RedisOptionsInit } from './options.js';

const tokens = new Map<string, Token<RedisConnection>>();

/**
 * The token a named connection is bound to. Memoised, since `token()` returns a
 * fresh object per call and the module and consumer would otherwise hold
 * different tokens for one name.
 *
 * A `Token` is not a constructor type, so reach it with `inject()`:
 *
 * ```ts
 * class Sessions {
 *   readonly redis = inject(redisConnection('sessions'));
 * }
 * ```
 */
export const redisConnection = (name: string): Token<RedisConnection> => {
  const existing = tokens.get(name);
  if (existing) return existing;
  const created = token<RedisConnection>(`RedisConnection(${name})`);
  tokens.set(name, created);
  return created;
};

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
) =>
  provide(target, {
    useFactory: (options: RedisOptions) =>
      new (ctor as new (options: RedisOptions) => RedisConnection)(options),
    inject: [optionsToken] as const,
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

  return {
    module: RedisModule,
    imports,
    exports: [optionsToken, connection],
    providers: [
      optionsProvider,
      connectionFrom(connection, optionsToken, ctor),
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
  ): DynamicModule {
    const options = new RedisOptions(init);
    const target = as ?? options.name;
    if (target !== undefined) return namedModule(target, options);

    return {
      module: RedisModule,
      exports: [RedisOptions, RedisConnection],
      providers: [
        provide(RedisOptions, { useValue: options }),
        connectionFrom(RedisConnection, RedisOptions),
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
  ): DynamicModule;
  static forRootAsync<const D extends Deps>(
    config: AsyncModuleConfig<RedisOptionsInit, D>,
    as?: ConnectionTarget,
  ): DynamicModule;
  static forRootAsync(
    source:
      | (() => RedisOptionsInit | Promise<RedisOptionsInit>)
      | AsyncModuleConfig<RedisOptionsInit, Deps>,
    as?: ConnectionTarget,
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
      return namedModule(as, { useFactory, inject }, imports);
    }

    return {
      module: RedisModule,
      imports,
      exports: [RedisOptions, RedisConnection],
      providers: [
        provide(RedisOptions, { useFactory, inject }),
        connectionFrom(RedisConnection, RedisOptions),
      ],
    };
  }
}
