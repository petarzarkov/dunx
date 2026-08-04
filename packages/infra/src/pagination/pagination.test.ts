import { beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { like } from 'drizzle-orm';
import { drizzle, type BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { CursorError, decodeCursor, encodeCursor } from './cursor.js';
import { paginate } from './keyset.js';
import {
  PAGINATION,
  PageOptionsError,
  PaginationDirection,
  PaginationOrder,
  parsePageOptions,
} from './options.js';

const notes = sqliteTable('notes', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

/**
 * The index signature is what satisfies `paginate`'s `Record<string, unknown>`
 * constraint - it indexes rows by a sort key chosen at runtime. An `interface`
 * gets no implicit one, and `consistent-type-definitions` rules out the type alias
 * that would, so it is stated.
 */
interface Note {
  id: string;
  title: string;
  createdAt: Date;
  [key: string]: unknown;
}

let db: BunSQLiteDatabase;

/** A real `bun:sqlite`, because keyset pagination is a statement about SQL. */
const seed = (rows: readonly { id: string; at: number }[]): void => {
  const sqlite = new Database(':memory:');
  sqlite.run(
    'create table notes (id text primary key, title text not null, created_at integer not null)',
  );
  db = drizzle(sqlite);
  // drizzle rejects values([]), so an empty seed just leaves the table empty.
  if (rows.length === 0) return;
  db.insert(notes)
    .values(
      rows.map((row) => ({
        id: row.id,
        title: `note ${row.id}`,
        createdAt: new Date(row.at),
      })),
    )
    .run();
};

/**
 * `cursor` is `string | undefined` rather than optional: the tests read it straight
 * off `meta.nextCursor ?? undefined`, and `exactOptionalPropertyTypes` treats a
 * present-but-undefined property as different from an absent one.
 */
interface PageArgs {
  take?: number;
  order?: PaginationOrder;
  direction?: PaginationDirection;
  cursor?: string | undefined;
}

const page = (
  { cursor, ...rest }: PageArgs = {},
  where?: Parameters<typeof paginate>[0]['where'],
) =>
  paginate<typeof notes, Note>({
    db: db as never,
    table: notes,
    options: {
      take: 2,
      order: PaginationOrder.DESC,
      direction: PaginationDirection.FORWARD,
      ...rest,
      ...(cursor === undefined ? {} : { cursor }),
    },
    ...(where === undefined ? {} : { where }),
  });

beforeEach(() => {
  // Descending by createdAt: e, d, c, b, a.
  seed([
    { id: 'a', at: 1000 },
    { id: 'b', at: 2000 },
    { id: 'c', at: 3000 },
    { id: 'd', at: 4000 },
    { id: 'e', at: 5000 },
  ]);
});

describe('the cursor codec', () => {
  it('round-trips a date and an id', () => {
    const at = new Date('2026-01-02T03:04:05.000Z');
    expect(decodeCursor(encodeCursor(at, 'row-1'))).toEqual({
      s: at.toISOString(),
      i: 'row-1',
    });
  });

  it('is url-safe, since it travels in a query string', () => {
    const token = encodeCursor('a/b+c=d', 'x'.repeat(40));
    expect(token).not.toContain('/');
    expect(token).not.toContain('+');
    expect(encodeURIComponent(token)).toBe(token);
  });

  /** Every failure is one error: which layer rejected it is not a client's business. */
  it('rejects anything that did not come from encodeCursor', () => {
    for (const bad of [
      'not-base64!!',
      Buffer.from('not json').toString('base64url'),
      Buffer.from('{"s":"x"}').toString('base64url'),
      Buffer.from('{"s":1,"i":"a"}').toString('base64url'),
      Buffer.from('{"s":"x","i":""}').toString('base64url'),
      Buffer.from('null').toString('base64url'),
    ]) {
      expect(() => decodeCursor(bad)).toThrow(CursorError);
    }
  });

  /**
   * The reference required the id to be a UUID, which silently breaks keyset
   * pagination over any table with a serial or a slug id.
   */
  it('accepts a non-UUID id', () => {
    expect(decodeCursor(encodeCursor('v', '42')).i).toBe('42');
  });
});

describe('parsePageOptions', () => {
  it('applies the documented defaults for an empty query', () => {
    expect(parsePageOptions()).toEqual({
      take: PAGINATION.DEFAULT_TAKE,
      order: PAGINATION.DEFAULT_ORDER,
      direction: PAGINATION.DEFAULT_DIRECTION,
    });
  });

  it('reads a plain object and a URLSearchParams the same way', () => {
    const expected = {
      take: 5,
      order: PaginationOrder.ASC,
      direction: PaginationDirection.BACKWARD,
      cursor: 'abc',
    };
    expect(
      parsePageOptions({
        take: '5',
        order: 'asc',
        direction: 'backward',
        cursor: 'abc',
      }),
    ).toEqual(expected);
    expect(
      parsePageOptions(
        new URLSearchParams('take=5&order=asc&direction=backward&cursor=abc'),
      ),
    ).toEqual(expected);
  });

  it('rejects a take outside the bounds, naming them', () => {
    expect(() => parsePageOptions({ take: '0' })).toThrow(PageOptionsError);
    expect(() => parsePageOptions({ take: '101' })).toThrow(
      /between 1 and 100/,
    );
    expect(() => parsePageOptions({ take: '1.5' })).toThrow(PageOptionsError);
    expect(() => parsePageOptions({ take: 'many' })).toThrow(PageOptionsError);
  });

  it('rejects an unknown order or direction, listing what is allowed', () => {
    expect(() => parsePageOptions({ order: 'sideways' })).toThrow(/asc, desc/);
    expect(() => parsePageOptions({ direction: 'up' })).toThrow(
      /forward, backward/,
    );
  });

  it('accepts either case for order', () => {
    expect(parsePageOptions({ order: 'DESC' }).order).toBe(
      PaginationOrder.DESC,
    );
  });

  /** A cursor is bounded because an unbounded one is an unbounded base64 decode. */
  it('rejects an over-long cursor or search', () => {
    expect(() =>
      parsePageOptions({ cursor: 'x'.repeat(PAGINATION.MAX_CURSOR + 1) }),
    ).toThrow(PageOptionsError);
    expect(() =>
      parsePageOptions({ search: 'x'.repeat(PAGINATION.MAX_SEARCH + 1) }),
    ).toThrow(PageOptionsError);
  });

  it('treats an empty cursor or search as absent', () => {
    expect(parsePageOptions({ cursor: '', search: '' })).not.toHaveProperty(
      'cursor',
    );
  });

  it('takes the first value when a key repeats', () => {
    expect(parsePageOptions({ take: ['3', '9'] }).take).toBe(3);
  });
});

describe('paginate', () => {
  it('returns the first page newest-first, with no previous cursor', async () => {
    const first = await page();
    expect(first.data.map((row) => row.id)).toEqual(['e', 'd']);
    expect(first.meta.hasNextPage).toBe(true);
    expect(first.meta.hasPreviousPage).toBe(false);
    expect(first.meta.previousCursor).toBeNull();
    expect(first.meta.nextCursor).toBeString();
  });

  /** The whole point: walking forwards must visit every row exactly once. */
  it('walks the whole table forwards without repeating or skipping a row', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const result = await page(cursor === undefined ? {} : { cursor });
      seen.push(...result.data.map((row) => row.id));
      if (!result.meta.hasNextPage) break;
      cursor = result.meta.nextCursor ?? undefined;
    }
    expect(seen).toEqual(['e', 'd', 'c', 'b', 'a']);
  });

  it('walks backwards to the page it came from', async () => {
    const first = await page();
    const second = await page({ cursor: first.meta.nextCursor ?? undefined });
    expect(second.data.map((row) => row.id)).toEqual(['c', 'b']);

    const back = await page({
      cursor: second.meta.previousCursor ?? undefined,
      direction: PaginationDirection.BACKWARD,
    });
    // Same rows as page one, in the same order the caller asked for.
    expect(back.data.map((row) => row.id)).toEqual(['e', 'd']);
    expect(back.meta.hasNextPage).toBe(true);
  });

  it('honours ascending order', async () => {
    const first = await page({ order: PaginationOrder.ASC });
    expect(first.data.map((row) => row.id)).toEqual(['a', 'b']);
    const next = await page({
      order: PaginationOrder.ASC,
      cursor: first.meta.nextCursor ?? undefined,
    });
    expect(next.data.map((row) => row.id)).toEqual(['c', 'd']);
  });

  it('reports the last page and mints no next cursor on it', async () => {
    const last = await page({ take: 5 });
    expect(last.data).toHaveLength(5);
    expect(last.meta.hasNextPage).toBe(false);
    // A next cursor here would be a token that returns nothing.
    expect(last.meta.nextCursor).toBeNull();
  });

  /**
   * Rows sharing a sort value are exactly what a naive `WHERE createdAt < ?` gets
   * wrong: it skips the tie or returns it twice. The id tie-break is what fixes it.
   */
  it('does not skip or repeat rows that share a sort value', async () => {
    seed([
      { id: 'a', at: 1000 },
      { id: 'b', at: 1000 },
      { id: 'c', at: 1000 },
      { id: 'd', at: 1000 },
    ]);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const result = await page(cursor === undefined ? {} : { cursor });
      seen.push(...result.data.map((row) => row.id));
      if (!result.meta.hasNextPage) break;
      cursor = result.meta.nextCursor ?? undefined;
    }
    expect(seen).toHaveLength(4);
    expect(new Set(seen).size).toBe(4);
  });

  /** A row inserted mid-walk must not shift a page, which is offset's failure. */
  it('is unaffected by an insert between pages', async () => {
    const first = await page();
    db.insert(notes)
      .values({ id: 'z', title: 'inserted', createdAt: new Date(9000) })
      .run();

    const second = await page({ cursor: first.meta.nextCursor ?? undefined });
    // 'z' sorts newest, so it belongs before the cursor and must not appear here,
    // and nothing already read is repeated.
    expect(second.data.map((row) => row.id)).toEqual(['c', 'b']);
  });

  it('ANDs a base filter with the cursor', async () => {
    const filtered = await page({ take: 10 }, like(notes.title, '%a%'));
    expect(filtered.data.map((row) => row.id)).toEqual(['a']);
  });

  it('sorts by an explicit column', async () => {
    const byId = await page({ take: 5, order: PaginationOrder.ASC });
    expect(byId.data.map((row) => row.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('says so when the tie-break column is missing', async () => {
    await expect(
      paginate({
        db: db as never,
        table: notes,
        options: {
          take: 2,
          order: PaginationOrder.DESC,
          direction: PaginationDirection.FORWARD,
        },
        idColumn: 'nope',
      }),
    ).rejects.toThrow(/no "nope" column/);
  });

  /**
   * The shape `examples/full` actually has: an integer autoincrement primary key and
   * no timestamp, so the sort key falls back to `id`. The cursor carries it as a
   * string, and SQLite's column affinity converts it back - found by wiring the
   * example up, since every case above uses a text id with a timestamp sort.
   */
  it('walks a table whose only key is an integer id', async () => {
    const sqlite = new Database(':memory:');
    sqlite.run('create table rows (id integer primary key autoincrement)');
    const numeric = drizzle(sqlite);
    const table = sqliteTable('rows', {
      id: integer('id').primaryKey({ autoIncrement: true }),
    });
    numeric
      .insert(table)
      .values([{}, {}, {}, {}, {}] as never)
      .run();

    const seen: number[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const result = await paginate<typeof table, { id: number }>({
        db: numeric as never,
        table,
        options: {
          take: 2,
          order: PaginationOrder.ASC,
          direction: PaginationDirection.FORWARD,
          ...(cursor === undefined ? {} : { cursor }),
        },
      });
      seen.push(...result.data.map((row) => row.id));
      if (!result.meta.hasNextPage) break;
      cursor = result.meta.nextCursor ?? undefined;
    }

    expect(seen).toEqual([1, 2, 3, 4, 5]);
  });

  it('returns an empty page rather than failing on an empty table', async () => {
    seed([]);
    const empty = await page();
    expect(empty.data).toEqual([]);
    expect(empty.meta.hasNextPage).toBe(false);
    expect(empty.meta.nextCursor).toBeNull();
    expect(empty.meta.previousCursor).toBeNull();
  });
});
