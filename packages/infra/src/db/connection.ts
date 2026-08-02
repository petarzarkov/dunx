import type { AbstractCtor, OnShutdown } from '@dunx/core';
import type { BackendName, DialectName } from './dialect.js';

/**
 * What owns the socket or the file handle.
 *
 * drizzle is the interface for *querying* - this package adds no query
 * abstraction over it. But a drizzle handle has no `close()` and no lifecycle
 * hook, so something has to hold the driver, know how to shut it down, and hand
 * the raw handle back. That is all this is: no `sql`, no `all`, no `get`, no
 * `run`. Those are drizzle's.
 *
 * It is an abstract class rather than an interface so it is an injection token -
 * `constructor(private readonly connection: DbConnection)` is how a service
 * reaches `raw` without knowing which backend is configured.
 */
export abstract class DbConnection<TDb = unknown> implements OnShutdown {
  abstract readonly backend: BackendName;
  abstract readonly dialect: DialectName;

  /**
   * The drizzle handle. Bound in the container under drizzle's own class -
   * `BunSQLiteDatabase` or `BunSQLDatabase` - so a repository injects the real
   * thing rather than a wrapper.
   */
  abstract readonly db: TDb;

  /**
   * The driver handle underneath drizzle: a `bun:sqlite` `Database` or a
   * `Bun.SQL` client. `unknown` here because the base cannot promise either -
   * narrow with `instanceof SqliteConnection` / `instanceof SqlConnection`, which
   * restores the concrete type.
   */
  abstract readonly raw: unknown;

  /** Idempotent. */
  abstract close(): Promise<void>;

  /**
   * Concrete, not abstract: the hook and the explicit call are one operation.
   * `@dunx/core` shuts down in reverse construction order, and every repository
   * depends on the drizzle handle which depends on this - so everything holding
   * the connection has already drained by the time this fires.
   */
  async onShutdown(): Promise<void> {
    await this.close();
  }
}

/**
 * Configuration, and the thing that knows how to act on it. `open()` lives here
 * rather than in a `switch` inside `DbModule`, so adding a backend is not an edit
 * to a dispatch table.
 */
export abstract class DbOptions<TDb = unknown> {
  abstract readonly backend: BackendName;
  abstract readonly dialect: DialectName;

  /**
   * The token the drizzle handle is bound to. drizzle's database classes are real
   * runtime classes, so they are usable as tokens directly - which is what lets a
   * repository annotate `BunSQLiteDatabase<typeof schema>` and get both the token
   * (the erased class name) and the schema types (the type argument).
   */
  abstract readonly token: AbstractCtor<TDb>;

  abstract open(): Promise<DbConnection<TDb>>;
}
