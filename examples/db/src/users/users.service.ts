import type { OnInit, OnShutdown } from '@dunx/core';
import { Database } from '@dunx/db';
import { Logger } from '../logger.js';
import { UsersRepository, type User } from './users.repository.js';

export class UsersService implements OnInit, OnShutdown {
  constructor(
    private readonly db: Database,
    private readonly repository: UsersRepository,
    private readonly logger: Logger,
  ) {}

  /**
   * The connection is already open here — `DbModule` binds it through an async
   * factory and dunx settles every factory before it constructs anything.
   */
  async onInit(): Promise<void> {
    await this.repository.createSchema();
    this.logger.info(`schema ready on ${this.db.backend}/${this.db.dialect}`);
  }

  /**
   * Runs last, before the connection closes. Shutdown is reverse construction
   * order, so this service drains while the database it depends on is still
   * usable — the query below would throw otherwise.
   */
  async onShutdown(): Promise<void> {
    this.logger.info(
      `draining with ${await this.repository.count()} row(s) left`,
    );
  }

  /** Commits: both inserts land, and the callback's value comes back out. */
  async register(...people: readonly [string, string][]): Promise<number> {
    return this.db.transaction(async (tx) => {
      const scoped = this.repository.with(tx);
      for (const [name, email] of people) {
        await scoped.insert(name, email);
      }
      return scoped.count();
    });
  }

  /** Rolls back: the insert is undone by the throw, and the throw propagates. */
  async registerAndFail(name: string, email: string): Promise<string> {
    try {
      await this.db.transaction(async (tx) => {
        await this.repository.with(tx).insert(name, email);
        throw new Error('payment declined');
      });
      return 'unexpectedly committed';
    } catch (error) {
      return error instanceof Error ? error.message : 'unknown failure';
    }
  }

  findAll(): Promise<readonly User[]> {
    return this.repository.findAll();
  }

  findByEmail(email: string): Promise<User | null> {
    return this.repository.findByEmail(email);
  }
}
