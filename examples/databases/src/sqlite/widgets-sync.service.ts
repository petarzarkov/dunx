import type { OnInit } from '@dunx/core';
import { SyncDatabase, transactionSync } from '@dunx/infra/db';
import { desc, sql } from 'drizzle-orm';
import * as schema from './schema.js';
import { widgets, type Widget } from './schema.js';

/**
 * The same three operations in synchronous mode. `SyncDatabase` is
 * `BunSQLiteDatabase` under a name saying `SyncSqliteOptions` opened it, which is
 * what `transactionSync` accepts and what keeps the two handles apart at the
 * injection site. A `SyncDatabase` still satisfies the async handle's type.
 */
export class SyncWidgets implements OnInit {
  constructor(private readonly db: SyncDatabase<typeof schema>) {}

  onInit(): void {
    this.db.run(sql`CREATE TABLE IF NOT EXISTS widgets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      weight INTEGER NOT NULL
    )`);
  }

  /** `.get()` and `.all()` are drizzle's synchronous terminators. */
  add(name: string, weight: number): Widget {
    return this.db.insert(widgets).values({ name, weight }).returning().get();
  }

  list(): readonly Widget[] {
    return this.db.select().from(widgets).orderBy(desc(widgets.id)).all();
  }

  /**
   * `transactionSync` delegates to drizzle's own `db.transaction()`, safe here
   * because an async callback is a compile error - the rollback bug the async
   * `transaction()` works around only exists downstream of a returned promise.
   * Returns a count: `NotThenable`'s object branch is a weak type.
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
