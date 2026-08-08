import { Logger } from '@dunx/core';
import { createApp } from './bootstrap.js';
import { AppConfigService } from './config.js';
import { HealthController } from './health/health.controller.js';

/**
 * One service, every part of dunx, and it stays up. `bun run tour` is the
 * scripted walkthrough that exits; this is the thing you open in a browser.
 */
async function bootstrap(): Promise<void> {
  const app = await createApp();
  app.enableShutdownHooks();

  const config = app.get(AppConfigService);
  const logger = app.get(Logger);
  const url = await app.listen(config.get('port'));

  for (const area of await app.get(HealthController).areas()) {
    const mark = area.state === 'live' ? '✓' : '·';
    logger.info(`${mark} ${area.name} - ${area.detail}`);
  }

  logger.info(`listening on ${url}`);
  logger.info(`docs      ${new URL('api/docs', url).href}`);
  logger.info(`openapi   ${new URL('api/openapi.json', url).href}`);
  logger.info(`health    ${new URL('api/health', url).href}`);
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
