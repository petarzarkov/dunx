import {
  DataSources,
  dbConnection,
  dbHandle,
  SyncDatabase,
} from '@dunx/infra/db';
import type * as schema from './schema.js';

export type TenantDb = SyncDatabase<typeof schema>;

/** Declared once so every injection site shares the token and the schema types. */
export const reportingDb = dbHandle<TenantDb>('reporting');
export const reportingConnection = dbConnection<TenantDb>('reporting');

/**
 * The pool class. A subclass is what carries `TenantDb` to the injection site:
 * `DataSources` is generic and a token carries no type argument.
 */
export class TenantSources extends DataSources<TenantDb> {}
