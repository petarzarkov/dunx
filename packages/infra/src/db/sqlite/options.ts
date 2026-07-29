import { Database as BunSqlite, type DatabaseOptions } from 'bun:sqlite';
import {
  Backend,
  DbOptions,
  type BackendName,
  type Database,
} from '../contract.js';
import { DatabaseError } from '../errors.js';
import { SqliteDatabase } from './database.js';

export interface SqliteInit {
  /** `':memory:'`, a path, or a `sqlite:`/`file:` URL. Defaults to `':memory:'`. */
  readonly filename?: string | URL;
  /** Opens `SQLITE_OPEN_READONLY`. Suppresses `create`. */
  readonly readOnly?: boolean;
  /** Create the file if it is missing. Default `true`. */
  readonly create?: boolean;
  /**
   * Default `true`, unlike the driver. Strict mode makes a missing binding an
   * error instead of a silent `NULL`, and lets named parameters be written
   * without the `$` prefix. Only observable through `raw` — the contract binds
   * positionally.
   */
  readonly strict?: boolean;
  /** Return integers as `bigint` rather than truncating to 53 bits. */
  readonly safeIntegers?: boolean;
  /**
   * Run once, immediately after opening, each prefixed with `PRAGMA`. The only
   * place `journal_mode = WAL` can be set before the first query.
   */
  readonly pragmas?: readonly string[];
}

/**
 * Bun accepts `sqlite://./dev.db`, `file:./dev.db` and a bare path, but
 * `bun:sqlite` itself only takes a path — so the scheme comes off here. A bare
 * `:memory:` has no scheme and passes through untouched.
 */
const toPath = (filename: string | URL): string => {
  const raw = filename instanceof URL ? filename.href : filename;
  const stripped = /^(?:sqlite|file):(?:\/\/)?(.*)$/.exec(raw)?.[1] ?? raw;

  if (stripped.length === 0) {
    throw new DatabaseError(
      `"${raw}" names no SQLite database. Use ':memory:', a path, or a ` +
        'sqlite:// URL with one — for example sqlite://./dev.db.',
    );
  }
  return stripped;
};

/** Configuration for the `bun:sqlite` backend. A class, so it is injectable. */
export class SqliteOptions extends DbOptions {
  override readonly backend: BackendName = Backend.SQLITE;

  readonly filename: string;
  readonly readOnly: boolean;
  readonly create: boolean;
  readonly strict: boolean;
  readonly safeIntegers: boolean;
  readonly pragmas: readonly string[];

  constructor(init: SqliteInit = {}) {
    super();
    this.filename = toPath(init.filename ?? ':memory:');
    this.readOnly = init.readOnly ?? false;
    this.create = init.create ?? true;
    this.strict = init.strict ?? true;
    this.safeIntegers = init.safeIntegers ?? false;
    this.pragmas = init.pragmas ?? [];
  }

  /** Exactly what is handed to `new Database(...)`. */
  toDriverOptions(): DatabaseOptions {
    const options: DatabaseOptions = {
      strict: this.strict,
      safeIntegers: this.safeIntegers,
    };
    // Mutually exclusive open flags — CREATE alongside READONLY is meaningless.
    if (this.readOnly) options.readonly = true;
    else options.create = this.create;
    return options;
  }

  /**
   * `async` only to satisfy the contract; opening a SQLite file does not block.
   * The pragmas run before the returned handle is visible to anything.
   */
  override async open(): Promise<Database> {
    const driver = new BunSqlite(this.filename, this.toDriverOptions());
    for (const pragma of this.pragmas) driver.exec(`PRAGMA ${pragma}`);
    return new SqliteDatabase(driver);
  }
}
