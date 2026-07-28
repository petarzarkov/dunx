import { HttpFactory } from '@dunx/http';
import { AppModule } from './app.module.js';
import { UsersService } from './users/users.service.js';

// Port 0 by default so concurrent runs never collide.
const app = await HttpFactory.create(AppModule, {
  port: Number(process.env['PORT'] ?? 0),
});
app.enableShutdownHooks();

const url = await app.listen();
console.log(`[dunx] listening on ${url}`);
console.log(`[dunx] ${app.get(UsersService).summary()}`);

const listed = await (await fetch(new URL('users', url))).json();
console.log(`[dunx] GET /users -> ${JSON.stringify(listed)}`);

if (process.env['DUNX_HOLD']) {
  console.log('[dunx] holding — send SIGTERM to close');
  await app.closed;
} else {
  await app.shutdown();
}
