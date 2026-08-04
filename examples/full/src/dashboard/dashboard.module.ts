import { Module } from '@dunx/core';
import { JobPublisher } from '@dunx/infra/queue';
import { QueueDashboardModule } from '@dunx/queue-dashboard';
import { AppConfigService } from '../config.js';
import { JobsModule } from '../jobs/jobs.module.js';
import { THUMBNAIL_QUEUE } from '../jobs/thumbnail.jobs.js';

/**
 * bull-board at `/queues`, over the same queue the jobs feature publishes to.
 *
 * `forRootAsync` rather than `forRoot`, because the queue lives in the container -
 * `JobPublisher.queue(name)` opens it on first use, so it cannot be named in a
 * static call.
 *
 * `JobsModule` is imported for its `QueueModule.forRoot`, which is what binds
 * `JobPublisher`. Importing it here rather than assuming the app already did keeps
 * this module usable on its own.
 */
@Module({
  imports: [
    JobsModule,
    QueueDashboardModule.forRootAsync({
      useFactory: (publisher: JobPublisher, config: AppConfigService) => ({
        path: '/queues',
        /**
         * A thunk, not an array: constructing a bullmq `Queue` opens a connection, so
         * naming it here would make this app connect to Redis at boot even when
         * nobody opens the board. Called on the first dashboard request instead.
         */
        queues: () => [publisher.queue(THUMBNAIL_QUEUE)],
        uiConfig: { boardTitle: `${config.get('appName')} queues` },
        /**
         * Every request is authorised, and this example lets them all through on
         * purpose - there is no session to check and a demo that 404s its own
         * dashboard teaches nothing. It is written out rather than omitted because
         * omitting it is the same behaviour with none of the warning: a real
         * deployment checks a session here, and `@dunx/auth`'s `SessionGuard` is
         * what it would read.
         */
        authorize: () => true,
      }),
      inject: [JobPublisher, AppConfigService] as const,
    }),
  ],
})
export class DashboardModule {}
