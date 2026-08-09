import { Module } from '@dunx/core';
import { JobPublisher, QueueModule } from '@dunx/infra/queue';
import { AppConfigService } from '../config.js';
import { PicturesModule } from '../pictures/pictures.module.js';
import { JobsController } from './jobs.controller.js';
import { ThumbnailJobs } from './thumbnail.jobs.js';

/**
 * Imported by **both** containers, which is the whole shape of a queue: the web
 * process publishes, a separate worker process consumes, and they agree only on
 * this module.
 *
 * `consume: true` is what makes this process work them as well as publish, and it
 * is the only line about it anywhere - the container owns starting and stopping the
 * workers, so no entrypoint has to. Leave it out and the module binds the publish
 * side alone, which is what a web tier with a separate worker fleet wants.
 *
 * `PicturesModule` is here because the handler injects `Thumbnails`, and the
 * container that runs it has to be able to build it.
 */
@Module({
  imports: [
    QueueModule.forRootAsync({
      useFactory: (config: AppConfigService) => {
        const { url } = config.get('redis');
        return {
          ...(url === undefined ? {} : { url }),
          prefix: 'dunx-full',
          // This process works its own queues. The container starts the workers at
          // onInit and stops them at onShutdown - before the database they use -
          // so `main.ts` says nothing about queues and there is no second command.
          consume: true,
          // The file bullmq forks into for a queue whose handler is marked
          // `background`. Absolute, because the child resolves it, not this module.
          processor: new URL('./jobs.processor.ts', import.meta.url).pathname,
        };
      },
      inject: [AppConfigService] as const,
    }),
    PicturesModule,
  ],
  controllers: [JobsController],
  providers: [ThumbnailJobs],
  // The publisher, re-exported so a feature that enqueues does not import
  // @dunx/infra/queue itself.
  exports: [JobPublisher, ThumbnailJobs],
})
export class JobsModule {}
