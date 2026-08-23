import type { DynamicModule } from '@dunx/core';
import { DbModule, SqlOptions } from '@dunx/infra/db';
import * as schema from './schema.js';
import { PostgresWidgets } from './widgets.service.js';

/**
 * Postgres. `SqlInit` extends `Bun.SQL`'s own option type, so `max`, `tls` and
 * the rest are accepted as Bun defines them. The dialect is resolved from the
 * URL at construction: `drizzle-orm/bun-sql` builds a `PgDialect` unconditionally
 * and would emit Postgres syntax at a server that does not speak it.
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
