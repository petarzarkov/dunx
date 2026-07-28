import { Database, Dialect, type DialectName } from './contract.js';
import { DatabaseError } from './errors.js';

/**
 * Quotes a table or column name for the dialect. MySQL and MariaDB use
 * backticks; Postgres and SQLite use double quotes. An embedded quote is doubled.
 *
 * This exists because an identifier **cannot** be a bound parameter. The tagged
 * template makes values safe and portable; a table name interpolated into it is
 * neither, and this is the only correct way to place one.
 */
export const quoteIdentifier = (
  dialect: DialectName,
  identifier: string,
): string => {
  if (identifier.length === 0 || identifier.includes('\0')) {
    throw new DatabaseError(
      `${JSON.stringify(identifier)} is not a usable SQL identifier.`,
    );
  }

  return dialect === Dialect.MYSQL || dialect === Dialect.MARIADB
    ? `\`${identifier.replaceAll('`', '``')}\``
    : `"${identifier.replaceAll('"', '""')}"`;
};

/**
 * Optional base for repositories. Extending it is worth one line because a
 * subclass that declares no constructor of its own inherits this one — and
 * `@dunx/core` reads constructor dependencies through the prototype chain, so
 * the container injects `Database` into a class with no constructor at all:
 *
 * ```ts
 * export class UsersRepository extends Repository {
 *   findAll() {
 *     // Note `all`, not the tagged template: a `${}` in the template becomes a
 *     // bound parameter, and an identifier cannot be one.
 *     return this.db.all(`SELECT * FROM ${this.table('users')}`);
 *   }
 * }
 * ```
 *
 * Injecting `Database` directly is equally supported; nothing requires this.
 */
export abstract class Repository {
  constructor(protected readonly db: Database) {}

  /** `quoteIdentifier` bound to the connected dialect. */
  protected table(identifier: string): string {
    return quoteIdentifier(this.db.dialect, identifier);
  }
}
