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
 * here too. An `@dunx/infra/db` connection satisfies it with no adapter in between —
 * `dialect` is exactly that union and `db` is exactly `unknown`.
 */
export interface DrizzleSource {
  readonly dialect: 'postgres' | 'mysql' | 'mariadb' | 'sqlite';
  /** The drizzle handle — `BunSQLiteDatabase` or `BunSQLDatabase`. */
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
 * better-auth's `database` option over a connection the app already opened. Nothing
 * here connects: the point is that the app keeps **one** pool, one SQLite handle and
 * one shutdown path, instead of better-auth opening a second.
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
 * The `provider` comes from the connection's own dialect, so swapping `bun:sqlite`
 * for `Bun.SQL` needs no edit at the call site. The schema does not have to be passed
 * either — `@dunx/infra/db` builds its handle with `drizzle({ client, schema })` and
 * the adapter reads `db._.fullSchema`, so the better-auth tables being in the app's
 * schema object is the whole requirement.
 *
 * dunx ships **no** schema for those tables. They are better-auth's, they change with
 * its plugins, and its own CLI generates them: `bunx @better-auth/cli generate`. A
 * copy of them inside a framework is a copy that silently rots against the library
 * that reads it.
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
