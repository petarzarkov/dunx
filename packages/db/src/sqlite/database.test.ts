import { beforeEach, describe, expect, it } from 'bun:test';
import { Backend, Dialect, type Database } from '../contract.js';
import { DatabaseError } from '../errors.js';
import { SqliteOptions } from './options.js';
import { SqliteDatabase } from './database.js';

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
  born: string | null;
}

let db: Database;

beforeEach(async () => {
  db = await new SqliteOptions().open();
  await db.exec(
    'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, born TEXT)',
  );
});

const names = async (): Promise<readonly string[]> =>
  (await db.all<User>('SELECT name FROM users ORDER BY id')).map(
    (row) => row.name,
  );

describe('SqliteDatabase', () => {
  it('reports its backend, dialect and driver handle', () => {
    expect(db.backend).toBe(Backend.SQLITE);
    expect(db.dialect).toBe(Dialect.SQLITE);
    expect(db).toBeInstanceOf(SqliteDatabase);
    // The escape hatch: narrowing restores the concrete type on `raw`.
    if (db instanceof SqliteDatabase) {
      expect(typeof db.raw.serialize).toBe('function');
    }
  });

  it('binds template values as parameters rather than interpolating them', async () => {
    await db.sql`INSERT INTO users (name) VALUES (${"o'brien"})`.run();
    const found = await db.sql<User>`
      SELECT * FROM users WHERE name = ${"o'brien"}
    `.get();

    expect(found?.name).toBe("o'brien");
    // A quote in a value cannot end the literal, so nothing was concatenated.
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

  it('reports changes and the inserted rowid', async () => {
    expect(
      await db.sql`INSERT INTO users (name) VALUES (${'ada'})`.run(),
    ).toEqual({ changes: 1, lastInsertRowid: 1 });

    await db.run('INSERT INTO users (name) VALUES (?)', ['grace']);
    expect(await db.sql`UPDATE users SET born = ${'1906'}`.run()).toMatchObject(
      {
        changes: 2,
      },
    );
    expect(await db.run('DELETE FROM users')).toMatchObject({ changes: 2 });
  });

  it('converts a Date to ISO 8601, which the driver otherwise refuses', async () => {
    const born = new Date('1815-12-10T00:00:00.000Z');
    await db.sql`INSERT INTO users (name, born) VALUES (${'ada'}, ${born})`.run();

    const found = await db.sql<User>`SELECT * FROM users`.get();
    expect(found?.born).toBe('1815-12-10T00:00:00.000Z');
  });

  it('binds every SqlValue the contract allows', async () => {
    await db.exec(
      'CREATE TABLE kinds (t TEXT, n REAL, big INT, b INT, blob BLOB, nil TEXT)',
    );
    await db.sql`
      INSERT INTO kinds VALUES (${'s'}, ${1.5}, ${9007199254740993n}, ${true}, ${new Uint8Array([1, 2])}, ${null})
    `.run();

    const row = await db.sql<{
      t: string;
      n: number;
      big: number;
      b: number;
      blob: Uint8Array;
      nil: null;
    }>`SELECT * FROM kinds`.get();

    expect(row?.t).toBe('s');
    expect(row?.n).toBe(1.5);
    expect(row?.b).toBe(1);
    expect(row?.blob).toEqual(new Uint8Array([1, 2]));
    expect(row?.nil).toBe(null);
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
        await tx.sql`INSERT INTO users (name) VALUES (${'grace'})`.run();
        return 'done';
      });

      expect(result).toBe('done');
      expect(await names()).toEqual(['ada', 'grace']);
    });

    /**
     * The reason this is not built on the driver's own `db.transaction()`: that
     * wrapper commits when the callback *returns*, so with an async callback the
     * commit lands before the promise settles and a later throw changes nothing.
     */
    it('rolls back work that was awaited before the throw', async () => {
      const failing = db.transaction(async (tx) => {
        await tx.sql`INSERT INTO users (name) VALUES (${'ada'})`.run();
        await Bun.sleep(1);
        await tx.sql`INSERT INTO users (name) VALUES (${'grace'})`.run();
        throw new Error('boom');
      });

      expect((await rejection(failing)).message).toBe('boom');
      expect(await names()).toEqual([]);
    });

    it('rolls back to a savepoint without losing the outer work', async () => {
      await db.transaction(async (tx) => {
        await tx.sql`INSERT INTO users (name) VALUES (${'outer'})`.run();

        const inner = tx.transaction(async (sp) => {
          await sp.sql`INSERT INTO users (name) VALUES (${'inner'})`.run();
          throw new Error('inner failed');
        });
        expect((await rejection(inner)).message).toBe('inner failed');

        await tx.sql`INSERT INTO users (name) VALUES (${'after'})`.run();
      });

      expect(await names()).toEqual(['outer', 'after']);
    });

    it('commits a released savepoint with its parent', async () => {
      await db.transaction(async (tx) => {
        await tx.transaction(async (sp) => {
          await sp.sql`INSERT INTO users (name) VALUES (${'nested'})`.run();
        });
      });

      expect(await names()).toEqual(['nested']);
    });

    it('discards a released savepoint when the parent rolls back', async () => {
      const failing = db.transaction(async (tx) => {
        await tx.transaction(async (sp) => {
          await sp.sql`INSERT INTO users (name) VALUES (${'nested'})`.run();
        });
        throw new Error('outer failed');
      });

      expect((await rejection(failing)).message).toBe('outer failed');
      expect(await names()).toEqual([]);
    });

    /**
     * One connection cannot hold two transactions, so overlapping top-level calls
     * are queued rather than issuing a nested BEGIN.
     */
    it('serialises concurrent top-level transactions', async () => {
      const insert = (name: string) =>
        db.transaction(async (tx) => {
          await Bun.sleep(1);
          await tx.sql`INSERT INTO users (name) VALUES (${name})`.run();
          return name;
        });

      expect(
        await Promise.all([insert('a'), insert('b'), insert('c')]),
      ).toEqual(['a', 'b', 'c']);
      expect(await names()).toEqual(['a', 'b', 'c']);
    });

    it('does not let one failed transaction block the queue', async () => {
      const failing = db.transaction(() => {
        throw new Error('first fails');
      });
      const succeeding = db.transaction(async (tx) => {
        await tx.sql`INSERT INTO users (name) VALUES (${'second'})`.run();
        return 'ok';
      });

      expect((await rejection(failing)).message).toBe('first fails');
      expect(await succeeding).toBe('ok');
      expect(await names()).toEqual(['second']);
    });

    it('rolls back on a constraint violation raised by the driver', async () => {
      await db.run('INSERT INTO users (name) VALUES (?)', ['ada']);

      const failing = db.transaction(async (tx) => {
        await tx.sql`INSERT INTO users (name) VALUES (${'grace'})`.run();
        await tx.sql`INSERT INTO users (name) VALUES (${'ada'})`.run();
      });

      expect((await rejection(failing)).message).toMatch(/UNIQUE/);
      expect(await names()).toEqual(['ada']);
    });
  });

  describe('close', () => {
    it('is idempotent', async () => {
      await db.close();
      await db.close();
      expect(await db.close().then(() => 'resolved')).toBe('resolved');
    });

    it('reports a clear error rather than crashing on use after close', async () => {
      await db.close();
      expect(await rejection(db.all('SELECT 1'))).toBeInstanceOf(DatabaseError);
      expect((await rejection(db.exec('SELECT 1'))).message).toMatch(/closed/);
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
