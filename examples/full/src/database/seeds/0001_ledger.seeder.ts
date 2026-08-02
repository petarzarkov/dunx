import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import * as schema from '../schema.js';
import { ledger } from '../schema.js';

/**
 * The handle is already inside a transaction that also writes the journal row, so a
 * throw in here leaves neither the data nor the record - and the file is retried on
 * the next boot.
 */
export function seed(db: BunSQLiteDatabase<typeof schema>): void {
  db.insert(ledger).values({ memo: 'seeded: audit fee', amount: -7 }).run();
}
