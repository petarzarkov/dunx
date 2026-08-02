import { Logger, type OnInit } from '@dunx/core';
import { SyncDatabase } from '@dunx/infra/db';
import { sql } from 'drizzle-orm';
import * as schema from '../database/schema.js';

/**
 * better-auth's tables, created at `onInit` for the same reason `Ledger` creates its
 * own: a `:memory:` database has nowhere to keep a migration journal. A real app runs
 * `bunx @better-auth/cli generate` and then `drizzle-kit`, which own the SQL.
 *
 * The column names are drizzle's defaults for the schema in `database/auth.schema.ts`
 * — camelCase, because that file passes no explicit names.
 */
/**
 * One statement per entry, not one template with four. `db.run` goes through
 * `bun:sqlite`'s `prepare`, which compiles a single statement and silently drops
 * whatever follows the first semicolon — the table after it simply never exists.
 */
const TABLES = [
  sql`CREATE TABLE IF NOT EXISTS user (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    emailVerified INTEGER NOT NULL DEFAULT 0,
    image TEXT,
    role TEXT,
    banned INTEGER,
    banReason TEXT,
    banExpires INTEGER,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  )`,
  sql`CREATE TABLE IF NOT EXISTS session (
    id TEXT PRIMARY KEY NOT NULL,
    token TEXT NOT NULL UNIQUE,
    userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    expiresAt INTEGER NOT NULL,
    ipAddress TEXT,
    userAgent TEXT,
    impersonatedBy TEXT,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  )`,
  sql`CREATE TABLE IF NOT EXISTS account (
    id TEXT PRIMARY KEY NOT NULL,
    accountId TEXT NOT NULL,
    providerId TEXT NOT NULL,
    userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    accessToken TEXT,
    refreshToken TEXT,
    idToken TEXT,
    accessTokenExpiresAt INTEGER,
    refreshTokenExpiresAt INTEGER,
    scope TEXT,
    password TEXT,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  )`,
  sql`CREATE TABLE IF NOT EXISTS verification (
    id TEXT PRIMARY KEY NOT NULL,
    identifier TEXT NOT NULL,
    value TEXT NOT NULL,
    expiresAt INTEGER NOT NULL,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  )`,
];

export class AuthTables implements OnInit {
  constructor(
    private readonly db: SyncDatabase<typeof schema>,
    private readonly logger: Logger,
  ) {}

  /**
   * `onInit`, not the module factory: `betterAuth()` opens no connection and issues
   * no query when it is built, so the tables only have to exist before the first
   * request — and this runs before `listen()` binds.
   */
  onInit(): void {
    for (const table of TABLES) this.db.run(table);
    this.logger.info(`better-auth tables created (${TABLES.length})`);
  }
}
