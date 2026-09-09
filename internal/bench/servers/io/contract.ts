/**
 * The `io` scenario's contract, in one place because twenty subjects in seven
 * languages have to agree on it byte for byte.
 *
 * One request does two round trips, in this order:
 *
 * 1. `GET bench:greeting` against Redis - the cache lookup.
 * 2. `SELECT id, memo, amount FROM bench_ledger WHERE id = $1` against Postgres,
 *    **parameterised**, because a bound parameter is where drivers differ: it is
 *    the prepare-and-bind path rather than a string the server parses fresh.
 *
 * Sequential rather than concurrent. A cache read that gates a database read is
 * the shape the scenario is named for, and issuing both at once would measure the
 * client's concurrency primitives instead.
 *
 * **The pool is pinned to the same size everywhere.** With 64 connections against
 * one worker thread, pool size sets how many queries are in flight, and a subject
 * with a bigger default would be measured on its configuration. Every client that
 * exposes one is given `IO_POOL_SIZE`; the ones that multiplex a single connection
 * instead are recorded as doing so in the subject's `io` field.
 */
export const IO_REDIS_KEY = 'bench:greeting';
export const IO_TABLE = 'bench_ledger';
export const IO_ROW_ID = 1;
export const IO_POOL_SIZE = 8;
export const IO_SELECT = `SELECT id, memo, amount FROM ${IO_TABLE} WHERE id = $1`;

export interface IoPayload {
  readonly cached: string;
  readonly id: number;
  readonly memo: string;
  readonly amount: number;
}

/**
 * The scenario is off unless the harness passes both URLs, and that is what keeps
 * a machine with no Redis and no Postgres able to run the other four scenarios.
 * A subject spawns fresh per scenario, so the connections are opened only for the
 * run that uses them and never land in the startup column.
 */
export const ioEnabled = (): boolean =>
  process.env['BENCH_IO_PG_URL'] !== undefined &&
  process.env['BENCH_IO_REDIS_URL'] !== undefined;

export const pgUrl = (): string => process.env['BENCH_IO_PG_URL'] ?? '';
export const redisUrl = (): string => process.env['BENCH_IO_REDIS_URL'] ?? '';

/** Identical bytes from every subject, so the comparison is like for like. */
export const ioPayload = (
  cached: string | null,
  row: { id: number; memo: string; amount: number } | undefined,
): IoPayload => ({
  cached: cached ?? 'missing',
  id: row?.id ?? 0,
  memo: row?.memo ?? 'missing',
  amount: row?.amount ?? 0,
});
