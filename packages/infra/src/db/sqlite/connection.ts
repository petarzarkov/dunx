import type { Database as BunSqlite } from 'bun:sqlite';
import { BunSQLiteDatabase, drizzle } from 'drizzle-orm/bun-sqlite';
import { DbConnection, type DrizzleInit } from '../connection.js';
import {
  Backend,
  Dialect,
  type BackendName,
  type DialectName,
} from '../dialect.js';

/**
 * `drizzle-orm/bun-sqlite` over a `bun:sqlite` handle.
 *
 * The client is constructed by `SqliteOptions` and handed in, rather than letting
 * `drizzle('./dev.db')` open it: drizzle's own path forwards only
 * `readonly`/`create`/`readwrite`, so the handle comes back **non-strict**. A
 * single object binding is read as a named-parameter map, and a non-strict handle
 * writes `NULL` for one it cannot use - a stray `Date` - where a strict one
 * throws. Measured on Bun 1.3.14.
 */
export class SqliteConnection<
  TSchema extends Record<string, unknown>,
  TDb extends BunSQLiteDatabase<TSchema> = BunSQLiteDatabase<TSchema>,
> extends DbConnection<TDb> {
  override readonly backend: BackendName = Backend.SQLITE;
  override readonly dialect: DialectName = Dialect.SQLITE;

  override readonly raw: BunSqlite;
  override readonly db: TDb;

  #closed = false;

  constructor(raw: BunSqlite, schema: TSchema, options: DrizzleInit = {}) {
    super();
    this.raw = raw;
    // `TDb` exists so `SyncSqliteConnection` can narrow `db` without redeclaring
    // it - a redeclared field would be defined as `undefined` over this
    // assignment, and TypeScript 7 rejects `declare override`. The handle drizzle
    // returns is the same object in both modes; the subclass is what makes the
    // narrower type true, by defining the property that names it.
    this.db = drizzle({ client: raw, schema, ...options }) as unknown as TDb;
  }

  /**
   * The real implementation. Closing a `bun:sqlite` handle is a file operation with
   * nothing to wait for, so `close()` is this plus a resolved promise it only
   * allocates because `DbConnection` has to describe `Bun.SQL` too.
   */
  closeSync(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.raw.close();
  }

  override async close(): Promise<void> {
    this.closeSync();
  }

  /** Whether `close()` has run. drizzle cannot report this - it holds no state. */
  get closed(): boolean {
    return this.#closed;
  }
}

/**
 * The same `drizzle-orm/bun-sqlite` handle, marked at the type level as belonging
 * to a connection opened in **synchronous mode**.
 *
 * It adds no method and no behaviour. What it adds is a name: `transactionSync()`
 * accepts this and nothing else, so reaching the synchronous transaction requires
 * having configured `SyncSqliteOptions` rather than `SqliteOptions`. The container
 * enforces it too - a service annotating `SyncDatabase<typeof schema>` fails to
 * resolve in an app whose `DbModule` bound `BunSQLiteDatabase`.
 *
 * The relationship is one-way on purpose. A `SyncDatabase` **is** a
 * `BunSQLiteDatabase`, so everything that took the async handle - `transaction()`,
 * `runSeeds()`, a repository written before the mode existed - still takes this
 * one. Synchronous mode is a superset, not a fork.
 *
 * There is no Postgres counterpart and there will not be one: `Bun.SQL` is a
 * socket, and nothing makes a socket synchronous.
 */
export class SyncDatabase<
  TSchema extends Record<string, unknown>,
> extends BunSQLiteDatabase<TSchema> {
  /**
   * Never assigned by this class - `SyncSqliteConnection` defines it on the handle
   * drizzle built, because that handle is the object services are given. Declaring
   * it is what stops `BunSQLiteDatabase` from being structurally identical to this,
   * which is the whole mechanism above.
   */
  declare readonly synchronous: true;
}

/**
 * A `bun:sqlite` connection whose handle is typed for synchronous use.
 *
 * The driver, the pragmas and the lifecycle are `SqliteConnection`'s - the only
 * difference is the type of `db`, and one own property defined on it so that type
 * is true rather than a claim. `instanceof SqliteConnection` still holds.
 */
export class SyncSqliteConnection<
  TSchema extends Record<string, unknown>,
> extends SqliteConnection<TSchema, SyncDatabase<TSchema>> {
  constructor(raw: BunSqlite, schema: TSchema, options: DrizzleInit = {}) {
    super(raw, schema, options);
    // Non-enumerable, so it stays out of anything that walks the handle.
    Object.defineProperty(this.db, 'synchronous', { value: true });
  }
}
