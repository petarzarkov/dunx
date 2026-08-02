import type { OnInit } from '@dunx/core';
import { SyncDatabase, transactionSync } from '@dunx/infra/db';
import { desc, sql } from 'drizzle-orm';
import * as schema from './schema.js';
import { widgets, type Widget } from './schema.js';

/**
 * The same three operations, in **synchronous mode**. Not one `await`, not one
 * promise, not one microtask — `bun:sqlite` is a function call into SQLite, and
 * this mode stops pretending otherwise.
 *
 * `SyncDatabase` is `BunSQLiteDatabase` under a name that says the connection was
 * opened by `SyncSqliteOptions`. That name is the whole mechanism: `transactionSync`
 * accepts this and nothing else, and the container will not hand a `SyncDatabase`
 * to a service that asked for the async handle, or the reverse.
 *
 * The relationship is one-way. A `SyncDatabase` *is* a `BunSQLiteDatabase`, so
 * anything already written against the async handle still takes this one — sync
 * mode is a superset, not a fork.
 */
export class SyncWidgets implements OnInit {
  constructor(private readonly db: SyncDatabase<typeof schema>) {}

  /** Returns `void`, not `Promise<void>`. There is nothing to wait for. */
  onInit(): void {
    this.db.run(sql`CREATE TABLE IF NOT EXISTS widgets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      weight INTEGER NOT NULL
    )`);
  }

  /** `.get()` and `.all()` are the synchronous terminators drizzle offers here. */
  add(name: string, weight: number): Widget {
    return this.db.insert(widgets).values({ name, weight }).returning().get();
  }

  list(): readonly Widget[] {
    return this.db.select().from(widgets).orderBy(desc(widgets.id)).all();
  }

  /**
   * `transactionSync` returns the value, not a promise. It delegates to drizzle's
   * own `db.transaction()`, which is correct *because* the callback cannot be
   * async: the bug the async `transaction()` works around is entirely downstream of
   * a callback that returns a promise.
   *
   * The callback is held to that at compile time — an `async` one is a type error
   * naming the constraint, rather than a rollback that silently does nothing.
   *
   * The return is a count rather than the two rows because `NotThenable`'s object
   * branch is a weak type: TypeScript rejects an object or array that shares no
   * property with `{ then?: undefined }`, so a scalar is what this constraint
   * currently accepts.
   */
  addPairAtomically(first: string, second: string, fail: boolean): number {
    return transactionSync(this.db, (tx) => {
      tx.insert(widgets).values({ name: first, weight: 1 }).run();
      if (fail) throw new Error('rolling back on purpose');
      tx.insert(widgets).values({ name: second, weight: 2 }).run();
      return tx.select().from(widgets).all().length;
    });
  }
}
