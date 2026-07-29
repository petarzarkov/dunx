import { Database as BunSqlite } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { Backend, Dialect } from '../dialect.js';
import { SqliteConnection } from './connection.js';
import { SqliteOptions } from './options.js';

const people = sqliteTable('people', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  email: text('email'),
  seenAt: integer('seen_at', { mode: 'timestamp_ms' }),
});

const schema = { people };
type Schema = typeof schema;

const DDL = sql`CREATE TABLE people (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT,
  seen_at INTEGER
)`;

let connection: SqliteConnection<Schema>;

beforeEach(async () => {
  connection = await new SqliteOptions({ schema }).open();
  connection.db.run(DDL);
});

afterEach(async () => {
  await connection.close();
});

describe('what is injected', () => {
  it('is drizzle’s own database class, not a wrapper', () => {
    expect(connection.db).toBeInstanceOf(BunSQLiteDatabase);
  });

  it('reports the backend and dialect', () => {
    expect(connection.backend).toBe(Backend.SQLITE);
    expect(connection.dialect).toBe(Dialect.SQLITE);
  });

  it('exposes no query methods of its own — those are drizzle’s', () => {
    const holder = connection as unknown as Record<string, unknown>;
    expect(holder['sql']).toBeUndefined();
    expect(holder['all']).toBeUndefined();
    expect(holder['get']).toBeUndefined();
    expect(holder['exec']).toBeUndefined();
  });
});

describe('querying through drizzle', () => {
  it('inserts and selects with the schema’s own types', () => {
    connection.db.insert(people).values({ name: 'ada' }).run();
    const rows = connection.db.select().from(people).all();
    expect(rows).toEqual([{ id: 1, name: 'ada', email: null, seenAt: null }]);
  });

  it('returns the inserted row with returning()', () => {
    const returned = connection.db
      .insert(people)
      .values({ name: 'grace', email: 'g@example.com' })
      .returning()
      .all();
    expect(returned).toEqual([
      { id: 1, name: 'grace', email: 'g@example.com', seenAt: null },
    ]);
  });

  it('projects a subset of columns', () => {
    connection.db.insert(people).values({ name: 'ada' }).run();
    expect(
      connection.db.select({ name: people.name }).from(people).all(),
    ).toEqual([{ name: 'ada' }]);
  });

  it('filters with a bound parameter', () => {
    connection.db
      .insert(people)
      .values([{ name: 'ada' }, { name: 'grace' }])
      .run();
    const found = connection.db
      .select()
      .from(people)
      .where(eq(people.name, 'grace'))
      .get();
    expect(found?.name).toBe('grace');
  });

  it('returns undefined from get() when there is no row', () => {
    expect(connection.db.select().from(people).get()).toBeUndefined();
  });

  it('updates', () => {
    connection.db.insert(people).values({ name: 'ada' }).run();
    connection.db
      .update(people)
      .set({ email: 'ada@example.com' })
      .where(eq(people.name, 'ada'))
      .run();
    expect(connection.db.select().from(people).get()?.email).toBe(
      'ada@example.com',
    );
  });

  it('deletes', () => {
    connection.db.insert(people).values({ name: 'ada' }).run();
    connection.db.delete(people).where(eq(people.name, 'ada')).run();
    expect(connection.db.select().from(people).all()).toEqual([]);
  });

  it('orders and limits', () => {
    connection.db
      .insert(people)
      .values([{ name: 'c' }, { name: 'a' }, { name: 'b' }])
      .run();
    const rows = connection.db
      .select({ name: people.name })
      .from(people)
      .orderBy(people.name)
      .limit(2)
      .all();
    expect(rows.map((row) => row.name)).toEqual(['a', 'b']);
  });

  it('counts', async () => {
    connection.db.insert(people).values({ name: 'ada' }).run();
    expect(await connection.db.$count(people)).toBe(1);
  });

  /**
   * The relational API only exists when the schema generic reached the handle. It
   * typechecks here, which is the assertion — with the default `TSchema` drizzle
   * types `query` as a `DrizzleTypeError`.
   */
  it('exposes the relational query API, which proves the schema generic arrived', async () => {
    connection.db.insert(people).values({ name: 'ada' }).run();
    const found = await connection.db.query.people.findFirst();
    expect(found?.name).toBe('ada');
  });

  it('runs raw SQL through drizzle’s own door', () => {
    connection.db.run(sql`INSERT INTO people (name) VALUES (${'raw'})`);
    expect(
      connection.db.all<{ name: string }>(sql`SELECT name FROM people`),
    ).toEqual([{ name: 'raw' }]);
  });
});

describe('the raw handle', () => {
  it('is the bun:sqlite Database, fully typed', () => {
    expect(connection.raw).toBeInstanceOf(BunSqlite);
    expect(connection.raw.filename).toBe(':memory:');
  });

  it('is the same connection drizzle writes through', () => {
    connection.db.insert(people).values({ name: 'ada' }).run();
    const rows = connection.raw.query('SELECT name FROM people').all();
    expect(rows).toEqual([{ name: 'ada' }]);
  });

  it('reaches the SQLite-only capabilities drizzle does not model', () => {
    connection.db.insert(people).values({ name: 'ada' }).run();
    const snapshot = connection.raw.serialize();
    expect(snapshot.byteLength).toBeGreaterThan(0);

    const restored = BunSqlite.deserialize(snapshot);
    expect(restored.query('SELECT name FROM people').all()).toEqual([
      { name: 'ada' },
    ]);
    restored.close();
  });

  it('is also reachable as drizzle’s $client', () => {
    const client = (connection.db as unknown as { $client: BunSqlite }).$client;
    expect(client).toBe(connection.raw);
  });
});

describe('Date bindings', () => {
  it('round-trips a Date through a timestamp_ms column', () => {
    const seenAt = new Date('2026-07-29T12:34:56.789Z');
    connection.db.insert(people).values({ name: 'ada', seenAt }).run();
    expect(connection.db.select().from(people).get()?.seenAt).toEqual(seenAt);
  });

  it('stores that column as an integer, not a string', () => {
    connection.db
      .insert(people)
      .values({ name: 'ada', seenAt: new Date(1_785_328_496_789) })
      .run();
    expect(connection.raw.query('SELECT seen_at FROM people').get()).toEqual({
      seen_at: 1_785_328_496_789,
    });
  });

  it('refuses a raw Date alongside another parameter, whatever strict says', () => {
    // Two or more bindings means positional binding, and the driver rejects a
    // Date there outright: "Binding expected string, TypedArray, boolean,
    // number, bigint or null".
    expect(() =>
      connection.db.run(
        sql`INSERT INTO people (name, email) VALUES (${'ada'}, ${new Date()})`,
      ),
    ).toThrow();
    expect(connection.db.select().from(people).all()).toEqual([]);
  });

  /**
   * A *single* object binding is read as a named-parameter map instead, and that
   * is the case `strict: true` exists for: strict rejects it, non-strict writes
   * `NULL` and says nothing. Measured on Bun 1.3.14, which is why this package
   * defaults `strict` on even though the driver does not.
   */
  it('refuses a lone raw Date under the default strict', () => {
    let cause: unknown;
    try {
      connection.db.run(sql`INSERT INTO people (email) VALUES (${new Date()})`);
    } catch (error) {
      // drizzle rewraps the driver's failure; the driver's own words are the cause.
      cause = (error as { cause?: unknown }).cause;
    }
    expect(cause).toBeInstanceOf(Error);
    expect((cause as Error).message).toContain('Missing parameter');
  });

  it('silently writes NULL for the same binding when strict is off', async () => {
    const loose = await new SqliteOptions({ schema, strict: false }).open();
    loose.db.run(sql`CREATE TABLE stamps (at TEXT)`);
    loose.db.run(sql`INSERT INTO stamps (at) VALUES (${new Date()})`);
    expect(
      loose.db.all<{ at: string | null }>(sql`SELECT at FROM stamps`),
    ).toEqual([{ at: null }]);
    await loose.close();
  });
});

describe('closing', () => {
  it('is idempotent', async () => {
    await connection.close();
    await connection.close();
    expect(connection.closed).toBe(true);
  });

  it('reports closed only once it has happened', async () => {
    expect(connection.closed).toBe(false);
    await connection.close();
    expect(connection.closed).toBe(true);
  });

  it('closes the driver handle underneath drizzle', async () => {
    await connection.close();
    expect(() => connection.raw.query('SELECT 1').get()).toThrow();
  });

  it('runs on the shutdown hook', async () => {
    await connection.onShutdown();
    expect(connection.closed).toBe(true);
  });

  it('makes a later query through drizzle fail', async () => {
    await connection.close();
    expect(() => connection.db.select().from(people).all()).toThrow();
  });
});
