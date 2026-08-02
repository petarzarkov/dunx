import { DatabaseError } from './errors.js';

/**
 * The four dialects `Bun.SQL` accepts. Taken from Bun's own rejection message -
 * `new Bun.SQL('oracle://…')` throws with exactly this list.
 *
 * Bun accepting a dialect is not the same as this package supporting it; see
 * `SqlOptions`, which takes Postgres only.
 */
export const Dialect = Object.freeze({
  POSTGRES: 'postgres',
  MYSQL: 'mysql',
  MARIADB: 'mariadb',
  SQLITE: 'sqlite',
} as const);

export type DialectName = (typeof Dialect)[keyof typeof Dialect];

export const Backend = Object.freeze({
  /** `drizzle-orm/bun-sqlite` over `bun:sqlite` - embedded, no server, synchronous underneath. */
  SQLITE: 'sqlite',
  /** `drizzle-orm/bun-sql` over `Bun.SQL` - pooled, asynchronous, Postgres. */
  SQL: 'sql',
} as const);

export type BackendName = (typeof Backend)[keyof typeof Backend];

/**
 * Every scheme `Bun.SQL` resolves, verified against Bun 1.3.14. `pg://` is *not*
 * one of them, despite being common elsewhere.
 */
const SCHEMES: Readonly<Record<string, DialectName>> = Object.freeze({
  'postgres:': Dialect.POSTGRES,
  'postgresql:': Dialect.POSTGRES,
  'mysql:': Dialect.MYSQL,
  'mariadb:': Dialect.MARIADB,
  'sqlite:': Dialect.SQLITE,
  'file:': Dialect.SQLITE,
});

/**
 * Which dialect a connection URL names.
 *
 * This is stricter than Bun on purpose. Bun reads a *schemeless* string as a
 * Postgres host - `new Bun.SQL({ url: './dev.db' })` reports `adapter:
 * 'postgres'` and then fails at connect time with a socket error. Rejecting it
 * here turns that into a message about the URL.
 */
export const dialectFromUrl = (url: string | URL): DialectName => {
  const href = url instanceof URL ? url.href : url;
  const end = href.indexOf(':');
  const scheme = end === -1 ? '' : href.slice(0, end + 1).toLowerCase();
  const dialect = SCHEMES[scheme];

  if (!dialect) {
    throw new DatabaseError(
      `"${href}" is not a connection URL Bun.SQL understands. Expected one of ` +
        `${Object.keys(SCHEMES).join(', ')} - note that pg:// is not supported.`,
    );
  }
  return dialect;
};
