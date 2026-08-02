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
 * Anything that is not a promise. A `then` typed `undefined` is what excludes one:
 * an ordinary object or array has no `then` at all and satisfies it, `Promise<T>`
 * has a callable one and does not.
 */
type NotThenable =
  | { then?: undefined }
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined
  | void;

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
 * Nesting opens a savepoint, so an inner failure unwinds only the inner work.
 *
 * ### Why this is not `db.transaction()` on `bun:sqlite`
 *
 * Because drizzle's is synchronous there. `drizzle-orm/bun-sqlite` delegates to
 * `bun:sqlite`'s own `db.transaction()`, and that wrapper commits as soon as the
 * callback **returns its promise** - so `client.inTransaction` is already `false`
 * before the first `await` resumes, every statement after an `await` runs in
 * autocommit, and a later throw rolls back nothing. Measured on Bun 1.3.14:
 * insert, `await Bun.sleep(1)`, throw, catch - the row is still there.
 *
 * This issues `BEGIN`/`COMMIT`/`ROLLBACK` itself instead, so an async callback is
 * atomic. There is only one connection, so two overlapping top-level transactions
 * would issue a nested `BEGIN`; they queue instead. A nested call is already
 * inside the holder's turn and takes a savepoint, so it must not queue behind
 * itself.
 *
 * On Postgres this delegates to drizzle's own `db.transaction()`, which is
 * genuinely async - it goes through `Bun.SQL`'s `begin()`, which reserves a
 * connection for the duration. The handle a Postgres callback receives is
 * drizzle's `PgTransaction`, not the database, because the pooled backend's outer
 * handle would take a different connection and sit outside the transaction. That
 * also means nesting on Postgres is `tx.transaction(...)` - drizzle's own, which
 * takes a savepoint - since this function's second overload takes the database.
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
 * Runs `fn` in a real `bun:sqlite` transaction and returns its value - not a
 * promise, not a microtask, nothing to await. Commits on return, rolls back on
 * throw, and nests as a savepoint via `tx.transaction(...)`.
 *
 * ### This is drizzle's own `db.transaction()`, and here that is correct
 *
 * The workaround `transaction()` above exists because drizzle's bun-sqlite
 * transaction delegates to `bun:sqlite`'s, which commits the moment the callback
 * **returns** - so a callback that returns a promise has already committed before
 * its first `await` resumes. Everything about that failure is downstream of the
 * callback being asynchronous. Take the promise away and the wrapper is exactly
 * right, so this delegates instead of issuing `BEGIN`/`COMMIT` itself: one native
 * transaction, no statement strings, no queue, no promise.
 *
 * The callback is held to that by `NotThenable`. An `async` callback, or one that
 * returns `Promise.resolve(…)`, is a compile error naming the constraint rather
 * than a rollback that silently does nothing. Verified against Bun 1.3.14: with a
 * synchronous callback the row is gone after a throw; with an async one it is not.
 *
 * Both transactions may be used against the same `SyncDatabase`. A `transactionSync`
 * opened while an async `transaction()` is suspended across an `await` takes a
 * savepoint rather than failing, because `bun:sqlite` branches on
 * `Database.inTransaction`, which the outer `BEGIN` has already set.
 */
export const transactionSync = <
  TSchema extends Record<string, unknown>,
  T extends NotThenable,
>(
  db: SyncDatabase<TSchema>,
  fn: (tx: SyncTransaction<TSchema>) => T,
): T => db.transaction(fn);
