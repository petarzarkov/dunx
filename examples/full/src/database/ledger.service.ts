import { Logger } from '@dunx/core';
import type { OnInit, OnShutdown } from '@dunx/core';
import {
  asSqlite,
  DbConnection,
  runSeeds,
  SyncDatabase,
  transaction,
  transactionSync,
  type SeedReport,
} from '@dunx/infra/db';
import { paginate, type Page, type PageOptions } from '@dunx/infra/pagination';
import { count, desc, eq, sql, sum } from 'drizzle-orm';
import * as schema from './schema.js';
import { ledger, type Entry } from './schema.js';

export class Ledger implements OnInit, OnShutdown {
  /**
   * `SyncDatabase` is `BunSQLiteDatabase` under a name saying the connection was
   * opened in synchronous mode, which is what reaches `transactionSync` below.
   * `DbConnection` carries the lifecycle and the driver; drizzle has neither.
   */
  constructor(
    private readonly db: SyncDatabase<typeof schema>,
    private readonly connection: DbConnection,
    private readonly logger: Logger,
  ) {}

  /** Standing in for a migration, which a `:memory:` database cannot keep. */
  async onInit(): Promise<void> {
    this.db.run(sql`CREATE TABLE IF NOT EXISTS ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memo TEXT NOT NULL,
      amount INTEGER NOT NULL
    )`);
    await runSeeds(this.db, { dir: `${import.meta.dir}/seeds` });
  }

  list(limit: number): readonly Entry[] {
    return this.db
      .select()
      .from(ledger)
      .orderBy(desc(ledger.id))
      .limit(limit)
      .all();
  }

  /**
   * Keyset rather than `OFFSET`: a cursor names the last row seen, so an insert
   * between two requests cannot shift a page and serve an entry twice. No
   * timestamp column here, so `paginate` falls back to the unique primary key.
   */
  page(options: PageOptions): Page<Entry> {
    return paginate<typeof ledger, Entry>({
      db: this.db,
      table: ledger,
      options,
    });
  }

  find(id: number): Entry | undefined {
    return this.db.select().from(ledger).where(eq(ledger.id, id)).get();
  }

  /** `.returning()` hands back the row the database actually wrote. */
  add(memo: string, amount: number): Entry {
    return this.db.insert(ledger).values({ memo, amount }).returning().get();
  }

  remove(id: number): boolean {
    const gone = this.db
      .delete(ledger)
      .where(eq(ledger.id, id))
      .returning()
      .all();
    return gone.length > 0;
  }

  balance(): number {
    return (
      this.db
        .select({ total: sum(ledger.amount).mapWith(Number) })
        .from(ledger)
        .get()?.total ?? 0
    );
  }

  rows(): number {
    return this.db.select({ n: count() }).from(ledger).get()?.n ?? 0;
  }

  /**
   * `transaction()` from `@dunx/infra/db`, not `db.transaction()`: drizzle's own
   * commits as soon as the callback returns its promise, so everything after the
   * first `await` would run in autocommit.
   */
  transfer(
    from: string,
    to: string,
    amount: number,
    fail = false,
  ): Promise<number> {
    return transaction(this.db, async (tx) => {
      tx.insert(ledger).values({ memo: from, amount: -amount }).run();
      await Bun.sleep(1);
      if (fail) throw new Error('transfer failed after the first leg');
      tx.insert(ledger).values({ memo: to, amount }).run();
      return (
        tx
          .select({ total: sum(ledger.amount).mapWith(Number) })
          .from(ledger)
          .get()?.total ?? 0
      );
    });
  }

  /**
   * The same two legs with nothing to await. `transactionSync` is drizzle's own
   * `db.transaction()`, safe because the callback cannot return a promise.
   */
  transferSync(from: string, to: string, amount: number, fail = false): number {
    return transactionSync(this.db, (tx) => {
      tx.insert(ledger).values({ memo: from, amount: -amount }).run();
      if (fail) throw new Error('transfer failed after the first leg');
      tx.insert(ledger).values({ memo: to, amount }).run();
      return (
        tx
          .select({ total: sum(ledger.amount).mapWith(Number) })
          .from(ledger)
          .get()?.total ?? 0
      );
    });
  }

  async demonstrate(): Promise<void> {
    const { db, logger } = this;
    logger.info(
      `backend=${this.connection.backend} dialect=${this.connection.dialect}, ` +
        'table "ledger" created at onInit',
    );

    // `raw` is `unknown` on the base, because the base also describes `Bun.SQL`.
    // `asSqlite` checks the connection and hands back the `bun:sqlite` handle, so
    // pragmas and triggers are reachable without a cast.
    const driver = asSqlite(this.connection);
    const journal = driver.query('pragma journal_mode').get();
    logger.info(
      `raw driver -> bun:sqlite ${driver.filename}, ${JSON.stringify(journal)}`,
    );

    logger.info(
      `insert -> ${JSON.stringify(this.add('opening balance', 100))}`,
    );
    this.add('coffee', -3);

    const rows = db
      .select({ memo: ledger.memo, amount: ledger.amount })
      .from(ledger)
      .orderBy(ledger.id)
      .all();
    logger.info(`select -> ${JSON.stringify(rows)}`);

    // `.get()` is `undefined` when there is no row - never `null`.
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
    this.rollsBackSynchronously();
    await this.seeds();
  }

  /** `transactionSync` throws where `transaction` rejects. */
  private rollsBackSynchronously(): void {
    const before = this.rows();
    try {
      transactionSync(this.db, (tx) => {
        tx.insert(ledger).values({ memo: 'discarded', amount: 999 }).run();
        throw new Error('rolled back on purpose, synchronously');
      });
    } catch (error) {
      this.logger.info(`sync transaction threw: ${(error as Error).message}`);
    }
    this.logger.info(
      `rolled back sync transaction -> still ${before} rows, no promise allocated`,
    );
  }

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
    const before = this.rows();
    await transaction(this.db, async (tx) => {
      tx.insert(ledger).values({ memo: 'discarded', amount: 999 }).run();
      await Bun.sleep(1);
      throw new Error('rolled back on purpose');
    }).catch((error: unknown) =>
      this.logger.info(`transaction threw: ${(error as Error).message}`),
    );
    this.logger.info(
      `rolled back transaction -> still ${before} rows, ` +
        '"discarded" never landed',
    );
  }

  /**
   * Seed data, the half `drizzle-kit` has no concept of. Numbered files in
   * `seeds/`, applied once and recorded in `dunx_seeds`.
   */
  private async seeds(): Promise<void> {
    const dir = `${import.meta.dir}/seeds`;
    this.report('runSeeds after onInit', await runSeeds(this.db, { dir }));
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
