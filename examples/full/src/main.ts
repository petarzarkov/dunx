import { betterAuthDocument, Auth } from '@dunx/auth';
import { Logger } from '@dunx/core';
import { DashboardMiddleware } from '@dunx/dashboard';
import {
  Compression,
  HealthRegistry,
  HttpFactory,
  RedisRelay,
  StaticFiles,
  ThrottleGuard,
  type HttpApp,
} from '@dunx/http';
import { OpenApiModule } from '@dunx/openapi';
import { AppModule } from './app.module.js';
import { AppConfigService, RELAY_CHANNEL } from './config.js';
import { RequestTrailMiddleware } from './http/request-trail.js';

/**
 * One app for `bun start`, `bun run tour` and the tests, and one file: `createApp`
 * is exported for the callers that only want the shape, and the block at the
 * bottom serves it when this file is the entry point.
 *
 * Everything between `create()` and `listen()` may still shape the server; after
 * `listen()` each of these throws.
 */
export const createApp = async (): Promise<HttpApp> => {
  const app = await HttpFactory.create(
    // `forRootAsync` because `contribute` needs the `Auth` instance, which
    // `AppModule` exports and the graph cannot supply synchronously.
    OpenApiModule.forRootAsync({
      root: AppModule,
      inject: [Auth] as const,
      useFactory: (auth: Auth) => ({
        title: 'dunx full example',
        version: '0.1.0',
        description:
          'Every part of dunx in one service. Generated from the same zod schemas the routes validate against.',
        // better-auth answers `/api/auth/*` itself, so route discovery sees
        // none of it; this merges the library's own schema in.
        contribute: [
          betterAuthDocument(auth, { basePath: '/api/auth', tag: 'Auth' }),
        ],
        /**
         * Every Swagger UI parameter is available; these are a sample.
         * `requestInterceptor` takes the source of an expression, not a
         * function - the page is rendered server-side, so a closure cannot travel.
         */
        ui: {
          title: 'dunx full example - API',
          docExpansion: 'list',
          filter: true,
          tryItOutEnabled: true,
          persistAuthorization: true,
          displayRequestDuration: true,
          operationsSorter: 'alpha',
          tagsSorter: 'alpha',
          syntaxHighlight: { theme: 'nord' },
          requestInterceptor:
            '(req) => { req.headers["x-dunx-example"] = "1"; return req; }',
        },
      }),
    }),
    {
      /**
       * `requestLogging`, `cors`, `prefix` and `trustProxy` are not here: they
       * read from validated config, so `AppHttpOptions` answers them from inside
       * the container (`http/http-options.ts`). What is left is the settings that
       * are constructed objects rather than environment.
       */
      websocket: { idleTimeout: 30 },
      // Multi-node websocket fan-out on `Bun.RedisClient`. No url, so it
      // resolves $VALKEY_URL, $REDIS_URL, then localhost. With no Redis running
      // it degrades to single-process behaviour and still boots.
      relay: new RedisRelay({ connectionTimeout: 500 }),
      relayChannel: RELAY_CHANNEL,
    },
  );

  // The imperative half, unchanged and still supported: `use`, `set`,
  // `enableCors` and `setGlobalPrefix` all still work, and a call here wins over
  // the provider because it happens after construction.
  //
  // First, ahead of everything. Its `authorize` answers 404 to a stranger; a
  // guard running earlier would answer 401 and confirm the mount exists.
  app.use(DashboardMiddleware);
  app.use(Compression);
  // Before the rate limit: twenty hashed bundles must not spend a request budget.
  app.use(StaticFiles);
  app.use(RequestTrailMiddleware);
  // After anything that establishes the caller, since that decides the subject.
  app.use(ThrottleGuard);
  return app;
};

/**
 * One service, every part of dunx, and it stays up. `bun run tour` is the
 * scripted walkthrough that exits; this is the thing you open in a browser.
 *
 * **There is nothing here about queues.** `JobsModule` sets `consume: true` on its
 * `QueueModule`, so the container starts the workers at `onInit` and stops them at
 * `onShutdown` - before the database they depend on. A queue with a `background`
 * handler is forked by bullmq into `jobs/jobs.processor.ts`, so there is no second
 * process to run and no second command to remember.
 */
const start = async (): Promise<void> => {
  const app = await createApp();
  app.enableShutdownHooks();

  const config = app.get(AppConfigService);
  const logger = app.get(Logger);
  const url = await app.listen(config.get('port'));
  // The readiness report the orchestrator will read, printed once at boot so the
  // first thing in the log is what is actually working.
  for (const check of (await app.get(HealthRegistry).readiness()).checks) {
    const mark = check.state === 'up' ? '✓' : '·';
    logger.info(`${mark} ${check.name} - ${check.detail ?? check.state}`);
  }

  logger.info(`listening on ${url}`);
  logger.info(`docs      ${new URL('api/docs', url).href}`);
  logger.info(`openapi   ${new URL('api/openapi.json', url).href}`);
  logger.info(`live      ${new URL('api/health/live', url).href}`);
  logger.info(`ready     ${new URL('api/health/ready', url).href}`);
  logger.info(`dashboard ${new URL('api/_dunx', url).href}`);
  logger.info(
    `queues    ${new URL('api/_dunx/queues', url).href} (bull-board)`,
  );
  logger.info('ctrl-c to stop');

  // Nothing else to do: the server holds the process open, and the shutdown
  // hooks resolve this once a signal arrives.
  await app.closed;
};

// False when a test or the tour imports this file for `createApp` alone, which is
// what lets one module be both the entry point and the app's definition.
if (import.meta.main) {
  start().catch((error: unknown) => {
    console.error('[full] failed to start', error);
    process.exit(1);
  });
}
