import {
  AppFactory,
  Module,
  type AbstractCtor,
  type OnShutdown,
} from '@dunx/core';
import { describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { BunSQLDatabase } from 'drizzle-orm/bun-sql';
import { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { DbConnection, DbOptions } from './connection.js';
import { Backend, Dialect } from './dialect.js';
import { DbModule } from './module.js';
import { SqlConnection } from './sql/connection.js';
import { SqlOptions } from './sql/options.js';
import { SqliteConnection } from './sqlite/connection.js';
import { SqliteOptions } from './sqlite/options.js';

const widgets = sqliteTable('widgets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
});

const schema = { widgets };
type Schema = typeof schema;

/**
 * The token, instantiated to this schema. The runtime value is drizzle's class
 * either way - writing the type argument once here is what a repository does with
 * its constructor annotation, and it is what keeps `app.get` typed.
 */
const handle: AbstractCtor<BunSQLiteDatabase<Schema>> = BunSQLiteDatabase;

/**
 * Stands in for `@dunx/transform`. This package cannot depend on it - the plugin is
 * what builds `@dunx/infra` - so the tests write the record it would append.
 */
const records = (ctor: object, deps: () => readonly unknown[]): void => {
  Object.defineProperty(ctor, Symbol.for('dunx.deps'), { value: deps });
};

const shutdowns: string[] = [];

/**
 * The point of the whole arrangement: the annotation is drizzle's own class with
 * the schema as its type argument. `@dunx/transform` records the bare name - a real
 * runtime class, so a usable token - and ignores the type argument, so the schema
 * types survive into every query below.
 */
class WidgetsRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  handle(): BunSQLiteDatabase<Schema> {
    return this.db;
  }

  create(name: string): void {
    this.db.insert(widgets).values({ name }).run();
  }

  names(): readonly string[] {
    return this.db
      .select({ name: widgets.name })
      .from(widgets)
      .all()
      .map((row) => row.name);
  }
}
records(WidgetsRepository, () => [BunSQLiteDatabase]);

/** Drains before the connection closes, because it was constructed after it. */
class Draining implements OnShutdown {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  onShutdown(): void {
    const rows = this.db.select().from(widgets).all();
    shutdowns.push(`drained with ${rows.length} widgets still readable`);
  }
}
records(Draining, () => [BunSQLiteDatabase]);

class Config {
  readonly filename = ':memory:';
}

const options = (): SqliteOptions<Schema> => new SqliteOptions({ schema });

describe('DbModule.forRoot', () => {
  it('binds drizzle’s own class as the token', async () => {
    @Module({ imports: [DbModule.forRoot(options())] })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.get(handle)).toBeInstanceOf(BunSQLiteDatabase);
    await app.shutdown();
  });

  it('injects that handle into a repository', async () => {
    @Module({
      imports: [DbModule.forRoot(options())],
      providers: [WidgetsRepository],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.get(WidgetsRepository).handle()).toBe(app.get(handle));
    await app.shutdown();
  });

  it('binds the options, so the dialect is readable', async () => {
    const configured = options();

    @Module({ imports: [DbModule.forRoot(configured)] })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.get(DbOptions)).toBe(configured);
    expect(app.get(DbOptions).dialect).toBe(Dialect.SQLITE);
    expect(app.get(DbOptions).backend).toBe(Backend.SQLITE);
    await app.shutdown();
  });

  it('binds the connection, which is the escape hatch to the driver', async () => {
    @Module({ imports: [DbModule.forRoot(options())] })
    class Root {}

    const app = await AppFactory.create(Root);
    const connection = app.get(DbConnection);
    expect(connection).toBeInstanceOf(SqliteConnection);
    // Narrowing restores the concrete handle type.
    if (!(connection instanceof SqliteConnection)) throw new Error('narrowing');
    expect(connection.raw.filename).toBe(':memory:');
    await app.shutdown();
  });

  it('hands the connection and the drizzle handle the same driver', async () => {
    @Module({ imports: [DbModule.forRoot(options())] })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.get(DbConnection).db).toBe(app.get(handle));
    await app.shutdown();
  });

  it('has the connection open before the first constructor runs', async () => {
    class Eager {
      readonly rows: number;

      constructor(db: BunSQLiteDatabase<Schema>) {
        // No await, no `db.ready()` - the async factory has already settled.
        db.run(sql`CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT)`);
        this.rows = db.select().from(widgets).all().length;
      }
    }
    records(Eager, () => [BunSQLiteDatabase]);

    @Module({ imports: [DbModule.forRoot(options())], providers: [Eager] })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.get(Eager).rows).toBe(0);
    await app.shutdown();
  });

  it('actually queries, end to end', async () => {
    @Module({
      imports: [DbModule.forRoot(options())],
      providers: [WidgetsRepository],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    app
      .get(handle)
      .run(
        sql`CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`,
      );

    const repository = app.get(WidgetsRepository);
    repository.create('cog');
    repository.create('sprocket');
    expect(repository.names()).toEqual(['cog', 'sprocket']);
    await app.shutdown();
  });
});

describe('DbModule.forRootAsync', () => {
  it('takes the options from a factory that may inject', async () => {
    @Module({ providers: [Config], exports: [Config] })
    class ConfigModule {}

    @Module({
      imports: [
        DbModule.forRootAsync(BunSQLiteDatabase, {
          imports: [ConfigModule],
          useFactory: (config: Config) =>
            new SqliteOptions({ schema, filename: config.filename }),
          inject: [Config],
        }),
      ],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.get(handle)).toBeInstanceOf(BunSQLiteDatabase);
    expect(app.get(DbOptions)).toBeInstanceOf(SqliteOptions);
    await app.shutdown();
  });

  it('awaits an async factory before anything is constructed', async () => {
    @Module({
      imports: [
        DbModule.forRootAsync(BunSQLiteDatabase, {
          useFactory: async () => {
            await Bun.sleep(1);
            return new SqliteOptions({ schema });
          },
        }),
      ],
      providers: [WidgetsRepository],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.get(WidgetsRepository).handle()).toBe(app.get(handle));
    await app.shutdown();
  });

  it('binds the connection as well', async () => {
    @Module({
      imports: [
        DbModule.forRootAsync(BunSQLiteDatabase, {
          useFactory: () => new SqliteOptions({ schema }),
        }),
      ],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.get(DbConnection)).toBeInstanceOf(SqliteConnection);
    await app.shutdown();
  });
});

describe('shutdown', () => {
  it('closes the connection', async () => {
    @Module({ imports: [DbModule.forRoot(options())] })
    class Root {}

    const app = await AppFactory.create(Root);
    const connection = app.get(DbConnection);
    await app.shutdown();

    expect(connection).toBeInstanceOf(SqliteConnection);
    if (!(connection instanceof SqliteConnection)) throw new Error('narrowing');
    expect(connection.closed).toBe(true);
  });

  /**
   * The reason the drizzle handle is bound through a factory that *depends* on the
   * connection: it forces the connection to be constructed first, and core tears
   * down in reverse, so it closes last.
   */
  it('drains dependents while the connection is still usable', async () => {
    shutdowns.length = 0;

    @Module({
      imports: [DbModule.forRoot(options())],
      providers: [WidgetsRepository, Draining],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    app
      .get(handle)
      .run(
        sql`CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`,
      );
    app.get(WidgetsRepository).create('cog');

    await app.shutdown();
    // A query inside onShutdown succeeded, so the connection outlived it.
    expect(shutdowns).toEqual(['drained with 1 widgets still readable']);
  });

  it('is idempotent', async () => {
    @Module({ imports: [DbModule.forRoot(options())] })
    class Root {}

    const app = await AppFactory.create(Root);
    await app.shutdown();
    await app.shutdown();
    expect(app.get(DbConnection)).toBeInstanceOf(SqliteConnection);
  });
});

describe('the Bun.SQL backend', () => {
  const url = process.env['DUNX_DB_TEST_URL'];

  it('binds drizzle’s Postgres class as its token', () => {
    expect(
      new SqlOptions({ schema, url: 'postgres://localhost/x' }).token,
    ).toBe(BunSQLDatabase);
  });

  it('is a different token from the SQLite backend', () => {
    expect(BunSQLDatabase).not.toBe(BunSQLiteDatabase);
  });

  it.skipIf(url === undefined)('binds a live Postgres connection', async () => {
    @Module({
      imports: [
        DbModule.forRoot(new SqlOptions({ schema: {}, url: url ?? '' })),
      ],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.get(BunSQLDatabase)).toBeInstanceOf(BunSQLDatabase);
    expect(app.get(DbConnection)).toBeInstanceOf(SqlConnection);
    await app.shutdown();
  });
});
