import { NoopTracer, type Tracer } from '@dunx/core';
import type { DbConnection } from './connection.js';
import type { QueryMetrics } from './metrics.js';
import { QuerySpans } from './spans.js';

/** What sees each statement the driver runs: a timer, a span, or both. */
export interface QueryObserver {
  /** Runs one execution. `execute` returns a promise for `Bun.SQL`, a value for sqlite. */
  run<T>(sql: string, execute: () => T): T;
  /** sqlite compiles in `prepare`, so a syntax error never reaches `run`. */
  rejected(sql: string, error: unknown, durationNs: number): void;
}

/** Times into a {@link QueryMetrics}. */
export class QueryTimer implements QueryObserver {
  constructor(private readonly metrics: QueryMetrics) {}

  run<T>(sql: string, execute: () => T): T {
    const started = Bun.nanoseconds();
    let value: T;
    try {
      value = execute();
    } catch (error) {
      this.metrics.observe(sql, Bun.nanoseconds() - started, true);
      throw error;
    }
    if (!(value instanceof Promise)) {
      this.metrics.observe(sql, Bun.nanoseconds() - started);
      return value;
    }
    return value.then(
      (settled: unknown) => {
        this.metrics.observe(sql, Bun.nanoseconds() - started);
        return settled;
      },
      (error: unknown) => {
        this.metrics.observe(sql, Bun.nanoseconds() - started, true);
        throw error;
      },
    ) as T;
  }

  rejected(sql: string, _error: unknown, durationNs: number): void {
    this.metrics.observe(sql, durationNs, true);
  }
}

/** The outer observer's `run` wraps the inner's, so a span covers the timing. */
class Observers implements QueryObserver {
  constructor(
    private readonly outer: QueryObserver,
    private readonly inner: QueryObserver,
  ) {}

  run<T>(sql: string, execute: () => T): T {
    return this.outer.run(sql, () => this.inner.run(sql, execute));
  }

  rejected(sql: string, error: unknown, durationNs: number): void {
    this.outer.rejected(sql, error, durationNs);
    this.inner.rejected(sql, error, durationNs);
  }
}

type SqliteStatement = Record<string, unknown>;

interface SqliteClient {
  prepare: (sql: string, ...rest: unknown[]) => SqliteStatement;
}

type Settle = (value: unknown) => unknown;

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

/** Marks a client so a second `instrument` call does not stack a second observer. */
const INSTRUMENTED: unique symbol = Symbol.for('dunx.infra.db.instrumented');

const instrumentSqlite = (
  client: SqliteClient,
  observer: QueryObserver,
): void => {
  const original = client.prepare.bind(client);
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
      observer.rejected(sql, error, Bun.nanoseconds() - preparing);
      throw error;
    }
    for (const name of SQLITE_METHODS) {
      const method = statement[name];
      if (typeof method !== 'function') continue;
      statement[name] = function (this: unknown, ...args: unknown[]) {
        return observer.run(sql, () => method.apply(this, args));
      };
    }
    return statement;
  };
};

const instrumentSql = (client: SqlClient, observer: QueryObserver): void => {
  const original = client.unsafe.bind(client);
  client.unsafe = (sql: string, ...rest: unknown[]): SqlQuery => {
    const query = original(sql, ...rest);
    const originalThen = query.then.bind(query);
    let running: Promise<unknown> | undefined;
    // This observes the `then` Bun's own lazy `Query` already has, rather than
    // making anything thenable, so the rule does not apply.
    // oxlint-disable-next-line unicorn/no-thenable
    query.then = (onOk?: Settle, onErr?: Settle): unknown => {
      // The first `then` is what starts the query, and `finally` is not wrapped
      // because attaching it would start it too. A second `then` joins the run
      // already observed rather than measuring again.
      running ??= observer.run(
        sql,
        () =>
          new Promise((resolve, reject) => {
            originalThen(resolve, reject);
          }),
      );
      return running.then(onOk, onErr);
    };
    return query;
  };
};

/**
 * Wraps the driver in place and returns it, so the caller can pass the result
 * straight to `drizzle()`. The two seams are public Bun API: `bun:sqlite`
 * prepares a statement per query, so `Database.prepare` is wrapped and the four
 * execute methods on what it returns are observed; `Bun.SQL`'s `unsafe()`
 * returns a lazy `Query` that runs when awaited, so its `then` is. Wrapping twice
 * is a no-op, which is what keeps a reconnect from stacking observers.
 */
export const instrument = <T extends object>(
  client: T,
  observer: QueryObserver,
): T => {
  if (Reflect.get(client, INSTRUMENTED) === true) return client;
  const candidate = client as unknown as Partial<Instrumentable>;
  if (typeof candidate.prepare === 'function') {
    instrumentSqlite(client as unknown as SqliteClient, observer);
  } else if (typeof candidate.unsafe === 'function') {
    instrumentSql(client as unknown as SqlClient, observer);
  } else {
    return client;
  }
  Reflect.set(client, INSTRUMENTED, true);
  return client;
};

const observerFor = (
  opened: DbConnection<unknown>,
  metrics: QueryMetrics | undefined,
  tracer: Tracer | undefined,
): QueryObserver | undefined => {
  const timer = metrics === undefined ? undefined : new QueryTimer(metrics);
  if (tracer === undefined || tracer instanceof NoopTracer) return timer;
  const spans = new QuerySpans(tracer, opened);
  return timer === undefined ? spans : new Observers(spans, timer);
};

/**
 * Instruments after `open()` rather than before `drizzle()`. `instrument` mutates
 * the client in place and drizzle looks `prepare`/`unsafe` up on it per query, so
 * a handle built earlier still goes through the observer - which keeps this out
 * of both connection constructors and both option classes.
 *
 * With no metrics and the no-op tracer the driver is handed over untouched.
 */
export const instrumented = async <TDb>(
  opening: Promise<DbConnection<TDb>>,
  metrics: QueryMetrics | undefined,
  tracer: Tracer | undefined,
): Promise<DbConnection<TDb>> => {
  const opened = await opening;
  const observer = observerFor(opened, metrics, tracer);
  // A `Bun.SQL` client is a **function** - it is callable as a tagged template -
  // so an `=== 'object'` guard skipped the whole Postgres backend.
  const raw: unknown = opened.raw;
  if (
    observer !== undefined &&
    ((typeof raw === 'object' && raw !== null) || typeof raw === 'function')
  ) {
    instrument(raw as object, observer);
  }
  return opened;
};
