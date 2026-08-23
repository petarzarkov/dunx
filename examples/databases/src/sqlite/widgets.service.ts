import type { OnInit } from '@dunx/core';
import { transaction } from '@dunx/infra/db';
import { desc, sql } from 'drizzle-orm';
import { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import * as schema from './schema.js';
import { widgets, type Widget } from './schema.js';

/**
 * SQLite in asynchronous mode. `BunSQLiteDatabase<typeof schema>` is drizzle's
 * own class, so it is both the injection token and the typed handle - the
 * transform records the bare name and the schema types survive injection.
 */
export class Widgets implements OnInit {
  constructor(private readonly db: BunSQLiteDatabase<typeof schema>) {}

  /**
   * Standing in for a migration, which a `:memory:` database has nowhere to keep.
   * Real changes are `drizzle-kit generate` plus the bun-sqlite migrator.
   */
  onInit(): void {
    // `run` is synchronous even here - the driver is `bun:sqlite` either way.
    // Async mode changes the query-builder surface, not the driver.
    this.db.run(sql`CREATE TABLE IF NOT EXISTS widgets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      weight INTEGER NOT NULL
    )`);
  }

  add(name: string, weight: number): Promise<Widget[]> {
    return this.db.insert(widgets).values({ name, weight }).returning();
  }

  list(): Promise<Widget[]> {
    return this.db.select().from(widgets).orderBy(desc(widgets.id));
  }

  /**
   * `@dunx/infra/db`'s `transaction()`, not drizzle's. drizzle delegates to
   * `bun:sqlite`'s wrapper, which commits when the callback returns its promise,
   * so everything after the first `await` runs in autocommit and a later throw
   * rolls back nothing. This issues `BEGIN`/`COMMIT`/`ROLLBACK` itself.
   */
  async addPairAtomically(
    first: string,
    second: string,
    fail: boolean,
  ): Promise<Widget[]> {
    return transaction(this.db, async (tx) => {
      const [a] = await tx
        .insert(widgets)
        .values({ name: first, weight: 1 })
        .returning();
      if (fail) throw new Error('rolling back on purpose');
      const [b] = await tx
        .insert(widgets)
        .values({ name: second, weight: 2 })
        .returning();
      return [a, b].filter((row): row is Widget => row !== undefined);
    });
  }
}
