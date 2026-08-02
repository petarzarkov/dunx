import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { SqliteConnection } from './sqlite/connection.js';
import { SqliteOptions } from './sqlite/options.js';
import { transaction } from './transaction.js';

const entries = sqliteTable('entries', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
});

const schema = { entries };
type Schema = typeof schema;

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

let connection: SqliteConnection<Schema>;
let db: BunSQLiteDatabase<Schema>;

const names = (): readonly string[] =>
  db
    .select({ name: entries.name })
    .from(entries)
    .orderBy(entries.id)
    .all()
    .map((row) => row.name);

const insert = (name: string): void => {
  db.insert(entries).values({ name }).run();
};

beforeEach(async () => {
  connection = await new SqliteOptions({ schema }).open();
  db = connection.db;
  db.run(
    sql`CREATE TABLE entries (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)`,
  );
});

afterEach(async () => {
  await connection.close();
});

describe('committing', () => {
  it('keeps the work when the callback returns', async () => {
    await transaction(db, (tx) => {
      tx.insert(entries).values({ name: 'kept' }).run();
    });
    expect(names()).toEqual(['kept']);
  });

  it('returns the callback’s value', async () => {
    const value = await transaction(db, () => 42);
    expect(value).toBe(42);
  });

  it('awaits a promise the callback returns', async () => {
    const value = await transaction(db, async () => {
      await Bun.sleep(1);
      return 'late';
    });
    expect(value).toBe('late');
  });

  it('hands the callback the same handle, so the schema types survive', async () => {
    await transaction(db, (tx) => {
      expect(tx).toBe(db);
      // Only compiles because `tx` is still BunSQLiteDatabase<typeof schema>.
      tx.insert(entries).values({ name: 'typed' }).run();
    });
    expect(names()).toEqual(['typed']);
  });

  it('commits work done after an await', async () => {
    await transaction(db, async (tx) => {
      tx.insert(entries).values({ name: 'before' }).run();
      await Bun.sleep(1);
      tx.insert(entries).values({ name: 'after' }).run();
    });
    expect(names()).toEqual(['before', 'after']);
  });

  it('leaves the connection usable afterwards', async () => {
    await transaction(db, (tx) => {
      tx.insert(entries).values({ name: 'one' }).run();
    });
    insert('two');
    expect(names()).toEqual(['one', 'two']);
  });
});

describe('rolling back', () => {
  it('discards the work when the callback throws', async () => {
    const error = await rejection(
      transaction(db, (tx) => {
        tx.insert(entries).values({ name: 'discarded' }).run();
        throw new Error('nope');
      }),
    );
    expect(error.message).toBe('nope');
    expect(names()).toEqual([]);
  });

  /**
   * The measurement this whole function exists for. `bun:sqlite`'s own
   * `transaction()` - which is what drizzle's `db.transaction()` delegates to -
   * commits as soon as the callback returns its promise, so the insert below is
   * already committed before the throw is even reached.
   */
  it('discards work done before an await, which drizzle’s own cannot', async () => {
    await rejection(
      transaction(db, async (tx) => {
        tx.insert(entries).values({ name: 'discarded' }).run();
        await Bun.sleep(1);
        throw new Error('async throw');
      }),
    );
    expect(names()).toEqual([]);
  });

  it('discards work done after an await', async () => {
    await rejection(
      transaction(db, async (tx) => {
        await Bun.sleep(1);
        tx.insert(entries).values({ name: 'discarded' }).run();
        throw new Error('async throw');
      }),
    );
    expect(names()).toEqual([]);
  });

  it('discards across several awaits', async () => {
    await rejection(
      transaction(db, async (tx) => {
        tx.insert(entries).values({ name: 'a' }).run();
        await Bun.sleep(1);
        tx.insert(entries).values({ name: 'b' }).run();
        await Bun.sleep(1);
        throw new Error('late');
      }),
    );
    expect(names()).toEqual([]);
  });

  it('rolls back a rejected promise as well as a throw', async () => {
    await rejection(
      transaction(db, async (tx) => {
        tx.insert(entries).values({ name: 'discarded' }).run();
        return Promise.reject(new Error('rejected'));
      }),
    );
    expect(names()).toEqual([]);
  });

  it('propagates the original error, not a wrapper', async () => {
    const thrown = new TypeError('mine');
    const error = await rejection(
      transaction(db, () => {
        throw thrown;
      }),
    );
    expect(error).toBe(thrown);
  });

  it('leaves the connection usable after a rollback', async () => {
    await rejection(
      transaction(db, () => {
        throw new Error('nope');
      }),
    );
    insert('after');
    expect(names()).toEqual(['after']);
  });

  it('discards an update as well as an insert', async () => {
    insert('original');
    await rejection(
      transaction(db, async (tx) => {
        tx.update(entries)
          .set({ name: 'changed' })
          .where(eq(entries.name, 'original'))
          .run();
        await Bun.sleep(1);
        throw new Error('nope');
      }),
    );
    expect(names()).toEqual(['original']);
  });

  it('discards a delete', async () => {
    insert('keep me');
    await rejection(
      transaction(db, async (tx) => {
        tx.delete(entries).run();
        await Bun.sleep(1);
        throw new Error('nope');
      }),
    );
    expect(names()).toEqual(['keep me']);
  });
});

describe('what drizzle’s own transaction() does here', () => {
  /**
   * Not a test of this package - a test of the claim in its doc comment. If Bun
   * ever fixes this, the assertion fails and the reasoning gets revisited rather
   * than silently outliving the bug.
   */
  it('cannot roll back an async callback', async () => {
    await rejection(
      db.transaction(async (tx) => {
        tx.insert(entries).values({ name: 'survives' }).run();
        await Bun.sleep(1);
        throw new Error('should have rolled back');
      }) as unknown as Promise<unknown>,
    );
    expect(names()).toEqual(['survives']);
  });

  it('does roll back a synchronous one', () => {
    expect(() =>
      db.transaction((tx) => {
        tx.insert(entries).values({ name: 'discarded' }).run();
        throw new Error('sync throw');
      }),
    ).toThrow('sync throw');
    expect(names()).toEqual([]);
  });
});

describe('nesting', () => {
  it('takes a savepoint, so an inner failure unwinds only the inner work', async () => {
    await transaction(db, async (tx) => {
      tx.insert(entries).values({ name: 'outer' }).run();
      await rejection(
        transaction(tx, async (sp) => {
          sp.insert(entries).values({ name: 'inner' }).run();
          await Bun.sleep(1);
          throw new Error('inner');
        }),
      );
      tx.insert(entries).values({ name: 'outer after' }).run();
    });
    expect(names()).toEqual(['outer', 'outer after']);
  });

  it('unwinds everything when the inner failure is not caught', async () => {
    await rejection(
      transaction(db, async (tx) => {
        tx.insert(entries).values({ name: 'outer' }).run();
        await transaction(tx, (sp) => {
          sp.insert(entries).values({ name: 'inner' }).run();
          throw new Error('inner');
        });
      }),
    );
    expect(names()).toEqual([]);
  });

  it('commits the inner work when nothing throws', async () => {
    await transaction(db, async (tx) => {
      tx.insert(entries).values({ name: 'outer' }).run();
      await transaction(tx, (sp) => {
        sp.insert(entries).values({ name: 'inner' }).run();
      });
    });
    expect(names()).toEqual(['outer', 'inner']);
  });

  it('returns the inner value', async () => {
    const value = await transaction(db, (tx) => transaction(tx, () => 'inner'));
    expect(value).toBe('inner');
  });

  it('nests three deep', async () => {
    await transaction(db, async (one) => {
      one.insert(entries).values({ name: '1' }).run();
      await transaction(one, async (two) => {
        two.insert(entries).values({ name: '2' }).run();
        await rejection(
          transaction(two, async (three) => {
            three.insert(entries).values({ name: '3' }).run();
            await Bun.sleep(1);
            throw new Error('deepest');
          }),
        );
      });
    });
    expect(names()).toEqual(['1', '2']);
  });

  it('releases the savepoint, so a later top-level transaction still works', async () => {
    await transaction(db, async (tx) => {
      await transaction(tx, (sp) => {
        sp.insert(entries).values({ name: 'inner' }).run();
      });
    });
    await transaction(db, (tx) => {
      tx.insert(entries).values({ name: 'later' }).run();
    });
    expect(names()).toEqual(['inner', 'later']);
  });

  it('recovers from an inner rollback and commits the outer', async () => {
    await transaction(db, async (tx) => {
      await rejection(
        transaction(tx, (sp) => {
          sp.insert(entries).values({ name: 'gone' }).run();
          throw new Error('inner');
        }),
      );
      tx.insert(entries).values({ name: 'kept' }).run();
    });
    expect(names()).toEqual(['kept']);
  });
});

describe('overlapping top-level transactions', () => {
  /**
   * There is one connection, so a second `BEGIN` while the first is open would be
   * "cannot start a transaction within a transaction". They queue instead.
   */
  it('queues rather than issuing a nested BEGIN', async () => {
    await Promise.all([
      transaction(db, async (tx) => {
        tx.insert(entries).values({ name: 'first' }).run();
        await Bun.sleep(5);
      }),
      transaction(db, async (tx) => {
        await Bun.sleep(1);
        tx.insert(entries).values({ name: 'second' }).run();
      }),
    ]);
    expect(names()).toEqual(['first', 'second']);
  });

  it('runs a queued transaction after one that rolled back', async () => {
    const failing = rejection(
      transaction(db, async (tx) => {
        tx.insert(entries).values({ name: 'discarded' }).run();
        await Bun.sleep(3);
        throw new Error('nope');
      }),
    );
    const succeeding = transaction(db, (tx) => {
      tx.insert(entries).values({ name: 'kept' }).run();
    });

    await Promise.all([failing, succeeding]);
    expect(names()).toEqual(['kept']);
  });

  it('keeps every one of many queued transactions', async () => {
    await Promise.all(
      ['a', 'b', 'c', 'd'].map((name) =>
        transaction(db, async (tx) => {
          await Bun.sleep(1);
          tx.insert(entries).values({ name }).run();
        }),
      ),
    );
    expect([...names()].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('does not queue a nested call behind its own holder', async () => {
    // A nested call is already inside the holder's turn, so waiting on the queue
    // would deadlock. Completing at all is the assertion.
    await transaction(db, async (tx) => {
      await transaction(tx, async (sp) => {
        await Bun.sleep(1);
        sp.insert(entries).values({ name: 'nested' }).run();
      });
    });
    expect(names()).toEqual(['nested']);
  });
});
