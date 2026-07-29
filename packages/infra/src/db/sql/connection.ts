import { drizzle, type BunSQLDatabase } from 'drizzle-orm/bun-sql';
import { DbConnection } from '../connection.js';
import {
  Backend,
  Dialect,
  type BackendName,
  type DialectName,
} from '../dialect.js';

/**
 * `drizzle-orm/bun-sql` over a `Bun.SQL` client.
 *
 * Postgres only. `Bun.SQL` itself speaks four dialects, but
 * `drizzle-orm/bun-sql` hardcodes `new PgDialect(...)` — there is no branch on
 * `client.options.adapter` anywhere in it. Pointed at a `sqlite://` client it
 * still compiles `$1` placeholders and Postgres quoting, and the trivial cases
 * even appear to work, which is worse than failing. `SqlOptions` refuses a
 * non-Postgres URL for exactly that reason.
 */
export class SqlConnection<
  TSchema extends Record<string, unknown>,
> extends DbConnection<BunSQLDatabase<TSchema>> {
  override readonly backend: BackendName = Backend.SQL;
  override readonly dialect: DialectName = Dialect.POSTGRES;

  override readonly raw: Bun.SQL;
  override readonly db: BunSQLDatabase<TSchema>;

  #closed = false;

  constructor(raw: Bun.SQL, schema: TSchema) {
    super();
    this.raw = raw;
    this.db = drizzle({ client: raw, schema });
  }

  override async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.raw.close();
  }

  get closed(): boolean {
    return this.#closed;
  }
}
