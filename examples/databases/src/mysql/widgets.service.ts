import type { OnInit } from '@dunx/core';
import { desc, eq, sql } from 'drizzle-orm';
import { MySqlRemoteDatabase } from 'drizzle-orm/mysql-proxy';
import { MysqlConnection } from './driver.js';
import * as schema from './schema.js';
import { widgets, type Widget } from './schema.js';

/**
 * MySQL. The query code is drizzle's, exactly as on the other two dialects —
 * everything MySQL-specific is in `driver.ts` and in the two notes below.
 */
export class MysqlWidgets implements OnInit {
  constructor(
    private readonly db: MySqlRemoteDatabase<typeof schema>,
    private readonly connection: MysqlConnection,
  ) {}

  async onInit(): Promise<void> {
    await this.db.execute(sql`CREATE TABLE IF NOT EXISTS widgets (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(128) NOT NULL,
      weight INT NOT NULL
    )`);
    await this.db.execute(sql`TRUNCATE TABLE widgets`);
  }

  /**
   * MySQL has no `RETURNING`, so drizzle offers `$returningId()` instead — it reads
   * the `insertId` the adapter forwards and, for a multi-row insert, counts forward
   * from it. Reading the row back is the second statement.
   */
  async add(name: string, weight: number): Promise<Widget | undefined> {
    const [inserted] = await this.db
      .insert(widgets)
      .values({ name, weight })
      .$returningId();
    if (inserted === undefined) return undefined;
    const [row] = await this.db
      .select()
      .from(widgets)
      .where(eq(widgets.id, inserted.id));
    return row;
  }

  list(): Promise<Widget[]> {
    return this.db.select().from(widgets).orderBy(desc(widgets.id));
  }

  /**
   * Not `transaction()` from `@dunx/infra/db` — that dispatches on `bun:sqlite` vs
   * `bun-sql`, and this handle is neither. `mysql-proxy` refuses `db.transaction()`
   * outright, so the connection opens one on `Bun.SQL` and builds a drizzle handle
   * over the reserved socket. See `MysqlConnection.transaction`.
   */
  addPairAtomically(
    first: string,
    second: string,
    fail: boolean,
  ): Promise<number> {
    return this.connection.transaction(async (tx) => {
      await tx.insert(widgets).values({ name: first, weight: 1 });
      if (fail) throw new Error('rolling back on purpose');
      await tx.insert(widgets).values({ name: second, weight: 2 });
      return 2;
    });
  }
}
