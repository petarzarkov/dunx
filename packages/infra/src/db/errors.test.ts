import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { AppError } from '@dunx/core';
import { ConstraintError, ConstraintKind, toDatabaseError } from './errors.js';

/**
 * Every case is provoked out of a real driver rather than a hand-built object.
 * The shapes are the thing under test, and `code`/`errno` are not documented -
 * a fixture would pin what this file assumed rather than what Bun reports.
 */
const sqlite = (): Database => {
  const db = new Database(':memory:');
  db.run('pragma foreign_keys = on');
  db.run(
    'create table users (id integer primary key, email text unique not null, age integer check (age > 0))',
  );
  db.run(
    'create table posts (id integer primary key, author integer not null references users(id))',
  );
  db.run("insert into users values (1, 'a@b.c', 30)");
  return db;
};

const thrownBy = (statement: string): unknown => {
  const db = sqlite();
  try {
    db.run(statement);
    throw new Error(`expected ${statement} to fail`);
  } catch (error) {
    return toDatabaseError(error);
  } finally {
    db.close();
  }
};

describe('a SQLite constraint', () => {
  const cases = [
    {
      what: 'a duplicate unique value',
      sql: "insert into users values (2, 'a@b.c', 1)",
      kind: ConstraintKind.Unique,
      status: 409,
      code: 'SQLITE_CONSTRAINT_UNIQUE',
      constraint: 'users.email',
    },
    {
      what: 'a duplicate primary key',
      sql: "insert into users values (1, 'q@r.s', 1)",
      kind: ConstraintKind.Unique,
      status: 409,
      code: 'SQLITE_CONSTRAINT_PRIMARYKEY',
      constraint: 'users.id',
    },
    {
      what: 'a missing parent row',
      sql: 'insert into posts values (1, 999)',
      kind: ConstraintKind.ForeignKey,
      status: 409,
      code: 'SQLITE_CONSTRAINT_FOREIGNKEY',
      constraint: undefined,
    },
    {
      what: 'a null in a not-null column',
      sql: 'insert into users values (3, null, 1)',
      kind: ConstraintKind.NotNull,
      status: 400,
      code: 'SQLITE_CONSTRAINT_NOTNULL',
      constraint: 'users.email',
    },
    {
      what: 'a failed check',
      sql: "insert into users values (4, 'x@y.z', -1)",
      kind: ConstraintKind.Check,
      status: 400,
      code: 'SQLITE_CONSTRAINT_CHECK',
      constraint: 'age > 0',
    },
  ] as const;

  for (const item of cases) {
    it(`maps ${item.what} to ${item.status}`, () => {
      const error = thrownBy(item.sql);

      expect(error).toBeInstanceOf(ConstraintError);
      const constraint = error as ConstraintError;
      expect(constraint.kind).toBe(item.kind);
      expect(constraint.status).toBe(item.status);
      expect(constraint.driverCode).toBe(item.code);
      expect(constraint.constraint).toBe(item.constraint);
    });
  }

  it('keeps the driver message off the response and on the cause', () => {
    const error = thrownBy("insert into users values (2, 'a@b.c', 1)");
    const constraint = error as ConstraintError;

    // `@dunx/http`'s mapper sends `message` to the caller for a 4xx, so the
    // schema must not be in it.
    expect(constraint.message).not.toContain('users');
    expect(constraint.message).not.toContain('email');
    expect(String((constraint.cause as Error).message)).toContain(
      'users.email',
    );
  });

  it('answers a status without importing the web layer', () => {
    // Same contract `CursorError` uses: an integer on `AppError`, which
    // `@dunx/http` reads. Nothing here knows what a Response is.
    const error = thrownBy("insert into users values (2, 'a@b.c', 1)");
    expect(error).toBeInstanceOf(AppError);
  });
});

describe('something that is not a constraint', () => {
  it('leaves a syntax error alone', () => {
    const error = thrownBy('selct 1');
    expect(error).not.toBeInstanceOf(ConstraintError);
    expect((error as Error).name).toBe('SQLiteError');
  });

  it('leaves a missing table alone', () => {
    expect(thrownBy('select * from nope')).not.toBeInstanceOf(ConstraintError);
  });

  it('leaves a datatype mismatch alone', () => {
    const error = thrownBy("insert into users values ('str', 'z@z.z', 1)");
    expect(error).not.toBeInstanceOf(ConstraintError);
  });

  it('passes a non-object through untouched', () => {
    expect(toDatabaseError('a string')).toBe('a string');
    expect(toDatabaseError(undefined)).toBeUndefined();
    expect(toDatabaseError(null)).toBeNull();
  });

  it('leaves a plain Error alone', () => {
    const plain = new Error('boom');
    expect(toDatabaseError(plain)).toBe(plain);
  });

  it('does not re-wrap something it already classified', () => {
    const once = toDatabaseError(
      thrownBy("insert into users values (2, 'a@b.c', 1)"),
    );
    expect(toDatabaseError(once)).toBe(once);
  });
});

/**
 * The same five cases against a real server, because the shapes differ from
 * SQLite's in a way no offline fixture would have caught: `Bun.SQL` puts its own
 * label in `code` (`ERR_POSTGRES_SERVER_ERROR` for every one of these) and the
 * SQLSTATE in `errno`, which is the reverse of where a Node client keeps it.
 *
 * Skipped without `DUNX_DB_TEST_URL`, like the rest of the live db suites. The
 * `coverage` job declares the server.
 */
describe('a live server constraint', () => {
  const url = process.env['DUNX_DB_TEST_URL'];
  const prefix = `dunx_err_${process.pid}`;

  const withSchema = async (
    run: (sql: import('bun').SQL) => Promise<void>,
  ): Promise<void> => {
    const sql = new Bun.SQL(url ?? '', { connectionTimeout: 5 });
    try {
      await sql.unsafe(
        `create table ${prefix}_users (id int primary key, email text unique not null, age int check (age > 0))`,
      );
      await sql.unsafe(
        `create table ${prefix}_posts (id int primary key, author int not null references ${prefix}_users(id))`,
      );
      await sql.unsafe(`insert into ${prefix}_users values (1, 'a@b.c', 30)`);
      await run(sql);
    } finally {
      await sql
        .unsafe(`drop table if exists ${prefix}_posts, ${prefix}_users`)
        .catch(() => undefined);
      await sql.close();
    }
  };

  const caught = async (
    sql: import('bun').SQL,
    statement: string,
  ): Promise<ConstraintError> => {
    try {
      await sql.unsafe(statement);
      throw new Error(`expected ${statement} to fail`);
    } catch (error) {
      const mapped = toDatabaseError(error);
      expect(mapped).toBeInstanceOf(ConstraintError);
      return mapped as ConstraintError;
    }
  };

  it.skipIf(url === undefined)('maps all four kinds', async () => {
    await withSchema(async (sql) => {
      const unique = await caught(
        sql,
        `insert into ${prefix}_users values (2, 'a@b.c', 1)`,
      );
      expect(unique.kind).toBe(ConstraintKind.Unique);
      expect(unique.status).toBe(409);
      expect(unique.driverCode).toBe('23505');
      expect(unique.constraint).toContain('email');

      const fk = await caught(
        sql,
        `insert into ${prefix}_posts values (1, 999)`,
      );
      expect(fk.kind).toBe(ConstraintKind.ForeignKey);
      expect(fk.status).toBe(409);
      expect(fk.driverCode).toBe('23503');

      const notNull = await caught(
        sql,
        `insert into ${prefix}_users values (3, null, 1)`,
      );
      expect(notNull.kind).toBe(ConstraintKind.NotNull);
      expect(notNull.status).toBe(400);
      expect(notNull.driverCode).toBe('23502');

      const check = await caught(
        sql,
        `insert into ${prefix}_users values (4, 'x@y.z', -1)`,
      );
      expect(check.kind).toBe(ConstraintKind.Check);
      expect(check.status).toBe(400);
      expect(check.driverCode).toBe('23514');
    });
  });

  it.skipIf(url === undefined)('leaves a syntax error alone', async () => {
    await withSchema(async (sql) => {
      try {
        await sql.unsafe('selct 1');
        throw new Error('expected a syntax error');
      } catch (error) {
        expect(toDatabaseError(error)).not.toBeInstanceOf(ConstraintError);
      }
    });
  });
});
