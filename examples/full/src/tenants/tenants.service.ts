import { inject, Logger, type OnInit } from '@dunx/core';
import { transactionSync } from '@dunx/infra/db';
import { count, eq, sql } from 'drizzle-orm';
import { reportingDb, TenantSources, type TenantDb } from './sources.js';
import { rollups, tickets, type Rollup, type Ticket } from './schema.js';

const CREATE_TICKETS = sql`CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject TEXT NOT NULL
)`;

const CREATE_ROLLUPS = sql`CREATE TABLE IF NOT EXISTS rollups (
  tenant TEXT PRIMARY KEY,
  tickets INTEGER NOT NULL
)`;

/**
 * A database per tenant, resolved from a key the caller passes rather than from
 * anything ambient, plus one named reporting database that every tenant rolls up
 * into. Nothing here holds a current tenant, so two concurrent requests cannot
 * read each other's rows.
 */
export class Tenants implements OnInit {
  /** `reportingDb` is a `Token`, so a field initialiser rather than a parameter. */
  private readonly reporting = inject(reportingDb);

  constructor(
    private readonly sources: TenantSources,
    private readonly logger: Logger,
  ) {}

  /** Standing in for a migration, which a `:memory:` database cannot keep. */
  async onInit(): Promise<void> {
    this.reporting.run(CREATE_ROLLUPS);
  }

  /**
   * `use` rather than `get`: it holds the tenant's data source open for the
   * duration, so a pool at `max` evicts some other tenant and never this one.
   */
  async open(tenant: string, subject: string): Promise<Ticket> {
    return this.sources.use(tenant, (db) => {
      db.run(CREATE_TICKETS);
      return db.insert(tickets).values({ subject }).returning().get();
    });
  }

  async list(tenant: string): Promise<readonly Ticket[]> {
    return this.sources.use(tenant, (db) => {
      db.run(CREATE_TICKETS);
      return db.select().from(tickets).orderBy(tickets.id).all();
    });
  }

  /** Counts in the tenant's database, writes the total to the reporting one. */
  async rollUp(tenant: string): Promise<Rollup> {
    const total = await this.sources.use(tenant, (db) => {
      db.run(CREATE_TICKETS);
      return db.select({ n: count() }).from(tickets).get()?.n ?? 0;
    });

    return transactionSync(this.reporting, (tx) => {
      tx.insert(rollups)
        .values({ tenant, tickets: total })
        .onConflictDoUpdate({ target: rollups.tenant, set: { tickets: total } })
        .run();
      return tx
        .select()
        .from(rollups)
        .where(eq(rollups.tenant, tenant))
        .get() as Rollup;
    });
  }

  reported(): readonly Rollup[] {
    return this.reporting.select().from(rollups).orderBy(rollups.tenant).all();
  }

  /** What the pool is holding: which keys are live, and how many it may hold. */
  live(): { keys: readonly string[]; size: number } {
    return { keys: this.sources.keys(), size: this.sources.size };
  }

  /** A deprovisioned tenant, closed and forgotten rather than left to idle out. */
  async release(tenant: string): Promise<boolean> {
    const evicted = await this.sources.evict(tenant);
    if (evicted) this.logger.info(`closed the data source for ${tenant}`);
    return evicted;
  }

  async demonstrate(): Promise<void> {
    for (const tenant of ['acme', 'globex']) {
      await this.open(tenant, `first ticket for ${tenant}`);
      const rollup = await this.rollUp(tenant);
      this.logger.info(
        `${tenant} -> ${rollup.tickets} ticket(s), rolled up into the ` +
          'reporting database',
      );
    }

    const { keys, size } = this.live();
    this.logger.info(
      `tenant data sources live: ${size} (${keys.join(', ')}), ` +
        'each its own connection',
    );

    // The handle without a lease, for a caller that wants drizzle directly.
    const acme = await this.dbFor('acme');
    this.logger.info(
      `dbHandle('reporting') holds ${this.reported().length} rollup(s); ` +
        `acme's own database holds ${acme.select().from(tickets).all().length}`,
    );

    await this.release('globex');
    this.logger.info(
      `released globex -> still open: ${this.sources.keys().join(', ')}`,
    );
  }

  /**
   * The tenant's drizzle handle, for a caller that wants it directly. Not called
   * `handle`: `@dunx/testing` reads a provider with a `handle` method as a
   * `Middleware` and warns that the fixture is missing the global chain.
   */
  dbFor(tenant: string): Promise<TenantDb> {
    return this.sources.get(tenant);
  }
}
