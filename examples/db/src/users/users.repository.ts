import { Database, Repository } from '@dunx/db';

export interface User {
  id: number;
  name: string;
  email: string;
}

/**
 * No constructor of its own. `Repository` declares `(db: Database)` and
 * `@dunx/core` reads constructor dependencies along the prototype chain, so the
 * container injects the connection into a class that declares nothing.
 */
export class UsersRepository extends Repository {
  /** `table()` quotes for the connected dialect — an identifier cannot be a bound parameter. */
  get users(): string {
    return this.table('users');
  }

  /**
   * The same repository against a transaction handle. Inside `transaction(fn)`
   * every statement has to go through `tx`; on a pooled backend the injected
   * `Database` would take a different connection and sit outside the transaction.
   */
  with(db: Database): UsersRepository {
    return new UsersRepository(db);
  }

  async createSchema(): Promise<void> {
    await this.db.exec(`
      CREATE TABLE ${this.users} (
        id    INTEGER PRIMARY KEY,
        name  TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE
      )
    `);
  }

  /** The tagged template binds values; the same literal works on Postgres. */
  async insert(name: string, email: string): Promise<number> {
    const { lastInsertRowid } = await this.db.sql`
      INSERT INTO users (name, email) VALUES (${name}, ${email})
    `.run();
    return Number(lastInsertRowid);
  }

  findAll(): Promise<readonly User[]> {
    return this.db.all<User>(`SELECT * FROM ${this.users} ORDER BY id`);
  }

  findByEmail(email: string): Promise<User | null> {
    return this.db.sql<User>`SELECT * FROM users WHERE email = ${email}`.get();
  }

  async count(): Promise<number> {
    const row = await this.db.get<{ n: number }>(
      `SELECT count(*) AS n FROM ${this.users}`,
    );
    return row?.n ?? 0;
  }
}
