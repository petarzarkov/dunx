import {
  DataSources,
  dbConnection,
  dbHandle,
  dbMetrics,
  dbOptions,
  SyncDatabase,
} from '@dunx/infra/db';
import type * as schema from './schema.js';

export type TenantDb = SyncDatabase<typeof schema>;

/**
 * Declared once so every injection site shares the token and the schema types.
 * All four families for one name: the handle a repository queries, the
 * connection behind it, the options it was opened from, and its query timings.
 */
export const reportingDb = dbHandle<TenantDb>('reporting');
export const reportingConnection = dbConnection<TenantDb>('reporting');
export const reportingOptions = dbOptions<TenantDb>('reporting');
export const reportingMetrics = dbMetrics('reporting');

/**
 * The pool class. A subclass is what carries `TenantDb` to the injection site:
 * `DataSources` is generic and a token carries no type argument.
 */
export class TenantSources extends DataSources<TenantDb> {}
