import type { OnInit } from '@dunx/core';
import { transaction } from '@dunx/infra/db';
import { desc, sql } from 'drizzle-orm';
import { BunSQLDatabase } from 'drizzle-orm/bun-sql';
import * as schema from './schema.js';
import { widgets, type Widget } from './schema.js';

/**
 * Postgres through `drizzle-orm/bun-sql` over `Bun.SQL`. Compare with the SQLite
 * file: the imports differ by two lines and the bodies are identical.
 */
export class PostgresWidgets implements OnInit {
  constructor(private readonly db: BunSQLDatabase<typeof schema>) {}

  async onInit(): Promise<void> {
    await this.db.execute(sql`CREATE TABLE IF NOT EXISTS widgets (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      weight INTEGER NOT NULL
    )`);
    await this.db.execute(sql`TRUNCATE widgets RESTART IDENTITY`);
  }

  add(name: string, weight: number): Promise<Widget[]> {
    return this.db.insert(widgets).values({ name, weight }).returning();
  }

  list(): Promise<Widget[]> {
    return this.db.select().from(widgets).orderBy(desc(widgets.id));
  }

  /**
   * Here `transaction()` delegates to drizzle's own, which goes through
   * `Bun.SQL.begin()`. The callback is handed a `PgTransaction` because the
   * pooled outer handle would take a different connection.
   */
  addPairAtomically(
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
