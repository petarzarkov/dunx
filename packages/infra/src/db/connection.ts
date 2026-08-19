import type { AbstractCtor, OnShutdown } from '@dunx/core';
import { DatabaseError } from './errors.js';
import type { Casing, Logger as QueryLogger } from 'drizzle-orm';
import type { BackendName, DialectName } from './dialect.js';

/**
 * The drizzle-owned half of a connection's options. Not this package's to
 * interpret: both backends' init types extend it and forward it to `drizzle()`
 * verbatim, which is what makes `casing` and the query logger reachable from
 * inside the container rather than only from a hand-built handle.
 */
export interface DrizzleInit {
  /**
   * How a column with no explicit name is spelled in SQL. `'snake_case'` is the
   * drizzle idiom, and it has to agree with `drizzle.config.ts` - drizzle-kit
   * generates migrations from the config, the handle queries with this.
   */
  readonly casing?: Casing;
  /**
   * `true` writes every query to the console. An object with `logQuery` sends it
   * anywhere instead, core's `Logger` included, which is how a slow endpoint gets
   * diagnosed without a proxy in front of the database.
   */
  readonly logger?: boolean | QueryLogger;
}

/**
 * The keys that were actually set. `exactOptionalPropertyTypes` separates an
 * absent `casing` from one explicitly `undefined`, and drizzle's config accepts
 * only the first.
 */
export const drizzleOptions = (init: {
  readonly casing: Casing | undefined;
  readonly logger: boolean | QueryLogger | undefined;
}): DrizzleInit => ({
  ...(init.casing === undefined ? {} : { casing: init.casing }),
  ...(init.logger === undefined ? {} : { logger: init.logger }),
});

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
   * A round trip, for a health check. Throws if the connection is unusable.
   *
   * Here rather than in `@dunx/http`'s health module because a round trip is
   * dialect-specific and this is what knows the dialect. It also keeps the
   * `drizzle-orm` peer where it already is: an indicator building its own `sql`
   * tag would put drizzle into the web layer. `@dunx/http`'s `QueryProbe` is
   * satisfied by this method structurally, with no adapter, which is why neither
   * package depends on the other.
   *
   * **Concrete rather than abstract, and that is a deliberate trade.** `abstract`
   * would be the honest shape and it would break every connection an app has
   * subclassed, for one method, in a package that versions in lockstep. So the base
   * throws instead. The blast radius is what makes it acceptable: this is reached
   * only by an app that opts into `DatabaseIndicator`, and it says exactly what to
   * do rather than reporting a connection healthy without having checked.
   */
  async ping(): Promise<void> {
    await Promise.resolve();
    throw new DatabaseError(
      `${this.constructor.name} does not implement ping(), so its health cannot be ` +
        'checked. Override it with a round trip your dialect understands, such as ' +
        'a `select 1`.',
    );
  }

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
