import { AppFactory } from '@dunx/core';
import { Database, DbOptions } from '@dunx/db';
import { AppModule } from './app.module.js';
import { Logger } from './logger.js';
import { trySqlBackend } from './sql-backend.js';
import { UsersService } from './users/users.service.js';

const app = await AppFactory.create(AppModule);
app.enableShutdownHooks();

const log = (message: string): void => console.log(`[dunx] ${message}`);
const db = app.get(Database);
const users = app.get(UsersService);

log(`options -> ${app.get(DbOptions).backend}`);
log(`database -> ${db.backend} / ${db.dialect}`);

// Committed.
const registered = await users.register(
  ['Ada Lovelace', 'ada@dunx.dev'],
  ['Grace Hopper', 'grace@dunx.dev'],
);
log(`register -> ${registered} row(s) after commit`);

// Rolled back — the insert before the throw is undone.
const failed = await users.registerAndFail('Rollback Rita', 'rita@dunx.dev');
log(`failed transaction -> ${failed}`);
log(`after rollback -> ${(await users.findAll()).length} row(s), unchanged`);

for (const user of await users.findAll()) {
  log(`  #${user.id} ${user.name} <${user.email}>`);
}

const found = await users.findByEmail('ada@dunx.dev');
log(`bound lookup -> ${found?.name ?? 'not found'}`);

// A savepoint: the inner failure unwinds only the inner work.
const kept = await db.transaction(async (tx) => {
  await tx.sql`
    INSERT INTO users (name, email) VALUES (${'Kept'}, ${'kept@dunx.dev'})
  `.run();

  await tx
    .transaction(async (savepoint) => {
      await savepoint.sql`
        INSERT INTO users (name, email) VALUES (${'Discarded'}, ${'gone@dunx.dev'})
      `.run();
      throw new Error('inner failed');
    })
    .catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      log(`  savepoint rolled back: ${reason}`);
    });

  return tx.get<{ n: number }>('SELECT count(*) AS n FROM users');
});
log(`savepoint -> ${kept?.n} row(s), the outer insert survived`);

// The escape hatch, and the other backend.
log(`raw handle -> ${db.raw?.constructor.name}`);
await trySqlBackend(log);

app.get(Logger).info('shutting down');
await app.shutdown();
log('closed');
