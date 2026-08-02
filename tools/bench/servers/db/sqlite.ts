/**
 * One app, two SQLite modes, chosen by `$DB_MODE`. Everything else is held
 * constant: the same file, the same pragmas, the same rows, the same SQL, the same
 * JSON on the wire, `requestLogging: false` and no CORS so every route stays on
 * `@dunx/http`'s direct dispatch path.
 *
 * What differs is only how the handler reaches the database.
 *
 * - `async` — the shape someone writes when the repository might one day be
 *   Postgres: `await` drizzle's thenable query builder, an `async` handler, and
 *   `transaction()` with an `async` callback.
 * - `sync` — `.get()`/`.all()`/`.run()` and `transactionSync()`, with no `async`
 *   and no `await` between `Bun.serve` and the row.
 *
 * The two controllers are written out in full rather than branching inside one
 * handler, because a branch would keep the async version's machinery in the
 * synchronous path and measure neither.
 */
import { Module } from '@dunx/core';
import {
  Controller,
  Get,
  HttpFactory,
  Post,
  type RouteSchemas,
} from '@dunx/http';
import {
  DbModule,
  SqliteOptions,
  SyncDatabase,
  SyncSqliteOptions,
  transaction,
  transactionSync,
} from '@dunx/infra/db';
import { eq, sql } from 'drizzle-orm';
import { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { PLAINTEXT, port } from '../shared.js';

const ledger = sqliteTable('ledger', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  memo: text('memo').notNull(),
  amount: integer('amount').notNull(),
});

const schema = { ledger };
type Schema = typeof schema;

const ROWS = 500;
const pragmas = ['journal_mode = WAL', 'synchronous = NORMAL'];

const sync = process.env['DB_MODE'] === 'sync';

/**
 * The two rows `/write` moves an amount between, and the one `/read` selects.
 * Updates rather than inserts, so the table stays 500 rows for the whole run — an
 * insert-per-request would grow the work under later rounds and turn drift into an
 * apparent difference between modes.
 */
const READ_ID = 1;
const LEFT = 2;
const RIGHT = 3;

const declared = { status: 200 } as const satisfies RouteSchemas;

interface Row {
  id: number;
  memo: string;
  amount: number;
}

/** Identical bytes from both modes, so the comparison is like for like. */
const seen = (row: Row | undefined): Row =>
  row ?? { id: 0, memo: 'missing', amount: 0 };

@Controller()
class AsyncController {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  @Get('/plaintext')
  plaintext(): Response {
    return new Response(PLAINTEXT);
  }

  @Get('/read', declared)
  async read(): Promise<Row> {
    const rows = await this.db
      .select()
      .from(ledger)
      .where(eq(ledger.id, READ_ID));
    return seen(rows[0]);
  }

  @Post('/write', declared)
  async write(): Promise<{ balance: number }> {
    const balance = await transaction(this.db, async (tx) => {
      await tx
        .update(ledger)
        .set({ amount: sql`${ledger.amount} + 1` })
        .where(eq(ledger.id, LEFT));
      await tx
        .update(ledger)
        .set({ amount: sql`${ledger.amount} - 1` })
        .where(eq(ledger.id, RIGHT));
      const rows = await tx
        .select({ amount: ledger.amount })
        .from(ledger)
        .where(eq(ledger.id, LEFT));
      return rows[0]?.amount ?? 0;
    });
    return { balance };
  }
}

@Controller()
class SyncController {
  constructor(private readonly db: SyncDatabase<Schema>) {}

  @Get('/plaintext')
  plaintext(): Response {
    return new Response(PLAINTEXT);
  }

  @Get('/read', declared)
  read(): Row {
    return seen(
      this.db.select().from(ledger).where(eq(ledger.id, READ_ID)).get(),
    );
  }

  @Post('/write', declared)
  write(): { balance: number } {
    return {
      balance: transactionSync(this.db, (tx) => {
        tx.update(ledger)
          .set({ amount: sql`${ledger.amount} + 1` })
          .where(eq(ledger.id, LEFT))
          .run();
        tx.update(ledger)
          .set({ amount: sql`${ledger.amount} - 1` })
          .where(eq(ledger.id, RIGHT))
          .run();
        return (
          tx
            .select({ amount: ledger.amount })
            .from(ledger)
            .where(eq(ledger.id, LEFT))
            .get()?.amount ?? 0
        );
      }),
    };
  }
}

const file = `${process.env['DB_FILE'] ?? '/tmp/dunx-bench'}-${sync ? 'sync' : 'async'}.db`;
await Bun.file(file)
  .delete()
  .catch(() => undefined);

@Module({
  imports: [
    sync
      ? DbModule.forRoot(
          new SyncSqliteOptions({ schema, filename: file, pragmas }),
        )
      : DbModule.forRoot(
          new SqliteOptions({ schema, filename: file, pragmas }),
        ),
  ],
  controllers: [sync ? SyncController : AsyncController],
})
class AppModule {}

const app = await HttpFactory.create(AppModule, {
  port: port(),
  requestLogging: false,
});

const handle = app.get<BunSQLiteDatabase<Schema>>(
  sync ? SyncDatabase : BunSQLiteDatabase,
);
handle.run(sql`CREATE TABLE ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memo TEXT NOT NULL,
  amount INTEGER NOT NULL
)`);
for (let index = 0; index < ROWS; index += 1) {
  handle
    .insert(ledger)
    .values({ memo: `row ${index}`, amount: index })
    .run();
}

await app.listen();
