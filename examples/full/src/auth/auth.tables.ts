import { Logger, type OnInit } from '@dunx/core';
import { SyncDatabase } from '@dunx/infra/db';
import { sql } from 'drizzle-orm';
import * as schema from '../database/schema.js';

/**
 * better-auth's tables, created at `onInit` because a `:memory:` database has
 * nowhere to keep a migration journal. A real app runs
 * `bunx @better-auth/cli generate` and then `drizzle-kit`.
 *
 * One statement per entry: `db.run` goes through `bun:sqlite`'s `prepare`, which
 * compiles one statement and silently drops whatever follows the first semicolon.
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

  /** `onInit` rather than the module factory: `betterAuth()` queries nothing when
   * built, and this still runs before `listen()` binds. */
  onInit(): void {
    for (const table of TABLES) this.db.run(table);
    this.logger.info(`better-auth tables created (${TABLES.length})`);
  }
}
