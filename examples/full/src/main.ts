import { Logger } from '@dunx/core';
import { WorkerFactory, type QueueConsumer } from '@dunx/infra/queue';
import { AppModule } from './app.module.js';
import { createApp } from './bootstrap.js';
import { AppConfigService } from './config.js';
import { HealthController } from './health/health.controller.js';
import type { HttpApp } from '@dunx/http';

/**
 * One service, every part of dunx, and it stays up. `bun run tour` is the
 * scripted walkthrough that exits; this is the thing you open in a browser.
 */

/**
 * `INLINE_WORKER=true` consumes the queues **in this process**, so a job's log
 * lines land in the same stream as the request that enqueued it.
 *
 * That is the whole appeal, and it is worth being clear about what it costs. The
 * default - `bun run worker`, a second process - is what the example is for: a
 * worker is its own container, it opens only what a handler needs, and it scales
 * and fails separately from the web tier. Inline, a slow handler competes with
 * every request for the same event loop.
 *
 * `WorkerFactory.attach` is the supported way to do it: the handlers are found on
 * the same module ref the app was built from and resolved out of the container
 * that is already running, so nothing is constructed twice.
 */
const attachWorker = async (
  app: HttpApp,
  logger: Logger,
): Promise<QueueConsumer> => {
  const consumer = await WorkerFactory.attach(app, AppModule);
  await consumer.start();
  logger.info(
    'INLINE_WORKER=true: consuming in this process, so job logs appear here. ' +
      'Unset it for the two-process shape, which is the one to copy.',
  );
  return consumer;
};

/**
 * The consumer stops **before** the container does, which `attach` cannot enforce
 * for itself: `App` has no hook to register against, and a worker still running
 * while providers tear down finds its database closed underneath it.
 *
 * So this replaces `enableShutdownHooks()` rather than running alongside it -
 * that registers its own handler, and two handlers racing is exactly the
 * ordering this exists to guarantee.
 */
const shutdownWith = (app: HttpApp, consumer: QueueConsumer): void => {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void (async () => {
        await consumer.stop();
        await app.shutdown();
      })();
    });
  }
};

async function bootstrap(): Promise<void> {
  const app = await createApp();

  const config = app.get(AppConfigService);
  const logger = app.get(Logger);
  const inline = config.get('inlineWorker');

  // Before `listen`, so a job enqueued by the first request has something to
  // consume it, and so a wiring error fails boot rather than the first job.
  const consumer = inline ? await attachWorker(app, logger) : undefined;
  if (consumer) shutdownWith(app, consumer);
  else app.enableShutdownHooks();

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
  logger.info(
    inline
      ? 'worker    in this process (INLINE_WORKER=true)'
      : 'worker    `bun run worker`, a second process - or INLINE_WORKER=true',
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
