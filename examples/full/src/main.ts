import { Logger } from '@dunx/core';
import { createApp } from './bootstrap.js';
import { AppConfigService } from './config.js';
import { HealthController } from './health/health.controller.js';

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

bootstrap()
  .then(() => {
    /**
     * The drain is complete by here - `app.closed` resolves after every `onShutdown`
     * has run, in reverse dependency order. The explicit exit is for the handle dunx
     * does not own.
     *
     * Against an **unreachable** broker, bullmq's Bun adapter cannot cancel its own
     * pending reconnect, so a client survives `disconnect()` and holds the event loop
     * open after a perfectly successful shutdown. That is leak B in
     * docs/roadmap/queue-shutdown-sigterm.md - measured, upstream, and not fixable
     * from here. Without this, `SIGTERM` drains everything and then hangs until
     * `SIGKILL`, which is what guide 17-deployment.md's grace-period advice is about.
     */
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error('[full] failed to start', error);
    process.exit(1);
  });
