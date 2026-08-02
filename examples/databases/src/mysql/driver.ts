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
 * MySQL for `@dunx/infra/db`, assembled in this example rather than shipped by the
 * package — and needing no change to the package to work, which is the point.
 * `DbOptions.open()` is where a backend lives, so adding one is a new class, not
 * an edit to a dispatch table inside `DbModule`.
 *
 * ### Why it is built this way
 *
 * drizzle 0.45.2 has no Bun-native MySQL driver. Its only Bun entrypoints are
 * `bun-sql` (Postgres — it builds a `PgDialect` unconditionally) and `bun-sqlite`.
 * Its MySQL drivers are `mysql2` and `mysql-proxy`, and `mysql2` is a JavaScript
 * reimplementation of a wire protocol Bun already speaks, so it is out.
 *
 * `mysql-proxy` is the way through: drizzle's MySQL dialect with the transport left
 * as a callback. `Bun.SQL` supplies the transport. drizzle owns the SQL generation
 * and the schema, Bun owns every byte of I/O, and nothing pulls in `mysql2`.
 *
 * Verified end to end against MySQL 8 on Bun 1.3.14 with drizzle-orm 0.45.2:
 * inserts, selects, `where`, `orderBy`/`limit`/`offset`, updates, deletes,
 * aggregates, `$returningId()` for single- and multi-row inserts, inner and left
 * joins, prepared statements with `placeholder()`, and the `mysql-proxy` migrator.
 * The two caveats are on `MysqlConnection.transaction` and in the README.
 *
 * ### Not generic over the schema, unlike `SqliteOptions` and `SqlOptions`
 *
 * This example has one schema, so the type parameter would be machinery with
 * nothing to vary. Promoting this into `@dunx/infra/db` is what would make it
 * `MysqlOptions<TSchema>`; until then the concrete type reads better.
 */
type Schema = typeof schema;

/** drizzle's callback contract, over `Bun.SQL`. Three details, all load-bearing. */
const callbackFor =
  (client: Bun.SQL): RemoteCallback =>
  async (query, params, method) => {
    if (method === 'all') {
      // `.values()` is not optional. drizzle's `mapResultRow` indexes each row
      // POSITIONALLY, and `Bun.SQL`'s default object rows lose columns on a join:
      // selecting `users.id, users.name, posts.id, posts.name` comes back with two
      // keys, not four, because the later names overwrite the earlier ones.
      // Measured — a manual object-to-array conversion would be silently wrong.
      return { rows: await client.unsafe(query, params).values() };
    }

    const result = await client.unsafe(query, params);
    // A MySQL write returns no result set, so a non-empty array means `execute()`
    // ran a SELECT. drizzle passes `'execute'` whenever the query carries no
    // fields, and without this branch those rows would be silently discarded.
    if (result.length > 0) return { rows: result };

    // `mysql-proxy/session.js` reads `data[0].insertId` and `data[0].affectedRows`,
    // even though `RemoteCallback`'s declared type puts both at the top level. The
    // declared ones are dead; following the signature breaks `$returningId()`.
    // Bun's own property is `lastInsertRowid`, not `insertId`.
    return {
      rows: [
        {
          insertId: Number(result.lastInsertRowid ?? 0),
          affectedRows: Number(result.affectedRows ?? 0),
        },
      ],
    };
  };

/** The lifecycle and the driver handle, neither of which a drizzle handle has. */
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

  override async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.raw.close();
  }

  /**
   * `db.transaction()` throws on this driver — `mysql-proxy/session.js` hardcodes
   * "Transactions are not supported by the MySql Proxy driver", because a callback
   * transport has no way to pin its statements to one connection.
   *
   * `Bun.SQL` does have a way: `begin()` reserves a connection for the duration. So
   * the transaction is opened on the client and a second drizzle handle is built
   * over the reserved socket. Commit and rollback both verified.
   *
   * This is the one functional gap against drizzle's `mysql2` driver, and it costs
   * an extra handle inside the callback rather than costing correctness.
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
 * What `DbModule.forRoot` takes. `MySqlRemoteDatabase` is a real runtime class, so
 * it is the injection token as well as the type — the same trick `SqliteOptions`
 * and `SqlOptions` use, and the reason a service can annotate the schema-typed
 * handle and still be resolved by name.
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
      // `adapter` is not redundant, and leaving it out is a real bug on Bun
      // 1.3.14: in the **options-object** form, `POSTGRES_URL`, `PGURL` or
      // `TLS_POSTGRES_DATABASE_URL` in the environment silently overrides an
      // explicitly passed `url` and forces `adapter: 'postgres'` — so a MySQL URL
      // is dialled as Postgres and fails with a bare "Connection closed".
      // Measured; `new Bun.SQL(urlString)` and `new Bun.SQL(new URL(url))` are
      // unaffected, and so is naming the adapter. See docs/bun-apis.md.
      adapter: 'mysql',
      max: 4,
      connectionTimeout: 5,
    });
    // Awaited here, so a repository is never handed an unconnected client.
    await client.connect();
    return new MysqlConnection(client);
  }
}
