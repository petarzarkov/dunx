import { Database as BunSqlite } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import { AppFactory, Module } from '@dunx/core';
import { sql } from 'drizzle-orm';
import { BunSQLDatabase } from 'drizzle-orm/bun-sql';
import { BunSQLiteDatabase, drizzle } from 'drizzle-orm/bun-sqlite';
import { DbModule } from './module.js';
import { QueryMetrics, QueryOperation } from './metrics.js';
import { SqliteOptions } from './sqlite/options.js';
import { SqlOptions } from './sql/options.js';

const DDL = 'CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)';

const sqliteHandle = (
  metrics?: QueryMetrics,
): { db: BunSQLiteDatabase<Record<string, never>>; raw: BunSqlite } => {
  const raw = new BunSqlite(':memory:', { strict: true });
  raw.run(DDL);
  metrics?.instrument(raw);
  return { db: drizzle({ client: raw, schema: {} }), raw };
};

describe('QueryMetrics classification', () => {
  it('groups by the leading keyword, whatever the casing or indent', () => {
    const metrics = new QueryMetrics();
    metrics.observe('SELECT 1', 1000);
    metrics.observe('  \n select * from t', 1000);
    metrics.observe('insert into t (name) values (?)', 1000);
    metrics.observe('UPDATE t SET name = ?', 1000);
    metrics.observe('delete from t', 1000);

    const byOperation = new Map(
      metrics.snapshot().operations.map((o) => [o.operation, o.count]),
    );
    expect(byOperation.get(QueryOperation.SELECT)).toBe(2);
    expect(byOperation.get(QueryOperation.INSERT)).toBe(1);
    expect(byOperation.get(QueryOperation.UPDATE)).toBe(1);
    expect(byOperation.get(QueryOperation.DELETE)).toBe(1);
    expect(metrics.snapshot().total).toBe(5);
  });

  it('does not guess at a CTE, which can end in any of the four', () => {
    const metrics = new QueryMetrics();
    metrics.observe('with recent as (select 1) select * from recent', 1000);
    metrics.observe('create table t (id integer)', 1000);
    metrics.observe('selectors are not select', 1000);
    expect(metrics.snapshot().operations).toHaveLength(1);
    expect(metrics.snapshot().operations[0]?.operation).toBe(
      QueryOperation.OTHER,
    );
  });

  it('counts failures separately without dropping them from the total', () => {
    const metrics = new QueryMetrics();
    metrics.observe('select 1', 1000);
    metrics.observe('select bad', 1000, true);
    const [stats] = metrics.snapshot().operations;
    expect(stats?.count).toBe(2);
    expect(stats?.errors).toBe(1);
  });

  it('keeps the text of the slowest query, truncated', () => {
    const metrics = new QueryMetrics();
    metrics.observe(`select '${'x'.repeat(500)}'`, 9_000);
    metrics.observe('select 1', 1_000);
    const slowest = metrics.snapshot().operations[0]?.slowest;
    expect(slowest).toHaveLength(200);
    expect(metrics.snapshot().operations[0]?.duration.max).toBe(9_000);
  });

  it('clamps a sub-nanosecond query rather than throwing', () => {
    const metrics = new QueryMetrics();
    expect(() => {
      metrics.observe('select 1', 0);
    }).not.toThrow();
    expect(metrics.snapshot().operations[0]?.duration.min).toBe(1);
  });

  it('empties on reset and moves `since` forward', async () => {
    const metrics = new QueryMetrics();
    const before = metrics.snapshot().since;
    metrics.observe('select 1', 1000);
    await Bun.sleep(5);
    metrics.reset();
    expect(metrics.snapshot()).toMatchObject({ operations: [], total: 0 });
    expect(Date.parse(metrics.snapshot().since)).toBeGreaterThan(
      Date.parse(before),
    );
  });

  it('serialises', () => {
    const metrics = new QueryMetrics();
    metrics.observe('select 1', 1000);
    const report = metrics.snapshot();
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });
});

describe('instrumenting bun:sqlite', () => {
  it('times every query drizzle runs, and leaves the results alone', () => {
    const metrics = new QueryMetrics();
    const { db } = sqliteHandle(metrics);

    db.run(sql`insert into t (name) values ('ada')`);
    db.run(sql`insert into t (name) values ('grace')`);
    const rows = db.all<{ id: number; name: string }>(sql`select * from t`);

    expect(rows).toHaveLength(2);
    const report = metrics.snapshot();
    expect(report.total).toBe(3);
    const inserts = report.operations.find(
      (o) => o.operation === QueryOperation.INSERT,
    );
    expect(inserts?.count).toBe(2);
    expect(Number(inserts?.duration.min)).toBeGreaterThan(0);
  });

  it('records a failing statement as an error and rethrows it', () => {
    const metrics = new QueryMetrics();
    const { db } = sqliteHandle(metrics);
    expect(() => db.all(sql`select * from nope`)).toThrow();
    expect(metrics.snapshot().operations[0]?.errors).toBe(1);
  });

  it('is idempotent, so a second instrument does not double count', () => {
    const metrics = new QueryMetrics();
    const raw = new BunSqlite(':memory:', { strict: true });
    raw.run(DDL);
    metrics.instrument(raw);
    metrics.instrument(raw);
    const db = drizzle({ client: raw, schema: {} });

    db.run(sql`insert into t (name) values ('ada')`);
    expect(metrics.snapshot().total).toBe(1);
  });

  it('leaves a client it does not recognise untouched', () => {
    const stranger = { nothing: true };
    expect(new QueryMetrics().instrument(stranger)).toBe(stranger);
  });
});

describe('DbModule metrics', () => {
  const options = (): SqliteOptions<Record<string, never>> =>
    new SqliteOptions({ schema: {}, filename: ':memory:' });

  it('instruments nothing by default', async () => {
    @Module({ imports: [DbModule.forRoot(options())] })
    class Root {}

    const app = await AppFactory.create(Root);
    const db = app.get(BunSQLiteDatabase);
    db.run(sql`create table t (id integer)`);
    db.run(sql`insert into t (id) values (1)`);

    // An unbound class self-binds, so this resolves - to an instance nothing
    // ever reported into, which is the observable difference.
    expect(app.get(QueryMetrics).snapshot().total).toBe(0);
    await app.shutdown();
  });

  it('binds and instruments under { metrics: true }', async () => {
    @Module({ imports: [DbModule.forRoot(options(), { metrics: true })] })
    class Root {}

    const app = await AppFactory.create(Root);
    const db = app.get(BunSQLiteDatabase);
    db.run(sql`create table t (id integer)`);
    db.run(sql`insert into t (id) values (1)`);

    const report = app.get(QueryMetrics).snapshot();
    expect(report.total).toBe(2);
    expect(
      report.operations.find((o) => o.operation === QueryOperation.INSERT)
        ?.count,
    ).toBe(1);
    await app.shutdown();
  });

  it('instruments through forRootAsync too', async () => {
    @Module({
      imports: [
        DbModule.forRootAsync(
          BunSQLiteDatabase,
          { useFactory: () => options() },
          { metrics: true },
        ),
      ],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    app.get(BunSQLiteDatabase).run(sql`create table t (id integer)`);
    expect(app.get(QueryMetrics).snapshot().total).toBe(1);
    await app.shutdown();
  });
});

describe('instrumenting Bun.SQL', () => {
  const url = process.env['DUNX_DB_TEST_URL'];

  /**
   * `unsafe()` returns a lazy `Query` that runs when it is awaited, so the timer
   * wraps `then` rather than `finally` - attaching `finally` would start the
   * query itself. Only a live Postgres proves that, so this skips without one.
   */
  it.skipIf(url === undefined)(
    'times a real query without forcing it to run early',
    async () => {
      @Module({
        imports: [
          DbModule.forRoot(new SqlOptions({ schema: {}, url: url ?? '' }), {
            metrics: true,
          }),
        ],
      })
      class Root {}

      const app = await AppFactory.create(Root);
      const db = app.get(BunSQLDatabase);
      const metrics = app.get(QueryMetrics);

      await db.execute(sql`create table if not exists dunx_metrics_t (id int)`);
      await db.execute(sql`insert into dunx_metrics_t (id) values (1)`);
      const rows = await db.execute(sql`select * from dunx_metrics_t`);
      await db.execute(sql`drop table dunx_metrics_t`);

      expect(rows).toBeDefined();
      const report = metrics.snapshot();
      expect(report.total).toBe(4);
      const selects = report.operations.find(
        (o) => o.operation === QueryOperation.SELECT,
      );
      expect(selects?.count).toBe(1);
      expect(Number(selects?.duration.min)).toBeGreaterThan(0);
      await app.shutdown();
    },
  );

  it.skipIf(url === undefined)('records a failing query', async () => {
    @Module({
      imports: [
        DbModule.forRoot(new SqlOptions({ schema: {}, url: url ?? '' }), {
          metrics: true,
        }),
      ],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    const metrics = app.get(QueryMetrics);
    // `db.execute` returns drizzle's own thenable rather than a Promise, so it
    // is awaited here rather than handed to `.rejects`.
    let threw = false;
    try {
      await app.get(BunSQLDatabase).execute(sql`select * from nope_not_here`);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(metrics.snapshot().operations[0]?.errors).toBe(1);
    await app.shutdown();
  });
});
