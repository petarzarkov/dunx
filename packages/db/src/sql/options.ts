import {
  Backend,
  Dialect,
  DbOptions,
  type BackendName,
  type Database,
  type DialectName,
} from '../contract.js';
import { DatabaseError } from '../errors.js';
import { SqlDatabase } from './database.js';

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
 * Postgres host — `new Bun.SQL({ url: './dev.db' })` reports `adapter:
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
        `${Object.keys(SCHEMES).join(', ')} — note that pg:// is not supported.`,
    );
  }
  return dialect;
};

/**
 * Extends the driver's own option type rather than restating it, so pooling, TLS
 * and auth stay in sync with whatever Bun supports. `url` is required and
 * `adapter` is dropped — the URL scheme already decides it.
 */
export interface SqlInit extends Omit<
  Bun.SQL.PostgresOrMySQLOptions,
  'url' | 'adapter'
> {
  readonly url: string | URL;
}

/** Configuration for the `Bun.SQL` backend. A class, so it is injectable. */
export class SqlOptions extends DbOptions {
  override readonly backend: BackendName = Backend.SQL;

  readonly url: string;
  /** Derived from the URL scheme at construction, so a bad URL fails before any I/O. */
  readonly dialect: DialectName;
  readonly #init: SqlInit;

  constructor(init: SqlInit) {
    super();
    this.url = init.url instanceof URL ? init.url.href : init.url;
    this.dialect = dialectFromUrl(this.url);
    this.#init = init;
  }

  /** Exactly what is handed to `new Bun.SQL(...)`. */
  toDriverOptions(): Bun.SQL.Options {
    return { ...this.#init, url: this.url };
  }

  /**
   * The handshake is awaited here rather than deferred to the first query.
   * `DbModule` opens through an async factory and dunx settles every factory
   * before it constructs anything, so a repository can never be handed a client
   * that has not connected.
   */
  override async open(): Promise<Database> {
    const client = new Bun.SQL(this.toDriverOptions());
    await client.connect();
    return new SqlDatabase(client, this.dialect);
  }
}
