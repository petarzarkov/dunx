import { int, mysqlTable, varchar } from 'drizzle-orm/mysql-core';

/**
 * `mysqlTable`, from `drizzle-orm/mysql-core`. MySQL has no `TEXT` primary key
 * story worth using and no `RETURNING`, so `varchar` and an autoincrement `int`
 * are the idiomatic pair here.
 */
export const widgets = mysqlTable('widgets', {
  id: int('id').primaryKey().autoincrement(),
  name: varchar('name', { length: 128 }).notNull(),
  weight: int('weight').notNull(),
});

export type Widget = typeof widgets.$inferSelect;
