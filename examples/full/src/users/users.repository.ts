import { SyncDatabase } from '@dunx/infra/db';
import { eq, like, sql } from 'drizzle-orm';
import * as schema from '../database/schema.js';
import { users, type User } from '../database/schema.js';

// The row type comes from the table, so the controller and the service import one
// definition rather than a hand-written copy of the columns.
export type { User };

export class UsersRepository {
  /**
   * `SyncDatabase` because `DatabaseModule` configured synchronous mode; it is
   * drizzle's `BunSQLiteDatabase` with a name the container can tell apart.
   * `@dunx/transform` records the bare type name — a real runtime class, so a usable
   * token — and ignores the type argument, so the schema types survive injection.
   *
   * Every method below is `async` although bun-sqlite executes synchronously: the
   * HTTP layer awaits them, and moving this table to the pooled backend then costs
   * no signature change. `Ledger.transferSync` is what refusing that trade looks
   * like.
   */
  constructor(private readonly db: SyncDatabase<typeof schema>) {}

  async migrate(): Promise<void> {
    this.db.run(sql`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    )`);
  }

  /** One statement for every name; `name` is UNIQUE, so a repeat boot is a no-op. */
  async seed(names: readonly string[]): Promise<void> {
    this.db
      .insert(users)
      .values(names.map((name) => ({ name })))
      .onConflictDoNothing()
      .run();
  }

  async findAll(limit: number, q?: string): Promise<readonly User[]> {
    return this.db
      .select()
      .from(users)
      .where(like(users.name, q === undefined ? '%' : `%${q}%`))
      .orderBy(users.id)
      .limit(limit)
      .all();
  }

  /** `.get()` is `undefined` for no row; the controller's 404 turns on `null`. */
  async find(id: number): Promise<User | null> {
    return this.db.select().from(users).where(eq(users.id, id)).get() ?? null;
  }

  /** `.returning()`, so the id is the one the database wrote. */
  async create(name: string): Promise<User> {
    return this.db.insert(users).values({ name }).returning().get();
  }
}
