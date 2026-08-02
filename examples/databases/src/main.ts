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
 * Four containers, one after another, because each binds its own `DbConnection`
 * and the container is flat - two backends in one app would be a duplicate token,
 * which dunx rejects at boot naming both modules. Running an app per dialect is
 * also what a real deployment does.
 *
 * `AppFactory`, not `HttpFactory`: there is no HTTP here at all. A dunx app does
 * not need a server, and keeping one out is what makes the database wiring the
 * only thing on screen.
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

  // Not one `await` in this block. `bun:sqlite` is a function call into SQLite.
  widgets.add('bolt', 3);
  widgets.addPairAtomically('nut', 'screw', false);
  const committed = widgets.list().length;

  try {
    widgets.addPairAtomically('ghost', 'phantom', true);
  } catch {
    // The rollback is the demonstration.
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
   * A timer, for the event loop, and not decoration - without it this script exits
   * **silently with code 0** in the middle of the MySQL section.
   *
   * On Bun 1.3.14 an in-flight `Bun.SQL` query on the **MySQL** adapter does not
   * hold a reference on the event loop. A long-running server never notices,
   * because `Bun.serve` holds one; a script like this has nothing else pending, so
   * the loop drains while the query is outstanding and the process just stops -
   * no error, no rejection, no output, exit 0. Measured: with this interval the
   * MySQL section completes every time, without it never. The Postgres adapter and
   * `bun:sqlite` are unaffected. See docs/bun-apis.md.
   */
  const keepalive = setInterval(() => undefined, 250);

  try {
    // One throwaway container purely to read the validated config the same way
    // every other app in this repo does, rather than touching `Bun.env` here.
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
