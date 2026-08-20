import { and, asc, desc, eq, getTableColumns, gt, lt, or } from 'drizzle-orm';
import type { Column, SQL, Table } from 'drizzle-orm';
import { decodeCursor, encodeCursor } from './cursor.js';
import { PaginationDirection, PaginationOrder } from './options.js';
import type { PageOptions } from './options.js';
import { pageOf, type Page } from './page.js';

/**
 * The chain `paginate` walks, parameterised by what the driver hands back at the
 * end of it. Anything with drizzle's `select()` fits, so both dialects and a
 * transaction handle do.
 */
export interface PaginateSource<TTable extends Table, TResult> {
  select: () => {
    from: (table: TTable) => {
      where: (condition: SQL | undefined) => {
        orderBy: (...columns: SQL[]) => {
          limit: (rows: number) => TResult;
        };
      };
    };
  };
}

/**
 * What a synchronous driver's builder answers: `all()` returning the rows, not a
 * promise of them. `drizzle-orm/bun-sqlite` in synchronous mode is the case;
 * `drizzle-orm/bun-sql` has no `all` at all, and an asynchronous SQLite driver's
 * `all()` returns a promise, so neither is assignable here.
 */
export interface SyncRows {
  all: () => unknown[];
}

interface PaginateBase<TTable extends Table> {
  readonly table: TTable;
  readonly options: PageOptions;
  /**
   * Base filter - a search or a status condition - ANDed with the cursor.
   *
   * `| undefined` on every optional here, stated rather than left to the `?`. Under
   * `exactOptionalPropertyTypes` those are different types, and the natural caller
   * builds this conditionally: `where: clauses.length === 0 ? undefined :
   * and(...clauses)`. Without it every call site has to spread the key in instead,
   * which is friction for nothing - the same lesson `PageOptions.cursor` taught.
   */
  readonly where?: SQL | undefined;
  /**
   * Column to sort by. Must be unique-per-row together with `id`, which is what
   * makes the seek deterministic. Defaults to the first of `updatedAt`,
   * `createdAt`, `id` the table actually has.
   */
  readonly orderBy?: string | undefined;
  /** The tie-breaking unique column. @default 'id' */
  readonly idColumn?: string | undefined;
}

/**
 * Keyset (cursor) pagination over a drizzle table.
 *
 * Keyset rather than `OFFSET`: an offset scan re-reads and discards every row
 * before the page, so page 500 costs 500 pages of work, and a row inserted between
 * two requests shifts every subsequent page by one - the same item appears twice or
 * not at all. A cursor names the last row seen, so the database seeks straight to it
 * and a concurrent insert changes nothing about what the reader has already read.
 *
 * This is the asynchronous shape: `await` on the query builder, which is what
 * `drizzle-orm/bun-sql` answers. See {@link SyncPaginateParams} for the
 * synchronous one.
 */
export interface PaginateParams<
  TTable extends Table,
> extends PaginateBase<TTable> {
  readonly db: PaginateSource<TTable, PromiseLike<unknown[]>>;
}

/**
 * The same parameters against a synchronous driver.
 *
 * `db` is the discriminant, and it is the driver's own type rather than a flag:
 * a builder that answers `all(): unknown[]` is a synchronous one, so `paginate`
 * returns a `Page` rather than a promise of one and a repository over
 * `drizzle-orm/bun-sqlite` needs no `async` on its `list`.
 */
export interface SyncPaginateParams<
  TTable extends Table,
> extends PaginateBase<TTable> {
  readonly db: PaginateSource<TTable, SyncRows>;
}

const ORDER_PRECEDENCE = ['updatedAt', 'createdAt', 'id'] as const;

/** Everything the query and the envelope need, decided before either is built. */
interface Plan {
  readonly conditions: readonly SQL[];
  readonly order: readonly SQL[];
  readonly sortKey: string;
  readonly idKey: string;
  readonly backward: boolean;
}

const plan = <TTable extends Table>(params: PaginateBase<TTable>): Plan => {
  const { table, options, where } = params;
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
  return {
    conditions,
    order:
      sortKey === idKey
        ? [direction(idColumn)]
        : [direction(sortColumn), direction(idColumn)],
    sortKey,
    idKey,
    backward,
  };
};

/**
 * One row more than asked for is fetched and then dropped: its existence is what
 * answers `hasNextPage` without a second `COUNT(*)` over the same predicate.
 */
const envelope = <TRow extends Record<string, unknown>>(
  rows: TRow[],
  options: PageOptions,
  { sortKey, idKey, backward }: Plan,
): Page<TRow> => {
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
 * Rows plus the cursors to move either way, on whichever channel the driver
 * answers on.
 *
 * **The return type follows `db`.** A synchronous driver gets a `Page` and an
 * asynchronous one a `Promise<Page>`, decided by overload rather than by a flag,
 * so a repository over `drizzle-orm/bun-sqlite` is synchronous end to end - which
 * is what keeps a read-check-write inside `transactionSync` atomic instead of
 * forcing an `async list` onto every repository that shares the file.
 *
 * The two are not distinguished at runtime by the builder's *shape*: an
 * asynchronous SQLite driver has an `all()` too. What is checked is the value it
 * returns, so a promise is adopted rather than mistaken for rows.
 *
 * An argument error - a table with no tie-break column - throws rather than
 * rejecting, on both channels. It is a `TypeError` about the call, not a database
 * failure, and the synchronous overload has nowhere to reject from.
 */
export function paginate<
  TTable extends Table,
  TRow extends Record<string, unknown>,
>(params: SyncPaginateParams<TTable>): Page<TRow>;
export function paginate<
  TTable extends Table,
  TRow extends Record<string, unknown>,
>(params: PaginateParams<TTable>): Promise<Page<TRow>>;
export function paginate<
  TTable extends Table,
  TRow extends Record<string, unknown>,
>(
  params: SyncPaginateParams<TTable> | PaginateParams<TTable>,
): Page<TRow> | Promise<Page<TRow>> {
  const { db, table, options } = params;
  const prepared = plan(params);

  const query = (db as PaginateSource<TTable, unknown>)
    .select()
    .from(table)
    .where(
      prepared.conditions.length === 0
        ? undefined
        : and(...prepared.conditions),
    )
    .orderBy(...prepared.order)
    .limit(options.take + 1);

  const rows = isSync(query) ? query.all() : query;
  return Array.isArray(rows)
    ? envelope(rows as TRow[], options, prepared)
    : Promise.resolve(rows as PromiseLike<unknown[]>).then((resolved) =>
        envelope(resolved as TRow[], options, prepared),
      );
}

/**
 * Whether the builder offers `all()`. Calling it is what decides the channel: a
 * synchronous driver returns the rows and an asynchronous one a promise of them,
 * and the array check downstream is what tells those apart.
 */
const isSync = (query: unknown): query is SyncRows =>
  typeof (query as SyncRows | undefined)?.all === 'function';

/**
 * A cursor carries the sort value as a string. A timestamp column has to go back to
 * a `Date` for drizzle to encode it the way it stored it; anything else compares
 * fine as the string it already is.
 */
const restore = (value: string, column: Column): Date | string => {
  const type = (column as unknown as { dataType?: string }).dataType;
  return type === 'date' ? new Date(value) : value;
};
