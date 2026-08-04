import { and, asc, desc, eq, getTableColumns, gt, lt, or } from 'drizzle-orm';
import type { Column, SQL, Table } from 'drizzle-orm';
import { decodeCursor, encodeCursor } from './cursor.js';
import { PaginationDirection, PaginationOrder } from './options.js';
import type { PageOptions } from './options.js';
import { pageOf, type Page } from './page.js';

/**
 * Keyset (cursor) pagination over a drizzle table.
 *
 * Keyset rather than `OFFSET`: an offset scan re-reads and discards every row
 * before the page, so page 500 costs 500 pages of work, and a row inserted between
 * two requests shifts every subsequent page by one - the same item appears twice or
 * not at all. A cursor names the last row seen, so the database seeks straight to it
 * and a concurrent insert changes nothing about what the reader has already read.
 *
 * `await` on the query builder, not `.all()`. drizzle's builders are thenable on the
 * synchronous `bun:sqlite` driver as well as the asynchronous `Bun.SQL` one
 * (measured), so one code path serves both dialects `@dunx/infra/db` supports. The
 * implementation this was ported from called `.all()` and was SQLite-only.
 */
export interface PaginateParams<TTable extends Table> {
  /** Anything with drizzle's `select()`, so both dialects and a transaction fit. */
  readonly db: {
    select: () => {
      from: (table: TTable) => {
        where: (condition: SQL | undefined) => {
          orderBy: (...columns: SQL[]) => {
            limit: (rows: number) => PromiseLike<unknown[]>;
          };
        };
      };
    };
  };
  readonly table: TTable;
  readonly options: PageOptions;
  /** Base filter - a search or a status condition - ANDed with the cursor. */
  readonly where?: SQL;
  /**
   * Column to sort by. Must be unique-per-row together with `id`, which is what
   * makes the seek deterministic. Defaults to the first of `updatedAt`,
   * `createdAt`, `id` the table actually has.
   */
  readonly orderBy?: string;
  /** The tie-breaking unique column. @default 'id' */
  readonly idColumn?: string;
}

const ORDER_PRECEDENCE = ['updatedAt', 'createdAt', 'id'] as const;

/**
 * Rows plus the cursors to move either way.
 *
 * One row more than asked for is fetched and then dropped: its existence is what
 * answers `hasNextPage` without a second `COUNT(*)` over the same predicate.
 */
export const paginate = async <
  TTable extends Table,
  TRow extends Record<string, unknown>,
>(
  params: PaginateParams<TTable>,
): Promise<Page<TRow>> => {
  const { db, table, options, where } = params;
  const columns = getTableColumns(table) as unknown as Record<string, Column>;
  const idKey = params.idColumn ?? 'id';
  const idColumn = columns[idKey];
  if (!idColumn) {
    throw new TypeError(
      `paginate: the table has no "${idKey}" column to break ties on. ` +
        'Pass idColumn.',
    );
  }

  const sortKey =
    (params.orderBy !== undefined && columns[params.orderBy] !== undefined
      ? params.orderBy
      : undefined) ??
    ORDER_PRECEDENCE.find((key) => columns[key] !== undefined) ??
    idKey;
  const sortColumn = columns[sortKey] ?? idColumn;

  /**
   * Reading backwards means running the query in the opposite order and reversing
   * the rows afterwards, so the caller always receives them in the order asked for.
   */
  const backward = options.direction === PaginationDirection.BACKWARD;
  const descending = (options.order === PaginationOrder.DESC) !== backward;
  const compare = descending ? lt : gt;

  const conditions: SQL[] = [];
  if (where !== undefined) conditions.push(where);

  if (options.cursor !== undefined) {
    const { s, i } = decodeCursor(options.cursor);
    if (sortKey === idKey) {
      conditions.push(compare(idColumn, i));
    } else {
      // The row after the cursor is either strictly past its sort value, or level
      // with it and past its id. Without the tie-break, rows sharing a timestamp
      // are skipped or repeated.
      const value = restore(s, sortColumn);
      const seek = or(
        compare(sortColumn, value),
        and(eq(sortColumn, value), compare(idColumn, i)),
      );
      if (seek !== undefined) conditions.push(seek);
    }
  }

  const direction = descending ? desc : asc;
  const order =
    sortKey === idKey
      ? [direction(idColumn)]
      : [direction(sortColumn), direction(idColumn)];

  const rows = (await db
    .select()
    .from(table)
    .where(conditions.length === 0 ? undefined : and(...conditions))
    .orderBy(...order)
    .limit(options.take + 1)) as TRow[];

  const more = rows.length > options.take;
  if (more) rows.pop();
  if (backward) rows.reverse();

  const hadCursor = options.cursor !== undefined;
  return pageOf(rows, {
    take: options.take,
    hasNextPage: backward ? hadCursor : more,
    hasPreviousPage: backward ? more : hadCursor,
    cursorOf: (row) =>
      encodeCursor(row[sortKey] as Date | string | number, String(row[idKey])),
  });
};

/**
 * A cursor carries the sort value as a string. A timestamp column has to go back to
 * a `Date` for drizzle to encode it the way it stored it; anything else compares
 * fine as the string it already is.
 */
const restore = (value: string, column: Column): Date | string => {
  const type = (column as unknown as { dataType?: string }).dataType;
  return type === 'date' ? new Date(value) : value;
};
