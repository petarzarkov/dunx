import type { DynamicModule } from '@dunx/core';
import { DbModule, SqlOptions } from '@dunx/infra/db';
import * as schema from './schema.js';
import { PostgresWidgets } from './widgets.service.js';

/**
 * Postgres, in five lines of configuration.
 *
 * `SqlInit` extends `Bun.SQL`'s own option type rather than restating it, so
 * pooling, TLS and auth stay in sync with whatever Bun supports — `max`,
 * `idleTimeout`, `tls` and the rest are all accepted here.
 *
 * The dialect is resolved from the URL **at construction**, so a bad URL throws
 * before any I/O, and a non-Postgres one throws with a message saying why:
 * `drizzle-orm/bun-sql` builds a `PgDialect` unconditionally, so it would compile
 * `$1` placeholders and Postgres quoting against a server that does not speak them.
 *
 * The handshake is awaited inside `open()` rather than deferred to the first
 * query. dunx settles every async factory before it constructs anything, so a
 * repository can never be handed a client that has not connected — there is no
 * lazy connect and no `await db.ready()`.
 */
export class PostgresModule {
  static forUrl(url: string): DynamicModule {
    return {
      module: PostgresModule,
      imports: [
        DbModule.forRoot(
          new SqlOptions({ schema, url, max: 4, connectionTimeout: 5 }),
        ),
      ],
      providers: [PostgresWidgets],
    };
  }
}
