import { sql } from 'drizzle-orm';
import type { BunSQLDatabase } from 'drizzle-orm/bun-sql';
import { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import type { SyncDatabase } from './sqlite/connection.js';

/**
 * The handle drizzle hands a Postgres transaction callback. Derived from
 * `db.transaction` rather than restated, so it cannot drift from
 * `PgTransaction<BunSQLQueryResultHKT, …>`.
 */
export type SqlTransaction<TSchema extends Record<string, unknown>> =
  Parameters<Parameters<BunSQLDatabase<TSchema>['transaction']>[0]>[0];

/**
 * The handle drizzle hands a `bun:sqlite` transaction callback - its own
 * `SQLiteBunTransaction`, derived rather than restated. Nesting is
 * `tx.transaction(...)`, which takes a savepoint.
 */
export type SyncTransaction<TSchema extends Record<string, unknown>> =
  Parameters<Parameters<BunSQLiteDatabase<TSchema>['transaction']>[0]>[0];

/**
 * A callback's return type, unless it is a promise - then a branded tuple nothing
 * can be assigned to, so the mistake is a type error where the result is used.
 *
 * Not a constraint on the type parameter. `{ then?: undefined }` is a weak type,
 * so TypeScript rejects any object sharing no property with it, and returning a
 * row from a transaction did not compile. Only primitives got through.
 */
type NoPromise<T> =
  T extends PromiseLike<unknown>
    ? [
        'transactionSync: the callback must be synchronous - use transaction() for an async one',
        never,
      ]
    : T;

/** Per-handle transaction state. Off to the side, because drizzle owns the handle. */
interface Scope {
  depth: number;
  /** Serialises top-level transactions - see below. */
  queue: Promise<unknown>;
}

const scopes = new WeakMap<object, Scope>();

const scopeOf = (db: object): Scope => {
  const existing = scopes.get(db);
  if (existing !== undefined) return existing;

  const created: Scope = { depth: 0, queue: Promise.resolve() };
  scopes.set(db, created);
  return created;
};

/** `run` is bun-sqlite's raw door and needs no schema, so it stays generic. */
const exec = <TSchema extends Record<string, unknown>>(
  db: BunSQLiteDatabase<TSchema>,
  text: string,
): void => {
  db.run(sql.raw(text));
};

const scoped = async <TSchema extends Record<string, unknown>, T>(
  db: BunSQLiteDatabase<TSchema>,
  fn: (tx: BunSQLiteDatabase<TSchema>) => T | Promise<T>,
): Promise<T> => {
  const scope = scopeOf(db);
  const depth = scope.depth++;
  const savepoint = `dunx_sp_${depth}`;

  exec(db, depth === 0 ? 'BEGIN' : `SAVEPOINT ${savepoint}`);
  try {
    // The same handle, not a derived one: there is exactly one connection, so
    // every statement issued anywhere is already inside this transaction. That is
    // also why the schema type survives a transaction unchanged.
    const result = await fn(db);
    exec(db, depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
    return result;
  } catch (error) {
    if (depth === 0) {
      exec(db, 'ROLLBACK');
    } else {
      // RELEASE as well: rolling back to a savepoint leaves it on the stack.
      exec(db, `ROLLBACK TO ${savepoint}`);
      exec(db, `RELEASE ${savepoint}`);
    }
    throw error;
  } finally {
    scope.depth--;
  }
};

const sqliteTransaction = <TSchema extends Record<string, unknown>, T>(
  db: BunSQLiteDatabase<TSchema>,
  fn: (tx: BunSQLiteDatabase<TSchema>) => T | Promise<T>,
): Promise<T> => {
  const scope = scopeOf(db);
  if (scope.depth > 0) return scoped(db, fn);

  const run = scope.queue.then(() => scoped(db, fn));
  scope.queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
};

/**
 * Runs `fn` in a transaction, committing on return and rolling back on throw.
 * Nesting opens a savepoint.
 *
 * Not `db.transaction()` on `bun:sqlite`: drizzle delegates to `bun:sqlite`'s,
 * which commits as soon as the callback returns its promise, so anything after an
 * `await` runs in autocommit. This issues `BEGIN`/`COMMIT`/`ROLLBACK` itself, and
 * overlapping top-level transactions queue rather than nest a `BEGIN`.
 *
 * On Postgres it delegates to drizzle's own, over `Bun.SQL.begin()`, so nesting
 * there is `tx.transaction(...)`.
 */
export function transaction<TSchema extends Record<string, unknown>, T>(
  db: BunSQLiteDatabase<TSchema>,
  fn: (tx: BunSQLiteDatabase<TSchema>) => T | Promise<T>,
): Promise<T>;
export function transaction<TSchema extends Record<string, unknown>, T>(
  db: BunSQLDatabase<TSchema>,
  fn: (tx: SqlTransaction<TSchema>) => T | Promise<T>,
): Promise<T>;
export function transaction<TSchema extends Record<string, unknown>, T>(
  db: BunSQLiteDatabase<TSchema> | BunSQLDatabase<TSchema>,
  fn:
    | ((tx: BunSQLiteDatabase<TSchema>) => T | Promise<T>)
    | ((tx: SqlTransaction<TSchema>) => T | Promise<T>),
): Promise<T> {
  // The two backends take different handles, so the callback is narrowed by the
  // same test that picks the implementation.
  if (db instanceof BunSQLiteDatabase) {
    return sqliteTransaction(
      db,
      fn as (tx: BunSQLiteDatabase<TSchema>) => T | Promise<T>,
    );
  }

  const callback = fn as (tx: SqlTransaction<TSchema>) => T | Promise<T>;
  return db.transaction(async (tx) => callback(tx));
}

/**
 * Runs `fn` in a real `bun:sqlite` transaction and returns its value, with nothing
 * to await. Commits on return, rolls back on throw, nests as a savepoint.
 *
 * This is drizzle's own `db.transaction()`, which is correct here: the early
 * commit `transaction()` works around is entirely downstream of a callback that
 * returns a promise, and `NoPromise` makes an `async` callback a type error.
 *
 * Both may be used against one `SyncDatabase`. A `transactionSync` opened while an
 * async `transaction()` is suspended takes a savepoint, since `bun:sqlite`
 * branches on `Database.inTransaction`.
 */
export const transactionSync = <TSchema extends Record<string, unknown>, T>(
  db: SyncDatabase<TSchema>,
  fn: (tx: SyncTransaction<TSchema>) => T,
): NoPromise<T> => db.transaction(fn) as NoPromise<T>;
