import { Durations, type HistogramSnapshot } from '@dunx/core';
import { instrument, QueryTimer } from './instrument.js';
import { sanitize } from './statement.js';

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

/**
 * A snapshot is served over the dashboard's stats endpoint, so anything kept here
 * is readable by whoever can reach that page. Truncation is not redaction.
 */
const redact = (sql: string): string =>
  sanitize(sql).slice(0, SLOWEST_TEXT_LIMIT);

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
 * The seams are public Bun API, on the objects dunx hands to `drizzle()`, and
 * shared with query spans: see `instrument`.
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
    return instrument(client, new QueryTimer(this));
  }
}
