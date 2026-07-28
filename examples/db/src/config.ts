import { SqlOptions, SqliteOptions, type DbOptionsInput } from '@dunx/db';

/**
 * A class, not a token — it is a runtime value, so it self-binds and any
 * constructor can name it.
 */
export class Config {
  /** Unset in CI, which is the point: the example must run with no server. */
  readonly databaseUrl = process.env['DATABASE_URL'];

  /**
   * Options are classes, so which one you construct is what selects the backend.
   * `bun:sqlite` at `:memory:` needs nothing installed.
   */
  options(): DbOptionsInput {
    return this.databaseUrl
      ? new SqlOptions({ url: this.databaseUrl, max: 4 })
      : new SqliteOptions({ filename: ':memory:' });
  }
}
