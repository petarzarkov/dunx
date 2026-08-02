import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database as BunSqlite, type SQLQueryBindings } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { DbOptions } from '../connection.js';
import { Backend, Dialect } from '../dialect.js';
import { DatabaseError } from '../errors.js';
import { SqliteConnection } from './connection.js';
import { SqliteOptions } from './options.js';

/**
 * A `Date` is deliberately outside `SQLQueryBindings` - binding one is the whole
 * point of the strict-mode tests, so the cast is the test setup, not a shortcut.
 */
const dateBinding = (): SQLQueryBindings =>
  ({ x: new Date('2026-07-29T00:00:00Z') }) as unknown as SQLQueryBindings;

const bindDate = (raw: BunSqlite): unknown => {
  raw.exec('CREATE TABLE t (x)');
  return raw
    .query<{ x: unknown }, SQLQueryBindings>(
      'INSERT INTO t (x) VALUES ($x) RETURNING x',
    )
    .get(dateBinding());
};

const selectOne = <T extends Record<string, unknown> = Record<string, unknown>>(
  raw: BunSqlite,
  statement: string,
): T | null => raw.query<T, []>(statement).get();

// A real file in an OS temp directory that is removed whole afterwards - WAL and
// SHM siblings included. Nothing file-backed is ever written inside the repo.
let directory: string;
let scratch: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dunx-db-'));
  scratch = join(directory, 'scratch.db');
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('SqliteOptions defaults', () => {
  it('defaults to an in-memory database', () => {
    const options = new SqliteOptions({ schema: {} });
    expect(options.filename).toBe(':memory:');
    expect(options.readOnly).toBe(false);
    expect(options.create).toBe(true);
    expect(options.safeIntegers).toBe(false);
    expect(options.pragmas).toEqual([]);
    expect(options.backend).toBe(Backend.SQLITE);
    expect(options.dialect).toBe(Dialect.SQLITE);
  });

  it('defaults strict on, unlike the driver', () => {
    expect(new SqliteOptions({ schema: {} }).strict).toBe(true);
    expect(new SqliteOptions({ schema: {}, strict: false }).strict).toBe(false);
  });

  it('keeps the schema it was handed', () => {
    const schema = { users: { name: 'users' } };
    expect(new SqliteOptions({ schema }).schema).toBe(schema);
  });
});

describe('SqliteOptions filename', () => {
  it.each([
    [':memory:', ':memory:'],
    ['sqlite://:memory:', ':memory:'],
    ['sqlite://./x.db', './x.db'],
    ['sqlite:./x.db', './x.db'],
    ['sqlite:///var/lib/app.db', '/var/lib/app.db'],
    ['file:./x.db', './x.db'],
    ['./x.db', './x.db'],
    ['/var/lib/app.db', '/var/lib/app.db'],
  ])('reads %p as the path %p', (input, expected) => {
    expect(new SqliteOptions({ schema: {}, filename: input }).filename).toBe(
      expected,
    );
  });

  it('accepts a URL instance', () => {
    expect(
      new SqliteOptions({
        schema: {},
        filename: new URL('file:///var/lib/app.db'),
      }).filename,
    ).toBe('/var/lib/app.db');
  });

  it.each(['sqlite://', 'sqlite:', 'file:'])(
    'rejects %p, which names no database',
    (input) => {
      expect(() => new SqliteOptions({ schema: {}, filename: input })).toThrow(
        DatabaseError,
      );
      expect(() => new SqliteOptions({ schema: {}, filename: input })).toThrow(
        /:memory:/,
      );
    },
  );
});

describe('SqliteOptions.toDriverOptions', () => {
  it('passes strict, safeIntegers and create through', () => {
    expect(new SqliteOptions({ schema: {} }).toDriverOptions()).toEqual({
      strict: true,
      safeIntegers: false,
      create: true,
    });
    expect(
      new SqliteOptions({
        schema: {},
        strict: false,
        safeIntegers: true,
        create: false,
      }).toDriverOptions(),
    ).toEqual({ strict: false, safeIntegers: true, create: false });
  });

  it('suppresses create when readOnly is set, even if create was asked for', () => {
    const driver = new SqliteOptions({
      schema: {},
      readOnly: true,
      create: true,
    }).toDriverOptions();

    expect(driver).toEqual({
      strict: true,
      safeIntegers: false,
      readonly: true,
    });
    expect(driver).not.toHaveProperty('create');
  });

  it('carries no filename - the driver takes it positionally', () => {
    expect(
      new SqliteOptions({ schema: {}, filename: scratch }).toDriverOptions(),
    ).not.toHaveProperty('filename');
  });
});

describe('SqliteOptions as an injection token source', () => {
  it("binds the drizzle handle under drizzle's own class", () => {
    expect(new SqliteOptions({ schema: {} }).token).toBe(BunSQLiteDatabase);
  });

  it('is a DbOptions, so DbModule can hold it abstractly', () => {
    expect(new SqliteOptions({ schema: {} })).toBeInstanceOf(DbOptions);
  });
});

describe('SqliteOptions.open', () => {
  it('returns a SqliteConnection over a real bun:sqlite handle', async () => {
    const connection = await new SqliteOptions({ schema: {} }).open();

    expect(connection).toBeInstanceOf(SqliteConnection);
    expect(connection.raw).toBeInstanceOf(BunSqlite);
    expect(connection.backend).toBe(Backend.SQLITE);
    expect(connection.dialect).toBe(Dialect.SQLITE);
    expect(connection.closed).toBe(false);
    await connection.close();
  });

  it('wraps that handle in a drizzle database that sees the same data', async () => {
    const connection = await new SqliteOptions({ schema: {} }).open();

    expect(connection.db).toBeInstanceOf(BunSQLiteDatabase);
    connection.raw.exec('CREATE TABLE t (x INTEGER)');
    connection.raw.exec('INSERT INTO t VALUES (42)');
    expect(connection.db.all(sql`SELECT x FROM t`)).toEqual([{ x: 42 }]);
    await connection.close();
  });

  // `foreign_keys` rather than `journal_mode`, because an in-memory database is
  // already in MEMORY journal mode and that pragma would prove nothing.
  it('runs pragmas before the handle is visible', async () => {
    const connection = await new SqliteOptions({
      schema: {},
      pragmas: ['foreign_keys = ON'],
    }).open();

    expect(selectOne(connection.raw, 'PRAGMA foreign_keys')).toEqual({
      foreign_keys: 1,
    });
    await connection.close();
  });

  it('leaves the pragmas at their defaults when none are given', async () => {
    const connection = await new SqliteOptions({ schema: {} }).open();

    expect(selectOne(connection.raw, 'PRAGMA foreign_keys')).toEqual({
      foreign_keys: 0,
    });
    await connection.close();
  });

  it('applies pragmas in order, WAL included, on a file-backed database', async () => {
    const connection = await new SqliteOptions({
      schema: {},
      filename: join(directory, 'wal.db'),
      pragmas: ['journal_mode = WAL', 'synchronous = NORMAL'],
    }).open();

    expect(selectOne(connection.raw, 'PRAGMA journal_mode')).toEqual({
      journal_mode: 'wal',
    });
    expect(selectOne(connection.raw, 'PRAGMA synchronous')).toEqual({
      synchronous: 1,
    });
    await connection.close();
  });

  it('reaches the driver with strict on, so a Date binding throws', async () => {
    const connection = await new SqliteOptions({ schema: {} }).open();

    expect(() => bindDate(connection.raw)).toThrow(TypeError);
    await connection.close();
  });

  // The reason strict defaults on: drizzle's own `drizzle('./dev.db')` path
  // forwards no strict flag and this silent NULL is what you get.
  it('binds the same Date as NULL when strict is off', async () => {
    const connection = await new SqliteOptions({
      schema: {},
      strict: false,
    }).open();

    expect(bindDate(connection.raw)).toEqual({ x: null });
    await connection.close();
  });

  it('reaches the driver with safeIntegers, returning bigints', async () => {
    const connection = await new SqliteOptions({
      schema: {},
      safeIntegers: true,
    }).open();

    expect(selectOne(connection.raw, 'SELECT 1 AS n')).toEqual({ n: 1n });
    await connection.close();
  });

  it('closes idempotently, flipping closed once', async () => {
    const connection = await new SqliteOptions({ schema: {} }).open();

    await connection.close();
    expect(connection.closed).toBe(true);
    await connection.close();
    expect(connection.closed).toBe(true);
    expect(() => selectOne(connection.raw, 'SELECT 1 AS n')).toThrow();
  });

  it('closes through the shutdown hook too', async () => {
    const connection = await new SqliteOptions({ schema: {} }).open();

    await connection.onShutdown();
    expect(connection.closed).toBe(true);
  });

  it('creates a real file and reads it back on reopen', async () => {
    const writer = await new SqliteOptions({
      schema: {},
      filename: scratch,
    }).open();
    writer.raw.exec('CREATE TABLE t (x INTEGER)');
    writer.raw.exec('INSERT INTO t VALUES (7)');
    await writer.close();

    expect((await stat(scratch)).isFile()).toBe(true);

    // Through the URL form, to prove the scheme comes off before the driver sees it.
    const reader = await new SqliteOptions({
      schema: {},
      filename: `sqlite://${scratch}`,
    }).open();
    expect(reader.db.all(sql`SELECT x FROM t`)).toEqual([{ x: 7 }]);
    await reader.close();
  });

  /**
   * `casing` and the query `logger` are drizzle's own, and they were unreachable
   * from inside the container while only `schema` was forwarded to `drizzle()`.
   * `casing: 'snake_case'` is the standard drizzle idiom; the logger is how a slow
   * endpoint gets diagnosed.
   */
  it('forwards casing, so an unnamed column resolves to snake_case', async () => {
    const people = sqliteTable('people', {
      id: integer().primaryKey(),
      firstName: text(),
    });
    const connection = await new SqliteOptions({
      schema: { people },
      casing: 'snake_case',
    }).open();
    connection.raw.exec(
      'CREATE TABLE people (id INTEGER PRIMARY KEY, first_name TEXT)',
    );

    await connection.db.insert(people).values({ id: 1, firstName: 'ada' });
    expect(await connection.db.select().from(people)).toEqual([
      { id: 1, firstName: 'ada' },
    ]);
    await connection.close();
  });

  it('forwards a query logger', async () => {
    const queries: string[] = [];
    const connection = await new SqliteOptions({
      schema: {},
      logger: {
        logQuery: (query) => {
          queries.push(query);
        },
      },
    }).open();

    connection.db.all(sql`SELECT 1 AS x`);
    expect(queries).toEqual(['SELECT 1 AS x']);
    await connection.close();
  });

  it('reaches the driver with readOnly, so a write fails', async () => {
    const seed = await new SqliteOptions({
      schema: {},
      filename: join(directory, 'ro.db'),
    }).open();
    seed.raw.exec('CREATE TABLE t (x INTEGER)');
    await seed.close();

    const connection = await new SqliteOptions({
      schema: {},
      filename: join(directory, 'ro.db'),
      readOnly: true,
    }).open();
    expect(() => connection.raw.exec('INSERT INTO t VALUES (1)')).toThrow(
      /readonly/i,
    );
    await connection.close();
  });
});
