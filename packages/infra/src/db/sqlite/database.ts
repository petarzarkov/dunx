import type {
  Database as BunSqlite,
  SQLQueryBindings,
  Statement,
} from 'bun:sqlite';
import {
  Backend,
  Database,
  Dialect,
  type BackendName,
  type DialectName,
  type Query,
  type Row,
  type RunResult,
  type SqlValue,
} from '../contract.js';
import { DatabaseError } from '../errors.js';
import { LazyQuery } from '../query.js';

/**
 * `bun:sqlite` refuses a `Date` binding outright — "Binding expected string,
 * TypedArray, boolean, number, bigint or null". `Bun.SQL` accepts one, so the
 * shared `SqlValue` union keeps it and this closes the gap.
 */
const bind = (values: readonly SqlValue[]): SQLQueryBindings[] =>
  values.map((value) => (value instanceof Date ? value.toISOString() : value));

/**
 * `bun:sqlite` on the shared contract.
 *
 * Every method returns a promise even though the driver is synchronous. Nothing
 * is gained locally; what it buys is that a repository written against this can
 * be pointed at Postgres without touching a call site.
 */
export class SqliteDatabase extends Database {
  override readonly backend: BackendName = Backend.SQLITE;
  override readonly dialect: DialectName = Dialect.SQLITE;

  readonly #db: BunSqlite;
  #closed = false;
  #depth = 0;
  /** Serialises top-level transactions — see `transaction`. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(db: BunSqlite) {
    super();
    this.#db = db;
  }

  /** The `bun:sqlite` handle, for `serialize()`, extensions, `iterate()` and the rest. */
  override get raw(): BunSqlite {
    return this.#db;
  }

  override sql<T extends object = Row>(
    strings: TemplateStringsArray,
    ...values: readonly SqlValue[]
  ): Query<T> {
    // n+1 cooked chunks joined by n placeholders is exactly the SQLite syntax.
    return this.#lazy<T>(strings.join('?'), values);
  }

  override async all<T extends object = Row>(
    text: string,
    params: readonly SqlValue[] = [],
  ): Promise<readonly T[]> {
    return this.#statement<T>(text).all(...bind(params));
  }

  override async get<T extends object = Row>(
    text: string,
    params: readonly SqlValue[] = [],
  ): Promise<T | null> {
    return this.#statement<T>(text).get(...bind(params));
  }

  override async run(
    text: string,
    params: readonly SqlValue[] = [],
  ): Promise<RunResult> {
    const changes = this.#statement<Row>(text).run(...bind(params));
    return {
      changes: changes.changes,
      lastInsertRowid: changes.lastInsertRowid,
    };
  }

  override async exec(text: string): Promise<void> {
    this.#assertOpen();
    this.#db.exec(text);
  }

  /**
   * Built from `BEGIN`/`COMMIT`/`ROLLBACK` rather than the driver's own
   * `db.transaction()`, because that wrapper is synchronous: handed an async
   * callback it commits as soon as the function *returns its promise*, so a
   * later rejection lands after the commit and nothing rolls back. Measured on
   * Bun 1.3.14.
   *
   * There is one connection, so two overlapping top-level transactions would
   * issue nested `BEGIN`s. They queue instead. A nested call is already inside
   * the holder's turn and takes a savepoint, so it must not queue behind itself.
   */
  override async transaction<T>(
    fn: (tx: Database) => T | Promise<T>,
  ): Promise<T> {
    if (this.#depth > 0) return this.#scoped(fn);

    const run = this.#queue.then(() => this.#scoped(fn));
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  override async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  async #scoped<T>(fn: (tx: Database) => T | Promise<T>): Promise<T> {
    this.#assertOpen();
    const depth = this.#depth++;
    const savepoint = `dunx_sp_${depth}`;
    this.#db.exec(depth === 0 ? 'BEGIN' : `SAVEPOINT ${savepoint}`);

    try {
      const result = await fn(this);
      this.#db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      if (depth === 0) {
        this.#db.exec('ROLLBACK');
      } else {
        // RELEASE as well: rolling back to a savepoint leaves it on the stack.
        this.#db.exec(`ROLLBACK TO ${savepoint}`);
        this.#db.exec(`RELEASE ${savepoint}`);
      }
      throw error;
    } finally {
      this.#depth--;
    }
  }

  #lazy<T extends object>(text: string, params: readonly SqlValue[]): Query<T> {
    return new LazyQuery<T>({
      all: () => this.all<T>(text, params),
      run: () => this.run(text, params),
    });
  }

  /** `query`, not `prepare` — the driver caches compiled statements by text. */
  #statement<T extends object>(text: string): Statement<T, SQLQueryBindings[]> {
    this.#assertOpen();
    return this.#db.query<T, SQLQueryBindings[]>(text);
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new DatabaseError(
        'This SQLite database is closed. onShutdown() already ran, or close() was ' +
          'called by hand — resolve the Database from the container again rather ' +
          'than holding one across a shutdown.',
      );
    }
  }
}
