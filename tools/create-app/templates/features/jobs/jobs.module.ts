import { Module } from '@dunx/core';
import { JobPublisher, QueueModule } from '@dunx/infra/queue';
import { AppConfigService } from '../config.js';
import { PicturesModule } from '../pictures/pictures.module.js';
import { JobsController } from './jobs.controller.js';
import { ThumbnailJobs } from './thumbnail.jobs.js';

/**
 * Imported by both containers: the web process publishes, a worker process
 * consumes, and they agree only on this module. `consume: true` makes this
 * process work them too; leave it out and it binds the publish side alone.
 */
@Module({
  imports: [
    QueueModule.forRootAsync({
      useFactory: (config: AppConfigService) => {
        const { url } = config.get('redis');
        return {
          ...(url === undefined ? {} : { url }),
          prefix: 'dunx-full',
          // The container starts the workers at onInit and stops them before
          // the database they use, so `main.ts` says nothing about queues.
          //
          // `true`, not `'if-any'`: this module declares handlers, and `true`
          // refuses to boot if that ever stops being so. `'if-any'` is for a
          // migration where the wiring lands before the first @JobHandler.
          consume: true,
          // Where bullmq forks for a `background` handler. Absolute: the child
          // resolves it, not this module.
          processor: new URL('./jobs.processor.ts', import.meta.url).pathname,
        };
      },
      inject: [AppConfigService] as const,
    }),
    PicturesModule,
  ],
  controllers: [JobsController],
  providers: [ThumbnailJobs],
  // Re-exported so a feature that enqueues does not import @dunx/infra/queue.
  exports: [JobPublisher, ThumbnailJobs],
})
export class JobsModule {}
