import { JobProcessor } from '@dunx/infra/queue';
import { ConfigModule, Module } from '@dunx/core';
import { LoggerModule } from '@dunx/infra/logger';
import { AppConfigService, validate } from '../config.js';
import { JobsModule } from './jobs.module.js';

/**
 * The file bullmq forks into; its default export is the processor. The child
 * builds its own container, so a handler gets what it declares without sharing
 * an event loop with the HTTP process. Its own module rather than `worker.ts`,
 * which has a `run()` that would boot a second worker inside every child.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ validate, as: AppConfigService }),
    LoggerModule.forRootAsync({
      useFactory: (config: AppConfigService) => ({
        // Named, so a line from a child is attributable on sight.
        name: `${config.get('appName')}-job`,
        level: config.get('log').level,
      }),
      inject: [AppConfigService] as const,
    }),
    JobsModule,
  ],
})
class JobProcessorModule {}

export default new JobProcessor(JobProcessorModule).handle;
