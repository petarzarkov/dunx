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
 * `Bun.SQL` hangs statement metadata off the returned array. Measured on Bun
 * 1.3.14 against the SQLite adapter: `INSERT` yields `count: 1`, `command:
 * 'INSERT'`, `lastInsertRowid: 1` and `affectedRows: null` — so `affectedRows`
 * exists in the shape but is not always populated, and `count` is the reliable
 * one. Both are read, in that order.
 */
interface ResultMeta {
  readonly count?: number | null;
  readonly affectedRows?: number | null;
  readonly lastInsertRowid?: number | bigint | null;
}

const runResult = (rows: readonly unknown[]): RunResult => {
  const meta = rows as unknown as ResultMeta;
  return {
    changes: meta.affectedRows ?? meta.count ?? 0,
    lastInsertRowid: meta.lastInsertRowid ?? null,
  };
};

/**
 * `Bun.SQL` on the shared contract — Postgres, MySQL, MariaDB, and SQLite too.
 *
 * The tagged template is handed straight to the driver's own template function,
 * so placeholder numbering, escaping and array parameters are Bun's, not a
 * reimplementation.
 */
export class SqlDatabase extends Database {
  override readonly backend: BackendName = Backend.SQL;
  override readonly dialect: DialectName;

  readonly #client: Bun.SQL;
  /** True only for the handle handed to a `transaction()` callback. */
  readonly #scoped: boolean;
  #closed = false;

  constructor(client: Bun.SQL, dialect: DialectName, scoped = false) {
    super();
    this.#client = client;
    this.dialect = dialect;
    this.#scoped = scoped;
  }

  /** The `Bun.SQL` client, for `reserve()`, `array()`, distributed transactions and the rest. */
  override get raw(): Bun.SQL {
    return this.#client;
  }

  override sql<T extends object = Row>(
    strings: TemplateStringsArray,
    ...values: readonly SqlValue[]
  ): Query<T> {
    const bound = this.#bind(values);
    return new LazyQuery<T>({
      all: async () => this.#open()<T[]>(strings, ...bound),
      run: async () => runResult(await this.#open()<Row[]>(strings, ...bound)),
    });
  }

  override async all<T extends object = Row>(
    text: string,
    params: readonly SqlValue[] = [],
  ): Promise<readonly T[]> {
    return this.#open().unsafe<T[]>(text, this.#bind(params));
  }

  override async get<T extends object = Row>(
    text: string,
    params: readonly SqlValue[] = [],
  ): Promise<T | null> {
    const rows = await this.all<T>(text, params);
    return rows[0] ?? null;
  }

  override async run(
    text: string,
    params: readonly SqlValue[] = [],
  ): Promise<RunResult> {
    return runResult(
      await this.#open().unsafe<Row[]>(text, this.#bind(params)),
    );
  }

  override async exec(text: string): Promise<void> {
    // simple() is the unparameterised protocol, the only one that accepts several
    // statements in one round trip.
    await this.#open().unsafe(text).simple();
  }

  /**
   * Delegates to the driver: `begin()` at the top level, `savepoint()` when this
   * handle is already inside one. The callback gets a handle bound to the
   * transaction's connection, which is why the outer `Database` must not be used
   * inside — on a pool it would take a different connection and sit outside the
   * transaction entirely.
   */
  override async transaction<T>(
    fn: (tx: Database) => T | Promise<T>,
  ): Promise<T> {
    const client = this.#open();
    const body = async (scope: Bun.SQL): Promise<T> =>
      fn(new SqlDatabase(scope, this.dialect, true));

    // begin/savepoint return ContextCallbackResult<T>, a conditional that cannot
    // reduce while T is generic. The callback's own return type is the truth.
    if (this.#scoped) {
      const scope = client as Bun.TransactionSQL;
      return (await scope.savepoint(body)) as T;
    }
    return (await client.begin(body)) as T;
  }

  override async close(): Promise<void> {
    if (this.#scoped) {
      throw new DatabaseError(
        'close() was called on a transaction handle. Closing would tear down the ' +
          'whole pool from inside a transaction — let transaction() return instead.',
      );
    }
    if (this.#closed) return;
    this.#closed = true;
    await this.#client.close();
  }

  /**
   * `Bun.SQL` binds a `Date` natively on Postgres and MySQL, but its SQLite
   * adapter is `bun:sqlite` underneath and throws "Binding expected string,
   * TypedArray, boolean, number, bigint or null". Converting only for SQLite
   * keeps a real `timestamptz` binding where one exists.
   */
  #bind(values: readonly SqlValue[]): SqlValue[] {
    if (this.dialect !== Dialect.SQLITE) return [...values];
    return values.map((value) =>
      value instanceof Date ? value.toISOString() : value,
    );
  }

  #open(): Bun.SQL {
    if (this.#closed) {
      throw new DatabaseError(
        'This SQL client is closed. onShutdown() already ran, or close() was ' +
          'called by hand — resolve the Database from the container again rather ' +
          'than holding one across a shutdown.',
      );
    }
    return this.#client;
  }
}
