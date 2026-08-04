import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import * as schema from '../schema.js';
import { ledger } from '../schema.js';

/**
 * A seed that belongs in one environment. A refused seed is *not* journaled, so it
 * still runs the first time it reaches somewhere it does belong.
 */
export const when = (env: string): boolean => env === 'production';

export function seed(db: BunSQLiteDatabase<typeof schema>): void {
  db.insert(ledger).values({ memo: 'seeded: opening audit', amount: 0 }).run();
}
