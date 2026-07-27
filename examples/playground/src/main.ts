import { DunxFactory } from '@dunx/core';
import { AppModule } from './app.module.js';
import { UsersService } from './users/users.service.js';

const app = await DunxFactory.create(AppModule);
app.enableShutdownHooks();

console.log(`[dunx] ${app.get(UsersService).summary()}`);

if (process.env['DUNX_HOLD']) {
  console.log('[dunx] holding — send SIGTERM to close');
  await app.closed;
} else {
  await app.shutdown();
}
