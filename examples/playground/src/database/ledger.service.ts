import type { OnShutdown } from '@dunx/core';
import { Database } from '@dunx/infra/db';
import { Logger } from '../logger.js';

interface Entry {
  readonly memo: string;
  readonly amount: number;
}

interface Total {
  readonly n: number;
}

/**
 * `Database` is an abstract class, which is what lets it be both the injectable
 * token and the contract — an interface would erase and leave `@dunx/compiler`
 * nothing to record.
 */
export class Ledger implements OnShutdown {
  constructor(
    private readonly db: Database,
    private readonly logger: Logger,
  ) {}

  async demonstrate(): Promise<void> {
    const { db, logger } = this;

    // exec: several statements, no parameters. For DDL and migrations.
    await db.exec(
      'CREATE TABLE ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
        'memo TEXT NOT NULL, amount INTEGER NOT NULL)',
    );
    logger.info(
      `backend=${db.backend} dialect=${db.dialect}, table "ledger" created`,
    );

    // Tagged template: every ${} is bound, never interpolated, and compiled to
    // the dialect's own placeholder syntax.
    const opened = await db.sql`
      INSERT INTO ledger (memo, amount) VALUES (${'opening balance'}, ${100})
    `.run();
    logger.info(
      `insert -> changes=${opened.changes} lastInsertRowid=${opened.lastInsertRowid}`,
    );

    // Raw text with positional parameters — the non-portable door.
    await db.run('INSERT INTO ledger (memo, amount) VALUES (?, ?)', [
      'coffee',
      -3,
    ]);
    const rows =
      await db.sql<Entry>`SELECT memo, amount FROM ledger ORDER BY id`;
    logger.info(`select -> ${JSON.stringify(rows)}`);

    // Commit on return. `tx` is the handle to use inside — the outer Database is
    // not enrolled in the transaction on the pooled backend.
    const balance = await db.transaction(async (tx) => {
      await tx.sql`INSERT INTO ledger (memo, amount) VALUES (${'refund'}, ${12})`.run();
      return (await tx.sql<Total>`SELECT sum(amount) AS n FROM ledger`.get())
        ?.n;
    });
    logger.info(
      `committed transaction -> ${await this.rows()} rows, balance ${balance}`,
    );

    // Roll back on throw, and the throw propagates.
    await db
      .transaction(async (tx) => {
        await tx.sql`INSERT INTO ledger (memo, amount) VALUES (${'discarded'}, ${999})`.run();
        throw new Error('rolled back on purpose');
      })
      .catch((error: unknown) =>
        logger.info(`transaction threw: ${(error as Error).message}`),
      );
    logger.info(
      `rolled back transaction -> still ${await this.rows()} rows, "discarded" never landed`,
    );
  }

  private async rows(): Promise<number> {
    const total = await this.db
      .sql<Total>`SELECT count(*) AS n FROM ledger`.get();
    return total?.n ?? 0;
  }

  /**
   * `close()` is idempotent, so `Database.onShutdown` finding it already closed
   * is fine. What this makes observable is the *order*: core drains in reverse
   * construction order, so every service holding the connection has already run
   * by the time this prints.
   */
  async onShutdown(): Promise<void> {
    await this.db.close();
    this.logger.info('database closed');
  }
}
