import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * One schema, used by every tenant database and by the reporting one. A tenant
 * database holds that tenant's rows only; the reporting database holds the
 * rollups written across all of them.
 */
export const tickets = sqliteTable('tickets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  subject: text('subject').notNull(),
});

export const rollups = sqliteTable('rollups', {
  tenant: text('tenant').primaryKey(),
  tickets: integer('tickets').notNull(),
});

export type Ticket = typeof tickets.$inferSelect;
export type Rollup = typeof rollups.$inferSelect;
