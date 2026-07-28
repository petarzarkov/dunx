import { provide, token, type DynamicModule, type Token } from '@dunx/core';
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
 * constructor parameter — reach it with `inject()` in a field initialiser:
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
 * `useFactory` rather than `useClass: Redis`. Either would work — declaring
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
 * on `RedisOptions` — the flat container reports that as a duplicate binding.
 */
const namedModule = (
  name: string,
  options: RedisOptions | (() => RedisOptions | Promise<RedisOptions>),
): DynamicModule => {
  const optionsToken = token<RedisOptions>(`RedisOptions(${name})`);
  // Branch on the call, not the argument: a union of provider shapes matches
  // neither `provide` overload.
  const optionsProvider =
    typeof options === 'function'
      ? provide(optionsToken, { useFactory: options })
      : provide(optionsToken, { useValue: options });

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
   * `redisConnection(init.name)` alone when `name` is set — a named registration
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
   * `name` is a parameter rather than a field of the awaited init because the
   * token has to exist before the factory runs.
   */
  static forRootAsync(
    load: () => RedisOptionsInit | Promise<RedisOptionsInit>,
    name?: string,
  ): DynamicModule {
    const build = async (): Promise<RedisOptions> =>
      new RedisOptions(await load());

    if (name !== undefined) return namedModule(name, build);

    return {
      module: RedisModule,
      providers: [
        provide(RedisOptions, { useFactory: build }),
        connectionFrom(RedisConnection, RedisOptions),
      ],
    };
  }
}
