import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Backend, Dialect, type Database } from '../contract.js';
import { DatabaseError } from '../errors.js';
import { quoteIdentifier } from '../repository.js';
import { SqlDatabase } from './database.js';
import { SqlOptions } from './options.js';

/**
 * The repo's rejection idiom: await the promise, keep the reason. `expect().rejects`
 * is typed as non-thenable by bun:test, which makes the assertion a lint warning.
 */
const rejection = async (promise: Promise<unknown>): Promise<Error> => {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof Error))
    throw new Error('expected the promise to reject with an Error');
  return error;
};

interface User {
  id: number;
  name: string;
}

/**
 * `Bun.SQL` speaks four dialects, and SQLite is one of them — so the whole
 * `SqlDatabase` code path is exercised for real here with no server running.
 * What is *not* covered is wire-protocol behaviour specific to a server dialect;
 * that is what the guarded suite at the bottom is for.
 */
let db: Database;

beforeEach(async () => {
  db = await new SqlOptions({ url: 'sqlite://:memory:' }).open();
  await db.exec(
    'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)',
  );
});

const names = async (): Promise<readonly string[]> =>
  (await db.all<User>('SELECT name FROM users ORDER BY id')).map(
    (row) => row.name,
  );

describe('SqlDatabase', () => {
  it('reports its backend, dialect and driver handle', () => {
    expect(db.backend).toBe(Backend.SQL);
    expect(db.dialect).toBe(Dialect.SQLITE);
    expect(db).toBeInstanceOf(SqlDatabase);
    if (db instanceof SqlDatabase) {
      // The Bun.SQL client is itself callable — it is the tagged template.
      expect(typeof db.raw).toBe('function');
      expect(typeof db.raw.begin).toBe('function');
    }
  });

  it('hands the template to the driver, so values are bound not interpolated', async () => {
    await db.sql`INSERT INTO users (name) VALUES (${"o'brien"})`.run();
    const found = await db.sql<User>`
      SELECT * FROM users WHERE name = ${"o'brien"}
    `.get();

    expect(found?.name).toBe("o'brien");
    expect(await names()).toEqual(["o'brien"]);
  });

  it('awaiting a query is all()', async () => {
    await db.run('INSERT INTO users (name) VALUES (?)', ['ada']);
    const rows = await db.sql<User>`SELECT * FROM users`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('ada');
  });

  it('returns null from get() when nothing matches', async () => {
    expect(await db.sql<User>`SELECT * FROM users WHERE id = ${99}`.get()).toBe(
      null,
    );
    expect(await db.get<User>('SELECT * FROM users WHERE id = ?', [99])).toBe(
      null,
    );
  });

  /** `affectedRows` is present in the result shape but null here, so `count` carries it. */
  it('reads changes out of the metadata Bun hangs off the result array', async () => {
    expect(
      await db.sql`INSERT INTO users (name) VALUES (${'ada'})`.run(),
    ).toEqual({ changes: 1, lastInsertRowid: 1 });

    await db.run('INSERT INTO users (name) VALUES (?)', ['grace']);
    expect(await db.run('DELETE FROM users')).toMatchObject({ changes: 2 });
  });

  it('converts a Date for the SQLite adapter, which rejects one', async () => {
    await db.exec('CREATE TABLE stamps (at TEXT)');
    await db.sql`INSERT INTO stamps VALUES (${new Date('2020-01-02T03:04:05.000Z')})`.run();

    expect(await db.get<{ at: string }>('SELECT * FROM stamps')).toEqual({
      at: '2020-01-02T03:04:05.000Z',
    });
  });

  it('runs several statements from exec', async () => {
    await db.exec('CREATE TABLE a (x INT); CREATE TABLE b (y INT)');
    expect(await db.all('SELECT * FROM a')).toEqual([]);
    expect(await db.all('SELECT * FROM b')).toEqual([]);
  });

  describe('transaction', () => {
    it('commits and returns the callback value', async () => {
      const result = await db.transaction(async (tx) => {
        await tx.sql`INSERT INTO users (name) VALUES (${'ada'})`.run();
        return 'done';
      });

      expect(result).toBe('done');
      expect(await names()).toEqual(['ada']);
    });

    it('rolls back on a throw', async () => {
      const failing = db.transaction(async (tx) => {
        await tx.sql`INSERT INTO users (name) VALUES (${'ada'})`.run();
        await Bun.sleep(1);
        throw new Error('boom');
      });

      expect((await rejection(failing)).message).toBe('boom');
      expect(await names()).toEqual([]);
    });

    it('nests as a savepoint, so an inner failure spares the outer work', async () => {
      await db.transaction(async (tx) => {
        await tx.sql`INSERT INTO users (name) VALUES (${'outer'})`.run();

        const inner = tx.transaction(async (sp) => {
          await sp.sql`INSERT INTO users (name) VALUES (${'inner'})`.run();
          throw new Error('inner failed');
        });
        expect((await rejection(inner)).message).toBe('inner failed');
      });

      expect(await names()).toEqual(['outer']);
    });

    it('commits a released savepoint with its parent', async () => {
      await db.transaction((tx) =>
        tx.transaction(
          async (sp) =>
            void (await sp.sql`INSERT INTO users (name) VALUES (${'n'})`.run()),
        ),
      );
      expect(await names()).toEqual(['n']);
    });

    it('refuses to close the pool from inside a transaction', async () => {
      expect(
        await rejection(db.transaction((tx) => tx.close())),
      ).toBeInstanceOf(DatabaseError);
      // The pool survived, so the transaction handle really was distinct.
      expect(await names()).toEqual([]);
    });
  });

  describe('close', () => {
    it('is idempotent', async () => {
      await db.close();
      await db.close();
      expect(await db.close().then(() => 'resolved')).toBe('resolved');
    });

    it('reports a clear error on use after close', async () => {
      await db.close();
      expect(await rejection(db.all('SELECT 1'))).toBeInstanceOf(DatabaseError);
      expect((await rejection(db.run('SELECT 1'))).message).toMatch(/closed/);
      expect((await rejection(db.transaction(() => 1))).message).toMatch(
        /closed/,
      );
    });

    it('is what onShutdown does', async () => {
      await db.onShutdown();
      expect(await rejection(db.get('SELECT 1'))).toBeInstanceOf(DatabaseError);
    });
  });
});

/**
 * Opt-in. Set `DUNX_DB_TEST_URL` to a reachable server to run these; with nothing
 * set the suite is skipped, so `bun run test` passes with no database installed.
 *
 *   DUNX_DB_TEST_URL=postgres://postgres:postgres@localhost:5432/postgres bun test
 */
const serverUrl = process.env['DUNX_DB_TEST_URL'];

describe.skipIf(!serverUrl)('SqlDatabase against a live server', () => {
  const table = `dunx_db_test_${Bun.randomUUIDv7().replaceAll('-', '')}`;
  let server: Database;
  // A table name cannot be a bound parameter, so it is quoted into the text and
  // the values go through placeholders — which differ by dialect.
  let insert: string;

  beforeEach(async () => {
    server = await new SqlOptions({ url: serverUrl ?? '', max: 2 }).open();
    const columns = server.dialect === Dialect.POSTGRES ? '($1, $2)' : '(?, ?)';
    insert = `INSERT INTO ${quoteIdentifier(server.dialect, table)} (id, name) VALUES ${columns}`;

    await server.exec(
      `DROP TABLE IF EXISTS ${quoteIdentifier(server.dialect, table)}`,
    );
    await server.exec(
      `CREATE TABLE ${quoteIdentifier(server.dialect, table)} (id INT, name VARCHAR(32))`,
    );
  });

  afterEach(async () => {
    await server
      .exec(`DROP TABLE IF EXISTS ${quoteIdentifier(server.dialect, table)}`)
      .catch(() => undefined);
    await server.close();
  });

  it('round-trips parameters against the real wire protocol', async () => {
    expect(await server.run(insert, [1, 'ada'])).toMatchObject({ changes: 1 });
    expect(
      await server.get<User>(
        `SELECT id, name FROM ${quoteIdentifier(server.dialect, table)}`,
      ),
    ).toMatchObject({ name: 'ada' });
  });

  it('binds a template value without an identifier in it', async () => {
    await server.run(insert, [1, 'ada']);
    const rows = await server.sql<{ one: number }>`SELECT ${1} AS one`;
    expect(rows[0]?.one).toBe(1);
  });

  it('rolls back a real transaction', async () => {
    const failing = server.transaction(async (tx) => {
      await tx.run(insert, [2, 'grace']);
      throw new Error('boom');
    });

    expect((await rejection(failing)).message).toBe('boom');
    expect(
      await server.all(
        `SELECT * FROM ${quoteIdentifier(server.dialect, table)}`,
      ),
    ).toHaveLength(0);
  });

  it('closes cleanly', async () => {
    await server.close();
    expect(await rejection(server.all('SELECT 1'))).toBeInstanceOf(
      DatabaseError,
    );
  });
});
