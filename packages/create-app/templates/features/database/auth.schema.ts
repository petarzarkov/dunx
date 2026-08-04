import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * better-auth's four tables, plus the columns its `admin` plugin adds. **Generated,
 * not written**: `bunx @better-auth/cli generate` emits this from the very options
 * `AuthModule` is configured with, which is why `@dunx/auth` ships no copy - the
 * shape follows the plugins an app enables.
 *
 * They live in the app's one schema module, so `drizzle({ client, schema })` carries
 * them and `drizzleDatabase(connection)` needs no schema argument.
 */
const stamp = () =>
  integer({ mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date());

export const user = sqliteTable('user', {
  id: text().primaryKey(),
  name: text().notNull(),
  email: text().notNull().unique(),
  emailVerified: integer({ mode: 'boolean' }).notNull().default(false),
  image: text(),
  /** `admin` plugin. Comma-separated for more than one - `rolesOf` splits it. */
  role: text(),
  banned: integer({ mode: 'boolean' }),
  banReason: text(),
  banExpires: integer({ mode: 'timestamp_ms' }),
  createdAt: stamp(),
  updatedAt: stamp(),
});

export const session = sqliteTable('session', {
  id: text().primaryKey(),
  token: text().notNull().unique(),
  userId: text()
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  expiresAt: integer({ mode: 'timestamp_ms' }).notNull(),
  ipAddress: text(),
  userAgent: text(),
  /** `admin` plugin. */
  impersonatedBy: text(),
  createdAt: stamp(),
  updatedAt: stamp(),
});

export const account = sqliteTable('account', {
  id: text().primaryKey(),
  accountId: text().notNull(),
  /** `credential` for email/password, else the social provider's id. */
  providerId: text().notNull(),
  userId: text()
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text(),
  refreshToken: text(),
  idToken: text(),
  accessTokenExpiresAt: integer({ mode: 'timestamp_ms' }),
  refreshTokenExpiresAt: integer({ mode: 'timestamp_ms' }),
  scope: text(),
  password: text(),
  createdAt: stamp(),
  updatedAt: stamp(),
});

export const verification = sqliteTable('verification', {
  id: text().primaryKey(),
  identifier: text().notNull(),
  value: text().notNull(),
  expiresAt: integer({ mode: 'timestamp_ms' }).notNull(),
  createdAt: stamp(),
  updatedAt: stamp(),
});

export type AuthUser = typeof user.$inferSelect;
