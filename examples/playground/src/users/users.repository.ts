import { Repository } from '@dunx/infra/db';

export interface User {
  readonly id: number;
  readonly name: string;
}

/**
 * No constructor of its own. `Repository` declares `Database`, and dunx reads
 * constructor dependencies along the prototype chain — so this class has the
 * connection injected while declaring nothing.
 *
 * Note `all`/`get`/`run` rather than the tagged template for the table name: a
 * `${}` in the template becomes a bound *value*, and an identifier cannot be one.
 * `this.table()` is `quoteIdentifier` bound to the connected dialect.
 */
export class UsersRepository extends Repository {
  async migrate(): Promise<void> {
    await this.db.exec(
      `CREATE TABLE IF NOT EXISTS ${this.table('users')} (` +
        'id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE)',
    );
  }

  async seed(names: readonly string[]): Promise<void> {
    for (const name of names) {
      await this.db.run(
        `INSERT OR IGNORE INTO ${this.table('users')} (name) VALUES (?)`,
        [name],
      );
    }
  }

  findAll(limit: number, q?: string): Promise<readonly User[]> {
    return this.db.all<User>(
      `SELECT id, name FROM ${this.table('users')} ` +
        'WHERE name LIKE ? ORDER BY id LIMIT ?',
      [q === undefined ? '%' : `%${q}%`, limit],
    );
  }

  /** `null` rather than `undefined` when there is no row. */
  find(id: number): Promise<User | null> {
    return this.db.get<User>(
      `SELECT id, name FROM ${this.table('users')} WHERE id = ?`,
      [id],
    );
  }

  async create(name: string): Promise<User> {
    const { lastInsertRowid } = await this.db.run(
      `INSERT INTO ${this.table('users')} (name) VALUES (?)`,
      [name],
    );
    return { id: Number(lastInsertRowid), name };
  }
}
