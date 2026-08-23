import type { AbstractCtor } from '@dunx/core';
import {
  Backend,
  DbConnection,
  DbOptions,
  Dialect,
  type BackendName,
  type DialectName,
} from '@dunx/infra/db';
import {
  drizzle,
  MySqlRemoteDatabase,
  type RemoteCallback,
} from 'drizzle-orm/mysql-proxy';
import * as schema from './schema.js';

/**
 * MySQL for `@dunx/infra/db`, added by this example without touching the package.
 * drizzle has no Bun-native MySQL driver, so `mysql-proxy` supplies the dialect
 * and `Bun.SQL` the transport. See the README for the verified surface.
 */
type Schema = typeof schema;

const callbackFor =
  (client: Bun.SQL): RemoteCallback =>
  async (query, params, method) => {
    if (method === 'all') {
      // drizzle indexes rows positionally, and Bun.SQL's object rows drop
      // duplicate column names on a join. `.values()` is required, not a choice.
      return { rows: await client.unsafe(query, params).values() };
    }

    const result = await client.unsafe(query, params);
    // drizzle sends `'execute'` for any fieldless query, so a non-empty array
    // here is a SELECT whose rows would otherwise be discarded.
    if (result.length > 0) return { rows: result };

    // mysql-proxy reads these off `data[0]`, though `RemoteCallback` declares
    // them at the top level. Following the signature breaks `$returningId()`.
    return {
      rows: [
        {
          insertId: Number(result.lastInsertRowid ?? 0),
          affectedRows: Number(result.affectedRows ?? 0),
        },
      ],
    };
  };

export class MysqlConnection extends DbConnection<MySqlRemoteDatabase<Schema>> {
  override readonly backend: BackendName = Backend.SQL;
  override readonly dialect: DialectName = Dialect.MYSQL;

  override readonly raw: Bun.SQL;
  override readonly db: MySqlRemoteDatabase<Schema>;

  #closed = false;

  constructor(raw: Bun.SQL) {
    super();
    this.raw = raw;
    this.db = drizzle(callbackFor(raw), { schema });
  }

  /** `DbConnection.ping()` throws by default; `DatabaseIndicator` calls this. */
  override async ping(): Promise<void> {
    await this.raw`select 1`;
  }

  override async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.raw.close();
  }

  /**
   * `db.transaction()` throws on mysql-proxy: a callback transport cannot pin
   * statements to one connection. `Bun.SQL.begin()` can, so the reserved socket
   * gets its own drizzle handle.
   */
  async transaction<T>(
    fn: (tx: MySqlRemoteDatabase<Schema>) => Promise<T>,
  ): Promise<T> {
    const run = async (reserved: Bun.SQL): Promise<T> =>
      fn(drizzle(callbackFor(reserved), { schema }));
    return this.raw.begin(run) as Promise<T>;
  }
}

/**
 * `MySqlRemoteDatabase` is a runtime class, so it serves as the injection token
 * as well as the type. `SqliteOptions` and `SqlOptions` do the same.
 */
export class MysqlOptions extends DbOptions<MySqlRemoteDatabase<Schema>> {
  override readonly backend: BackendName = Backend.SQL;
  override readonly dialect: DialectName = Dialect.MYSQL;
  override readonly token: AbstractCtor<MySqlRemoteDatabase<Schema>> =
    MySqlRemoteDatabase;

  constructor(private readonly url: string) {
    super();
  }

  override async open(): Promise<MysqlConnection> {
    const client = new Bun.SQL({
      url: this.url,
      // Required. In the options-object form `POSTGRES_URL` in the environment
      // overrides `url` and forces `adapter: 'postgres'`. See docs/bun-apis.md.
      adapter: 'mysql',
      max: 4,
      connectionTimeout: 5,
    });
    await client.connect();
    return new MysqlConnection(client);
  }
}
