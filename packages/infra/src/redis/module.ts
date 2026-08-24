import {
  provide,
  token,
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
const connectionFrom = (
  target: Token<RedisConnection> | typeof RedisConnection,
  optionsToken: Token<RedisOptions> | typeof RedisOptions,
) =>
  provide(target, {
    useFactory: (options: RedisOptions) => new Redis(options),
    inject: [optionsToken] as const,
  });

/**
 * A named connection binds its own options token, so two of them do not collide
 * on `RedisOptions` - the flat container reports that as a duplicate binding.
 */
const namedModule = (
  name: string,
  options: RedisOptions | FactoryProvider<RedisOptions, Deps>,
  imports: readonly ModuleRef[] = [],
): DynamicModule => {
  const optionsToken = token<RedisOptions>(`RedisOptions(${name})`);
  // Branch on the call, not the argument: a union of provider shapes matches
  // neither `provide` overload.
  const optionsProvider =
    options instanceof RedisOptions
      ? provide(optionsToken, { useValue: options })
      : provide(optionsToken, options);

  return {
    module: RedisModule,
    imports,
    exports: [optionsToken, redisConnection(name)],
    providers: [
      optionsProvider,
      connectionFrom(redisConnection(name), optionsToken),
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
  static forRoot(init: RedisOptionsInit = {}): DynamicModule {
    const options = new RedisOptions(init);
    if (options.name !== undefined) return namedModule(options.name, options);

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
    name?: string,
  ): DynamicModule;
  static forRootAsync<const D extends Deps>(
    config: AsyncModuleConfig<RedisOptionsInit, D>,
    name?: string,
  ): DynamicModule;
  static forRootAsync(
    source:
      | (() => RedisOptionsInit | Promise<RedisOptionsInit>)
      | AsyncModuleConfig<RedisOptionsInit, Deps>,
    name?: string,
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

    if (name !== undefined) {
      return namedModule(name, { useFactory, inject }, imports);
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
