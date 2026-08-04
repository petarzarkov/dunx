import { ConfigModule, Logger, Module } from '@dunx/core';
import { WorkerFactory } from '@dunx/infra/queue';
import { LoggerModule } from '@dunx/infra/logger';
import { AppConfigService, validate } from './config.js';
import { JobsModule } from './jobs/jobs.module.js';

/**
 * `bun run worker` - the consumer, and **a second process on purpose**.
 *
 * A worker is its own container: it builds only what a handler needs, opens a
 * bullmq `Worker` per queue, and has no HTTP server. That is why the full example
 * cannot demonstrate queues from `bun start` alone, and why this file exists
 * rather than a flag on the main app.
 *
 * It shares exactly one thing with the web process - `JobsModule` - so the two
 * agree on the queue name and the handler without agreeing on anything else.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ validate, as: AppConfigService }),
    LoggerModule.forRootAsync({
      useFactory: (config: AppConfigService) => ({
        name: `${config.get('appName')}-worker`,
        level: config.get('log').level,
      }),
      inject: [AppConfigService] as const,
    }),
    JobsModule,
  ],
})
class WorkerModule {}

async function run(): Promise<void> {
  const worker = await WorkerFactory.create(WorkerModule);
  await worker.start();
  worker.enableShutdownHooks();

  const logger = worker.get(Logger);
  logger.info('worker consuming - ctrl-c to stop');
  logger.info('enqueue with: curl -X POST localhost:3000/api/jobs/thumbnails');

  // An in-flight job is drained by `onShutdown` before this resolves.
  await worker.closed;
}

run().catch((error: unknown) => {
  console.error('[full] worker failed to start', error);
  process.exit(1);
});
