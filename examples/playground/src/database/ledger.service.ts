import type { OnShutdown } from '@dunx/core';
import {
  DbConnection,
  SqliteConnection,
  runSeeds,
  transaction,
  type SeedReport,
} from '@dunx/infra/db';
import { count, eq, sql, sum } from 'drizzle-orm';
import { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { Logger } from '../logger.js';
import * as schema from './schema.js';
import { ledger, type Entry } from './schema.js';

export class Ledger implements OnShutdown {
  /**
   * The annotation is drizzle's own class with the schema as its type argument.
   * `@dunx/compiler` records the bare type name — a real runtime class, so a usable
   * token — and ignores the type argument, so the schema types survive injection.
   * `DbConnection` is the lifecycle and the driver underneath; drizzle has neither.
   */
  constructor(
    private readonly db: BunSQLiteDatabase<typeof schema>,
    private readonly connection: DbConnection,
    private readonly logger: Logger,
  ) {}

  async demonstrate(): Promise<void> {
    const { db, logger } = this;

    // Standing in for a migration rather than replacing one: schema changes are
    // `drizzle-kit generate` plus drizzle-orm/bun-sqlite/migrator, which own the
    // SQL, the journal and the snapshot folder. A `:memory:` database has nowhere
    // to keep any of that, so the table is created here.
    db.run(sql`CREATE TABLE ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memo TEXT NOT NULL,
      amount INTEGER NOT NULL
    )`);
    logger.info(
      `backend=${this.connection.backend} dialect=${this.connection.dialect}, ` +
        'table "ledger" created',
    );

    // The escape hatch. `raw` is `unknown` on the base — the abstract class cannot
    // promise either driver — and `instanceof` is what restores the concrete type.
    if (this.connection instanceof SqliteConnection) {
      logger.info(`raw driver -> bun:sqlite ${this.connection.raw.filename}`);
    }

    // The builders are synchronous on bun-sqlite, so a statement ends in `.run()`,
    // `.all()` or `.get()`. `.returning()` hands back the row the database wrote.
    const opened: Entry = db
      .insert(ledger)
      .values({ memo: 'opening balance', amount: 100 })
      .returning()
      .get();
    logger.info(`insert -> ${JSON.stringify(opened)}`);

    db.insert(ledger).values({ memo: 'coffee', amount: -3 }).run();

    const rows = db
      .select({ memo: ledger.memo, amount: ledger.amount })
      .from(ledger)
      .orderBy(ledger.id)
      .all();
    logger.info(`select -> ${JSON.stringify(rows)}`);

    // `.get()` is `undefined` when there is no row — never `null`.
    const missing = db
      .select()
      .from(ledger)
      .where(eq(ledger.memo, 'not in the book'))
      .get();
    logger.info(
      `get() with no match -> ${missing === undefined ? 'undefined' : JSON.stringify(missing)}`,
    );

    await this.commits();
    await this.rollsBack();
    await this.seeds();
  }

  /**
   * `transaction()` from `@dunx/infra/db`, not `db.transaction()`: drizzle's own on
   * bun-sqlite delegates to `bun:sqlite`'s synchronous `transaction()`, which
   * commits as soon as the callback returns its promise. Everything after the first
   * `await` would run in autocommit — which is exactly what the `await` below
   * proves, and what makes the rollback in `rollsBack()` possible at all.
   */
  private async commits(): Promise<void> {
    const balance = await transaction(this.db, async (tx) => {
      tx.insert(ledger).values({ memo: 'refund', amount: 12 }).run();
      await Bun.sleep(1);
      return tx
        .select({ total: sum(ledger.amount).mapWith(Number) })
        .from(ledger)
        .get()?.total;
    });
    this.logger.info(
      `committed transaction -> ${this.rows()} rows, balance ${balance}`,
    );
  }

  /** Rolls back on throw, and the throw propagates rather than being swallowed. */
  private async rollsBack(): Promise<void> {
    await transaction(this.db, async (tx) => {
      tx.insert(ledger).values({ memo: 'discarded', amount: 999 }).run();
      await Bun.sleep(1);
      throw new Error('rolled back on purpose');
    }).catch((error: unknown) =>
      this.logger.info(`transaction threw: ${(error as Error).message}`),
    );
    this.logger.info(
      `rolled back transaction -> still ${this.rows()} rows, ` +
        '"discarded" never landed',
    );
  }

  /**
   * Seed *data*, which is the half `drizzle-kit` has no concept of. Numbered files
   * in `seeds/`, each applied once and recorded in `dunx_seeds` — so the second
   * call reports the same file as journaled instead of inserting its row twice.
   */
  private async seeds(): Promise<void> {
    const dir = `${import.meta.dir}/seeds`;

    this.report('first runSeeds', await runSeeds(this.db, { dir }));
    this.report('second runSeeds', await runSeeds(this.db, { dir }));
    this.logger.info(
      `seeded ledger -> ${this.rows()} rows, applied once despite two runs`,
    );
  }

  private report(label: string, report: SeedReport): void {
    this.logger.info(
      `${label} -> applied ${JSON.stringify(report.applied)}, ` +
        `journaled ${JSON.stringify(report.journaled)}, ` +
        `skipped ${JSON.stringify(report.skipped)}`,
    );
  }

  private rows(): number {
    return this.db.select({ n: count() }).from(ledger).get()?.n ?? 0;
  }

  /**
   * `close()` is idempotent, so `DbConnection.onShutdown` finding it already closed
   * is fine. What this makes observable is the *order*: core drains in reverse
   * construction order, so every service holding the connection has already run by
   * the time this prints.
   */
  async onShutdown(): Promise<void> {
    await this.connection.close();
    this.logger.info('database closed');
  }
}
