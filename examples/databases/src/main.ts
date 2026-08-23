import { AppFactory, ConfigModule, Logger } from '@dunx/core';
import { DatabasesConfigService, validate } from './config.js';
import { MysqlModule } from './mysql/module.js';
import { MysqlWidgets } from './mysql/widgets.service.js';
import { PostgresModule } from './postgres/module.js';
import { PostgresWidgets } from './postgres/widgets.service.js';
import { reachable } from './reachable.js';
import { SqliteModule } from './sqlite/module.js';
import { SyncWidgets } from './sqlite/widgets-sync.service.js';
import { Widgets } from './sqlite/widgets.service.js';

/**
 * One container per dialect: each binds its own `DbConnection`, and two in one
 * app is a duplicate token dunx rejects at boot. `AppFactory` rather than
 * `HttpFactory` - a dunx app does not need a server.
 */
const configModule = ConfigModule.forRoot({
  validate,
  as: DatabasesConfigService,
});

const sqliteAsync = async (logger: Logger, file: string): Promise<void> => {
  const app = await AppFactory.create({
    module: class SqliteAsyncApp {},
    imports: [configModule, SqliteModule.asynchronous(file)],
  });
  const widgets = app.get(Widgets);

  await widgets.add('bolt', 3);
  await widgets.add('washer', 1);
  await widgets.addPairAtomically('nut', 'screw', false);
  const committed = (await widgets.list()).length;

  await widgets.addPairAtomically('ghost', 'phantom', true).catch(() => null);
  const afterRollback = (await widgets.list()).length;

  logger.info(
    `sqlite (async)  ${committed} rows committed, ${afterRollback} after a rolled-back pair`,
  );
  await app.shutdown();
};

const sqliteSync = async (logger: Logger): Promise<void> => {
  const app = await AppFactory.create({
    module: class SqliteSyncApp {},
    imports: [configModule, SqliteModule.synchronous()],
  });
  const widgets = app.get(SyncWidgets);

  widgets.add('bolt', 3);
  widgets.addPairAtomically('nut', 'screw', false);
  const committed = widgets.list().length;

  try {
    widgets.addPairAtomically('ghost', 'phantom', true);
  } catch {
    // The rollback is what the next line counts.
  }
  const afterRollback = widgets.list().length;

  logger.info(
    `sqlite (sync)   ${committed} rows committed, ${afterRollback} after a rolled-back pair`,
  );
  await app.shutdown();
};

const postgres = async (logger: Logger, url: string): Promise<void> => {
  const why = await reachable(url);
  if (why !== null) {
    logger.info(`postgres        skipping - ${why}`);
    return;
  }

  const app = await AppFactory.create({
    module: class PostgresApp {},
    imports: [configModule, PostgresModule.forUrl(url)],
  });
  const widgets = app.get(PostgresWidgets);

  await widgets.add('bolt', 3);
  await widgets.addPairAtomically('nut', 'screw', false);
  const committed = (await widgets.list()).length;

  await widgets.addPairAtomically('ghost', 'phantom', true).catch(() => null);
  const afterRollback = (await widgets.list()).length;

  logger.info(
    `postgres        ${committed} rows committed, ${afterRollback} after a rolled-back pair`,
  );
  await app.shutdown();
};

const mysql = async (logger: Logger, url: string): Promise<void> => {
  const why = await reachable(url);
  if (why !== null) {
    logger.info(`mysql           skipping - ${why}`);
    return;
  }

  const app = await AppFactory.create({
    module: class MysqlApp {},
    imports: [configModule, MysqlModule.forUrl(url)],
  });
  const widgets = app.get(MysqlWidgets);

  await widgets.add('bolt', 3);
  await widgets.addPairAtomically('nut', 'screw', false);
  const committed = (await widgets.list()).length;

  await widgets.addPairAtomically('ghost', 'phantom', true).catch(() => null);
  const afterRollback = (await widgets.list()).length;

  logger.info(
    `mysql           ${committed} rows committed, ${afterRollback} after a rolled-back pair`,
  );
  await app.shutdown();
};

const run = async (): Promise<void> => {
  /**
   * Holds the event loop open. On Bun 1.3.14 an in-flight `Bun.SQL` query on the
   * MySQL adapter takes no reference, so this script exits silently with code 0
   * mid-section. See docs/bun-apis.md.
   */
  const keepalive = setInterval(() => undefined, 250);

  try {
    const root = await AppFactory.create({
      module: class ConfigOnly {},
      imports: [configModule],
    });
    const config = root.get(DatabasesConfigService);
    const logger = root.get(Logger);

    await sqliteAsync(logger, config.get('sqliteFile'));
    await sqliteSync(logger);
    await postgres(logger, config.get('postgresUrl'));
    await mysql(logger, config.get('mysqlUrl'));

    await root.shutdown();
  } finally {
    clearInterval(keepalive);
  }
};

run().catch((error: unknown) => {
  console.error('[databases] failed', error);
  process.exit(1);
});
