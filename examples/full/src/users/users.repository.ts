import { SyncDatabase, toDatabaseError } from '@dunx/infra/db';
import { eq, like, sql } from 'drizzle-orm';
import * as schema from '../database/schema.js';
import { users, type User } from '../database/schema.js';

export type { User };

export class UsersRepository {
  /**
   * Every method is `async` although bun-sqlite executes synchronously, so moving
   * this table to the pooled backend costs no signature change.
   * `Ledger.transferSync` is what refusing that trade looks like.
   */
  constructor(private readonly db: SyncDatabase<typeof schema>) {}

  async migrate(): Promise<void> {
    this.db.run(sql`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    )`);
  }

  /** `name` is UNIQUE, so a repeat boot is a no-op. */
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

  /**
   * `name` is UNIQUE, so a repeat is a conflict rather than a server fault.
   * `toDatabaseError` turns the driver's `SQLITE_CONSTRAINT_UNIQUE` into a
   * `ConstraintError` carrying 409, and `@dunx/http` reads the status off it -
   * no error filter, and nothing here knows what a Response is.
   */
  async create(name: string): Promise<User> {
    try {
      return this.db.insert(users).values({ name }).returning().get();
    } catch (error) {
      throw toDatabaseError(error);
    }
  }
}
