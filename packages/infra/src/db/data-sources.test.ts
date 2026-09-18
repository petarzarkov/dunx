import { AppFactory, Module, type OnShutdown } from '@dunx/core';
import { describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { DataSources, type DataSourcesInit } from './data-sources.js';
import type { DbConnection } from './connection.js';
import { DatabaseError } from './errors.js';
import { QueryMetrics } from './metrics.js';
import { DbModule } from './module.js';
import {
  SqliteConnection,
  SyncDatabase,
  SyncSqliteConnection,
} from './sqlite/connection.js';
import { SyncSqliteOptions } from './sqlite/options.js';
import { dbMetrics } from './tokens.js';

const rows = sqliteTable('rows', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  tenant: text('tenant').notNull(),
});

const schema = { rows };
type Schema = typeof schema;
type Handle = SyncDatabase<Schema>;

/** One in-memory database per key, so every key really is its own data source. */
const perKey = (): DataSourcesInit<Handle>['create'] => () =>
  new SyncSqliteOptions({ schema });

const pool = (
  init: Partial<DataSourcesInit<Handle>> = {},
): DataSources<Handle> =>
  new DataSources<Handle>({ create: perKey(), idleMs: 0, ...init });

class Tenants extends DataSources<Handle> {}

describe('DataSources', () => {
  it('opens on first use and reuses after', async () => {
    let opened = 0;
    const sources = pool({
      create: () => {
        opened += 1;
        return new SyncSqliteOptions({ schema });
      },
    });

    const first = await sources.get('a');
    expect(await sources.get('a')).toBe(first);
    expect(opened).toBe(1);
    expect(sources.size).toBe(1);
    expect(sources.has('a')).toBe(true);
    await sources.close();
  });

  it('gives two keys two databases', async () => {
    const sources = pool();
    const a = await sources.get('a');
    const b = await sources.get('b');

    expect(a).not.toBe(b);
    a.run(
      sql`CREATE TABLE rows (id INTEGER PRIMARY KEY, tenant TEXT NOT NULL)`,
    );
    a.insert(rows).values({ tenant: 'a' }).run();
    // `b` never saw the table, so the two share no state at all.
    expect(() => b.select().from(rows).all()).toThrow();
    expect(sources.keys()).toEqual(['a', 'b']);
    await sources.close();
  });

  it('shares one open between concurrent callers for one key', async () => {
    let opened = 0;
    const sources = pool({
      create: async () => {
        opened += 1;
        await Bun.sleep(5);
        return new SyncSqliteOptions({ schema });
      },
    });

    const [first, second] = await Promise.all([
      sources.get('a'),
      sources.get('a'),
    ]);
    expect(first).toBe(second);
    expect(opened).toBe(1);
    await sources.close();
  });

  it('hands back the connection, so the raw driver is reachable', async () => {
    const sources = pool();
    const connection = await sources.connection('a');

    expect(connection).toBeInstanceOf(SyncSqliteConnection);
    await connection.ping();
    expect(connection.db).toBe(await sources.get('a'));
    await sources.close();
  });

  it('does not cache a failed open', async () => {
    let attempts = 0;
    const sources = pool({
      create: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('tenant not provisioned');
        return new SyncSqliteOptions({ schema });
      },
    });

    await expect(sources.get('a')).rejects.toThrow('tenant not provisioned');
    expect(sources.size).toBe(0);
    expect(await sources.get('a')).toBeDefined();
    expect(attempts).toBe(2);
    await sources.close();
  });

  it('does not cache an open that rejects asynchronously', async () => {
    let attempts = 0;
    const sources = pool({
      create: async () => {
        attempts += 1;
        await Bun.sleep(1);
        throw new Error('handshake refused');
      },
    });

    await expect(sources.get('a')).rejects.toThrow('handshake refused');
    expect(sources.size).toBe(0);
    await expect(sources.get('a')).rejects.toThrow('handshake refused');
    expect(attempts).toBe(2);
    await sources.close();
  });
});

describe('the bound on live data sources', () => {
  it('evicts the least recently used one when max is reached', async () => {
    const sources = pool({ max: 2 });
    const first = await sources.connection('a');
    await sources.get('b');
    // Touching 'a' makes 'b' the idlest, so 'c' takes b's slot.
    await sources.get('a');
    await sources.get('c');

    expect(sources.keys()).toEqual(['a', 'c']);
    expect(sources.size).toBe(2);
    expect(first).toBeInstanceOf(SqliteConnection);
    await sources.close();
  });

  it('closes the data source it evicts', async () => {
    const sources = pool({ max: 1 });
    const evicted = await sources.connection('a');
    await sources.get('b');
    // Eviction frees the slot at once and closes behind it, so admission never
    // waits on another tenant's close.
    await Bun.sleep(5);

    expect(evicted).toBeInstanceOf(SqliteConnection);
    if (!(evicted instanceof SqliteConnection)) throw new Error('narrowing');
    expect(evicted.closed).toBe(true);
    await sources.close();
  });

  it('never evicts one that use() is borrowing', async () => {
    const sources = pool({ max: 1 });
    const borrowed = await sources.use('a', async (db) => {
      await sources.get('b').catch(() => undefined);
      return db;
    });

    expect(borrowed).toBeDefined();
    expect(sources.keys()).toEqual(['a']);
    await sources.close();
  });

  it('refuses rather than exceeding the bound when every one is borrowed', async () => {
    const sources = pool({ max: 1 });
    await sources.use('a', async () => {
      await expect(sources.get('b')).rejects.toThrow(DatabaseError);
      await expect(sources.get('b')).rejects.toThrow(
        'All 1 data sources are open and borrowed',
      );
    });
    await sources.close();
  });

  it('releases the lease even when the work throws', async () => {
    const sources = pool({ max: 1 });
    await expect(
      sources.use('a', () => {
        throw new Error('query failed');
      }),
    ).rejects.toThrow('query failed');

    await sources.get('b');
    expect(sources.keys()).toEqual(['b']);
    await sources.close();
  });

  /**
   * Admission has to be atomic. Both reviewers on #162 found the same window:
   * `#makeRoom` awaited between reading `size` and inserting, so a second
   * caller admitted itself into the slot the first had just cleared.
   */
  it('never holds more than max when two keys race for the last slot', async () => {
    const sources = pool({
      max: 1,
      create: async () => {
        await Bun.sleep(5);
        return new SyncSqliteOptions({ schema });
      },
    });

    const both = Promise.all([sources.get('a'), sources.get('b')]);
    await Bun.sleep(1);
    expect(sources.size).toBeLessThanOrEqual(1);
    await both;
    expect(sources.size).toBeLessThanOrEqual(1);
    await sources.close();
  });

  it('holds as many as asked when max is 0', async () => {
    const sources = pool({ max: 0 });
    for (const key of ['a', 'b', 'c', 'd']) await sources.get(key);
    expect(sources.size).toBe(4);
    await sources.close();
  });
});

describe('idle eviction', () => {
  it('closes what has not been used for idleMs', async () => {
    // `sweepMs` out of the way, so `prune` is what evicts and not the timer.
    const sources = pool({ idleMs: 5, sweepMs: 60_000 });
    const idle = await sources.connection('a');
    await Bun.sleep(20);

    expect(await sources.prune()).toBe(1);
    expect(sources.size).toBe(0);
    expect(idle).toBeInstanceOf(SqliteConnection);
    if (!(idle instanceof SqliteConnection)) throw new Error('narrowing');
    expect(idle.closed).toBe(true);
    await sources.close();
  });

  it('keeps one that was used inside the window', async () => {
    const sources = pool({ idleMs: 1_000, sweepMs: 60_000 });
    await sources.get('a');
    expect(await sources.prune()).toBe(0);
    expect(sources.size).toBe(1);
    await sources.close();
  });

  it('runs on its own timer, without holding the process open', async () => {
    const sources = pool({ idleMs: 5 });
    await sources.get('a');
    await Bun.sleep(30);
    expect(sources.size).toBe(0);
    await sources.close();
  });

  it('prunes nothing when idle eviction is off', async () => {
    const sources = pool({ idleMs: 0 });
    await sources.get('a');
    expect(await sources.prune()).toBe(0);
    await sources.close();
  });
});

describe('eviction by key', () => {
  it('closes and forgets the key', async () => {
    const sources = pool();
    const connection = await sources.connection('a');

    expect(await sources.evict('a')).toBe(true);
    expect(sources.has('a')).toBe(false);
    expect(connection).toBeInstanceOf(SqliteConnection);
    if (!(connection instanceof SqliteConnection)) throw new Error('narrowing');
    expect(connection.closed).toBe(true);
    await sources.close();
  });

  it('reports a key that was never live', async () => {
    const sources = pool();
    expect(await sources.evict('nobody')).toBe(false);
    await sources.close();
  });
});

describe('close', () => {
  it('closes every live data source', async () => {
    const sources = pool();
    const a = await sources.connection('a');
    const b = await sources.connection('b');
    await sources.close();

    expect(sources.size).toBe(0);
    expect(sources.closed).toBe(true);
    for (const connection of [a, b]) {
      if (!(connection instanceof SqliteConnection)) {
        throw new Error('narrowing');
      }
      expect(connection.closed).toBe(true);
    }
  });

  it('is idempotent', async () => {
    const sources = pool();
    await sources.get('a');
    await sources.close();
    await sources.close();
    expect(sources.size).toBe(0);
  });

  it('waits for an open that was already in flight when it ran', async () => {
    const created: string[] = [];
    const sources = pool({
      max: 1,
      create: async (key) => {
        await Bun.sleep(10);
        created.push(key);
        return new SyncSqliteOptions({ schema });
      },
    });
    await sources.get('a');
    // Needs the slot, so it goes through eviction - which is where admission
    // used to yield and land the insert after close() had taken its snapshot.
    const late = sources.get('b').catch(() => undefined);

    await sources.close();
    expect(created).toEqual(['a', 'b']);
    await late;
    expect(sources.size).toBe(0);
    expect(sources.closed).toBe(true);
  });

  it('refuses to open anything afterwards', async () => {
    const sources = pool();
    await sources.close();
    await expect(sources.get('a')).rejects.toThrow(
      'These data sources are closed',
    );
  });

  it('closes one that was still opening when it ran', async () => {
    let connection: DbConnection<Handle> | undefined;
    const sources = pool({
      create: async () => {
        await Bun.sleep(10);
        return new SyncSqliteOptions({ schema });
      },
    });

    const opening = sources
      .connection('a')
      .then((opened) => (connection = opened))
      .catch(() => undefined);
    await Bun.sleep(1);
    await sources.close();
    await opening;

    // Either it never surfaced, or it surfaced closed. Never open and orphaned.
    if (connection !== undefined) {
      expect(connection).toBeInstanceOf(SqliteConnection);
      if (!(connection instanceof SqliteConnection)) {
        throw new Error('narrowing');
      }
      expect(connection.closed).toBe(true);
    }
    expect(sources.size).toBe(0);
  });

  it('ignores a failed open while closing', async () => {
    const sources = pool({
      create: async () => {
        await Bun.sleep(5);
        throw new Error('handshake refused');
      },
    });
    const opening = sources.get('a').catch(() => undefined);
    await sources.close();
    await opening;
    expect(sources.size).toBe(0);
  });
});

describe('DbModule.forDataSources', () => {
  it('binds the subclass, which carries the handle type', async () => {
    @Module({
      imports: [DbModule.forDataSources({ create: perKey() }, Tenants)],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    const tenants = app.get(Tenants);
    expect(tenants).toBeInstanceOf(Tenants);
    expect(tenants).toBeInstanceOf(DataSources);

    const db = await tenants.get('acme');
    db.run(
      sql`CREATE TABLE rows (id INTEGER PRIMARY KEY, tenant TEXT NOT NULL)`,
    );
    db.insert(rows).values({ tenant: 'acme' }).run();
    expect(db.select().from(rows).all()).toHaveLength(1);
    await app.shutdown();
  });

  it('closes every live data source on application shutdown', async () => {
    @Module({
      imports: [DbModule.forDataSources({ create: perKey() }, Tenants)],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    const tenants = app.get(Tenants);
    const connection = await tenants.connection('acme');
    await app.shutdown();

    expect(tenants.closed).toBe(true);
    if (!(connection instanceof SqliteConnection)) {
      throw new Error('narrowing');
    }
    expect(connection.closed).toBe(true);
  });

  it('drains a consumer before the pool closes', async () => {
    const order: string[] = [];

    class Reporter implements OnShutdown {
      constructor(private readonly tenants: Tenants) {}

      async onShutdown(): Promise<void> {
        const db = await this.tenants.get('acme');
        db.run(sql`select 1`);
        order.push('reporter drained while the pool was still open');
      }
    }
    Object.defineProperty(Reporter, Symbol.for('dunx.deps'), {
      value: () => [Tenants],
    });

    @Module({
      imports: [DbModule.forDataSources({ create: perKey() }, Tenants)],
      providers: [Reporter],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    await app.get(Tenants).get('acme');
    await app.shutdown();
    expect(order).toEqual(['reporter drained while the pool was still open']);
  });

  it('times every data source into one shared QueryMetrics', async () => {
    @Module({
      imports: [
        DbModule.forDataSources({ create: perKey() }, Tenants, {
          metrics: true,
        }),
      ],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    const metrics = app.get(dbMetrics('Tenants'));
    expect(metrics).toBeInstanceOf(QueryMetrics);

    for (const key of ['acme', 'globex']) {
      (await app.get(Tenants).get(key)).run(sql`select 1`);
    }
    expect(metrics.snapshot().total).toBe(2);
    await app.shutdown();
  });
});

describe('DbModule.forDataSourcesAsync', () => {
  class Config {
    readonly tenants = ['acme', 'globex'];
  }

  it('takes the init from a factory that may inject', async () => {
    @Module({ providers: [Config], exports: [Config] })
    class ConfigModule {}

    @Module({
      imports: [
        DbModule.forDataSourcesAsync(
          {
            imports: [ConfigModule],
            useFactory: (config: Config): DataSourcesInit<Handle> => ({
              create: (key) => {
                if (!config.tenants.includes(key)) {
                  throw new DatabaseError(`no tenant "${key}"`);
                }
                return new SyncSqliteOptions({ schema });
              },
            }),
            inject: [Config],
          },
          Tenants,
        ),
      ],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(await app.get(Tenants).get('acme')).toBeDefined();
    await expect(app.get(Tenants).get('nobody')).rejects.toThrow('no tenant');
    await app.shutdown();
  });

  it('awaits an async factory before anything is constructed', async () => {
    @Module({
      imports: [
        DbModule.forDataSourcesAsync(
          {
            useFactory: async (): Promise<DataSourcesInit<Handle>> => {
              await Bun.sleep(1);
              return { create: perKey() };
            },
          },
          Tenants,
        ),
      ],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.get(Tenants)).toBeInstanceOf(Tenants);
    await app.shutdown();
  });
});

/** Two classes that really do share a runtime name, which one scope cannot. */
const poolClass = (): typeof Tenants => {
  class Tenants extends DataSources<Handle> {}
  return Tenants;
};

describe('two pools', () => {
  class Reporting extends DataSources<Handle> {}

  it('stay apart when their classes share a name', async () => {
    const First = poolClass();
    const Second = poolClass();
    expect(First.name).toBe(Second.name);

    @Module({
      imports: [
        DbModule.forDataSources({ create: perKey() }, First, {
          metrics: true,
          name: 'first',
        }),
        DbModule.forDataSources({ create: perKey() }, Second, {
          metrics: true,
          name: 'second',
        }),
      ],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.get(First)).not.toBe(app.get(Second));
    expect(app.get(dbMetrics('first'))).not.toBe(app.get(dbMetrics('second')));
    await app.shutdown();
  });

  it('do not collide on the init or the metrics token', async () => {
    @Module({
      imports: [
        DbModule.forDataSources({ create: perKey() }, Tenants, {
          metrics: true,
        }),
        DbModule.forDataSources({ create: perKey() }, Reporting, {
          metrics: true,
        }),
      ],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.get(Tenants)).not.toBe(app.get(Reporting));
    expect(app.get(dbMetrics('Tenants'))).not.toBe(
      app.get(dbMetrics('Reporting')),
    );
    await app.shutdown();
  });
});
