import { describe, expect, test } from 'bun:test';
import { AppFactory, ConfigModule } from '@dunx/core';
import { DatabasesConfigService, validate } from './config.js';
import { MysqlModule } from './mysql/module.js';
import { MysqlWidgets } from './mysql/widgets.service.js';
import { PostgresModule } from './postgres/module.js';
import { PostgresWidgets } from './postgres/widgets.service.js';
import { reachable } from './reachable.js';
import { SqliteModule } from './sqlite/module.js';
import { SyncWidgets } from './sqlite/widgets-sync.service.js';
import { Widgets } from './sqlite/widgets.service.js';

const configModule = ConfigModule.forRoot({
  validate,
  as: DatabasesConfigService,
});

const config = validate(Bun.env);

/**
 * `expect(...).rejects` is typed `void` in `bun:test`, so awaiting it trips
 * oxlint's `await-thenable`. Settling the promise by hand is the repo's idiom and
 * reads no worse.
 */
const threw = (promise: Promise<unknown>): Promise<string> =>
  promise.then(
    () => 'it resolved',
    (error: unknown) => (error as Error).message,
  );

/**
 * SQLite always runs. Postgres and MySQL are probed once and skipped if nothing is
 * listening, so a clean checkout with no Docker still exits 0 - `describe.skipIf`
 * is the honest way to say that, because a skipped test is reported as skipped
 * rather than as passing.
 */
const noPostgres = (await reachable(config.postgresUrl)) !== null;
const noMysql = (await reachable(config.mysqlUrl)) !== null;

describe('sqlite, asynchronous mode', () => {
  test('commits, and rolls back across an await', async () => {
    const app = await AppFactory.create({
      module: class SqliteAsyncTest {},
      imports: [configModule, SqliteModule.asynchronous(':memory:')],
    });
    const widgets = app.get(Widgets);

    await widgets.addPairAtomically('nut', 'screw', false);
    expect(await widgets.list()).toHaveLength(2);

    // The rollback is the point: drizzle's own bun-sqlite transaction would have
    // committed before this callback's first await resumed.
    expect(
      await threw(widgets.addPairAtomically('ghost', 'phantom', true)),
    ).toBe('rolling back on purpose');
    expect(await widgets.list()).toHaveLength(2);

    await app.shutdown();
  });
});

describe('sqlite, synchronous mode', () => {
  test('commits and rolls back with no promise anywhere', async () => {
    const app = await AppFactory.create({
      module: class SqliteSyncTest {},
      imports: [configModule, SqliteModule.synchronous()],
    });
    const widgets = app.get(SyncWidgets);

    expect(widgets.addPairAtomically('nut', 'screw', false)).toBe(2);
    expect(() => widgets.addPairAtomically('ghost', 'phantom', true)).toThrow(
      'rolling back on purpose',
    );
    expect(widgets.list()).toHaveLength(2);

    await app.shutdown();
  });
});

describe.skipIf(noPostgres)('postgres over Bun.SQL', () => {
  test('commits, and rolls back', async () => {
    const app = await AppFactory.create({
      module: class PostgresTest {},
      imports: [configModule, PostgresModule.forUrl(config.postgresUrl)],
    });
    const widgets = app.get(PostgresWidgets);

    await widgets.addPairAtomically('nut', 'screw', false);
    expect(await widgets.list()).toHaveLength(2);

    expect(
      await threw(widgets.addPairAtomically('ghost', 'phantom', true)),
    ).toBe('rolling back on purpose');
    expect(await widgets.list()).toHaveLength(2);

    await app.shutdown();
  });
});

describe.skipIf(noMysql)(
  'mysql over Bun.SQL through drizzle-orm/mysql-proxy',
  () => {
    test('inserts and reads back through $returningId', async () => {
      const app = await AppFactory.create({
        module: class MysqlInsertTest {},
        imports: [configModule, MysqlModule.forUrl(config.mysqlUrl)],
      });
      const widgets = app.get(MysqlWidgets);

      const row = await widgets.add('bolt', 3);
      expect(row?.name).toBe('bolt');
      expect(row?.weight).toBe(3);

      await app.shutdown();
    });

    test('commits and rolls back through Bun.SQL begin()', async () => {
      const app = await AppFactory.create({
        module: class MysqlTxTest {},
        imports: [configModule, MysqlModule.forUrl(config.mysqlUrl)],
      });
      const widgets = app.get(MysqlWidgets);

      await widgets.addPairAtomically('nut', 'screw', false);
      expect(await widgets.list()).toHaveLength(2);

      expect(
        await threw(widgets.addPairAtomically('ghost', 'phantom', true)),
      ).toBe('rolling back on purpose');
      expect(await widgets.list()).toHaveLength(2);

      await app.shutdown();
    });
  },
);
