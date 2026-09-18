import { AppFactory, Module, inject } from '@dunx/core';
import { describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { DbConnection, DbOptions } from './connection.js';
import { Dialect } from './dialect.js';
import { QueryMetrics } from './metrics.js';
import { DbModule } from './module.js';
import { SqliteConnection } from './sqlite/connection.js';
import { SqliteOptions } from './sqlite/options.js';
import { dbConnection, dbHandle, dbMetrics, dbOptions } from './tokens.js';

const widgets = sqliteTable('widgets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
});

const schema = { widgets };
type Schema = typeof schema;
type Handle = BunSQLiteDatabase<Schema>;

const options = (): SqliteOptions<Schema> => new SqliteOptions({ schema });

const reports = dbHandle<Handle>('reports');
const audit = dbHandle<Handle>('audit');

describe('the named token factories', () => {
  it('hand back one token per name, so module and consumer agree', () => {
    expect(dbHandle<Handle>('reports')).toBe(reports);
    expect(dbConnection('reports')).toBe(dbConnection('reports'));
    expect(dbOptions('reports')).toBe(dbOptions('reports'));
    expect(dbMetrics('reports')).toBe(dbMetrics('reports'));
  });

  it('keeps the four families apart for one name', () => {
    const all = [
      dbHandle('x'),
      dbConnection('x'),
      dbOptions('x'),
      dbMetrics('x'),
    ];
    expect(new Set(all).size).toBe(4);
  });

  it('describes itself by family and name', () => {
    expect(dbHandle('reports').description).toBe('DbHandle(reports)');
    expect(dbConnection('reports').description).toBe('DbConnection(reports)');
  });
});

describe('DbModule.forRoot with a name', () => {
  it('binds the handle, the connection and the options under it', async () => {
    const configured = options();

    @Module({ imports: [DbModule.forRoot(configured, { name: 'reports' })] })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.get(reports)).toBeInstanceOf(BunSQLiteDatabase);
    expect(app.get(dbConnection('reports'))).toBeInstanceOf(SqliteConnection);
    expect(app.get(dbOptions('reports'))).toBe(configured);
    expect(app.get(dbOptions('reports')).dialect).toBe(Dialect.SQLITE);
    await app.shutdown();
  });

  /**
   * Asserted on the module rather than through a failing `app.get`: an unbound
   * class self-binds, so asking for `DbConnection` would hand back a fresh one
   * instead of throwing, and nothing about the name would have been tested.
   */
  it('exports its own four tokens and no class token', () => {
    const named = DbModule.forRoot(options(), {
      name: 'reports',
      metrics: true,
    });
    expect(named.exports).toEqual([
      dbOptions('reports'),
      dbConnection('reports'),
      dbHandle('reports'),
      dbMetrics('reports'),
    ]);
    expect(named.exports).not.toContain(DbConnection);
    expect(named.exports).not.toContain(DbOptions);
    expect(named.exports).not.toContain(BunSQLiteDatabase);
  });

  it('lets two of them on one backend coexist', async () => {
    @Module({
      imports: [
        DbModule.forRoot(options(), { name: 'reports' }),
        DbModule.forRoot(options(), { name: 'audit' }),
      ],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.get(reports)).not.toBe(app.get(audit));
    await app.shutdown();
  });

  it('coexists with a default registration', async () => {
    @Module({
      imports: [
        DbModule.forRoot(options()),
        DbModule.forRoot(options(), { name: 'reports' }),
      ],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.get(BunSQLiteDatabase)).not.toBe(app.get(reports));
    expect(app.get(DbConnection)).toBeInstanceOf(SqliteConnection);
    await app.shutdown();
  });

  it('is injectable through inject() in a field initialiser', async () => {
    class Reports {
      readonly db = inject(reports);
      readonly connection = inject(dbConnection<Handle>('reports'));
    }

    @Module({
      imports: [DbModule.forRoot(options(), { name: 'reports' })],
      providers: [Reports],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    const service = app.get(Reports);
    service.db.run(
      sql`CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT)`,
    );
    service.db.insert(widgets).values({ name: 'cog' }).run();
    expect(service.db.select().from(widgets).all()).toHaveLength(1);
    expect(service.connection.db).toBe(service.db);
    await app.shutdown();
  });

  it('binds metrics under the name rather than the class', async () => {
    @Module({
      imports: [
        DbModule.forRoot(options(), { metrics: true }),
        DbModule.forRoot(options(), { name: 'reports', metrics: true }),
      ],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    const named = app.get(dbMetrics('reports'));
    expect(named).toBeInstanceOf(QueryMetrics);
    expect(named).not.toBe(app.get(QueryMetrics));

    app.get(reports).run(sql`select 1`);
    expect(named.snapshot().total).toBeGreaterThan(0);
    expect(app.get(QueryMetrics).snapshot().total).toBe(0);
    await app.shutdown();
  });

  it('closes the named connection on shutdown', async () => {
    @Module({ imports: [DbModule.forRoot(options(), { name: 'reports' })] })
    class Root {}

    const app = await AppFactory.create(Root);
    const connection = app.get(dbConnection('reports'));
    await app.shutdown();
    expect(connection).toBeInstanceOf(SqliteConnection);
    if (!(connection instanceof SqliteConnection)) throw new Error('narrowing');
    expect(connection.closed).toBe(true);
  });
});

describe('DbModule.forRootAsync with a name', () => {
  class Config {
    readonly filename = ':memory:';
  }

  it('takes the options from a factory that may inject', async () => {
    @Module({ providers: [Config], exports: [Config] })
    class ConfigModule {}

    @Module({
      imports: [
        DbModule.forRootAsync(
          BunSQLiteDatabase<Schema>,
          {
            imports: [ConfigModule],
            useFactory: (config: Config) =>
              new SqliteOptions({ schema, filename: config.filename }),
            inject: [Config],
          },
          { name: 'reports' },
        ),
      ],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.get(reports)).toBeInstanceOf(BunSQLiteDatabase);
    expect(app.get(dbOptions('reports'))).toBeInstanceOf(SqliteOptions);
    await app.shutdown();
  });

  it('carries metrics through the async form too', async () => {
    @Module({
      imports: [
        DbModule.forRootAsync(
          BunSQLiteDatabase<Schema>,
          { useFactory: () => new SqliteOptions({ schema }) },
          { name: 'audit', metrics: true },
        ),
      ],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    app.get(audit).run(sql`select 1`);
    expect(app.get(dbMetrics('audit')).snapshot().total).toBeGreaterThan(0);
    await app.shutdown();
  });
});
