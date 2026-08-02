import type { OnInit } from '@dunx/core';
import { transaction } from '@dunx/infra/db';
import { desc, sql } from 'drizzle-orm';
import { BunSQLDatabase } from 'drizzle-orm/bun-sql';
import * as schema from './schema.js';
import { widgets, type Widget } from './schema.js';

/**
 * Postgres, through `drizzle-orm/bun-sql` over `Bun.SQL`. No `pg`, no
 * `postgres.js` - Bun owns the socket, the pool and the wire protocol; drizzle
 * owns the SQL.
 *
 * Compare this file with the SQLite one: the imports differ by two lines and the
 * bodies are the same. That is the point of the async SQLite mode - the move from
 * one to the other is a change to a module, not to a repository.
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
   * On Postgres `transaction()` delegates to drizzle's own, which is genuinely
   * async - it goes through `Bun.SQL`'s `begin()`, which reserves a connection for
   * the duration. That is also why the callback is handed a `PgTransaction` rather
   * than the database: the pooled outer handle would take a different connection
   * and sit outside the transaction.
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
