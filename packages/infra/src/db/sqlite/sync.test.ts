import {
  AppFactory,
  Module,
  type AbstractCtor,
  type DynamicModule,
} from '@dunx/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DbConnection } from '../connection.js';
import { DbModule } from '../module.js';
import { runSeeds } from '../seed.js';
import { transaction, transactionSync } from '../transaction.js';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import {
  SqliteConnection,
  SyncDatabase,
  SyncSqliteConnection,
} from './connection.js';
import { SqliteOptions, SyncSqliteOptions } from './options.js';

const entries = sqliteTable('entries', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
});

const schema = { entries };
type Schema = typeof schema;

const records = (ctor: object, deps: () => readonly unknown[]): void => {
  Object.defineProperty(ctor, Symbol.for('dunx.deps'), { value: deps });
};

const rejection = async (promise: Promise<unknown>): Promise<Error> => {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof Error))
    throw new Error('expected the promise to reject with an Error');
  return error;
};

let connection: SyncSqliteConnection<Schema>;
let db: SyncDatabase<Schema>;

const names = (): readonly string[] =>
  db
    .select({ name: entries.name })
    .from(entries)
    .orderBy(entries.id)
    .all()
    .map((row) => row.name);

beforeEach(() => {
  connection = new SyncSqliteOptions({ schema }).openSync();
  db = connection.db;
  db.run(
    sql`CREATE TABLE entries (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)`,
  );
});

afterEach(() => {
  connection.closeSync();
});

describe('opening', () => {
  it('opens, queries and closes with nothing to await', () => {
    const opened = new SyncSqliteOptions({ schema }).openSync();
    opened.db.run(sql`CREATE TABLE t (id INTEGER)`);
    expect(opened.db.all(sql`SELECT count(*) AS n FROM t`)).toEqual([{ n: 0 }]);
    opened.closeSync();
    expect(opened.closed).toBe(true);
  });

  it('is still a SqliteConnection, so the raw escape hatch is unchanged', () => {
    expect(connection).toBeInstanceOf(SqliteConnection);
    expect(connection.raw.filename).toBe(':memory:');
    expect(connection.backend).toBe('sqlite');
    expect(connection.dialect).toBe('sqlite');
  });

  it('marks the handle, so the sync type is true rather than claimed', () => {
    expect(db.synchronous).toBe(true);
    // Non-enumerable, so nothing that walks the handle sees a stray key.
    expect(Object.keys(db)).not.toContain('synchronous');
  });

  it('leaves the async mode’s handle unmarked', async () => {
    const async = await new SqliteOptions({ schema }).open();
    expect((async.db as { synchronous?: unknown }).synchronous).toBeUndefined();
    await async.close();
  });

  it('applies pragmas and driver options exactly as the async mode does', () => {
    const opened = new SyncSqliteOptions({
      schema,
      pragmas: ['journal_mode = MEMORY'],
      safeIntegers: true,
    }).openSync();
    expect(opened.raw.query('PRAGMA journal_mode').get()).toEqual({
      journal_mode: 'memory',
    });
    // safeIntegers reached the driver: an integer comes back as a bigint.
    expect(opened.db.get<readonly bigint[]>(sql`SELECT 1`)).toEqual([1n]);
    opened.closeSync();
  });

  it('closeSync is idempotent, and close() is the same operation', async () => {
    const opened = new SyncSqliteOptions({ schema }).openSync();
    opened.closeSync();
    opened.closeSync();
    await opened.close();
    expect(opened.closed).toBe(true);
  });
});

describe('reading', () => {
  it('returns rows, not promises', () => {
    db.insert(entries).values({ name: 'ada' }).run();
    const rows = db.select().from(entries).all();
    expect(rows).not.toBeInstanceOf(Promise);
    expect(rows).toEqual([{ id: 1, name: 'ada' }]);
    expect(db.select().from(entries).get()).toEqual({ id: 1, name: 'ada' });
  });
});

describe('transactionSync', () => {
  it('returns the callback’s value directly, with no promise', () => {
    const value = transactionSync(db, (tx) => {
      tx.insert(entries).values({ name: 'kept' }).run();
      return tx.select().from(entries).all().length;
    });
    expect(value).toBe(1);
    expect(names()).toEqual(['kept']);
  });

  it('does not yield: the row is visible on the same tick', () => {
    let ticks = 0;
    queueMicrotask(() => {
      ticks += 1;
    });
    transactionSync(db, (tx) => {
      tx.insert(entries).values({ name: 'immediate' }).run();
    });
    expect(names()).toEqual(['immediate']);
    expect(ticks).toBe(0);
  });

  it('rolls back on throw, and the throw propagates', () => {
    db.insert(entries).values({ name: 'before' }).run();
    expect(() =>
      transactionSync(db, (tx) => {
        tx.insert(entries).values({ name: 'discarded' }).run();
        throw new Error('rolled back on purpose');
      }),
    ).toThrow('rolled back on purpose');
    expect(names()).toEqual(['before']);
  });

  it('nests through drizzle’s own handle, so an inner failure keeps the outer', () => {
    transactionSync(db, (tx) => {
      tx.insert(entries).values({ name: 'outer' }).run();
      try {
        tx.transaction((inner) => {
          inner.insert(entries).values({ name: 'inner' }).run();
          throw new Error('inner fails');
        });
      } catch {
        // The savepoint unwound; the outer transaction is still open.
      }
    });
    expect(names()).toEqual(['outer']);
  });

  it('takes a savepoint when an async transaction is suspended around it', async () => {
    await transaction(db, async (tx) => {
      tx.insert(entries).values({ name: 'outer' }).run();
      await Bun.sleep(1);
      expect(connection.raw.inTransaction).toBe(true);
      transactionSync(db, (inner) => {
        inner.insert(entries).values({ name: 'sync-leg' }).run();
      });
    });
    expect(names()).toEqual(['outer', 'sync-leg']);
  });

  it('rolls the savepoint back without touching the enclosing transaction', async () => {
    await transaction(db, async (tx) => {
      tx.insert(entries).values({ name: 'outer' }).run();
      await Bun.sleep(1);
      expect(() =>
        transactionSync(db, (inner) => {
          inner.insert(entries).values({ name: 'doomed' }).run();
          throw new Error('inner fails');
        }),
      ).toThrow('inner fails');
    });
    expect(names()).toEqual(['outer']);
  });
});

describe('the type gate', () => {
  /**
   * Never called - `tsc --noEmit` is the assertion. Each `@ts-expect-error` fails
   * the typecheck if the line below it stops being an error, which is the only way
   * to test that a mistake is unwritable rather than merely discouraged.
   */
  const uncompilable = (): void => {
    const asyncHandle: BunSQLiteDatabase<Schema> = db;
    // @ts-expect-error an async callback commits before its first await resumes
    const fromAsync: number = transactionSync(db, async () => 1);
    // @ts-expect-error so does one that returns a promise without being async
    const fromPromise: number = transactionSync(db, () => Promise.resolve(1));
    // @ts-expect-error the async mode's handle has no synchronous transaction
    transactionSync(asyncHandle, () => 1);
    void fromAsync;
    void fromPromise;
  };

  /**
   * The regression. `NotThenable` was `{ then?: undefined } | string | number | …`,
   * and `{ then?: undefined }` is a **weak type** - so TypeScript rejected any
   * object with no property in common with it, which is every row. Returning a row
   * from a transaction did not compile, and no test here caught it because all of
   * them returned a `number`.
   */
  const rowsAreReturnable = (): void => {
    const row = transactionSync(db, (tx) =>
      tx.insert(entries).values({ name: 'returned' }).returning().get(),
    );
    const name: string = row.name;
    const list: { id: number; name: string }[] = transactionSync(db, (tx) =>
      tx.select().from(entries).all(),
    );
    const tuple: [number, string] = transactionSync(db, () => [1, 'a']);
    void name;
    void list;
    void tuple;
  };

  it('is compile-time only, so nothing runs', () => {
    expect(uncompilable).toBeInstanceOf(Function);
    expect(rowsAreReturnable).toBeInstanceOf(Function);
  });

  it('returns a row object at runtime, not only in the types', () => {
    const row = transactionSync(db, (tx) =>
      tx.insert(entries).values({ name: 'row-out' }).returning().get(),
    );
    expect(row).not.toBeInstanceOf(Promise);
    expect(row.name).toBe('row-out');
  });
});

describe('the async transaction still works on a sync handle', () => {
  it('commits across an await', async () => {
    await transaction(db, async (tx) => {
      tx.insert(entries).values({ name: 'slow' }).run();
      await Bun.sleep(1);
    });
    expect(names()).toEqual(['slow']);
  });

  it('rolls back across an await, which drizzle’s own cannot', async () => {
    const error = await rejection(
      transaction(db, async (tx) => {
        tx.insert(entries).values({ name: 'discarded' }).run();
        await Bun.sleep(1);
        throw new Error('rolled back after the await');
      }),
    );
    expect(error.message).toBe('rolled back after the await');
    expect(names()).toEqual([]);
  });
});

describe('seeding', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dunx-sync-seed-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('runs against the sync handle unchanged', async () => {
    await writeFile(
      join(dir, '0001_entries.seeder.js'),
      `export function seed(db) { db.run("INSERT INTO entries (name) VALUES ('seeded')"); }`,
    );
    const first = await runSeeds(db, { dir });
    expect(first.applied).toEqual(['0001_entries.seeder.js']);
    const second = await runSeeds(db, { dir });
    expect(second.journaled).toEqual(['0001_entries.seeder.js']);
    expect(names()).toEqual(['seeded']);
  });
});

describe('DbModule', () => {
  class EntriesRepository {
    constructor(private readonly handle: SyncDatabase<Schema>) {}

    add(name: string): number {
      return transactionSync(this.handle, (tx) => {
        tx.insert(entries).values({ name }).run();
        return tx.select().from(entries).all().length;
      });
    }
  }
  records(EntriesRepository, () => [SyncDatabase]);

  const rootModule = (imported: DynamicModule): AbstractCtor<object> => {
    @Module({ imports: [imported], providers: [EntriesRepository] })
    class Root {}
    return Root;
  };

  it('binds the sync handle under SyncDatabase and closes on shutdown', async () => {
    const options = new SyncSqliteOptions({ schema });
    const app = await AppFactory.create(rootModule(DbModule.forRoot(options)));

    const opened = app.get(DbConnection);
    expect(opened).toBeInstanceOf(SyncSqliteConnection);

    const handle = app.get<SyncDatabase<Schema>>(SyncDatabase);
    handle.run(
      sql`CREATE TABLE entries (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)`,
    );
    expect(app.get(EntriesRepository).add('via di')).toBe(1);

    await app.shutdown();
    expect((opened as SyncSqliteConnection<Schema>).closed).toBe(true);
  });

  it('does not bind the async handle, so the mode is not bypassable', async () => {
    const app = await AppFactory.create(
      rootModule(DbModule.forRoot(new SyncSqliteOptions({ schema }))),
    );
    expect(() => app.get(SqliteOptions)).toThrow();
    await app.shutdown();
  });

  it('works through forRootAsync with the sync token', async () => {
    const app = await AppFactory.create(
      rootModule(
        DbModule.forRootAsync(SyncDatabase, {
          useFactory: () => new SyncSqliteOptions({ schema }),
        }),
      ),
    );
    expect(app.get(DbConnection)).toBeInstanceOf(SyncSqliteConnection);
    await app.shutdown();
  });
});
