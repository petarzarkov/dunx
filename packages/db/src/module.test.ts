import { AppFactory, Module, type OnShutdown } from '@dunx/core';
import { describe, expect, it } from 'bun:test';
import { Backend, Database, DbOptions } from './contract.js';
import { DbModule } from './module.js';
import { Repository } from './repository.js';
import { SqlDatabase } from './sql/database.js';
import { SqlOptions } from './sql/options.js';
import { SqliteDatabase } from './sqlite/database.js';
import { SqliteOptions } from './sqlite/options.js';

/**
 * The repo's rejection idiom: await the promise, keep the reason. `expect().rejects`
 * is typed as non-thenable by bun:test, which makes the assertion a lint warning.
 */
const rejection = async (promise: Promise<unknown>): Promise<Error> => {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof Error))
    throw new Error('expected the promise to reject with an Error');
  return error;
};

/**
 * Stands in for `@dunx/compiler`. This package cannot depend on it — the plugin
 * is what builds `@dunx/db` — so the tests write the record it would append.
 */
const records = (ctor: object, deps: () => readonly unknown[]): void => {
  Object.defineProperty(ctor, Symbol.for('dunx.deps'), { value: deps });
};

class UsersRepository {
  constructor(readonly db: Database) {}

  count(): Promise<{ n: number } | null> {
    return this.db.get<{ n: number }>('SELECT count(*) AS n FROM users');
  }
}
records(UsersRepository, () => [Database]);

/** No constructor of its own — dependencies come off the base. */
class PostsRepository extends Repository {
  posts(): Promise<readonly object[]> {
    return this.db.all('SELECT * FROM posts');
  }
}
records(Repository, () => [Database]);

class Config {
  readonly url = 'sqlite://:memory:';
}

describe('DbModule.forRoot', () => {
  it('binds Database and injects it into a repository', async () => {
    @Module({
      imports: [DbModule.forRoot(new SqliteOptions())],
      providers: [UsersRepository],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    const db = app.get(Database);
    expect(db).toBeInstanceOf(SqliteDatabase);
    expect(app.get(UsersRepository).db).toBe(db);

    await db.exec('CREATE TABLE users (id INT)');
    expect(await app.get(UsersRepository).count()).toEqual({ n: 0 });
    await app.shutdown();
  });

  it('injects the base class dependency into a subclass with no constructor', async () => {
    @Module({
      imports: [DbModule.forRoot(new SqliteOptions())],
      providers: [PostsRepository],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    await app.get(Database).exec('CREATE TABLE posts (id INT)');
    expect(await app.get(PostsRepository).posts()).toEqual([]);
    await app.shutdown();
  });

  it('binds the options too, so the dialect is readable', async () => {
    const options = new SqliteOptions({ filename: ':memory:' });

    const app = await AppFactory.create(DbModule.forRoot(options));
    expect(app.get(DbOptions)).toBe(options);
    expect(app.get(DbOptions).backend).toBe(Backend.SQLITE);
    await app.shutdown();
  });

  it('selects the Bun.SQL backend from SqlOptions', async () => {
    const app = await AppFactory.create(
      DbModule.forRoot(new SqlOptions({ url: 'sqlite://:memory:' })),
    );
    expect(app.get(Database)).toBeInstanceOf(SqlDatabase);
    expect(app.get(Database).backend).toBe(Backend.SQL);
    await app.shutdown();
  });

  it('accepts a configured module as the root', async () => {
    const app = await AppFactory.create(DbModule.forRoot(new SqliteOptions()));
    expect(await app.get(Database).get('SELECT 1 AS one')).toEqual({ one: 1 });
    await app.shutdown();
  });
});

describe('DbModule.forRootAsync', () => {
  it('settles the connection before any constructor runs', async () => {
    let connectedBeforeConstruct = false;

    class Probe {
      constructor(readonly db: Database) {
        // The factory has already awaited, so this handle is live — synchronously.
        connectedBeforeConstruct = db instanceof SqliteDatabase;
      }
    }
    records(Probe, () => [Database]);

    @Module({
      imports: [
        DbModule.forRootAsync({
          useFactory: async () => {
            await Bun.sleep(2);
            return new SqliteOptions();
          },
        }),
      ],
      providers: [Probe],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(connectedBeforeConstruct).toBe(true);
    expect(await app.get(Probe).db.get('SELECT 1 AS one')).toEqual({ one: 1 });
    await app.shutdown();
  });

  it('injects other providers into the options factory', async () => {
    @Module({
      imports: [
        DbModule.forRootAsync({
          useFactory: (config: Config) => new SqlOptions({ url: config.url }),
          inject: [Config],
        }),
      ],
      providers: [Config],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.get(Database)).toBeInstanceOf(SqlDatabase);
    await app.shutdown();
  });

  it('propagates a failure from the options factory out of create()', async () => {
    @Module({
      imports: [
        DbModule.forRootAsync({
          useFactory: () => new SqlOptions({ url: 'pg://localhost/app' }),
        }),
      ],
    })
    class Root {}

    expect((await rejection(AppFactory.create(Root))).message).toMatch(
      /pg:\/\//,
    );
  });
});

describe('shutdown', () => {
  it('drains a dependent before the connection it depends on', async () => {
    const order: string[] = [];

    class Drainer implements OnShutdown {
      constructor(readonly db: Database) {}

      async onShutdown(): Promise<void> {
        // Still usable — this is the ordering guarantee the hook relies on.
        expect(await this.db.get('SELECT 1 AS one')).toEqual({ one: 1 });
        order.push('drainer');
      }
    }
    records(Drainer, () => [Database]);

    @Module({
      imports: [DbModule.forRoot(new SqliteOptions())],
      providers: [Drainer],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    const db = app.get(Database);
    await app.shutdown();

    expect(order).toEqual(['drainer']);
    expect((await rejection(db.get('SELECT 1'))).message).toMatch(/closed/);
  });

  it('closes the connection once however many times shutdown is called', async () => {
    const app = await AppFactory.create(DbModule.forRoot(new SqliteOptions()));
    const db = app.get(Database);

    let closes = 0;
    const close = db.close.bind(db);
    db.close = async () => {
      closes += 1;
      await close();
    };

    await app.shutdown();
    await app.shutdown();
    expect(closes).toBe(1);
  });
});
