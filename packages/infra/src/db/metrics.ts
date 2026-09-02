import { Durations, type HistogramSnapshot } from '@dunx/core';

export const QueryOperation = Object.freeze({
  SELECT: 'select',
  INSERT: 'insert',
  UPDATE: 'update',
  DELETE: 'delete',
  OTHER: 'other',
} as const);
export type QueryOperation =
  (typeof QueryOperation)[keyof typeof QueryOperation];

export interface QueryStats {
  readonly operation: QueryOperation;
  readonly count: number;
  /** Queries whose promise rejected, or which threw synchronously. */
  readonly errors: number;
  /** Nanoseconds. */
  readonly duration: HistogramSnapshot;
  /**
   * The slowest query on this operation as a statement shape: literals replaced
   * with `?` and the text truncated. Never the query as written.
   */
  readonly slowest?: string;
}

export interface DbStatsReport {
  readonly operations: readonly QueryStats[];
  readonly total: number;
  readonly since: string;
}

/** Enough of the statement to recognise, without putting a 4 KB query in a payload. */
const SLOWEST_TEXT_LIMIT = 200;

/** A single-quoted literal, `''` escapes included. */
const STRING_LITERAL = /'(?:[^']|'')*'/g;
/** A bare number that is not part of an identifier or a `$1` placeholder. */
const NUMBER_LITERAL = /(?<![\w$.])\d+(?:\.\d+)?/g;

/**
 * The statement's shape, with its literals replaced.
 *
 * A snapshot is served over the dashboard's stats endpoint, so anything kept here
 * is readable by whoever can reach that page. drizzle parameterises, so a query it
 * built carries no values - but `sql` template escape hatches and hand-written
 * statements do, and a `where email = 'ada@example.com'` in a metrics payload is
 * the leak. Truncation is not redaction.
 */
const redact = (sql: string): string =>
  sql
    .replace(STRING_LITERAL, "'?'")
    .replace(NUMBER_LITERAL, '?')
    .slice(0, SLOWEST_TEXT_LIMIT);

const LEADING = /^\s*(select|insert|update|delete)\b/i;

const KEYWORDS: Readonly<Record<string, QueryOperation>> = {
  select: QueryOperation.SELECT,
  insert: QueryOperation.INSERT,
  update: QueryOperation.UPDATE,
  delete: QueryOperation.DELETE,
};

/**
 * The leading keyword, which is what separates a read from a write. A `with`
 * prefix reads as `other` rather than being unwrapped: a CTE can end in any of
 * the four, and guessing wrong is worse than not guessing.
 */
const operationOf = (sql: string): QueryOperation =>
  KEYWORDS[LEADING.exec(sql)?.[1]?.toLowerCase() ?? ''] ?? QueryOperation.OTHER;

interface Series {
  count: number;
  errors: number;
  readonly duration: Durations;
  slowestNs: number;
  slowest: string | undefined;
}

const series = (): Series => ({
  count: 0,
  errors: 0,
  duration: new Durations(),
  slowestNs: 0,
  slowest: undefined,
});

/**
 * How long the database is taking, by operation.
 *
 * Recorded from the driver dunx constructs. Drizzle's `Logger` cannot supply a
 * duration: `logQuery` fires before the statement runs with no completion
 * callback, and drizzle 0.45.2's OpenTelemetry hook never assigns its `otel`
 * binding. Both measured.
 *
 * The two seams are public Bun API, on the objects dunx hands to `drizzle()`:
 *
 * - `bun:sqlite` prepares a statement per query, so `Database.prepare` is wrapped
 *   and the four execute methods on what it returns are timed. Synchronous, so
 *   exact.
 * - `Bun.SQL`'s `unsafe()` returns a lazy `Query` that runs when awaited, so
 *   `then` is wrapped and `finally` is not - attaching `finally` would start it.
 *
 * Bound only when `metrics: true`.
 */
export class QueryMetrics {
  readonly #series = new Map<QueryOperation, Series>();
  #total = 0;
  #since = new Date();

  observe(sql: string, durationNs: number, failed = false): void {
    const operation = operationOf(sql);
    let stats = this.#series.get(operation);
    if (stats === undefined) {
      stats = series();
      this.#series.set(operation, stats);
    }
    this.#total += 1;
    stats.count += 1;
    if (failed) stats.errors += 1;
    stats.duration.record(durationNs);
    if (durationNs > stats.slowestNs) {
      stats.slowestNs = durationNs;
      stats.slowest = redact(sql);
    }
  }

  snapshot(): DbStatsReport {
    const operations: QueryStats[] = [];
    for (const [operation, stats] of this.#series) {
      operations.push({
        operation,
        count: stats.count,
        errors: stats.errors,
        duration: stats.duration.snapshot(),
        ...(stats.slowest === undefined ? {} : { slowest: stats.slowest }),
      });
    }
    return {
      operations,
      total: this.#total,
      since: this.#since.toISOString(),
    };
  }

  reset(): void {
    this.#series.clear();
    this.#total = 0;
    this.#since = new Date();
  }

  /**
   * Wraps the client in place and returns it, so the caller can pass the result
   * straight to `drizzle()`. Wrapping twice is a no-op, which is what keeps a
   * reconnect from stacking timers.
   */
  instrument<T extends object>(client: T): T {
    if (Reflect.get(client, INSTRUMENTED) === true) return client;
    const candidate = client as unknown as Partial<Instrumentable>;
    if (typeof candidate.prepare === 'function') {
      this.#instrumentSqlite(client as unknown as SqliteClient);
    } else if (typeof candidate.unsafe === 'function') {
      this.#instrumentSql(client as unknown as SqlClient);
    } else {
      return client;
    }
    Reflect.set(client, INSTRUMENTED, true);
    return client;
  }

  #instrumentSqlite(client: SqliteClient): void {
    const original = client.prepare.bind(client);
    const record = this.observe.bind(this);
    client.prepare = (sql: string, ...rest: unknown[]): SqliteStatement => {
      let statement: SqliteStatement;
      // sqlite compiles here, so a syntax error or an unknown table throws out of
      // `prepare` and never reaches a method below. Timed as well as counted: a
      // failed compilation or schema lookup is not free, and recording a constant
      // would skew the percentiles of an error-heavy workload.
      const preparing = Bun.nanoseconds();
      try {
        statement = original(sql, ...rest);
      } catch (error) {
        record(sql, Bun.nanoseconds() - preparing, true);
        throw error;
      }
      for (const name of SQLITE_METHODS) {
        const method = statement[name];
        if (typeof method !== 'function') continue;
        statement[name] = function (this: unknown, ...args: unknown[]) {
          const started = Bun.nanoseconds();
          try {
            const value = method.apply(this, args);
            record(sql, Bun.nanoseconds() - started);
            return value;
          } catch (error) {
            record(sql, Bun.nanoseconds() - started, true);
            throw error;
          }
        };
      }
      return statement;
    };
  }

  #instrumentSql(client: SqlClient): void {
    const original = client.unsafe.bind(client);
    const record = this.observe.bind(this);
    client.unsafe = (sql: string, ...rest: unknown[]): SqlQuery => {
      const query = original(sql, ...rest);
      const originalThen = query.then.bind(query);
      let timed = false;
      // This observes the `then` Bun's own lazy `Query` already has, rather than
      // making anything thenable, so the rule does not apply.
      // oxlint-disable-next-line unicorn/no-thenable
      query.then = (onOk?: Settle, onErr?: Settle): unknown => {
        // The first `then` is what starts the query; a second one attaches to a
        // promise already running, so only the first is a measurement.
        const started = timed ? 0 : Bun.nanoseconds();
        const wasFirst = !timed;
        timed = true;
        const stop = (failed: boolean): void => {
          if (wasFirst) record(sql, Bun.nanoseconds() - started, failed);
        };
        return originalThen(
          (value: unknown) => {
            stop(false);
            return onOk ? onOk(value) : value;
          },
          (error: unknown) => {
            stop(true);
            if (onErr) return onErr(error);
            throw error;
          },
        );
      };
      return query;
    };
  }
}

type Settle = (value: unknown) => unknown;

type SqliteStatement = Record<string, unknown>;

interface SqliteClient {
  prepare: (sql: string, ...rest: unknown[]) => SqliteStatement;
}

interface SqlQuery {
  then: (onOk?: Settle, onErr?: Settle) => unknown;
}

interface SqlClient {
  unsafe: (sql: string, ...rest: unknown[]) => SqlQuery;
}

interface Instrumentable {
  prepare: unknown;
  unsafe: unknown;
}

const SQLITE_METHODS = ['run', 'all', 'get', 'values'] as const;

/** Marks a client so a second `instrument` call does not stack a second timer. */
const INSTRUMENTED: unique symbol = Symbol.for('dunx.infra.db.instrumented');
