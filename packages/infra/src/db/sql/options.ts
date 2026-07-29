import type { AbstractCtor } from '@dunx/core';
import { BunSQLDatabase } from 'drizzle-orm/bun-sql';
import { DbOptions } from '../connection.js';
import {
  Backend,
  Dialect,
  dialectFromUrl,
  type BackendName,
  type DialectName,
} from '../dialect.js';
import { DatabaseError } from '../errors.js';
import { SqlConnection } from './connection.js';

/**
 * Extends the driver's own option type rather than restating it, so pooling, TLS
 * and auth stay in sync with whatever Bun supports. `url` is required and
 * `adapter` is dropped — the URL scheme already decides it.
 */
export interface SqlInit<TSchema extends Record<string, unknown>> extends Omit<
  Bun.SQL.PostgresOrMySQLOptions,
  'url' | 'adapter'
> {
  /** `import * as schema from './schema.js'`. Pass `{}` if you only run `sql` templates. */
  readonly schema: TSchema;
  readonly url: string | URL;
}

/**
 * Configuration for the `Bun.SQL` backend — Postgres. A class, so it is
 * injectable.
 *
 * The dialect is resolved from the URL **at construction**, so a bad URL throws
 * before any I/O.
 */
export class SqlOptions<
  TSchema extends Record<string, unknown>,
> extends DbOptions<BunSQLDatabase<TSchema>> {
  override readonly backend: BackendName = Backend.SQL;
  override readonly dialect: DialectName = Dialect.POSTGRES;

  /** drizzle's `BunSQLDatabase` is a real runtime class, so it is the token itself. */
  override readonly token: AbstractCtor<BunSQLDatabase<TSchema>> =
    BunSQLDatabase;

  readonly schema: TSchema;
  readonly url: string;
  readonly #driver: Bun.SQL.PostgresOrMySQLOptions;

  constructor(init: SqlInit<TSchema>) {
    super();
    // `schema` and `url` are consumed here, so neither rides along into the
    // driver options — a schema object is every table and column in the app.
    const { schema, url, ...driver } = init;
    this.schema = schema;
    this.url = url instanceof URL ? url.href : url;

    const dialect = dialectFromUrl(this.url);
    if (dialect !== Dialect.POSTGRES) {
      throw new DatabaseError(
        `"${this.url}" names ${dialect}, and drizzle-orm/bun-sql is Postgres ` +
          'only — it builds a PgDialect unconditionally, so a non-Postgres URL ' +
          'would compile $1 placeholders and Postgres quoting against a server ' +
          'that does not speak them. Use SqliteOptions for SQLite; MySQL and ' +
          'MariaDB have no drizzle driver on Bun.SQL.',
      );
    }
    this.#driver = { ...driver, url: this.url };
  }

  /**
   * Exactly what is handed to `new Bun.SQL(...)`. Narrowed to the server-backed
   * half of `Bun.SQL.Options`: this backend is Postgres by construction, and the
   * full union hides `url`, `max` and the rest behind `Bun.SQL.SQLiteOptions`.
   */
  toDriverOptions(): Bun.SQL.PostgresOrMySQLOptions {
    return { ...this.#driver };
  }

  /**
   * The handshake is awaited here rather than deferred to the first query.
   * `DbModule` opens through an async factory and dunx settles every factory
   * before it constructs anything, so a repository can never be handed a client
   * that has not connected.
   */
  override async open(): Promise<SqlConnection<TSchema>> {
    const client = new Bun.SQL(this.toDriverOptions());
    await client.connect();
    return new SqlConnection(client, this.schema);
  }
}
