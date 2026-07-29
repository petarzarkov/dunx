import { describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { BunSQLDatabase } from 'drizzle-orm/bun-sql';
import { DbOptions } from '../connection.js';
import { Backend, Dialect } from '../dialect.js';
import { DatabaseError } from '../errors.js';
import { SqlConnection } from './connection.js';
import { SqlOptions } from './options.js';

// A reachable Postgres. Unset in CI and locally, so every open() test skips.
const liveUrl = Bun.env['DUNX_DB_TEST_URL'];

/**
 * `toDriverOptions()` is typed as `Bun.SQL.Options`, a union whose SQLite member
 * has none of the pooling keys — so inspecting them needs the Postgres member.
 */
const serverOptions = (
  options: SqlOptions<Record<string, never>>,
): Bun.SQL.PostgresOrMySQLOptions =>
  options.toDriverOptions() as Bun.SQL.PostgresOrMySQLOptions;

const thrown = (url: string | URL): DatabaseError => {
  try {
    new SqlOptions({ schema: {}, url });
  } catch (error) {
    if (error instanceof DatabaseError) return error;
    throw error;
  }
  throw new Error(`expected ${String(url)} to be rejected`);
};

describe('SqlOptions', () => {
  it.each(['postgres://user:pw@localhost:5432/app', 'postgresql://db/app'])(
    'accepts %p',
    (url) => {
      const options = new SqlOptions({ schema: {}, url });
      expect(options.url).toBe(url);
      expect(options.dialect).toBe(Dialect.POSTGRES);
      expect(options.backend).toBe(Backend.SQL);
    },
  );

  it('normalises a URL instance to its href', () => {
    const options = new SqlOptions({
      schema: {},
      url: new URL('postgres://localhost:5432/app'),
    });
    expect(options.url).toBe('postgres://localhost:5432/app');
    expect(options.dialect).toBe(Dialect.POSTGRES);
  });

  it('keeps the schema it was handed', () => {
    const schema = { users: { name: 'users' } };
    expect(
      new SqlOptions({ schema, url: 'postgres://localhost:5432/app' }).schema,
    ).toBe(schema);
  });
});

describe('SqlOptions rejections', () => {
  // Resolved from the URL at construction, so a bad one throws before any I/O.
  it.each([
    'sqlite://:memory:',
    'file:./dev.db',
    'mysql://localhost:3306/app',
    'mariadb://localhost:3306/app',
    'pg://localhost/app',
    './dev.db',
  ])('rejects %p at construction, before connecting', (url) => {
    expect(() => new SqlOptions({ schema: {}, url })).toThrow(DatabaseError);
  });

  // A dialect Bun.SQL does speak, so the refusal is drizzle's, and the message
  // has to say so rather than looking like a typo in the URL.
  it.each([
    ['sqlite://:memory:', Dialect.SQLITE],
    ['file:./dev.db', Dialect.SQLITE],
    ['mysql://localhost:3306/app', Dialect.MYSQL],
    ['mariadb://localhost:3306/app', Dialect.MARIADB],
  ])('names %p as %p and blames PgDialect', (url, dialect) => {
    const error = thrown(url);
    expect(error.message).toContain(`names ${dialect}`);
    expect(error.message).toContain('PgDialect');
    expect(error.message).toContain('Postgres only');
  });

  it('points SQLite users at SqliteOptions and says MySQL has no driver', () => {
    expect(thrown('sqlite://:memory:').message).toContain('SqliteOptions');
    expect(thrown('mysql://localhost:3306/app').message).toContain(
      'no drizzle driver',
    );
  });

  // Unrecognised scheme, so dialectFromUrl rejects it before the Postgres check.
  it.each(['pg://localhost/app', './dev.db'])(
    'rejects %p as not a Bun.SQL URL at all',
    (url) => {
      expect(thrown(url).message).toContain('is not a connection URL');
    },
  );

  it('rejects a non-Postgres URL instance too', () => {
    expect(
      () => new SqlOptions({ schema: {}, url: new URL('mysql://db/app') }),
    ).toThrow(DatabaseError);
  });
});

describe('SqlOptions.toDriverOptions', () => {
  it('round-trips the extra Bun.SQL options with the url normalised', () => {
    const driver = serverOptions(
      new SqlOptions({
        schema: {},
        url: new URL('postgres://localhost:5432/app'),
        max: 4,
        idleTimeout: 30,
        connectionTimeout: 5,
        prepare: false,
        bigint: true,
      }),
    );

    expect(driver.url).toBe('postgres://localhost:5432/app');
    expect(driver.max).toBe(4);
    expect(driver.idleTimeout).toBe(30);
    expect(driver.connectionTimeout).toBe(5);
    expect(driver.prepare).toBe(false);
    expect(driver.bigint).toBe(true);
  });

  it('keeps a string url a string', () => {
    expect(
      serverOptions(
        new SqlOptions({ schema: {}, url: 'postgres://localhost:5432/app' }),
      ).url,
    ).toBe('postgres://localhost:5432/app');
  });

  it('drops adapter — the scheme already decides it', () => {
    expect(
      serverOptions(
        new SqlOptions({ schema: {}, url: 'postgres://localhost:5432/app' }),
      ),
    ).not.toHaveProperty('adapter');
  });

  // Bun.SQL construction is lazy, so this asserts the option shape without
  // reaching the network.
  it('is what Bun.SQL actually accepts', () => {
    const client = new Bun.SQL(
      new SqlOptions({
        schema: {},
        url: 'postgres://localhost:5432/app',
        max: 2,
      }).toDriverOptions(),
    );
    expect(client.options.adapter).toBe(Dialect.POSTGRES);
  });
});

describe('SqlOptions as an injection token source', () => {
  it("binds the drizzle handle under drizzle's own class", () => {
    expect(
      new SqlOptions({ schema: {}, url: 'postgres://localhost:5432/app' })
        .token,
    ).toBe(BunSQLDatabase);
  });

  it('is a DbOptions, so DbModule can hold it abstractly', () => {
    expect(
      new SqlOptions({ schema: {}, url: 'postgres://localhost:5432/app' }),
    ).toBeInstanceOf(DbOptions);
  });
});

describe.skipIf(liveUrl === undefined)(
  'SqlOptions.open against a real Postgres',
  () => {
    // Never reached when the variable is unset — skipIf has already taken the
    // block out — but the fallback keeps `url` a plain string for the typechecker.
    const options = (): SqlOptions<Record<string, never>> =>
      new SqlOptions({ schema: {}, url: liveUrl ?? '', max: 1 });

    it('returns a connected SqlConnection', async () => {
      const connection = await options().open();

      expect(connection).toBeInstanceOf(SqlConnection);
      expect(connection.backend).toBe(Backend.SQL);
      expect(connection.dialect).toBe(Dialect.POSTGRES);
      expect(connection.db).toBeInstanceOf(BunSQLDatabase);
      expect(connection.closed).toBe(false);
      await connection.close();
    });

    it('queries through the drizzle handle', async () => {
      const connection = await options().open();

      expect(await connection.db.execute(sql`SELECT 1 AS n`)).toEqual([
        { n: 1 },
      ]);
      await connection.close();
    });

    it('closes idempotently, flipping closed once', async () => {
      const connection = await options().open();

      await connection.close();
      expect(connection.closed).toBe(true);
      await connection.close();
      expect(connection.closed).toBe(true);
    });
  },
);
