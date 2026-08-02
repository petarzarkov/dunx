import {
  provide,
  token,
  type Deps,
  type DynamicModule,
  type FactoryProvider,
  type Token,
} from '@dunx/core';
import { Redis } from './client.js';
import { RedisConnection } from './connection.js';
import { RedisOptions, type RedisOptionsInit } from './options.js';

const tokens = new Map<string, Token<RedisConnection>>();

/**
 * The token a named connection is bound to.
 *
 * Memoised: `token()` returns a fresh object every call, so without this the
 * module and the consumer would each hold a different token for `'cache'` and the
 * lookup would miss. Same name in, same token out.
 *
 * A `Token` is not a constructor type, so a named connection cannot be a
 * constructor parameter - reach it with `inject()` in a field initialiser:
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
      providers: [
        provide(RedisOptions, { useValue: options }),
        connectionFrom(RedisConnection, RedisOptions),
      ],
    };
  }

  /**
   * `forRoot` with the options behind a factory. There is no separate async
   * machinery: the container resolves eagerly and awaits factories before any
   * constructor runs, so awaited config is already settled by then.
   *
   * The factory may also **inject**, which a bare loader cannot - reading the url
   * off `ConfigService`, say:
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
   * `name` is a parameter rather than a field of the awaited init because the
   * token has to exist before the factory runs.
   */
  static forRootAsync(
    load: () => RedisOptionsInit | Promise<RedisOptionsInit>,
    name?: string,
  ): DynamicModule;
  static forRootAsync<const D extends Deps>(
    config: FactoryProvider<RedisOptionsInit, D>,
    name?: string,
  ): DynamicModule;
  static forRootAsync(
    source:
      | (() => RedisOptionsInit | Promise<RedisOptionsInit>)
      | FactoryProvider<RedisOptionsInit, Deps>,
    name?: string,
  ): DynamicModule {
    const load = typeof source === 'function' ? source : source.useFactory;
    const inject = typeof source === 'function' ? [] : (source.inject ?? []);
    const useFactory = async (
      ...deps: readonly unknown[]
    ): Promise<RedisOptions> => new RedisOptions(await load(...deps));

    if (name !== undefined) return namedModule(name, { useFactory, inject });

    return {
      module: RedisModule,
      providers: [
        provide(RedisOptions, { useFactory, inject }),
        connectionFrom(RedisConnection, RedisOptions),
      ],
    };
  }
}
