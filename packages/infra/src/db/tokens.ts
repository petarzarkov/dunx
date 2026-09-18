import { token, type Token } from '@dunx/core';
import type { DbConnection, DbOptions } from './connection.js';
import type { QueryMetrics } from './metrics.js';

/**
 * One cache for all four families, keyed by the description, which already
 * carries the family and the name. `token()` returns a fresh object per call, so
 * without this the module and its consumer would hold different tokens for one
 * name and the lookup would miss.
 */
const cache = new Map<string, Token<unknown>>();

export const namedToken = <T>(description: string): Token<T> => {
  const existing = cache.get(description);
  if (existing !== undefined) return existing as Token<T>;
  const created = token<T>(description);
  cache.set(description, created);
  return created as Token<T>;
};

/**
 * The lifecycle and driver handle of the data source registered under `name`,
 * the counterpart of `DbConnection` for a default registration.
 *
 * A `Token` is not a constructor type, so reach it with `inject()`:
 *
 * ```ts
 * class Reports {
 *   readonly connection = inject(dbConnection('reports'));
 * }
 * ```
 */
export const dbConnection = <TDb = unknown>(
  name: string,
): Token<DbConnection<TDb>> => namedToken(`DbConnection(${name})`);

/**
 * The drizzle handle of the data source registered under `name`. The type
 * argument is what keeps drizzle's inference, so declare the token once and
 * inject that:
 *
 * ```ts
 * export const reportsDb = dbHandle<BunSQLDatabase<typeof schema>>('reports');
 *
 * class Reports {
 *   readonly db = inject(reportsDb);
 * }
 * ```
 *
 * A named registration binds this rather than drizzle's own class: two of them on
 * one backend would otherwise both claim `BunSQLDatabase` and the importer would
 * silently see one of them.
 */
export const dbHandle = <TDb>(name: string): Token<TDb> =>
  namedToken(`DbHandle(${name})`);

/** The resolved configuration of the data source registered under `name`. */
export const dbOptions = <TDb = unknown>(name: string): Token<DbOptions<TDb>> =>
  namedToken(`DbOptions(${name})`);

/**
 * The {@link QueryMetrics} of the registration named `name`, bound only when its
 * settings asked for metrics. A default registration binds the class itself; a
 * named one cannot, or two registrations would bind `QueryMetrics` twice.
 */
export const dbMetrics = (name: string): Token<QueryMetrics> =>
  namedToken(`QueryMetrics(${name})`);
