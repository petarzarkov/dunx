import { Logger } from '@dunx/core';
import type { OnInit, OnShutdown } from '@dunx/core';
import {
  DbConnection,
  runSeeds,
  SqliteConnection,
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
   * `SyncDatabase` is drizzle's `BunSQLiteDatabase` under a name that says the
   * connection was opened in synchronous mode - which is what makes
   * `transactionSync` below reachable. `@dunx/transform` records the bare type name
   * (a real runtime class, so a usable token) and ignores the type argument, so the
   * schema types survive injection. `DbConnection` is the lifecycle and the driver
   * underneath; drizzle has neither.
   */
  constructor(
    private readonly db: SyncDatabase<typeof schema>,
    private readonly connection: DbConnection,
    private readonly logger: Logger,
  ) {}

  /**
   * Standing in for a migration rather than replacing one: schema changes are
   * `drizzle-kit generate` plus drizzle-orm/bun-sqlite/migrator, which own the
   * SQL, the journal and the snapshot folder. A `:memory:` database has nowhere
   * to keep any of that, so the table is created here - and at `onInit`, so the
   * routes below have somewhere to write before the first request arrives.
   */
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
   * The same rows, paginated by cursor instead of by `limit`.
   *
   * Keyset rather than `OFFSET`, which is what makes it correct while rows are being
   * written: a cursor names the last row seen, so an insert between two requests
   * cannot shift a page and serve the same entry twice. This table has no timestamp,
   * so `paginate` falls back to the primary key - `id` is unique on its own, so no
   * tie-break column is needed.
   *
   * Synchronous, because `paginate`'s return type follows its `db`: a
   * `drizzle-orm/bun-sqlite` handle answers `all()` rather than a promise, so this
   * method needs no `async` and neither does its caller.
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
   * Both legs or neither. `transaction()` from `@dunx/infra/db`, not
   * `db.transaction()`: drizzle's own on bun-sqlite delegates to `bun:sqlite`'s
   * synchronous `transaction()`, which commits as soon as the callback returns its
   * promise - so everything after the first `await` would run in autocommit. That
   * is what makes the rollback below possible at all.
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
   * The same two legs, with nothing to await. `transactionSync` is drizzle's own
   * `db.transaction()` - correct here precisely because the callback cannot return
   * a promise, which is the case its early commit breaks. The return type is
   * `number`, not `Promise<number>`, so a controller calling this needs no `async`
   * and the request never yields.
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

    // The escape hatch. `raw` is `unknown` on the base - the abstract class cannot
    // promise either driver - and `instanceof` is what restores the concrete type.
    if (this.connection instanceof SqliteConnection) {
      logger.info(`raw driver -> bun:sqlite ${this.connection.raw.filename}`);
    }

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

  /**
   * The same rollback with no promise anywhere - `transactionSync` throws where
   * `transaction` rejects, so the recovery is `try`/`catch` rather than `.catch()`.
   */
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

  /** The `await` inside is what proves the transaction is not autocommitting. */
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
   * Seed *data*, which is the half `drizzle-kit` has no concept of. Numbered files
   * in `seeds/`, each applied once and recorded in `dunx_seeds` - so this reports
   * them journaled rather than applied, `onInit` having already run them.
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
