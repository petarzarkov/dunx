import type { OnInit } from '@dunx/core';
import { transaction } from '@dunx/infra/db';
import { desc, sql } from 'drizzle-orm';
import { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import * as schema from './schema.js';
import { widgets, type Widget } from './schema.js';

/**
 * SQLite in **asynchronous mode** — the default, and what `SqliteOptions` binds.
 *
 * `BunSQLiteDatabase<typeof schema>` is drizzle's own class, so it is both the
 * injection token and the typed handle: `@dunx/compiler` records the bare type
 * name and ignores the type argument, which is how the schema types survive
 * injection. There is no dunx wrapper around drizzle anywhere in this file.
 *
 * This is the mode to pick if the app might move to Postgres later — every call
 * here is already awaited, so the move is a change to one module.
 */
export class Widgets implements OnInit {
  constructor(private readonly db: BunSQLiteDatabase<typeof schema>) {}

  /**
   * Standing in for a migration rather than replacing one. Real schema changes are
   * `drizzle-kit generate` plus `drizzle-orm/bun-sqlite/migrator`, which own the
   * SQL, the journal and the snapshot folder — a `:memory:` database has nowhere
   * to keep any of that. `onInit` runs after the graph is built and before the
   * first caller, so the table exists by the time anything queries it.
   */
  onInit(): void {
    // Not awaited, and no `async`: `run` is synchronous even in this mode, because
    // the driver underneath is `bun:sqlite` either way. What "asynchronous mode"
    // buys is the *query-builder* surface returning promises, which is what makes
    // the service portable to Postgres.
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
   * `transaction()` is `@dunx/infra/db`'s, not drizzle's, and on `bun:sqlite` that
   * matters: drizzle delegates to `bun:sqlite`'s own wrapper, which commits as soon
   * as the callback *returns its promise* — so every statement after the first
   * `await` runs in autocommit and a later throw rolls back nothing. This issues
   * `BEGIN`/`COMMIT`/`ROLLBACK` itself, so an async callback is atomic.
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
