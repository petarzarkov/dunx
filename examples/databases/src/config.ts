import { ConfigService, type ConfigSource } from '@dunx/core';

/**
 * Three URLs and nothing else. Bun loads `.env` and `.env.local` itself, so there
 * is no loader here and no `dotenv` - `ConfigModule`'s whole contract is the one
 * `validate` function below, and a hand-written one costs no dependency.
 */
export interface DatabasesConfig {
  readonly sqliteFile: string;
  readonly postgresUrl: string;
  readonly mysqlUrl: string;
}

export class DatabasesConfigService extends ConfigService<DatabasesConfig> {}

const read = (source: ConfigSource, key: string, fallback: string): string => {
  const value = source[key];
  if (value === undefined || value === '') return fallback;
  if (typeof value !== 'string') {
    throw new Error(`${key} must be a string, got ${typeof value}`);
  }
  return value;
};

export const validate = (env: ConfigSource): DatabasesConfig => ({
  // `:memory:` needs no server and leaves nothing behind, so `bun start` is clean
  // on a fresh checkout and repeatable.
  sqliteFile: read(env, 'SQLITE_FILE', ':memory:'),
  postgresUrl: read(
    env,
    'POSTGRES_URL',
    'postgres://postgres:postgres@localhost:5432/postgres',
  ),
  mysqlUrl: read(env, 'MYSQL_URL', 'mysql://root:root@localhost:3306/mysql'),
});
