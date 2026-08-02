import { integer, pgTable, serial, text } from 'drizzle-orm/pg-core';

/** `pgTable`, from `drizzle-orm/pg-core`. `serial` is Postgres's autoincrement. */
export const widgets = pgTable('widgets', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  weight: integer('weight').notNull(),
});

export type Widget = typeof widgets.$inferSelect;
