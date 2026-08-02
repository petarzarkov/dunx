import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * `sqliteTable`, from `drizzle-orm/sqlite-core`. The three dialects in this
 * example each get their own schema module, because the column builders are
 * dialect-specific - that is drizzle's design, not a dunx one, and it is why the
 * three folders here are siblings rather than one parameterised thing.
 *
 * `typeof schema` is what flows into `BunSQLiteDatabase<typeof schema>` at every
 * injection site, so a table added here is visible to every service without being
 * registered anywhere.
 */
export const widgets = sqliteTable('widgets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  weight: integer('weight').notNull(),
});

/** Inferred, not restated: a column change here reaches every service that uses it. */
export type Widget = typeof widgets.$inferSelect;
