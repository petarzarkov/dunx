import {
  drizzleAdapter,
  type DB,
  type DrizzleAdapterConfig,
} from 'better-auth/adapters/drizzle';

/**
 * The two members of `@dunx/infra/db`'s `DbConnection` this reads.
 *
 * Restated structurally rather than imported, for the same reason `@dunx/http`
 * restates Standard Schema: it keeps `@dunx/auth`'s dependency list at `@dunx/core`
 * and `@dunx/http`, and it means a bare `drizzle({ client, schema })` handle works
 * here too. An `@dunx/infra/db` connection satisfies it with no adapter in between -
 * `dialect` is exactly that union and `db` is exactly `unknown`.
 */
export interface DrizzleSource {
  readonly dialect: 'postgres' | 'mysql' | 'mariadb' | 'sqlite';
  /** The drizzle handle - `BunSQLiteDatabase` or `BunSQLDatabase`. */
  readonly db: unknown;
}

/** What better-auth's drizzle adapter calls each of the dialects `@dunx/infra/db` reports. */
const PROVIDERS: Readonly<
  Record<DrizzleSource['dialect'], DrizzleAdapterConfig['provider']>
> = Object.freeze({
  postgres: 'pg',
  mysql: 'mysql',
  mariadb: 'mysql',
  sqlite: 'sqlite',
});

/**
 * better-auth's `database` option over a connection the app already opened, so the
 * app keeps one pool and one shutdown path rather than better-auth opening a
 * second. Nothing here connects.
 *
 * ```ts
 * AuthModule.forRootAsync({
 *   useFactory: (connection: DbConnection) => ({
 *     database: drizzleDatabase(connection),
 *   }),
 *   inject: [DbConnection],
 * });
 * ```
 *
 * The `provider` comes from the connection's dialect and the schema off
 * `db._.fullSchema`. Tables must be exported under better-auth's singular model
 * names, so a barrel exporting `users` fails on first query:
 *
 * ```ts
 * schema: { user: users, session: sessions, account: accounts, verification: verifications }
 * ```
 */
export const drizzleDatabase = (
  connection: DrizzleSource,
  config: Omit<DrizzleAdapterConfig, 'provider'> = {},
): ReturnType<typeof drizzleAdapter> =>
  // `db` is `unknown` on the contract because it cannot promise either backend's
  // handle. Narrowing it is what that contract documents.
  drizzleAdapter(connection.db as DB, {
    ...config,
    provider: PROVIDERS[connection.dialect],
  });
