import { expect, it } from 'bun:test';
import { ConfigModule, Logger, provide } from '@dunx/core';
import {
  createTestApp,
  createTestServer,
  RecordingLogger,
} from '@dunx/testing';
import { AppConfigService, validate } from './config.js';
import { DatabaseModule } from './database/database.module.js';
import { UsersModule } from './users/users.module.js';
import { UsersService } from './users/users.service.js';

/**
 * A slice of the real app in a container of its own - no HTTP, no OpenAPI, no
 * cache - with the logger replaced so the suite stays quiet and can assert on
 * what was logged.
 *
 * `Logger` is the interesting override: no module here binds it, `@dunx/core`
 * offers `ConsoleLogger` as a default after every module, and the substitution
 * applies there too. Everything else is the app's own wiring, constructor
 * injection included - which is what makes this a test of the harness against
 * real modules rather than against fixtures written to suit it.
 */
it('boots the users slice with the logger replaced', async () => {
  const logger = new RecordingLogger();

  const app = await createTestApp({
    modules: [
      ConfigModule.forRoot({ validate, as: AppConfigService }),
      DatabaseModule,
      UsersModule,
    ],
    overrides: [provide(Logger, { useValue: logger })],
  });

  expect(app.get(Logger)).toBe(logger);
  // DATABASE_FILE defaults to :memory:, and UsersService.onInit migrated and
  // seeded it before create() resolved.
  expect(await app.get(UsersService).summary()).toBe('2 users: ada, grace');

  const messages = () => logger.entries.map((entry) => entry.message);
  expect(messages()).toContain('dunx-full: users ready');

  await app.shutdown();
  expect(messages()).toContain('users draining');
});

it('refuses an override for a token the slice does not bind', async () => {
  class FixedConfig extends AppConfigService {}

  const message = await createTestApp({
    modules: [UsersModule],
    overrides: [provide(AppConfigService, { useClass: FixedConfig })],
  }).then(
    () => 'it resolved',
    (error: unknown) => (error as Error).message,
  );

  // ConfigModule is not in this list, so nothing binds AppConfigService - and a
  // silent no-op would have left the suite asserting against the real config.
  expect(message).toContain('Nothing to override for AppConfigService');
});

/**
 * The other half of `@dunx/testing`: the same container behind a real `Bun.serve`
 * on port 0, with a client already pointed at it.
 *
 * `service.test.ts` deliberately does *not* use this - it drives `createApp()`
 * itself, because the thing it is testing is the real bootstrap with its prefix,
 * CORS and middleware. This is the other case, and the more common one: a slice of
 * modules with no bootstrap of its own.
 *
 * `prefix` is passed here rather than a `setGlobalPrefix` call, and request
 * logging defaults to `false` so the suite does not print a JSON line per
 * assertion.
 */
it('serves a slice through a real Bun.serve on port 0', async () => {
  const server = await createTestServer({
    modules: [
      ConfigModule.forRoot({ validate, as: AppConfigService }),
      DatabaseModule,
      UsersModule,
    ],
    prefix: 'api',
  });

  const { status, body } =
    await server.json<readonly { name: string }[]>('api/users');

  expect(status).toBe(200);
  expect(body.map((user) => user.name)).toEqual(['ada', 'grace']);

  // `app` is the real `HttpApp`, so the container is still reachable for the
  // assertions a request cannot make.
  expect(await server.app.get(UsersService).summary()).toBe(
    '2 users: ada, grace',
  );

  await server.close();
});
