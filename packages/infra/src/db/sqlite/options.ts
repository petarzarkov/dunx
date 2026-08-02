import { Database as BunSqlite, type DatabaseOptions } from 'bun:sqlite';
import type { AbstractCtor } from '@dunx/core';
import { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { DbOptions } from '../connection.js';
import {
  Backend,
  Dialect,
  type BackendName,
  type DialectName,
} from '../dialect.js';
import { DatabaseError } from '../errors.js';
import {
  SqliteConnection,
  SyncDatabase,
  SyncSqliteConnection,
} from './connection.js';

export interface SqliteInit<TSchema extends Record<string, unknown>> {
  /**
   * The drizzle schema — `import * as schema from './schema.js'`. Required, and
   * the reason it is: it is the type argument that flows all the way to
   * `BunSQLiteDatabase<typeof schema>` at the injection site. Pass `{}` if you
   * only run `sql` templates.
   */
  readonly schema: TSchema;
  /** `':memory:'`, a path, or a `sqlite:`/`file:` URL. Defaults to `':memory:'`. */
  readonly filename?: string | URL;
  /** Opens `SQLITE_OPEN_READONLY`. Suppresses `create`. */
  readonly readOnly?: boolean;
  /**
   * Create the file if it is missing. Default `true` — and `false` does not
   * currently stop it: `new Database(path, { create: false })` still creates a
   * missing file on Bun 1.3.14. Use `readOnly` if the file must already exist.
   */
  readonly create?: boolean;
  /**
   * Default `true`, unlike the driver — and unlike what drizzle opens for you.
   * Strict mode turns an unsupported binding into a `TypeError` instead of a
   * silent `NULL`, which is what a raw `Date` in a `sql` template would otherwise
   * become.
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

/**
 * Everything the two `bun:sqlite` modes share: the normalised init, the driver
 * options, and opening the driver. Exported only because the emitted declarations
 * name it — `SqliteOptions` and `SyncSqliteOptions` are what an app constructs.
 *
 * They are siblings rather than one class with a `mode` flag because the mode
 * decides `TDb`, and `TDb` is what `DbModule.forRoot` infers the injection token
 * from. A flag would leave that inference with a union to guess at.
 */
export abstract class SqliteSettings<
  TSchema extends Record<string, unknown>,
  TDb,
> extends DbOptions<TDb> {
  override readonly backend: BackendName = Backend.SQLITE;
  override readonly dialect: DialectName = Dialect.SQLITE;

  readonly schema: TSchema;
  readonly filename: string;
  readonly readOnly: boolean;
  readonly create: boolean;
  readonly strict: boolean;
  readonly safeIntegers: boolean;
  readonly pragmas: readonly string[];

  constructor(init: SqliteInit<TSchema>) {
    super();
    this.schema = init.schema;
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
   * The open call and the pragmas, which run before the handle is visible to
   * anything. Nothing here blocks — `open()` is a promise only because
   * `DbOptions` has to describe `Bun.SQL`'s handshake as well.
   */
  protected openDriver(): BunSqlite {
    const driver = new BunSqlite(this.filename, this.toDriverOptions());
    for (const pragma of this.pragmas) driver.exec(`PRAGMA ${pragma}`);
    return driver;
  }
}

/**
 * Configuration for the `bun:sqlite` backend. A class, so it is injectable.
 *
 * This is the asynchronous mode and the default one: `transaction()` returns a
 * promise and takes a callback that may await. `SyncSqliteOptions` is the other
 * mode.
 */
export class SqliteOptions<
  TSchema extends Record<string, unknown>,
> extends SqliteSettings<TSchema, BunSQLiteDatabase<TSchema>> {
  /**
   * drizzle's database classes are real runtime classes, not interfaces, so the
   * class *is* the token. That is the whole trick behind injecting a
   * schema-generic handle: `@dunx/transform` records the bare type name from
   * `db: BunSQLiteDatabase<typeof schema>` and ignores the type argument, so the
   * token is the erased class while the schema types stay on the annotation.
   */
  override readonly token: AbstractCtor<BunSQLiteDatabase<TSchema>> =
    BunSQLiteDatabase;

  /** `async` only to satisfy the contract; opening a SQLite file does not block. */
  override async open(): Promise<SqliteConnection<TSchema>> {
    return new SqliteConnection(this.openDriver(), this.schema);
  }
}

/**
 * The same configuration, opened in **synchronous mode**.
 *
 * Every init field is `SqliteOptions`'s. What changes is the handle: services are
 * given a `SyncDatabase`, which is the only thing `transactionSync()` accepts, and
 * which the container will not hand to a service that asked for the async one.
 *
 * ```ts
 * DbModule.forRoot(new SyncSqliteOptions({ schema, filename: './dev.db' }));
 * // constructor(private readonly db: SyncDatabase<typeof schema>) {}
 * ```
 *
 * There is deliberately no `SyncSqlOptions`. `Bun.SQL` talks to a server over a
 * socket, so no amount of API design makes a Postgres query return a row instead
 * of a promise.
 */
export class SyncSqliteOptions<
  TSchema extends Record<string, unknown>,
> extends SqliteSettings<TSchema, SyncDatabase<TSchema>> {
  override readonly token: AbstractCtor<SyncDatabase<TSchema>> = SyncDatabase;

  /**
   * What `open()` actually does. Exposed because in this mode there is nothing
   * asynchronous left to hide: a test, or a script with no container, can open,
   * query and close without a single `await`.
   */
  openSync(): SyncSqliteConnection<TSchema> {
    return new SyncSqliteConnection(this.openDriver(), this.schema);
  }

  override async open(): Promise<SyncSqliteConnection<TSchema>> {
    return this.openSync();
  }
}
