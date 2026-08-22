import { Logger } from '@dunx/core';
import { HealthRegistry } from '@dunx/http';
import { createApp } from './bootstrap.js';
import { AppConfigService } from './config.js';

/**
 * One service, every part of dunx, and it stays up. `bun run tour` is the
 * scripted walkthrough that exits; this is the thing you open in a browser.
 *
 * **There is nothing here about queues.** `JobsModule` sets `consume: true` on its
 * `QueueModule`, so the container starts the workers at `onInit` and stops them at
 * `onShutdown` - before the database they depend on. One command, and the wiring
 * lives next to the jobs rather than in the entrypoint.
 */
async function bootstrap(): Promise<void> {
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
}

bootstrap().catch((error: unknown) => {
  console.error('[full] failed to start', error);
  process.exit(1);
});
