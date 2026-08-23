import type { OnInit } from '@dunx/core';
import { desc, eq, sql } from 'drizzle-orm';
import { MySqlRemoteDatabase } from 'drizzle-orm/mysql-proxy';
import { MysqlConnection } from './driver.js';
import * as schema from './schema.js';
import { widgets, type Widget } from './schema.js';

/** MySQL. Everything dialect-specific is in `driver.ts` and the two notes below. */
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

  /** MySQL has no `RETURNING`; `$returningId()` reads the forwarded `insertId`
   * and counts forward for a multi-row insert. */
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

  /** Not `@dunx/infra/db`'s `transaction()`: it dispatches on `bun:sqlite` vs
   * `bun-sql`, and this handle is neither. See `MysqlConnection.transaction`. */
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
