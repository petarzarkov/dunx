import type { OnShutdown } from '@dunx/core';

/**
 * The four dialects `Bun.SQL` accepts. Taken from Bun's own rejection message —
 * `new Bun.SQL('oracle://…')` throws with exactly this list.
 */
export const Dialect = Object.freeze({
  POSTGRES: 'postgres',
  MYSQL: 'mysql',
  MARIADB: 'mariadb',
  SQLITE: 'sqlite',
} as const);

export type DialectName = (typeof Dialect)[keyof typeof Dialect];

export const Backend = Object.freeze({
  /** `bun:sqlite` — embedded, no server, synchronous underneath. */
  SQLITE: 'sqlite',
  /** `Bun.SQL` — pooled, asynchronous, one client for four dialects. */
  SQL: 'sql',
} as const);

export type BackendName = (typeof Backend)[keyof typeof Backend];

/**
 * What a placeholder may be bound to on *either* backend. `Date` is in the union
 * even though `bun:sqlite` rejects it — the SQLite driver converts it to an ISO
 * 8601 string, so one call site works against both.
 */
export type SqlValue =
  | string
  | number
  | bigint
  | boolean
  | Date
  | Uint8Array
  | null;

export type Row = Record<string, unknown>;

export interface RunResult {
  /** Rows the statement affected. */
  readonly changes: number;
  /** `null` on every dialect that does not report one — i.e. everything but SQLite. */
  readonly lastInsertRowid: number | bigint | null;
}

/**
 * Lazy. Nothing reaches the database until a terminal method is called, and
 * awaiting the query itself is `all()`:
 *
 * ```ts
 * const rows = await db.sql`SELECT * FROM users`;
 * const one = await db.sql`SELECT * FROM users WHERE id = ${id}`.get();
 * const { changes } = await db.sql`DELETE FROM users`.run();
 * ```
 */
export interface Query<T> extends PromiseLike<readonly T[]> {
  all(): Promise<readonly T[]>;
  /** First row, or `null`. Fetches the whole result — it will not edit a `LIMIT` into your SQL. */
  get(): Promise<T | null>;
  run(): Promise<RunResult>;
}

/**
 * The single injectable contract. An abstract class rather than an interface
 * because a `@dunx/compiler` constructor parameter has to name a runtime value:
 *
 * ```ts
 * export class UsersRepository {
 *   constructor(private readonly db: Database) {}
 * }
 * ```
 *
 * Every method is async even on SQLite, which is synchronous underneath. That is
 * deliberate — it is what lets a call site move from SQLite to Postgres without
 * being rewritten.
 */
export abstract class Database implements OnShutdown {
  abstract readonly backend: BackendName;
  abstract readonly dialect: DialectName;

  /**
   * The driver handle — a `bun:sqlite` `Database` or a `Bun.SQL` client. Typed
   * `unknown` here because the contract cannot promise either one; narrow with
   * `instanceof SqliteDatabase` / `instanceof SqlDatabase`, which restores the
   * concrete type on `raw`.
   */
  abstract readonly raw: unknown;

  /**
   * Tagged template. Placeholders are compiled to whatever the dialect wants —
   * `?` for SQLite, `$1…` for Postgres — so the same literal is portable, and
   * values are always bound, never interpolated.
   */
  abstract sql<T extends object = Row>(
    strings: TemplateStringsArray,
    ...values: readonly SqlValue[]
  ): Query<T>;

  /** Raw SQL with positional parameters. The placeholder syntax is the dialect's, so this is the non-portable door. */
  abstract all<T extends object = Row>(
    text: string,
    params?: readonly SqlValue[],
  ): Promise<readonly T[]>;

  abstract get<T extends object = Row>(
    text: string,
    params?: readonly SqlValue[],
  ): Promise<T | null>;

  abstract run(text: string, params?: readonly SqlValue[]): Promise<RunResult>;

  /** Multiple statements separated by `;`, no parameters. For migrations and DDL. */
  abstract exec(text: string): Promise<void>;

  /**
   * Runs `fn` inside a transaction, committing on return and rolling back on
   * throw. Nesting opens a savepoint, so an inner failure unwinds only the inner
   * work. The `tx` handle must be used for everything inside — the outer
   * `Database` is not enrolled in the transaction on the pooled backend.
   */
  abstract transaction<T>(fn: (tx: Database) => T | Promise<T>): Promise<T>;

  /** Idempotent. */
  abstract close(): Promise<void>;

  /**
   * Concrete, not abstract: the lifecycle hook and the explicit call are the same
   * operation. Shutdown runs in reverse construction order, so every repository
   * that depends on this has already drained by the time it fires.
   */
  async onShutdown(): Promise<void> {
    await this.close();
  }
}

/**
 * Configuration, and the thing that knows how to act on it. `open()` lives here
 * rather than in a `switch` inside the module so that adding a backend does not
 * mean editing a dispatch table — and so `DbModule` needs no cast to go from the
 * abstract token to a concrete driver.
 */
export abstract class DbOptions {
  abstract readonly backend: BackendName;
  abstract open(): Promise<Database>;
}
