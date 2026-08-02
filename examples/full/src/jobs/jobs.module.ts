import { Module } from '@dunx/core';
import { QueueModule } from '@dunx/infra/queue';
import { AppConfigService } from '../config.js';
import { PicturesModule } from '../pictures/pictures.module.js';
import { JobsController } from './jobs.controller.js';
import { ThumbnailJobs } from './thumbnail.jobs.js';

/**
 * Imported by **both** containers, which is the whole shape of a queue: the web
 * process publishes, a separate worker process consumes, and they agree only on
 * this module.
 *
 * `QueueModule.forRoot` binds the publish side alone, so importing it does not
 * open a worker - a web process that publishes never consumes by accident.
 * `PicturesModule` is here because the handler injects `Thumbnails`, and the
 * worker's container has to be able to build it.
 */
@Module({
  imports: [
    QueueModule.forRootAsync({
      useFactory: (config: AppConfigService) => {
        const { url } = config.get('redis');
        return {
          ...(url === undefined ? {} : { url }),
          prefix: 'dunx-full',
        };
      },
      inject: [AppConfigService] as const,
    }),
    PicturesModule,
  ],
  controllers: [JobsController],
  providers: [ThumbnailJobs],
})
export class JobsModule {}
