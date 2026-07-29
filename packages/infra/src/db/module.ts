import {
  provide,
  type Deps,
  type DynamicModule,
  type FactoryProvider,
} from '@dunx/core';
import { Database, DbOptions } from './contract.js';
import type { SqlOptions } from './sql/options.js';
import type { SqliteOptions } from './sqlite/options.js';

/**
 * A union rather than the abstract base, so `forRoot` accepts only a real
 * configuration and the backend is decided by which class you constructed.
 */
export type DbOptionsInput = SqliteOptions | SqlOptions;

/**
 * Binds two tokens: `DbOptions`, so anything can read the resolved dialect, and
 * `Database`, the contract repositories inject.
 *
 * `Database` is always bound through a factory. dunx resolves eagerly and awaits
 * every async factory before it constructs anything, so the connection is open
 * and handshaken before the first repository's constructor runs — no lazy
 * connect, no half-initialised client, no `await db.ready()`.
 */
export class DbModule {
  static forRoot(options: DbOptionsInput): DynamicModule {
    return {
      module: DbModule,
      providers: [
        provide(DbOptions, { useValue: options }),
        provide(Database, { useFactory: () => options.open() }),
      ],
    };
  }

  /**
   * Not a second mechanism — the same `forRoot`, with the options themselves
   * produced by a factory that may await and may inject. Useful when the URL
   * comes from a secret store or a `Config` provider:
   *
   * ```ts
   * DbModule.forRootAsync({
   *   useFactory: (config: Config) => new SqlOptions({ url: config.databaseUrl }),
   *   inject: [Config],
   * })
   * ```
   */
  static forRootAsync<const D extends Deps>(
    provider: FactoryProvider<DbOptionsInput, D>,
  ): DynamicModule {
    return {
      module: DbModule,
      providers: [
        provide(DbOptions, provider),
        provide(Database, {
          useFactory: (options: DbOptions) => options.open(),
          inject: [DbOptions],
        }),
      ],
    };
  }
}
