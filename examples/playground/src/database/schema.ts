import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * One schema module, because there is one connection and one drizzle handle.
 * `typeof schema` is what flows into `BunSQLiteDatabase<typeof schema>` at every
 * injection site, so a table added here is visible to every repository without
 * anything being registered anywhere.
 */
export const ledger = sqliteTable('ledger', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  memo: text('memo').notNull(),
  amount: integer('amount').notNull(),
});

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
});

/** Inferred, not restated: a column change here reaches the services that use it. */
export type Entry = typeof ledger.$inferSelect;
export type User = typeof users.$inferSelect;
