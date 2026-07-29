import type { Database as BunSqlite } from 'bun:sqlite';
import { drizzle, type BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { DbConnection } from '../connection.js';
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
 * writes `NULL` for one it cannot use — a stray `Date` — where a strict one
 * throws. Measured on Bun 1.3.14.
 */
export class SqliteConnection<
  TSchema extends Record<string, unknown>,
> extends DbConnection<BunSQLiteDatabase<TSchema>> {
  override readonly backend: BackendName = Backend.SQLITE;
  override readonly dialect: DialectName = Dialect.SQLITE;

  override readonly raw: BunSqlite;
  override readonly db: BunSQLiteDatabase<TSchema>;

  #closed = false;

  constructor(raw: BunSqlite, schema: TSchema) {
    super();
    this.raw = raw;
    this.db = drizzle({ client: raw, schema });
  }

  override async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.raw.close();
  }

  /** Whether `close()` has run. drizzle cannot report this — it holds no state. */
  get closed(): boolean {
    return this.#closed;
  }
}
