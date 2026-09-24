import { Database as BunSqlite } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import { AppFactory, Module } from '@dunx/core';
import { OtelModule, OtelTracer } from '@dunx/core/otel';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { sql } from 'drizzle-orm';
import { BunSQLDatabase } from 'drizzle-orm/bun-sql';
import { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { traced } from '../otel.fixture.js';
import { DbConnection } from './connection.js';
import { DataSources } from './data-sources.js';
import { instrument, instrumented } from './instrument.js';
import { QueryMetrics } from './metrics.js';
import { DbModule } from './module.js';
import { QuerySpans } from './spans.js';
import { SqlOptions } from './sql/options.js';
import { SqliteOptions } from './sqlite/options.js';

const INSTRUMENTED = Symbol.for('dunx.infra.db.instrumented');

const options = (): SqliteOptions<Record<string, never>> =>
  new SqliteOptions({ schema: {}, filename: ':memory:' });

type Settle = (value: unknown) => unknown;

const connectionOf = (dialect: string, raw: unknown): DbConnection =>
  ({ dialect, raw }) as unknown as DbConnection;

describe('query spans over bun:sqlite', () => {
  it('opens a CLIENT child span per statement, without metrics', async () => {
    @Module({ imports: [OtelModule, DbModule.forRoot(options())] })
    class Root {}

    const app = await AppFactory.create(Root);
    const db = app.get(BunSQLiteDatabase);
    const spans = await traced(() => {
      db.run(sql`create table users (id integer, email text)`);
      db.run(sql`insert into users (id, email) values (1, 'ada@example.com')`);
      db.all(sql`select * from "users" where id = ${1}`);
    });
    await app.shutdown();

    expect(spans.map((span) => span.name)).toEqual([
      'CREATE',
      'INSERT users',
      'SELECT users',
    ]);
    const [, insert, select] = spans;
    expect(insert?.kind).toBe(SpanKind.CLIENT);
    expect(insert?.attributes).toEqual({
      'db.system.name': 'sqlite',
      'db.operation.name': 'INSERT',
      'db.collection.name': 'users',
      'db.query.text': "insert into users (id, email) values (?, '?')",
    });
    expect(select?.attributes['db.query.text']).toBe(
      'select * from "users" where id = ?',
    );
    expect(select?.parentSpanContext?.spanId).toBe(
      insert?.parentSpanContext?.spanId,
    );
    expect(select?.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('marks a statement sqlite rejects at prepare ERROR', async () => {
    @Module({
      imports: [OtelModule, DbModule.forRoot(options(), { metrics: true })],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    const db = app.get(BunSQLiteDatabase);
    const spans = await traced(() => db.all(sql`select * from nope`));
    const report = app.get(QueryMetrics).snapshot();
    await app.shutdown();

    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe('SELECT nope');
    expect(spans[0]?.status.code).toBe(SpanStatusCode.ERROR);
    expect(spans[0]?.events[0]?.name).toBe('exception');
    expect(report.operations[0]?.errors).toBe(1);
  });

  it('marks a statement that throws while running ERROR, and still times it', async () => {
    @Module({
      imports: [OtelModule, DbModule.forRoot(options(), { metrics: true })],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    const db = app.get(BunSQLiteDatabase);
    db.run(sql`create table t (id integer primary key)`);
    db.run(sql`insert into t (id) values (1)`);
    const spans = await traced(() =>
      db.run(sql`insert into t (id) values (1)`),
    );
    const report = app.get(QueryMetrics).snapshot();
    await app.shutdown();

    expect(spans[0]?.name).toBe('INSERT t');
    expect(spans[0]?.status.code).toBe(SpanStatusCode.ERROR);
    expect(report.total).toBe(3);
  });

  it('leaves the driver unwrapped under the no-op tracer', async () => {
    @Module({ imports: [DbModule.forRoot(options())] })
    class Root {}

    const app = await AppFactory.create(Root);
    const raw = app.get(DbConnection).raw as BunSqlite;
    const spans = await traced(() =>
      app.get(BunSQLiteDatabase).run(sql`select 1`),
    );
    await app.shutdown();

    expect(Reflect.get(raw, INSTRUMENTED)).toBeUndefined();
    expect(spans).toHaveLength(0);
  });

  it('traces a data source a pool opens', async () => {
    class Tenants extends DataSources<BunSQLiteDatabase> {}

    @Module({
      imports: [
        OtelModule,
        DbModule.forDataSources({ create: () => options() }, Tenants),
      ],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    const tenants = app.get(Tenants);
    const spans = await traced(async () => {
      (await tenants.get('acme')).run(sql`select 1`);
    });
    await app.shutdown();

    expect(spans.map((span) => span.name)).toEqual(['SELECT']);
  });

  it('opens a pool data source unwrapped under the no-op tracer', async () => {
    const tenants = new DataSources({ create: () => options() });
    const opened = await tenants.connection('acme');
    const raw = opened.raw as BunSqlite;
    await tenants.close();

    expect(Reflect.get(raw, INSTRUMENTED)).toBeUndefined();
  });
});

describe('query spans over Bun.SQL', () => {
  it('names the server and marks a refused query ERROR', async () => {
    const raw = new Bun.SQL('postgres://u:p@127.0.0.1:1/shop', {
      max: 1,
      connectionTimeout: 1,
    });
    instrument(
      raw,
      new QuerySpans(new OtelTracer(), connectionOf('postgres', raw)),
    );
    const spans = await traced(() => raw.unsafe('select * from orders'));
    await raw.close();

    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe('SELECT orders');
    expect(spans[0]?.attributes).toMatchObject({
      'db.system.name': 'postgresql',
      'db.namespace': 'shop',
      'server.address': '127.0.0.1',
      'server.port': 1,
    });
    expect(spans[0]?.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('opens one span for a query awaited twice', async () => {
    let started = 0;
    const client = {
      unsafe: (_sql: string) => {
        let running: Promise<unknown> | undefined;
        return {
          // Stands in for Bun's lazy `Query`: it runs on the first `then` and
          // every later `then` shares that run.
          // oxlint-disable-next-line unicorn/no-thenable
          then(onOk: (value: unknown) => unknown) {
            if (running === undefined) {
              started += 1;
              running = Promise.resolve([{ id: 1 }]);
            }
            return running.then(onOk);
          },
        };
      },
    };
    instrument(
      client,
      new QuerySpans(new OtelTracer(), connectionOf('mysql', client)),
    );
    const results: unknown[] = [];
    const spans = await traced(async () => {
      const query = client.unsafe('call refresh()');
      results.push(await query, await query);
    });

    expect(results).toEqual([[{ id: 1 }], [{ id: 1 }]]);
    expect(started).toBe(1);
    expect(spans.map((span) => span.name)).toEqual(['CALL']);
    expect(spans[0]?.attributes['db.system.name']).toBe('mysql');
  });

  it('times and traces one query together, a rejection included', async () => {
    const client = {
      unsafe: (text: string) => ({
        // Stands in for Bun's lazy `Query`, which is a thenable.
        // oxlint-disable-next-line unicorn/no-thenable
        then(onOk: Settle, onErr: Settle) {
          const outcome = text.includes('nope')
            ? Promise.reject(new Error('relation "nope" does not exist'))
            : Promise.resolve([]);
          return outcome.then(onOk, onErr);
        },
      }),
    };
    const metrics = new QueryMetrics();
    await instrumented(
      Promise.resolve(connectionOf('postgres', client)),
      metrics,
      new OtelTracer(),
    );
    const spans = await traced(async () => {
      await client.unsafe('select 1');
      await client.unsafe('select * from nope');
    });

    expect(spans.map((span) => span.status.code)).toEqual([
      SpanStatusCode.UNSET,
      SpanStatusCode.ERROR,
    ]);
    expect(metrics.snapshot().total).toBe(2);
    expect(metrics.snapshot().operations[0]?.errors).toBe(1);
  });

  const url = process.env['DUNX_DB_TEST_URL'];

  it.skipIf(url === undefined)('traces a live Postgres query', async () => {
    @Module({
      imports: [
        OtelModule,
        DbModule.forRoot(new SqlOptions({ schema: {}, url: url ?? '' })),
      ],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    try {
      const db = app.get(BunSQLDatabase);
      const spans = await traced(() => db.execute(sql`select 1`));
      expect(spans.map((span) => span.name)).toEqual(['SELECT']);
      expect(spans[0]?.attributes['db.system.name']).toBe('postgresql');
    } finally {
      await app.shutdown();
    }
  });
});
